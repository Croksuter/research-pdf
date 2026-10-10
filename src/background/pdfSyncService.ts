// ─── ResearchPDF cloud sync (Google Drive appDataFolder) ───
//
// One document per Google account, `researchpdf-sync-v1.json` (gzip; the file
// name predates snapshot version 2, which added the library), holding
// the viewer's durable state (shared/pdfSync.ts). Transport, auth and account
// pinning are ./googleAuth.ts, ./googleDriveStore.ts (which also emulates
// version-safe writes on Drive) and ./googleDriveAccount.ts; the merge is per
// document and per drawing.
//
// Runs unattended: on an alarm, at browser start, when a document is opened
// (the viewer waits for this pull) and shortly after a drawing is stored.
// A run where nothing changed on either side costs one metadata request, and
// a run whose merge only brings the remote side in writes nothing back, so
// two devices that agree never trade revisions.

import { applySyncedSettings, readSyncedSettings } from './settingsSync';
import { dbGetAll, openDB } from '../db/database';
import { getSetting, setSetting } from '../db/settingsRepository';
import { CloudSyncError } from './cloudSyncError';
import { getCachedGoogleToken, isGoogleSyncConfigured } from './googleAuth';
import { connectGoogleAccount, disconnectGoogleAccount, driveStoreForAccount, type GoogleAccountRef } from './googleDriveAccount';
import { DriveClobber, GoogleDriveStore, parseDriveEtag } from './googleDriveStore';
import { STORE_PDF_ANNOTATIONS, STORE_SETTINGS } from '../shared/constants';
import { debugError, debugLog, debugWarn } from '../shared/debugLog';
import { PdfAnnotationCache, isEmptyAnnotationCache, parsePdfAnnotationCache } from '../shared/pdfAnnotations';
import { PdfDocRecords, boundPdfDocRecords } from '../shared/pdfIdentity';
import { DEFAULT_PROJECT_ID } from '../shared/pdfProjects';
import { isSyncErrorCode, syncErrorText, type SyncErrorCode } from '../shared/syncErrors';
import {
  changedPdfDocIds,
  PDF_SYNC_SNAPSHOT_VERSION,
  PdfSyncSnapshot,
  boundPdfSyncSnapshot,
  mergePdfSyncSnapshots,
  parsePdfSyncSnapshot,
  pdfSyncSnapshotDataEquals,
} from '../shared/pdfSync';
import { stableJson } from '../shared/threeWayMerge';
import { mergeIntoPdfLibrary, readPdfLibrary } from './pdfLibraryStore';
import { mergeIntoPdfProjects, readPdfProjectFolders, readPdfProjects } from './pdfProjectStore';
import { mutatePdfDocRecords, readPdfDocRecords } from './pdfDocStateStore';
import { isRecord } from '../shared/guards';

export const PDF_SYNC_CONFIG_SETTING_KEY = 'researchPdfSyncConfig';
export const PDF_SYNC_STATE_SETTING_KEY = 'researchPdfSyncState';
// The account this device last synced with; kept after a disconnect, so that
// connecting a different account can ask before merging this device's data
// into it.
export const PDF_SYNC_LAST_ACCOUNT_SETTING_KEY = 'researchPdfSyncLastAccount';
// An account signed in but not connected yet, waiting for the user to confirm
// the switch (chrome.storage.session: gone when the browser closes).
const PENDING_ACCOUNT_SESSION_KEY = 'rpdfPendingGoogleAccount';
export const PDF_SYNC_ALARM_NAME = 'researchpdf-sync';
export const PDF_SYNC_SOON_ALARM_NAME = 'researchpdf-sync-soon';
export const PDF_SYNC_ALARM_PERIOD_MINUTES = 15;
const SOON_DELAY_MINUTES = 0.5;
const MAX_PRECONDITION_RETRIES = 1;
const MAX_CLOBBER_REPAIR_RETRIES = 2;

export interface PdfSyncConfig {
  googleAccountId: string;
  googleAccountEmail: string;
  enabled: boolean;
}

export interface PdfSyncPublicStatus {
  googleConfigured: boolean;
  googleConnected: boolean;
  googleAccountEmail: string;
  enabled: boolean;
  lastSyncAt: string | null;
  /** Worded by the page (shared/syncErrors.ts `syncStatusErrorText`). */
  errorCode: SyncErrorCode | null;
  errorDetail: string | null;
  /** The same, worded in the service worker's language; or an older build's stored sentence. */
  error: string | null;
  pendingLocalChanges: boolean;
  syncing: boolean;
}

interface PdfSyncState {
  etag: string | null;
  base: PdfSyncSnapshot | null;
  lastSyncAt: string | null;
  errorCode: SyncErrorCode | null;
  errorDetail: string | null;
  /** A sentence an older build stored instead of a code. */
  error: string | null;
  pendingLocalChanges: boolean;
  repair: DriveClobber | null;
}

export type PdfSyncResult =
  | { success: true; lastSyncAt: string; merged: boolean; changedDocIds: string[] }
  | { success: false; error: string; errorCode: SyncErrorCode };

const NO_ERROR = { errorCode: null, errorDetail: null, error: null } as const;

class StaleConfigError extends CloudSyncError {
  constructor() {
    super('account-changed');
    this.name = 'StaleConfigError';
  }
}

let activeSync: Promise<PdfSyncResult> | null = null;
// A run asked for while one is going: it starts when that one ends, so what
// the asker just stored is pushed (several asks share it).
let followUpSync: Promise<PdfSyncResult> | null = null;
let configGeneration = 0;

// ─── Config / state ───


function emptyConfig(): PdfSyncConfig {
  return { googleAccountId: '', googleAccountEmail: '', enabled: false };
}

function configFromUnknown(value: unknown): PdfSyncConfig {
  if (!isRecord(value)) return emptyConfig();
  const id = typeof value.googleAccountId === 'string' ? value.googleAccountId.slice(0, 128) : '';
  return {
    googleAccountId: id,
    googleAccountEmail: typeof value.googleAccountEmail === 'string' ? value.googleAccountEmail.slice(0, 320) : '',
    enabled: value.enabled === true && Boolean(id),
  };
}

export async function getPdfSyncConfig(): Promise<PdfSyncConfig> {
  return configFromUnknown(await getSetting<unknown>(PDF_SYNC_CONFIG_SETTING_KEY, emptyConfig()));
}

function emptyState(): PdfSyncState {
  return { etag: null, base: null, lastSyncAt: null, ...NO_ERROR, pendingLocalChanges: false, repair: null };
}

function repairFromUnknown(value: unknown): DriveClobber | null {
  if (!isRecord(value) || typeof value.fileId !== 'string' || typeof value.lostRevisionId !== 'string') return null;
  return parseDriveEtag(`${value.fileId}:${value.lostRevisionId}`)
    ? { fileId: value.fileId, lostRevisionId: value.lostRevisionId }
    : null;
}

function stateFromUnknown(value: unknown): PdfSyncState {
  if (!isRecord(value)) return emptyState();
  return {
    etag: typeof value.etag === 'string' ? value.etag : null,
    base: parsePdfSyncSnapshot(value.base),
    lastSyncAt: typeof value.lastSyncAt === 'string' ? value.lastSyncAt : null,
    errorCode: isSyncErrorCode(value.errorCode) ? value.errorCode : null,
    errorDetail: isSyncErrorCode(value.errorCode) && typeof value.errorDetail === 'string' ? value.errorDetail.slice(0, 64) : null,
    error: !isSyncErrorCode(value.errorCode) && typeof value.error === 'string' ? value.error : null,
    pendingLocalChanges: value.pendingLocalChanges === true,
    repair: repairFromUnknown(value.repair),
  };
}

async function getState(): Promise<PdfSyncState> {
  return stateFromUnknown(await getSetting<unknown>(PDF_SYNC_STATE_SETTING_KEY, emptyState()));
}

async function saveState(patch: Partial<PdfSyncState>): Promise<void> {
  await setSetting(PDF_SYNC_STATE_SETTING_KEY, { ...await getState(), ...patch });
}

async function commitConfig(build: (previous: PdfSyncConfig) => PdfSyncConfig): Promise<PdfSyncConfig> {
  configGeneration += 1;
  const previous = await getPdfSyncConfig();
  const config = build(previous);
  await setSetting(PDF_SYNC_CONFIG_SETTING_KEY, config);
  // A merge base belongs to one account's Drive object.
  if (previous.googleAccountId !== config.googleAccountId) await setSetting(PDF_SYNC_STATE_SETTING_KEY, emptyState());
  configGeneration += 1;
  return config;
}

async function assertConfigCurrent(config: PdfSyncConfig, generation: number): Promise<void> {
  if (configGeneration !== generation) throw new StaleConfigError();
  const current = await getPdfSyncConfig();
  if (configGeneration !== generation || current.googleAccountId !== config.googleAccountId) throw new StaleConfigError();
}

const hasError = (state: PdfSyncState) => state.errorCode !== null || state.error !== null;

export async function getPdfSyncStatus(): Promise<PdfSyncPublicStatus> {
  const [config, state] = await Promise.all([getPdfSyncConfig(), getState()]);
  return {
    googleConfigured: isGoogleSyncConfigured(),
    googleConnected: Boolean(config.googleAccountId),
    googleAccountEmail: config.googleAccountEmail,
    enabled: config.enabled,
    lastSyncAt: state.lastSyncAt,
    errorCode: state.errorCode,
    errorDetail: state.errorDetail,
    error: state.errorCode ? syncErrorText(state.errorCode, state.errorDetail) : state.error,
    pendingLocalChanges: state.pendingLocalChanges,
    syncing: activeSync !== null,
  };
}

// ─── Local snapshot ───

const readDocRecords = readPdfDocRecords;

export async function exportPdfSyncSnapshot(): Promise<PdfSyncSnapshot> {
  const [records, rows, library, projects, folders, settings] = await Promise.all([
    readDocRecords(), dbGetAll<unknown>(STORE_PDF_ANNOTATIONS), readPdfLibrary(), readPdfProjects(), readPdfProjectFolders(), readSyncedSettings(),
  ]);
  const annotations = rows
    .map(parsePdfAnnotationCache)
    .filter((cache): cache is PdfAnnotationCache => cache !== null && !isEmptyAnnotationCache(cache));
  return boundPdfSyncSnapshot({
    version: PDF_SYNC_SNAPSHOT_VERSION,
    exportedAt: new Date().toISOString(),
    docs: Object.values(records),
    annotations,
    library: Object.values(library),
    projects: Object.values(projects),
    folders: Object.values(folders),
    settings,
  });
}

// ─── Local apply ───

/**
 * Writes the merged snapshot over local state, one record at a time and only
 * where the local record is still the one that went into the merge. A record
 * the viewer changed meanwhile is left alone and reported as pending: the next
 * sync merges it. For such a record the stored base is what went INTO the
 * merge, not what came out: the local row never received the remote side, so
 * the common ancestor of the next merge is the pre-merge row. State (base,
 * version token) commits in the same IndexedDB transaction as the annotation
 * rows, so they can never disagree.
 */
async function applyPdfSyncSnapshot(
  merged: PdfSyncSnapshot,
  expected: PdfSyncSnapshot,
  stateUpdate: (pendingLocalChanges: boolean, base: PdfSyncSnapshot) => PdfSyncState,
  guard: () => boolean,
): Promise<{ pendingLocalChanges: boolean }> {
  let pending = false;
  const skippedDocs = new Set<string>();
  const skippedCaches = new Set<string>();

  // Reading positions live in chrome.storage.local, outside the transaction.
  // They are last-writer-wins and re-merged by the next sync, so applying them
  // first is safe even if the transaction below fails. The map is read and
  // written in the position store's queue, so a position a viewer saves while
  // this sync runs is either already in `current` (and kept, as pending) or
  // stored after this write; never lost.
  const expectedDocs = new Map(expected.docs.map((doc) => [doc.docId, doc]));
  await mutatePdfDocRecords((current) => {
    const next: PdfDocRecords = { ...current };
    const mergedDocIds = new Set<string>();
    // What the bound keeps of the local rows: the rest (too old, or beyond the
    // count) was never exported and is gone everywhere, so it goes here too
    // instead of standing as a local change forever.
    const inBounds = new Set(boundPdfDocRecords(Object.values(current)).map((doc) => doc.docId));
    merged.docs.forEach((doc) => {
      mergedDocIds.add(doc.docId);
      const local = current[doc.docId];
      const unchanged = stableJson(local ?? null) === stableJson(expectedDocs.get(doc.docId) ?? null);
      if (unchanged || !local || local.updatedAt <= doc.updatedAt) next[doc.docId] = doc;
      else { pending = true; skippedDocs.add(doc.docId); }
    });
    Object.keys(current).forEach((docId) => {
      if (mergedDocIds.has(docId)) return;
      if (!inBounds.has(docId) || stableJson(current[docId]) === stableJson(expectedDocs.get(docId) ?? null)) delete next[docId];
      else { pending = true; skippedDocs.add(docId); }
    });
    if (!guard()) throw new StaleConfigError();
    return { next, result: undefined };
  });
  // The library merge is a join: applying it over whatever the viewer wrote
  // meanwhile loses nothing, and a row that differs from the base afterwards
  // is simply pushed by the next sync.
  // Projects first: the library keeps every document they refer to.
  await mergeIntoPdfProjects(merged.projects, merged.folders);
  await mergeIntoPdfLibrary(merged.library);
  // Settings: per key the latest change; one changed here meanwhile is newer and stays.
  await applySyncedSettings(merged.settings);

  const db = await openDB();
  const tx = db.transaction([STORE_PDF_ANNOTATIONS, STORE_SETTINGS], 'readwrite');
  const annotationStore = tx.objectStore(STORE_PDF_ANNOTATIONS);
  const settingsStore = tx.objectStore(STORE_SETTINGS);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
  const request = <T>(req: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    const rows = (await request(annotationStore.getAll()) as unknown[]).map(parsePdfAnnotationCache);
    const local = new Map(rows.flatMap((cache) => (cache ? [[cache.docId, cache] as const] : [])));
    const expectedCaches = new Map(expected.annotations.map((cache) => [cache.docId, cache]));
    const mergedCaches = new Map(merged.annotations.map((cache) => [cache.docId, cache]));
    const docIds = new Set([...local.keys(), ...mergedCaches.keys()]);
    for (const docId of docIds) {
      const localCache = local.get(docId) ?? null;
      const unchanged = stableJson(localCache) === stableJson(expectedCaches.get(docId) ?? null);
      if (!unchanged) { pending = true; skippedCaches.add(docId); continue; }
      const target = mergedCaches.get(docId);
      if (!target) annotationStore.delete(docId);
      else if (stableJson(target) !== stableJson(localCache)) annotationStore.put(target);
    }
    if (!guard()) { tx.abort(); throw new StaleConfigError(); }
    const base: PdfSyncSnapshot = {
      ...merged,
      docs: [
        ...merged.docs.filter((doc) => !skippedDocs.has(doc.docId)),
        ...expected.docs.filter((doc) => skippedDocs.has(doc.docId)),
      ].sort((a, b) => a.docId.localeCompare(b.docId)),
      annotations: [
        ...merged.annotations.filter((cache) => !skippedCaches.has(cache.docId)),
        ...expected.annotations.filter((cache) => skippedCaches.has(cache.docId)),
      ].sort((a, b) => a.docId.localeCompare(b.docId)),
    };
    settingsStore.put({ key: PDF_SYNC_STATE_SETTING_KEY, value: stateUpdate(pending, base) });
  } catch (error) {
    try { tx.abort(); } catch { /* already aborted */ }
    throw error;
  }
  await done;
  return { pendingLocalChanges: pending };
}

// ─── Transport ───

function parseRemote(text: string): PdfSyncSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CloudSyncError('file-invalid');
  }
  const snapshot = parsePdfSyncSnapshot(raw);
  if (!snapshot) throw new CloudSyncError('file-too-new');
  return snapshot;
}

function storeFor(config: PdfSyncConfig): GoogleDriveStore {
  return driveStoreForAccount({ id: config.googleAccountId, email: config.googleAccountEmail });
}

function assertReady(config: PdfSyncConfig): void {
  if (!isGoogleSyncConfigured()) throw new CloudSyncError('not-configured');
  if (!config.googleAccountId) throw new CloudSyncError('connect-first');
  if (!config.enabled) throw new CloudSyncError('sync-off');
}

function errorOf(error: unknown): { code: SyncErrorCode; detail: string | null } {
  return error instanceof CloudSyncError ? { code: error.code, detail: error.detail } : { code: 'failed', detail: null };
}

function safeError(error: unknown): string {
  const { code, detail } = errorOf(error);
  return syncErrorText(code, detail);
}

// ─── Sync run ───

async function performSync(): Promise<PdfSyncResult> {
  // The generation first: a connect or disconnect that lands while the config
  // is being read must make this run stale, not look current.
  const generation = configGeneration;
  const config = await getPdfSyncConfig();
  debugLog('sync', 'start', () => ({ googleConnected: Boolean(config.googleAccountId), enabled: config.enabled }));
  try {
    assertReady(config);
    await assertConfigCurrent(config, generation);
    const store = storeFor(config);
    let preconditionRetries = 0;
    let clobberRepairRetries = 0;
    for (let attempt = 0; ; attempt += 1) {
      const [localAtStart, state] = await Promise.all([exportPdfSyncSnapshot(), getState()]);

      if (attempt === 0 && state.base && state.etag && !state.pendingLocalChanges && !state.repair
        && pdfSyncSnapshotDataEquals(localAtStart, state.base)
        && await store.probe() === state.etag) {
        await assertConfigCurrent(config, generation);
        const lastSyncAt = new Date().toISOString();
        await saveState({ lastSyncAt, ...NO_ERROR });
        await rememberSyncedAccount(config);
        debugLog('sync', 'terminal: success (unchanged)');
        return { success: true, lastSyncAt, merged: false, changedDocIds: [] };
      }

      const read = await store.read();
      await assertConfigCurrent(config, generation);
      // What the file holds now; `remote` may grow by a repaired revision below.
      const onFile: PdfSyncSnapshot | null = read.kind === 'file' ? parseRemote(read.text) : null;
      let remote = onFile;
      const remoteEtag = read.kind === 'file' ? read.etag : null;

      // A revision one of our own earlier writes replaced unseen is folded
      // back in additively: the chain cannot say what it merged against.
      if (state.repair && remote) {
        const lostText = await store.readRevision(state.repair.fileId, state.repair.lostRevisionId);
        await assertConfigCurrent(config, generation);
        if (lostText !== null) {
          debugWarn('sync', 'decision: fold clobbered revision back in');
          remote = mergePdfSyncSnapshots(remote, parseRemote(lostText), null);
        }
      }

      const sameObject = remoteEtag && state.etag
        && parseDriveEtag(remoteEtag)?.fileId === parseDriveEtag(state.etag)?.fileId;
      const base = remote && state.etag && !sameObject ? null : state.base;
      const initiallyMerged = remote ? mergePdfSyncSnapshots(localAtStart, remote, base) : localAtStart;

      // Reads can be slow; fold in whatever the viewer stored meanwhile.
      const localBeforePut = await exportPdfSyncSnapshot();
      const cloudSnapshot = pdfSyncSnapshotDataEquals(localAtStart, localBeforePut)
        ? initiallyMerged
        : mergePdfSyncSnapshots(localBeforePut, initiallyMerged, localAtStart);
      await assertConfigCurrent(config, generation);

      // The merge only brought the remote side in: nothing to push. Writing it
      // anyway would be a new revision that the other device then reads,
      // merges to the same thing and writes back, every run, forever.
      const nothingToPush = onFile !== null && remoteEtag !== null && pdfSyncSnapshotDataEquals(cloudSnapshot, onFile);
      const written = nothingToPush
        ? { kind: 'written' as const, etag: remoteEtag }
        : remote && remoteEtag ? await store.update(JSON.stringify(cloudSnapshot), remoteEtag) : await store.create(JSON.stringify(cloudSnapshot));
      debugLog('sync', nothingToPush ? 'drive write skipped (remote already has it)' : `drive write ${written.kind}`, () => ({ attempt }));
      if (written.kind === 'precondition-failed') {
        if (preconditionRetries >= MAX_PRECONDITION_RETRIES) {
          throw new CloudSyncError('conflict');
        }
        preconditionRetries += 1;
        continue;
      }
      if (written.kind === 'clobbered') {
        await assertConfigCurrent(config, generation);
        await saveState({ repair: written.clobber });
        if (clobberRepairRetries >= MAX_CLOBBER_REPAIR_RETRIES) {
          throw new CloudSyncError('conflict');
        }
        clobberRepairRetries += 1;
        continue;
      }
      await assertConfigCurrent(config, generation);

      const lastSyncAt = new Date().toISOString();
      const { pendingLocalChanges } = await applyPdfSyncSnapshot(
        cloudSnapshot,
        localBeforePut,
        (pending, base) => ({
          etag: written.etag,
          base,
          lastSyncAt,
          ...NO_ERROR,
          pendingLocalChanges: pending,
          repair: null,
        }),
        () => configGeneration === generation,
      );
      await rememberSyncedAccount(config);
      debugLog('sync', 'terminal: success', () => ({ merged: remote !== null, pendingLocalChanges }));
      return { success: true, lastSyncAt, merged: remote !== null, changedDocIds: changedPdfDocIds(localBeforePut, cloudSnapshot) };
    }
  } catch (error) {
    const { code, detail } = errorOf(error);
    const message = syncErrorText(code, detail);
    debugError('sync', 'terminal: failure', () => ({ error: code, detail }));
    if (!(error instanceof StaleConfigError)) {
      try {
        await assertConfigCurrent(config, generation);
        await saveState({ errorCode: code, errorDetail: detail, error: null });
      } catch {
        // Keep the original failure; state persistence must not obscure it.
      }
    }
    return { success: false, error: message, errorCode: code };
  }
}

function startSync(): Promise<PdfSyncResult> {
  const run = performSync().finally(() => {
    // A queued follow-up takes over as the active run when it starts.
    if (activeSync === run && !followUpSync) activeSync = null;
  });
  activeSync = run;
  return run;
}

/**
 * Runs a sync. Asked while one is running: one more run follows it (shared by
 * every ask made meanwhile), so a change stored during a run is not left for
 * the next alarm. `join` instead shares the running one: an open's pull needs
 * the remote side, which the running sync is fetching anyway.
 */
export function syncPdfNow(options: { join?: boolean } = {}): Promise<PdfSyncResult> {
  if (!activeSync) return startSync();
  if (options.join) return activeSync;
  if (!followUpSync) {
    followUpSync = activeSync.then(() => {
      followUpSync = null;
      return startSync();
    });
  }
  return followUpSync;
}

// A viewer opening a document pulls first, but a sync that finished this
// recently already brought everything: opening ten restored documents must
// not mean ten Drive round trips.
const OPEN_PULL_FRESH_MS = 60_000;

/**
 * Pull for a document being opened. Resolves with the documents the pull
 * changed locally; the viewer renders from local data meanwhile and reloads
 * its document only when it is among them.
 */
export async function pullPdfSyncForOpen(): Promise<{ changedDocIds: string[] }> {
  try {
    const config = await getPdfSyncConfig();
    if (!config.enabled || !config.googleAccountId || !isGoogleSyncConfigured()) return { changedDocIds: [] };
    if (!activeSync) {
      const state = await getState();
      if (!hasError(state) && state.lastSyncAt && Date.now() - Date.parse(state.lastSyncAt) < OPEN_PULL_FRESH_MS) return { changedDocIds: [] };
    }
    const result = await syncPdfNow({ join: true });
    return { changedDocIds: result.success ? result.changedDocIds : [] };
  } catch (error) {
    debugError('sync', 'open pull failed', () => ({ error: safeError(error) }));
    return { changedDocIds: [] };
  }
}

/** The unattended path: silent no-op unless a Google account is connected. */
export async function autoSyncPdfIfConnected(): Promise<void> {
  try {
    const config = await getPdfSyncConfig();
    if (!config.enabled || !config.googleAccountId || !isGoogleSyncConfigured()) return;
    await syncPdfNow();
  } catch (error) {
    debugError('sync', 'auto sync failed', () => ({ error: safeError(error) }));
  }
}

/** Coalesces a burst of edits into one push a little later. */
export function requestPdfSyncSoon(): void {
  try {
    chrome.alarms.create(PDF_SYNC_SOON_ALARM_NAME, { delayInMinutes: SOON_DELAY_MINUTES });
  } catch {
    // The periodic alarm still pushes it.
  }
}

// ─── Account ───

function accountFromUnknown(value: unknown): GoogleAccountRef | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return null;
  return { id: value.id.slice(0, 128), email: typeof value.email === 'string' ? value.email.slice(0, 320) : '' };
}

async function rememberSyncedAccount(config: PdfSyncConfig): Promise<void> {
  const previous = accountFromUnknown(await getSetting<unknown>(PDF_SYNC_LAST_ACCOUNT_SETTING_KEY, null));
  if (previous?.id === config.googleAccountId && previous.email === config.googleAccountEmail) return;
  await setSetting(PDF_SYNC_LAST_ACCOUNT_SETTING_KEY, { id: config.googleAccountId, email: config.googleAccountEmail });
}

/** The account this device's data last went to: the connected one, else the last one synced. */
async function previousAccount(): Promise<GoogleAccountRef | null> {
  const config = await getPdfSyncConfig();
  if (config.googleAccountId) return { id: config.googleAccountId, email: config.googleAccountEmail };
  return accountFromUnknown(await getSetting<unknown>(PDF_SYNC_LAST_ACCOUNT_SETTING_KEY, null));
}

/** Whether this device has anything a sync would carry into an account. */
async function hasLocalSyncData(): Promise<boolean> {
  const local = await exportPdfSyncSnapshot();
  return local.docs.length > 0 || local.annotations.length > 0 || local.library.length > 0 || local.folders.length > 0
    || local.projects.some((p) => p.id !== DEFAULT_PROJECT_ID || p.members.length > 0);
}

async function readPendingAccount(): Promise<GoogleAccountRef | null> {
  try {
    return accountFromUnknown((await chrome.storage.session.get(PENDING_ACCOUNT_SESSION_KEY))[PENDING_ACCOUNT_SESSION_KEY]);
  } catch {
    return null;
  }
}

async function setPendingAccount(account: GoogleAccountRef | null): Promise<void> {
  try {
    if (account) await chrome.storage.session.set({ [PENDING_ACCOUNT_SESSION_KEY]: account });
    else await chrome.storage.session.remove(PENDING_ACCOUNT_SESSION_KEY);
  } catch {
    /* best effort: without it the user signs in once more */
  }
}

export type PdfSyncConnectResult =
  | { success: true; status: PdfSyncPublicStatus }
  // Signed in to a different account than this device's data last went to:
  // nothing is connected until the page asks again with `confirmAccountChange`.
  | { success: false; needsConfirm: 'account-change'; previousEmail: string; email: string }
  | { success: false; error: string; errorCode: SyncErrorCode };

/**
 * Signs in and connects. When the account differs from the one this device
 * last synced with and there is local data, it stops there and asks: syncing
 * would add this device's papers and drawings to the other account's Drive.
 * The sign-in waits (its token stays cached for this browser session) for a
 * second call with `confirmAccountChange`, which connects it and merges.
 */
export async function connectPdfSyncGoogle(options: { confirmAccountChange?: boolean } = {}): Promise<PdfSyncConnectResult> {
  try {
    const pending = options.confirmAccountChange ? await readPendingAccount() : null;
    const confirmed = pending !== null && await getCachedGoogleToken(pending.id) !== null;
    const account: GoogleAccountRef = confirmed && pending ? pending : await connectGoogleAccount();
    await setPendingAccount(null);
    if (!confirmed) {
      const previous = await previousAccount();
      if (previous && previous.id !== account.id && await hasLocalSyncData()) {
        await setPendingAccount(account);
        debugLog('sync', 'google account differs from the last one synced: asking first');
        return { success: false, needsConfirm: 'account-change', previousEmail: previous.email, email: account.email };
      }
    }
    await commitConfig(() => ({ googleAccountId: account.id, googleAccountEmail: account.email, enabled: true }));
    debugLog('sync', 'google account connected');
    void syncPdfNow();
    return { success: true, status: await getPdfSyncStatus() };
  } catch (error) {
    const { code, detail } = errorOf(error);
    return { success: false, error: syncErrorText(code, detail), errorCode: code };
  }
}

/** Forgets the account here and revokes its token; the Drive file stays for other devices. */
export async function disconnectPdfSyncGoogle(): Promise<{ success: true; status: PdfSyncPublicStatus }> {
  // An install from before the last-account record: the connected account is
  // the one this device's data went to, if it ever synced.
  const [config, state] = await Promise.all([getPdfSyncConfig(), getState()]);
  if (config.googleAccountId && state.lastSyncAt) await rememberSyncedAccount(config);
  await setPendingAccount(null);
  await commitConfig(() => emptyConfig());
  await disconnectGoogleAccount();
  debugLog('sync', 'google account disconnected');
  return { success: true, status: await getPdfSyncStatus() };
}

export async function setPdfSyncEnabled(enabled: boolean): Promise<PdfSyncPublicStatus> {
  await commitConfig((previous) => ({ ...previous, enabled: enabled && Boolean(previous.googleAccountId) }));
  return getPdfSyncStatus();
}
