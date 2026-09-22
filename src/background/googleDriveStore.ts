import { GOOGLE_DRIVE_SYNC_FILE_NAME } from '../shared/constants';
import { CloudSyncError } from './cloudSyncError';

/**
 * A byte store over ONE file in the signed-in user's Drive `appDataFolder`.
 *
 * The folder is private to this OAuth client: it is invisible in the Drive UI,
 * unreachable by other apps, and the `drive.appdata` scope gives the app no
 * view of any other file. This module knows nothing about backups or merging;
 * cloudSyncService owns validation and the 3-way merge.
 *
 * Drive v3 has no conditional write (`If-Match`), so version safety is
 * emulated with `headRevisionId`:
 *   1. an update first re-reads the head revision and refuses (as a `412`
 *      equivalent) when it is not the revision the caller merged against;
 *   2. after the upload it reads the revision chain. If another writer slipped
 *      a revision in between (the narrow check-to-write window), that lost
 *      revision is reported as `clobbered` so the caller can fold it back in
 *      instead of letting a lost update masquerade as a deletion. A linear
 *      revision chain cannot say what the lost writer merged against, so the
 *      caller folds additively: a fold may resurrect a row, never drop one;
 *   3. file creation is raced with a deterministic winner (oldest, then id):
 *      a loser deletes its own file and reports a precondition failure.
 */

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const METADATA_TIMEOUT_MS = 20_000;
const TRANSFER_TIMEOUT_MS = 120_000;
const MAX_CONSISTENT_READ_ATTEMPTS = 3;
const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;
const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/u;
const FILE_FIELDS = 'id,createdTime,headRevisionId';

/** `forceRefresh` is set after a 401 so a revoked/expired token is replaced once. */
export type DriveTokenProvider = (forceRefresh: boolean) => Promise<string>;

export interface DriveAccount {
  id: string;
  email: string;
}

export interface DriveClobber {
  fileId: string;
  /** The revision another writer uploaded that our write replaced unseen. */
  lostRevisionId: string;
}

export type DriveReadResult =
  | { kind: 'missing' }
  | { kind: 'file'; text: string; etag: string };

export type DriveWriteResult =
  | { kind: 'ok'; etag: string }
  | { kind: 'precondition-failed' }
  | { kind: 'clobbered'; etag: string; clobber: DriveClobber };

interface DriveFileRef {
  id: string;
  createdTime: string;
  headRevisionId: string;
}

export function driveEtag(fileId: string, revisionId: string): string {
  return `${fileId}:${revisionId}`;
}

export function parseDriveEtag(etag: string | null): { fileId: string; revisionId: string } | null {
  if (!etag) return null;
  const index = etag.indexOf(':');
  if (index <= 0) return null;
  const fileId = etag.slice(0, index);
  const revisionId = etag.slice(index + 1);
  return DRIVE_ID_PATTERN.test(fileId) && DRIVE_ID_PATTERN.test(revisionId) ? { fileId, revisionId } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fileRefFromUnknown(value: unknown): DriveFileRef | null {
  if (!isRecord(value)) return null;
  const { id, createdTime, headRevisionId } = value;
  // IDs are interpolated into request paths; never trust their shape.
  if (typeof id !== 'string' || !DRIVE_ID_PATTERN.test(id)
    || typeof headRevisionId !== 'string' || !DRIVE_ID_PATTERN.test(headRevisionId)) return null;
  return { id, headRevisionId, createdTime: typeof createdTime === 'string' ? createdTime : '' };
}

async function gzip(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decodeBody(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const gzipped = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!gzipped) return new TextDecoder().decode(bytes);
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      // The file is ours, but never let a corrupt object exhaust memory.
      if (total > MAX_DECOMPRESSED_BYTES) {
        await reader.cancel();
        throw new CloudSyncError('Google Drive의 동기화 파일이 너무 큽니다.');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof CloudSyncError) throw error;
    throw new CloudSyncError('Google Drive의 동기화 파일을 읽지 못했습니다.');
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => { merged.set(chunk, offset); offset += chunk.byteLength; });
  return new TextDecoder().decode(merged);
}

async function driveErrorReason(response: Response): Promise<string> {
  try {
    const body: unknown = await response.clone().json();
    if (!isRecord(body) || !isRecord(body.error) || !Array.isArray(body.error.errors)) return '';
    const first: unknown = body.error.errors[0];
    return isRecord(first) && typeof first.reason === 'string' ? first.reason : '';
  } catch {
    return '';
  }
}

async function driveError(response: Response): Promise<CloudSyncError> {
  if (response.status === 401) {
    return new CloudSyncError('Google 로그인이 만료되었습니다. 설정에서 Google 계정을 다시 연결하세요.');
  }
  if (response.status === 403) {
    const reason = await driveErrorReason(response);
    if (reason === 'storageQuotaExceeded') return new CloudSyncError('Google Drive 저장 공간이 부족합니다.');
    if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
      return new CloudSyncError('Google Drive 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.');
    }
    return new CloudSyncError('Google Drive 접근이 거부되었습니다.');
  }
  if (response.status === 429) return new CloudSyncError('Google Drive 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.');
  return new CloudSyncError(`Google Drive 요청이 실패했습니다 (HTTP ${response.status}).`);
}

export function createGoogleDriveStore(getToken: DriveTokenProvider, fileName: string = GOOGLE_DRIVE_SYNC_FILE_NAME) {
  async function request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    // Every request is pinned to Google's API host, including the resumable
    // session URI that comes back from the server.
    if (!url.startsWith(`${DRIVE_API}/`) && !url.startsWith(`${DRIVE_UPLOAD}/`)) {
      throw new CloudSyncError('Google Drive 요청 주소가 올바르지 않습니다.');
    }
    for (let attempt = 0; ; attempt += 1) {
      const token = await getToken(attempt > 0);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          ...init,
          signal: controller.signal,
          credentials: 'omit',
          cache: 'no-store',
          headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new CloudSyncError('동기화 요청 시간이 초과되었습니다.');
        }
        throw new CloudSyncError('Google Drive에 연결하지 못했습니다.');
      } finally {
        clearTimeout(timeout);
      }
      if (response.status === 401 && attempt === 0) continue;
      return response;
    }
  }

  async function json(url: string, init: RequestInit = {}): Promise<unknown> {
    const response = await request(url, init, METADATA_TIMEOUT_MS);
    if (!response.ok) throw await driveError(response);
    try { return await response.json(); } catch {
      throw new CloudSyncError('Google Drive 응답을 해석하지 못했습니다.');
    }
  }

  /** Every sync file, deterministic winner first (oldest, then smallest id). */
  async function listFiles(): Promise<DriveFileRef[]> {
    const url = new URL(`${DRIVE_API}/files`);
    url.searchParams.set('spaces', 'appDataFolder');
    url.searchParams.set('q', `name = '${fileName}' and trashed = false`);
    url.searchParams.set('fields', `files(${FILE_FIELDS})`);
    url.searchParams.set('pageSize', '100');
    const body = await json(url.toString());
    const raw = isRecord(body) && Array.isArray(body.files) ? body.files : [];
    return raw
      .map(fileRefFromUnknown)
      .filter((file): file is DriveFileRef => file !== null)
      .sort((left, right) => left.createdTime.localeCompare(right.createdTime) || left.id.localeCompare(right.id));
  }

  async function headRevision(fileId: string): Promise<string | null> {
    const response = await request(
      `${DRIVE_API}/files/${fileId}?fields=headRevisionId,trashed`, {}, METADATA_TIMEOUT_MS,
    );
    if (response.status === 404) return null;
    if (!response.ok) throw await driveError(response);
    const body: unknown = await response.json().catch(() => null);
    if (!isRecord(body) || body.trashed === true) return null;
    return typeof body.headRevisionId === 'string' && DRIVE_ID_PATTERN.test(body.headRevisionId)
      ? body.headRevisionId : null;
  }

  async function download(url: string): Promise<string | null> {
    const response = await request(url, {}, TRANSFER_TIMEOUT_MS);
    if (response.status === 404) return null;
    if (!response.ok) throw await driveError(response);
    return decodeBody(new Uint8Array(await response.arrayBuffer()));
  }

  async function upload(fileId: string | null, text: string): Promise<DriveFileRef> {
    const bytes = await gzip(text);
    const start = await request(
      `${DRIVE_UPLOAD}/files${fileId ? `/${fileId}` : ''}?uploadType=resumable&fields=${FILE_FIELDS}`,
      {
        method: fileId ? 'PATCH' : 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': 'application/gzip',
          'X-Upload-Content-Length': String(bytes.byteLength),
        },
        body: JSON.stringify(fileId ? {} : {
          name: fileName,
          parents: ['appDataFolder'],
          mimeType: 'application/gzip',
        }),
      },
      METADATA_TIMEOUT_MS,
    );
    if (!start.ok) throw await driveError(start);
    const uploadId = start.headers.get('X-GUploader-UploadID');
    const session = start.headers.get('Location')
      ?? (uploadId
        ? `${DRIVE_UPLOAD}/files${fileId ? `/${fileId}` : ''}?uploadType=resumable&fields=${FILE_FIELDS}&upload_id=${encodeURIComponent(uploadId)}`
        : null);
    if (!session) throw new CloudSyncError('Google Drive 업로드 세션을 열지 못했습니다.');
    const finish = await request(
      session,
      { method: 'PUT', headers: { 'Content-Type': 'application/gzip' }, body: bytes },
      TRANSFER_TIMEOUT_MS,
    );
    if (!finish.ok) throw await driveError(finish);
    const written = fileRefFromUnknown(await finish.json().catch(() => null));
    if (!written) throw new CloudSyncError('Google Drive 업로드 결과를 확인하지 못했습니다.');
    return written;
  }

  async function revisionIds(fileId: string): Promise<string[]> {
    const ids: string[] = [];
    let pageToken = '';
    for (let page = 0; page < 10; page += 1) {
      const url = new URL(`${DRIVE_API}/files/${fileId}/revisions`);
      url.searchParams.set('fields', 'nextPageToken,revisions(id)');
      url.searchParams.set('pageSize', '1000');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const body = await json(url.toString());
      if (!isRecord(body)) break;
      (Array.isArray(body.revisions) ? body.revisions : []).forEach((revision: unknown) => {
        if (isRecord(revision) && typeof revision.id === 'string') ids.push(revision.id);
      });
      if (typeof body.nextPageToken !== 'string' || !body.nextPageToken) break;
      pageToken = body.nextPageToken;
    }
    return ids;
  }

  return {
    async account(): Promise<DriveAccount> {
      const body = await json(`${DRIVE_API}/about?fields=user(permissionId,emailAddress)`);
      const user = isRecord(body) && isRecord(body.user) ? body.user : {};
      if (typeof user.permissionId !== 'string' || !user.permissionId) {
        throw new CloudSyncError('Google 계정 정보를 확인하지 못했습니다.');
      }
      return {
        id: user.permissionId.slice(0, 128),
        email: typeof user.emailAddress === 'string' ? user.emailAddress.slice(0, 320) : '',
      };
    },

    /** Cheap metadata-only view of the current version; null when no file exists. */
    async probe(): Promise<string | null> {
      const [winner] = await listFiles();
      return winner ? driveEtag(winner.id, winner.headRevisionId) : null;
    },

    async read(): Promise<DriveReadResult> {
      for (let attempt = 0; attempt < MAX_CONSISTENT_READ_ATTEMPTS; attempt += 1) {
        const [winner] = await listFiles();
        if (!winner) return { kind: 'missing' };
        const text = await download(`${DRIVE_API}/files/${winner.id}?alt=media`);
        if (text === null) continue;
        // The body is only attributed to a revision when the head did not move
        // while it was downloading; otherwise the ETag would name the wrong body.
        if (await headRevision(winner.id) === winner.headRevisionId) {
          return { kind: 'file', text, etag: driveEtag(winner.id, winner.headRevisionId) };
        }
      }
      throw new CloudSyncError('Google Drive 파일이 계속 변경되어 읽지 못했습니다. 잠시 후 다시 시도하세요.');
    },

    /** One exact historical body, for clobber repair. null when Drive pruned it. */
    async readRevision(fileId: string, revisionId: string): Promise<string | null> {
      if (!DRIVE_ID_PATTERN.test(fileId) || !DRIVE_ID_PATTERN.test(revisionId)) return null;
      return download(`${DRIVE_API}/files/${fileId}/revisions/${revisionId}?alt=media`);
    },

    async create(text: string): Promise<DriveWriteResult> {
      const created = await upload(null, text);
      const [winner] = await listFiles();
      if (winner && winner.id !== created.id) {
        // Another profile created the file at the same moment and won. Our copy
        // holds nothing the local database does not, so it is safe to drop.
        await request(`${DRIVE_API}/files/${created.id}`, { method: 'DELETE' }, METADATA_TIMEOUT_MS)
          .catch(() => undefined);
        return { kind: 'precondition-failed' };
      }
      return { kind: 'ok', etag: driveEtag(created.id, created.headRevisionId) };
    },

    async update(text: string, etag: string): Promise<DriveWriteResult> {
      const expected = parseDriveEtag(etag);
      if (!expected) return { kind: 'precondition-failed' };
      if (await headRevision(expected.fileId) !== expected.revisionId) return { kind: 'precondition-failed' };
      const written = await upload(expected.fileId, text);
      const newEtag = driveEtag(written.id, written.headRevisionId);
      if (written.headRevisionId === expected.revisionId) return { kind: 'ok', etag: newEtag };

      const chain = await revisionIds(expected.fileId);
      const before = chain.indexOf(expected.revisionId);
      const after = chain.lastIndexOf(written.headRevisionId);
      // Drive prunes old revisions; an unverifiable chain is not evidence of loss.
      if (before < 0 || after < 0 || after <= before + 1) return { kind: 'ok', etag: newEtag };
      const lostRevisionId = chain[after - 1];
      if (!DRIVE_ID_PATTERN.test(lostRevisionId)) return { kind: 'ok', etag: newEtag };
      return {
        kind: 'clobbered',
        etag: newEtag,
        clobber: { fileId: expected.fileId, lostRevisionId },
      };
    },
  };
}

export type GoogleDriveStore = ReturnType<typeof createGoogleDriveStore>;
