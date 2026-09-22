import { vi } from 'vitest';

/**
 * An in-memory stand-in for the slice of Google's OAuth + Drive v3 surface the
 * sync code uses: appDataFolder listing, metadata, media download, resumable
 * upload, the revision chain, tokeninfo and revoke. Hooks let a test land a
 * competing writer at an exact point in a sync.
 */

export const TEST_CLIENT_ID = '355378593067-61bfn1c2ov40qkjvkj1m9aoaolavq0vg.apps.googleusercontent.com';
export const TEST_REDIRECT_URI = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/';
export const APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FILE_NAMES = new Set(['researchpdf-sync-v1.json']);

interface FakeRevision { id: string; bytes: Uint8Array }
interface FakeFile { id: string; createdTime: string; revisions: FakeRevision[] }
interface FakeAccount { id: string; email: string }

export interface FakeRequest { method: string; url: string }

export async function gunzipText(bytes: Uint8Array): Promise<string> {
  if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) return new TextDecoder().decode(bytes);
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export function createFakeGoogle() {
  const files = new Map<string, FakeFile>();
  const sessions = new Map<string, string | null>();
  const tokens = new Map<string, FakeAccount>();
  const revoked: string[] = [];
  const requests: FakeRequest[] = [];
  let counter = 0;
  let clock = Date.parse('2026-09-01T00:00:00.000Z');

  const state = {
    /** The account the next OAuth round trip signs in as; null = needs interaction. */
    session: { id: 'perm-main', email: 'main@example.test' } as FakeAccount | null,
    tokenAudience: TEST_CLIENT_ID,
    grantedScope: APPDATA_SCOPE,
    /** Runs after an upload session opens and before its bytes commit. */
    beforeUploadCommit: null as ((fileId: string | null) => void | Promise<void>) | null,
    /** Overrides the resumable session Location header. */
    sessionLocation: null as string | null,
    authFlows: [] as Array<{ interactive: boolean; url: URL }>,
  };

  const nextId = (prefix: string) => { counter += 1; return `${prefix}${counter}`; };

  function writeRevision(fileId: string | null, bytes: Uint8Array): FakeFile {
    let file = fileId ? files.get(fileId) : undefined;
    if (!file) {
      clock += 1_000;
      file = { id: fileId ?? nextId('file'), createdTime: new Date(clock).toISOString(), revisions: [] };
      files.set(file.id, file);
    }
    file.revisions.push({ id: nextId('rev'), bytes });
    return file;
  }

  const head = (file: FakeFile) => file.revisions[file.revisions.length - 1];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  const fileJson = (file: FakeFile) => ({ id: file.id, createdTime: file.createdTime, headRevisionId: head(file).id });

  async function handle(input: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    requests.push({ method, url: input });

    if (url.host === 'oauth2.googleapis.com') {
      const form = new URLSearchParams(String(init.body ?? ''));
      if (url.pathname === '/tokeninfo') {
        return tokens.has(form.get('access_token') ?? '')
          ? json({ aud: state.tokenAudience, scope: state.grantedScope, expires_in: '3599' })
          : json({ error: 'invalid_token' }, 400);
      }
      if (url.pathname === '/revoke') {
        const token = form.get('token') ?? '';
        revoked.push(token);
        tokens.delete(token);
        return json({});
      }
    }
    if (url.host !== 'www.googleapis.com') throw new Error(`unexpected host: ${url.host}`);

    const authorization = new Headers(init.headers).get('Authorization') ?? '';
    const account = tokens.get(authorization.replace(/^Bearer /u, ''));
    if (!account) return json({ error: { code: 401 } }, 401);

    const path = url.pathname;
    if (path === '/drive/v3/about') {
      return json({ user: { permissionId: account.id, emailAddress: account.email } });
    }
    if (path === '/drive/v3/files' && method === 'GET') {
      if (url.searchParams.get('spaces') !== 'appDataFolder') return json({ error: 'wrong space' }, 403);
      if (![...FILE_NAMES].some((name) => (url.searchParams.get('q') ?? '').includes(name))) return json({ files: [] });
      // Deliberately unsorted: the winner rule must not depend on server order.
      return json({ files: [...files.values()].reverse().map(fileJson) });
    }

    const upload = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/u.exec(path);
    if (upload) {
      const uploadId = url.searchParams.get('upload_id');
      if (uploadId && method === 'PUT') {
        if (!sessions.has(uploadId)) return json({ error: 'no session' }, 404);
        const target = sessions.get(uploadId) ?? null;
        sessions.delete(uploadId);
        await state.beforeUploadCommit?.(target);
        const bytes = new Uint8Array(init.body as Uint8Array);
        return json(fileJson(writeRevision(target, bytes)));
      }
      if (url.searchParams.get('uploadType') === 'resumable' && (method === 'POST' || method === 'PATCH')) {
        const fileId = upload[1] ?? null;
        if (fileId && !files.has(fileId)) return json({ error: 'not found' }, 404);
        if (!fileId) {
          const metadata = JSON.parse(String(init.body)) as { parents?: string[]; name?: string };
          if (metadata.parents?.[0] !== 'appDataFolder' || !FILE_NAMES.has(metadata.name ?? '')) {
            return json({ error: 'must target appDataFolder' }, 403);
          }
        }
        const id = nextId('upload');
        sessions.set(id, fileId);
        const location = state.sessionLocation
          ?? `https://www.googleapis.com${path}?uploadType=resumable&upload_id=${id}`;
        return new Response(null, { status: 200, headers: { Location: location } });
      }
    }

    const revision = /^\/drive\/v3\/files\/([^/]+)\/revisions(?:\/([^/]+))?$/u.exec(path);
    if (revision) {
      const file = files.get(revision[1]);
      if (!file) return json({ error: 'not found' }, 404);
      if (!revision[2]) return json({ revisions: file.revisions.map((entry) => ({ id: entry.id })) });
      const found = file.revisions.find((entry) => entry.id === revision[2]);
      return found ? new Response(found.bytes as Uint8Array<ArrayBuffer>) : json({ error: 'not found' }, 404);
    }

    const single = /^\/drive\/v3\/files\/([^/]+)$/u.exec(path);
    if (single) {
      const file = files.get(single[1]);
      if (!file) return json({ error: 'not found' }, 404);
      if (method === 'DELETE') { files.delete(file.id); return new Response(null, { status: 204 }); }
      if (url.searchParams.get('alt') === 'media') return new Response(head(file).bytes as Uint8Array<ArrayBuffer>);
      return json({ headRevisionId: head(file).id, trashed: false });
    }
    throw new Error(`unhandled fake Drive request: ${method} ${input}`);
  }

  const sessionStore = new Map<string, unknown>();
  const localStore = new Map<string, unknown>();
  const alarms = new Map<string, { delayInMinutes?: number; periodInMinutes?: number }>();
  const chromeMock = {
    alarms: {
      create: (name: string, info: { delayInMinutes?: number; periodInMinutes?: number }) => { alarms.set(name, info); },
      get: async (name: string) => alarms.get(name) ?? undefined,
      created: alarms,
    },
    runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' },
    identity: {
      getRedirectURL: () => TEST_REDIRECT_URI,
      launchWebAuthFlow: vi.fn(async (details: { url: string; interactive?: boolean }) => {
        const url = new URL(details.url);
        const interactive = details.interactive === true;
        state.authFlows.push({ interactive, url });
        const redirect = url.searchParams.get('redirect_uri') ?? '';
        const flowState = url.searchParams.get('state') ?? '';
        if (!state.session) {
          if (interactive) throw new Error('The user did not approve access.');
          return `${redirect}#error=interaction_required&state=${flowState}`;
        }
        const token = nextId('token-');
        tokens.set(token, state.session);
        const fragment = new URLSearchParams({
          access_token: token, token_type: 'Bearer', expires_in: '3599',
          scope: state.grantedScope, state: flowState,
        });
        return `${redirect}#${fragment.toString()}`;
      }),
    },
    storage: {
      local: {
        get: async (key: string) => (localStore.has(key) ? { [key]: localStore.get(key) } : {}),
        set: async (items: Record<string, unknown>) => {
          Object.entries(items).forEach(([key, value]) => localStore.set(key, value));
        },
      },
      session: {
        get: async (key: string) => (sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {}),
        set: async (items: Record<string, unknown>) => {
          Object.entries(items).forEach(([key, value]) => sessionStore.set(key, value));
        },
        remove: async (key: string) => { sessionStore.delete(key); },
      },
    },
  };

  return {
    state,
    requests,
    revoked,
    tokens,
    files,
    chrome: chromeMock,
    fetch: vi.fn((input: RequestInfo | URL, init?: RequestInit) => handle(String(input), init)),
    /** Another device's write: a new head revision holding this plain JSON body. */
    remoteWrite(body: unknown, fileId: string | null = null): FakeFile {
      const target = fileId ?? [...files.keys()][0] ?? null;
      return writeRevision(target, new TextEncoder().encode(JSON.stringify(body)));
    },
    /** A brand-new file, as created by another profile racing this one. */
    remoteCreate(body: unknown): FakeFile {
      return writeRevision(null, new TextEncoder().encode(JSON.stringify(body)));
    },
    async headBody<T = { words: Array<{ wordId: string }> }>(fileId?: string): Promise<T> {
      const file = files.get(fileId ?? [...files.keys()][0]);
      if (!file) throw new Error('no fake Drive file');
      return JSON.parse(await gunzipText(head(file).bytes)) as T;
    },
    headBytes(): Uint8Array {
      const file = files.get([...files.keys()][0]);
      if (!file) throw new Error('no fake Drive file');
      return head(file).bytes;
    },
    clearSessionCache: () => sessionStore.clear(),
    localStore,
    dataRequests: () => requests.filter((request) => request.url.includes('alt=media') || request.url.includes('/upload/')),
  };
}

export type FakeGoogle = ReturnType<typeof createFakeGoogle>;
