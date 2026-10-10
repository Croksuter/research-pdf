// ─── PDF files in the user's own Drive folder ───
//
// Drawings, positions, the library and settings travel in the sync document
// (appDataFolder, ./pdfSyncService.ts). The PDF files themselves, when the
// user chooses, go to a visible folder of their own Drive, `ResearchPDF`, so
// a paper opened from disk on one computer opens on another without the
// original file. The scope is `drive.file` — this app sees the folder and
// the files it created, nothing else — asked for only when the user turns
// this on (settings), on top of the connected sync account.
//
// One file per content (its SHA-256 in `appProperties`, so a second upload of
// the same bytes finds the first); named as the document is named in the
// library (renaming one renames its Drive copy). The library row keeps the
// Drive file id, so every device can open it (`fetchDriveCopy`) — and the
// device that uploads reads the bytes from this device's file cache
// (db/pdfFileCache.ts), where every opened PDF is kept.
//
// What goes up: what the user asks for (document info, home), and what a
// project's rule says — local files, web PDFs, each on or off per project
// (`rpdfDriveAuto`, a synced setting) — when a document of that project is
// opened.

import { readCachedDoc, readCachedPdf, storeCachedPdf } from '../db/pdfFileCache';
import { getSetting, setSetting } from '../db/settingsRepository';
import { debugError, debugLog } from '../shared/debugLog';
import { DRIVE_AUTO_STORAGE_KEY, driveAutoWants, parseDriveAutoRules } from '../shared/driveAuto';
import { isRecord } from '../shared/guards';
import { pdfDisplayName } from '../shared/localPdf';
import { libraryEntryName, librarySourceUrl, type PdfLibraryEntry } from '../shared/pdfLibrary';
import { DEFAULT_PROJECT_ID, projectsOfDoc } from '../shared/pdfProjects';
import { type SyncErrorCode } from '../shared/syncErrors';
import { CloudSyncError } from './cloudSyncError';
import { accessTokenForAccount, grantDriveFiles, type GoogleAccountRef } from './googleDriveAccount';
import { DRIVE_API, DRIVE_ID_PATTERN, DRIVE_UPLOAD, TRANSFER_TIMEOUT_MS, createDriveClient, driveError } from './googleDriveStore';
import { getPdfSyncConfig } from './pdfSyncService';
import { readPdfLibrary, updatePdfLibrary } from './pdfLibraryStore';
import { readPdfProjects } from './pdfProjectStore';

export const DRIVE_FOLDER_NAME = 'ResearchPDF';
export const PDF_DRIVE_FILES_SETTING_KEY = 'researchPdfDriveFiles';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHA_PROPERTY = 'rpdfSha256';
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

interface DriveFilesConfig {
  enabled: boolean;
  /** The account it was granted for (the sync account then). */
  accountId: string;
  folderId: string | null;
}

async function readConfig(): Promise<DriveFilesConfig> {
  const raw = await getSetting<unknown>(PDF_DRIVE_FILES_SETTING_KEY, null);
  if (!isRecord(raw)) return { enabled: false, accountId: '', folderId: null };
  return {
    enabled: raw.enabled === true,
    accountId: typeof raw.accountId === 'string' ? raw.accountId : '',
    folderId: typeof raw.folderId === 'string' && DRIVE_ID_PATTERN.test(raw.folderId) ? raw.folderId : null,
  };
}

export interface DriveFilesStatus {
  /** Sync is connected (PDF files ride on its account). */
  available: boolean;
  enabled: boolean;
  folderUrl: string | null;
  stored: number;
}

/** The sync account, when PDF files are on for it. */
async function account(): Promise<{ account: GoogleAccountRef; config: DriveFilesConfig }> {
  const [sync, config] = await Promise.all([getPdfSyncConfig(), readConfig()]);
  if (!sync.googleAccountId) throw new CloudSyncError('connect-first');
  if (!config.enabled || config.accountId !== sync.googleAccountId) throw new CloudSyncError('files-off');
  return { account: { id: sync.googleAccountId, email: sync.googleAccountEmail }, config };
}

export async function driveFilesStatus(): Promise<DriveFilesStatus> {
  const [sync, config, library] = await Promise.all([getPdfSyncConfig(), readConfig(), readPdfLibrary()]);
  const enabled = config.enabled && config.accountId === sync.googleAccountId && !!sync.googleAccountId;
  return {
    available: !!sync.googleAccountId,
    enabled,
    folderUrl: enabled && config.folderId ? `https://drive.google.com/drive/folders/${config.folderId}` : null,
    stored: Object.values(library).filter((e) => e.driveFileId).length,
  };
}

/** Turns PDF files on (asking Google for `drive.file` for the sync account) or off (the files stay). */
export async function setDriveFilesEnabled(enabled: boolean): Promise<DriveFilesStatus> {
  const sync = await getPdfSyncConfig();
  if (!enabled) {
    const config = await readConfig();
    await setSetting(PDF_DRIVE_FILES_SETTING_KEY, { ...config, enabled: false });
    return driveFilesStatus();
  }
  if (!sync.googleAccountId) throw new CloudSyncError('connect-first');
  const ref = { id: sync.googleAccountId, email: sync.googleAccountEmail };
  await grantDriveFiles(ref);
  const previous = await readConfig();
  const config: DriveFilesConfig = { enabled: true, accountId: ref.id, folderId: previous.accountId === ref.id ? previous.folderId : null };
  await setSetting(PDF_DRIVE_FILES_SETTING_KEY, config);
  await folder(ref, config); // made now, so the folder link works at once
  return driveFilesStatus();
}

function client(ref: GoogleAccountRef) {
  return createDriveClient((forceRefresh) => accessTokenForAccount(ref, forceRefresh, true));
}

/** The app's folder in My Drive: found (the oldest, if several), else made. */
async function folder(ref: GoogleAccountRef, config: DriveFilesConfig): Promise<string> {
  const drive = client(ref);
  if (config.folderId) {
    const response = await drive.request(`${DRIVE_API}/files/${config.folderId}?fields=id,trashed`, {});
    if (response.ok) {
      const body: unknown = await response.json().catch(() => null);
      if (isRecord(body) && body.trashed !== true) return config.folderId;
    } else if (response.status !== 404) throw await driveError(response);
  }
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set('q', `mimeType = '${FOLDER_MIME}' and name = '${DRIVE_FOLDER_NAME}' and trashed = false and 'root' in parents`);
  url.searchParams.set('fields', 'files(id,createdTime)');
  url.searchParams.set('orderBy', 'createdTime');
  url.searchParams.set('spaces', 'drive');
  const found = await drive.json(url.toString());
  const existing = isRecord(found) && Array.isArray(found.files) ? found.files.find((f: unknown) => isRecord(f) && typeof f.id === 'string' && DRIVE_ID_PATTERN.test(f.id)) as { id: string } | undefined : undefined;
  let id = existing?.id ?? null;
  if (!id) {
    const made = await drive.json(`${DRIVE_API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType: FOLDER_MIME, parents: ['root'] }),
    });
    id = isRecord(made) && typeof made.id === 'string' && DRIVE_ID_PATTERN.test(made.id) ? made.id : null;
    if (!id) throw new CloudSyncError('drive-bad-response');
  }
  await setSetting(PDF_DRIVE_FILES_SETTING_KEY, { ...config, folderId: id });
  return id;
}

/** The name a document's Drive copy gets: its library name, as a file name. */
export function driveFileName(entry: PdfLibraryEntry): string {
  const base = libraryEntryName(entry, pdfDisplayName).replace(/[\\/:*?"<>|\u0000-\u001f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 180) || 'document';
  return /\.pdf$/iu.test(base) ? base : `${base}.pdf`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** This device's bytes of the document: its kept copy, else a kept copy of one of its URLs, else a web URL fetched. */
async function bytesOf(entry: PdfLibraryEntry): Promise<Uint8Array | null> {
  const kept = await readCachedDoc(entry.docId).catch(() => null);
  if (kept) return kept.bytes;
  for (const url of entry.urls) {
    const hit = await readCachedPdf(url).catch(() => null);
    if (hit) return hit.bytes;
  }
  for (const url of entry.urls.filter((u) => /^https?:/u.test(u))) {
    try {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) continue;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 4 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-') return bytes;
    } catch {
      /* the next one */
    }
  }
  return null;
}

/** The app's file holding these bytes, if one exists. */
async function findBySha(drive: ReturnType<typeof client>, sha256: string): Promise<string | null> {
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set('q', `appProperties has { key='${SHA_PROPERTY}' and value='${sha256}' } and trashed = false`);
  url.searchParams.set('fields', 'files(id)');
  url.searchParams.set('spaces', 'drive');
  const body = await drive.json(url.toString());
  const file = isRecord(body) && Array.isArray(body.files) ? body.files[0] : null;
  return isRecord(file) && typeof file.id === 'string' && DRIVE_ID_PATTERN.test(file.id) ? file.id : null;
}

async function upload(drive: ReturnType<typeof client>, folderId: string, bytes: Uint8Array, name: string, sha256: string, docId: string): Promise<string> {
  const start = await drive.request(`${DRIVE_UPLOAD}/files?uploadType=resumable&fields=id`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'application/pdf',
      'X-Upload-Content-Length': String(bytes.byteLength),
    },
    body: JSON.stringify({ name, parents: [folderId], mimeType: 'application/pdf', appProperties: { [SHA_PROPERTY]: sha256, rpdfDocId: docId.slice(0, 100) } }),
  });
  if (!start.ok) throw await driveError(start);
  const uploadId = start.headers.get('X-GUploader-UploadID');
  const session = start.headers.get('Location')
    ?? (uploadId ? `${DRIVE_UPLOAD}/files?uploadType=resumable&fields=id&upload_id=${encodeURIComponent(uploadId)}` : null);
  if (!session) throw new CloudSyncError('drive-upload-session');
  const finish = await drive.request(session, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: bytes as Uint8Array<ArrayBuffer> }, TRANSFER_TIMEOUT_MS);
  if (!finish.ok) throw await driveError(finish);
  const body: unknown = await finish.json().catch(() => null);
  if (!isRecord(body) || typeof body.id !== 'string' || !DRIVE_ID_PATTERN.test(body.id)) throw new CloudSyncError('drive-upload-unverified');
  return body.id;
}

/** Whether the Drive copy is still there (not trashed or deleted by the user). */
async function exists(drive: ReturnType<typeof client>, fileId: string): Promise<boolean> {
  const response = await drive.request(`${DRIVE_API}/files/${fileId}?fields=id,trashed`, {});
  if (response.status === 404) return false;
  if (!response.ok) throw await driveError(response);
  const body: unknown = await response.json().catch(() => null);
  return isRecord(body) && body.trashed !== true;
}

export type DriveFileResult = { success: true; fileId: string } | { success: false; errorCode: SyncErrorCode };

const failure = (error: unknown): { success: false; errorCode: SyncErrorCode } => ({
  success: false,
  errorCode: error instanceof CloudSyncError ? error.code : 'failed',
});

// One upload at a time: several documents asked for at once go in turn.
let queue: Promise<unknown> = Promise.resolve();
function inTurn<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.catch(() => undefined);
  return run;
}

/** Puts the document's file in the user's Drive folder (or finds it there) and records it in the library. */
export function storeDocInDrive(docId: string): Promise<DriveFileResult> {
  return inTurn(async () => {
    try {
      const { account: ref, config } = await account();
      const entry = (await readPdfLibrary())[docId];
      if (!entry) throw new CloudSyncError('no-local-copy');
      const drive = client(ref);
      if (entry.driveFileId && await exists(drive, entry.driveFileId)) return { success: true, fileId: entry.driveFileId };
      const bytes = await bytesOf(entry);
      if (!bytes) throw new CloudSyncError('no-local-copy');
      if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new CloudSyncError('drive-file-too-large');
      const sha256 = await sha256Hex(bytes);
      const folderId = await folder(ref, config);
      const fileId = await findBySha(drive, sha256) ?? await upload(drive, folderId, bytes, driveFileName(entry), sha256, docId);
      await updatePdfLibrary({ kind: 'drive', docId, driveFileId: fileId });
      debugLog('sync', 'PDF kept in Drive', () => ({ docId, fileId, bytes: bytes.byteLength }));
      return { success: true, fileId };
    } catch (error) {
      debugError('sync', 'keeping a PDF in Drive failed', () => ({ docId, error: error instanceof Error ? error.message : String(error) }));
      return failure(error);
    }
  });
}

/** Moves the document's Drive copy to the trash (recoverable there for 30 days) and forgets it. */
export async function removeDocFromDrive(docId: string): Promise<{ success: boolean; errorCode?: SyncErrorCode }> {
  try {
    const entry = (await readPdfLibrary())[docId];
    if (!entry?.driveFileId) return { success: true };
    const { account: ref } = await account();
    const response = await client(ref).request(`${DRIVE_API}/files/${entry.driveFileId}?fields=id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ trashed: true }),
    });
    if (!response.ok && response.status !== 404) throw await driveError(response);
    await updatePdfLibrary({ kind: 'drive', docId, driveFileId: null });
    return { success: true };
  } catch (error) {
    return failure(error);
  }
}

/** The Drive copy takes the document's current name (after a rename). */
export async function renameDriveCopy(docId: string): Promise<void> {
  try {
    const entry = (await readPdfLibrary())[docId];
    if (!entry?.driveFileId) return;
    const { account: ref } = await account();
    const response = await client(ref).request(`${DRIVE_API}/files/${entry.driveFileId}?fields=id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name: driveFileName(entry) }),
    });
    if (!response.ok && response.status !== 404) throw await driveError(response);
  } catch (error) {
    debugLog('sync', 'renaming the Drive copy failed', () => ({ docId, error: error instanceof Error ? error.message : String(error) }));
  }
}

/**
 * Downloads the Drive copy of the document behind `url` (or `docId`) into
 * this device's file cache, under that URL and its identity, so the viewer
 * or the hub can open it from there.
 */
export async function fetchDriveCopy(request: { url?: string | null; docId?: string | null }): Promise<DriveFileResult> {
  try {
    const library = await readPdfLibrary();
    const url = request.url ? librarySourceUrl(request.url) : null;
    const entry = request.docId ? library[request.docId] : Object.values(library).find((e) => !!url && e.urls.includes(url) && e.driveFileId);
    if (!entry?.driveFileId) throw new CloudSyncError('no-local-copy');
    const { account: ref } = await account();
    const response = await client(ref).request(`${DRIVE_API}/files/${entry.driveFileId}?alt=media`, {}, TRANSFER_TIMEOUT_MS);
    if (!response.ok) throw await driveError(response);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await storeCachedPdf({ url: url ?? entry.urls.find((u) => u.startsWith('file:')) ?? null, docId: entry.docId, bytes, sha256: await sha256Hex(bytes), etag: null, lastModified: null });
    debugLog('sync', 'PDF fetched from Drive', () => ({ docId: entry.docId, bytes: bytes.byteLength }));
    return { success: true, fileId: entry.driveFileId };
  } catch (error) {
    return failure(error);
  }
}

/**
 * A document was opened: a project it belongs to (the default project when
 * none) may keep such files in Drive. Its bytes reach this device's cache a
 * little after it opens, so the upload waits for them.
 */
export async function maybeKeepInDrive(docId: string, url: string | null): Promise<void> {
  try {
    const status = await driveFilesStatus();
    if (!status.enabled) return;
    const [library, projects, stored] = await Promise.all([readPdfLibrary(), readPdfProjects(), chrome.storage.local.get(DRIVE_AUTO_STORAGE_KEY)]);
    const entry = library[docId];
    if (!entry || entry.driveFileId) return;
    const rules = parseDriveAutoRules(stored[DRIVE_AUTO_STORAGE_KEY]);
    const owners = projectsOfDoc(projects, docId);
    if (!driveAutoWants(rules, owners.length ? owners : [DEFAULT_PROJECT_ID], !url || url.startsWith('file:'))) return;
    for (const delay of [5_000, 20_000, 60_000]) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      const result = await storeDocInDrive(docId);
      if (result.success || result.errorCode !== 'no-local-copy') return;
    }
  } catch (error) {
    debugLog('sync', 'automatic Drive copy skipped', () => ({ docId, error: error instanceof Error ? error.message : String(error) }));
  }
}

/** Every document of `projectId` of the kinds its rule now keeps, in turn (after the rule was turned on). */
export async function keepProjectInDrive(projectId: string): Promise<{ queued: number }> {
  const [library, projects, stored] = await Promise.all([readPdfLibrary(), readPdfProjects(), chrome.storage.local.get(DRIVE_AUTO_STORAGE_KEY)]);
  const rule = parseDriveAutoRules(stored[DRIVE_AUTO_STORAGE_KEY])[projectId];
  if (!rule) return { queued: 0 };
  const docs = Object.values(library).filter((e) => {
    if (e.driveFileId) return false;
    const owners = projectsOfDoc(projects, e.docId);
    const inProject = projectId === DEFAULT_PROJECT_ID ? owners.length === 0 : owners.includes(projectId);
    const local = !e.urls.some((u) => /^https?:/u.test(u));
    return inProject && (local ? rule.local : rule.web);
  });
  for (const e of docs) void storeDocInDrive(e.docId);
  return { queued: docs.length };
}
