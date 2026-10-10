import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { driveFileName, driveFilesStatus, fetchDriveCopy, renameDriveCopy, storeDocInDrive } from '../src/background/pdfDriveFiles';
import { PDF_SYNC_CONFIG_SETTING_KEY } from '../src/background/pdfSyncService';
import { clearPdfFileCache, readCachedPdf, storeCachedPdf } from '../src/db/pdfFileCache';
import { setSetting } from '../src/db/settingsRepository';
import { driveAutoWants, parseDriveAutoRules } from '../src/shared/driveAuto';
import { PDF_LIBRARY_STORAGE_KEY, noUserFields, type PdfLibraryEntry } from '../src/shared/pdfLibrary';
import { clearAllStores } from './helpers';

const LOCAL_URL = 'file:///home/me/papers/alpha.pdf';
const PDF = new TextEncoder().encode('%PDF-1.7 alpha bytes');

interface FakeFile { id: string; name: string; mimeType: string; parents: string[]; appProperties: Record<string, string>; bytes: Uint8Array; trashed: boolean; createdTime: string }

/** Drive as `drive.file` sees it: only what this app made. */
function fakeDrive() {
  const files = new Map<string, FakeFile>();
  const sessions = new Map<string, Record<string, unknown>>();
  let next = 1;
  const id = () => `file${String(next++).padStart(8, '0')}`;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const requests: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    requests.push(`${method} ${url.pathname}`);
    if (new Headers(init.headers).get('Authorization') !== 'Bearer tok') return json({}, 401);
    const one = /^\/drive\/v3\/files\/([^/]+)$/u.exec(url.pathname);
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const sha = /value='([0-9a-f]+)'/u.exec(q)?.[1];
      const list = [...files.values()].filter((f) => !f.trashed && (sha ? f.appProperties.rpdfSha256 === sha : q.includes('folder') && f.mimeType.includes('folder') && f.name === 'ResearchPDF'));
      return json({ files: list.map((f) => ({ id: f.id, createdTime: f.createdTime })) });
    }
    if (url.pathname === '/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(String(init.body)) as FakeFile;
      const file = { ...meta, id: id(), appProperties: {}, bytes: new Uint8Array(), trashed: false, createdTime: new Date().toISOString() };
      files.set(file.id, file);
      return json({ id: file.id });
    }
    if (one && method === 'GET') {
      const file = files.get(one[1]);
      if (!file) return json({}, 404);
      if (url.searchParams.get('alt') === 'media') return new Response(file.bytes as Uint8Array<ArrayBuffer>);
      return json({ id: file.id, trashed: file.trashed });
    }
    if (one && method === 'PATCH') {
      const file = files.get(one[1]);
      if (!file) return json({}, 404);
      Object.assign(file, JSON.parse(String(init.body)));
      return json({ id: file.id });
    }
    if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const uploadId = `up${next++}`;
      sessions.set(uploadId, JSON.parse(String(init.body)));
      return json({}, 200, { Location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${uploadId}` });
    }
    if (url.pathname === '/upload/drive/v3/files' && method === 'PUT') {
      const meta = sessions.get(url.searchParams.get('upload_id') ?? '') as unknown as FakeFile;
      const file = { ...meta, id: id(), bytes: new Uint8Array(init.body as Uint8Array), trashed: false, createdTime: new Date().toISOString() };
      files.set(file.id, file);
      return json({ id: file.id });
    }
    return json({ error: 'unexpected' }, 400);
  });
  return { files, fetch, requests };
}

function chromeMock() {
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  const area = (store: Map<string, unknown>) => ({
    get: async (key: string | string[]) => Object.fromEntries((Array.isArray(key) ? key : [key]).filter((k) => store.has(k)).map((k) => [k, store.get(k)])),
    set: async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) store.set(k, v); },
    remove: async (key: string) => { store.delete(key); },
  });
  return { local, chrome: { storage: { local: area(local), session: area(session) } }, session };
}

function entry(overrides: Partial<PdfLibraryEntry> = {}): PdfLibraryEntry {
  return {
    docId: 'doc-alpha', urls: [LOCAL_URL], fileName: 'alpha.pdf', docTitle: null, title: null, venue: null, year: null,
    numPages: 3, openedAt: Date.now(), pinned: false, pinChangedAt: 0, paperKind: null, userKind: null, userKindAt: 0, ...noUserFields(), ...overrides,
  };
}

describe('PDF files in the user\'s Drive folder', () => {
  let drive: ReturnType<typeof fakeDrive>;
  let browser: ReturnType<typeof chromeMock>;

  beforeEach(async () => {
    await clearAllStores();
    drive = fakeDrive();
    browser = chromeMock();
    vi.stubGlobal('chrome', browser.chrome);
    vi.stubGlobal('fetch', drive.fetch);
    // A connected sync account, with a token that may reach the PDF files.
    browser.session.set('vocabTGoogleAccessToken', { accessToken: 'tok', expiresAt: Date.now() + 3_600_000, accountId: 'acc', files: true });
    await setSetting(PDF_SYNC_CONFIG_SETTING_KEY, { googleAccountId: 'acc', googleAccountEmail: 'me@x.org', enabled: true });
  });

  afterEach(() => vi.unstubAllGlobals());

  async function library(rows: PdfLibraryEntry[]): Promise<void> {
    browser.local.set(PDF_LIBRARY_STORAGE_KEY, Object.fromEntries(rows.map((r) => [r.docId, r])));
  }
  const stored = () => (browser.local.get(PDF_LIBRARY_STORAGE_KEY) as Record<string, PdfLibraryEntry>);

  it('stays off until the user turns it on', async () => {
    await library([entry()]);
    expect(await storeDocInDrive('doc-alpha')).toEqual({ success: false, errorCode: 'files-off' });
    expect((await driveFilesStatus()).enabled).toBe(false);
  });

  it('keeps a local file in the ResearchPDF folder once, named as the library names it, and opens it on another device', async () => {
    await setSetting('researchPdfDriveFiles', { enabled: true, accountId: 'acc', folderId: null });
    await library([entry({ userTitle: 'Alpha: my notes' }), entry({ docId: 'doc-twin', urls: [], fileName: 'same-bytes.pdf' })]);
    await storeCachedPdf({ url: LOCAL_URL, docId: 'doc-alpha', bytes: PDF, sha256: 'a'.repeat(64), etag: null, lastModified: null });
    await storeCachedPdf({ url: null, docId: 'doc-twin', bytes: PDF, sha256: 'a'.repeat(64), etag: null, lastModified: null });

    const first = await storeDocInDrive('doc-alpha');
    expect(first.success).toBe(true);
    const folders = [...drive.files.values()].filter((f) => f.mimeType.includes('folder'));
    const pdfs = [...drive.files.values()].filter((f) => f.mimeType === 'application/pdf');
    expect(folders.map((f) => f.name)).toEqual(['ResearchPDF']);
    expect(pdfs).toHaveLength(1);
    expect(pdfs[0]).toMatchObject({ name: 'Alpha my notes.pdf', parents: [folders[0].id] });
    expect(pdfs[0].appProperties.rpdfSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(stored()['doc-alpha'].driveFileId).toBe(pdfs[0].id);
    // The same bytes again: found, not uploaded twice.
    expect(await storeDocInDrive('doc-twin')).toEqual({ success: true, fileId: pdfs[0].id });
    expect([...drive.files.values()].filter((f) => f.mimeType === 'application/pdf')).toHaveLength(1);
    expect((await driveFilesStatus())).toMatchObject({ enabled: true, stored: 2, folderUrl: `https://drive.google.com/drive/folders/${folders[0].id}` });

    // Renamed: the Drive copy follows.
    browser.local.set(PDF_LIBRARY_STORAGE_KEY, { ...stored(), 'doc-alpha': { ...stored()['doc-alpha'], userTitle: 'Renamed' } });
    await renameDriveCopy('doc-alpha');
    expect(drive.files.get(pdfs[0].id)?.name).toBe('Renamed.pdf');

    // Another computer: no file at that path, nothing cached — the Drive copy comes down.
    await clearPdfFileCache();
    expect(await fetchDriveCopy({ url: `${LOCAL_URL}#page=2` })).toEqual({ success: true, fileId: pdfs[0].id });
    expect((await readCachedPdf(LOCAL_URL))?.bytes).toEqual(PDF);
  });

  it('says so when this device has no copy to upload', async () => {
    await setSetting('researchPdfDriveFiles', { enabled: true, accountId: 'acc', folderId: null });
    await library([entry({ urls: [] })]);
    expect(await storeDocInDrive('doc-alpha')).toEqual({ success: false, errorCode: 'no-local-copy' });
  });

  it('names a file safely', () => {
    expect(driveFileName(entry({ userTitle: 'a/b: c?' }))).toBe('a b c.pdf');
    expect(driveFileName(entry({ userTitle: null, title: 'Paper Title' }))).toBe('Paper Title.pdf');
    expect(driveFileName(entry())).toBe('alpha.pdf');
  });
});

describe('which projects keep their files in Drive', () => {
  it('reads the rules and answers per kind of file', () => {
    const rules = parseDriveAutoRules({ default: { local: true, web: false }, p1: { local: false, web: true }, junk: 'x', off: { local: false, web: false } });
    expect(rules).toEqual({ default: { local: true, web: false }, p1: { local: false, web: true } });
    expect(driveAutoWants(rules, ['default'], true)).toBe(true);
    expect(driveAutoWants(rules, ['default'], false)).toBe(false);
    expect(driveAutoWants(rules, ['p1', 'p2'], false)).toBe(true);
    expect(driveAutoWants(rules, ['p2'], true)).toBe(false);
  });
});
