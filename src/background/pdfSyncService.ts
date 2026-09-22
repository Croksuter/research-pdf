// ─── ResearchPDF cloud sync (Google Drive appDataFolder) ───
//
// One document per Google account, `researchpdf-sync-v1.json` (gzip), holding
// the viewer's durable state (shared/pdfSync.ts). Transport, auth, account
// pinning and Drive's version-safety emulation are the same modules the
// vocabulary engine uses; the merge is per document and per drawing.
//
// Runs unattended: on an alarm, at browser start, when a document is opened
// (the viewer waits for this pull) and shortly after a drawing is stored.
// A run where nothing changed on either side costs one metadata request.

import { dbGetAll, openDB } from '../db/database';
import { getSetting, setSetting } from '../db/settingsRepository';
import { CloudSyncError } from './cloudSyncError';
import { isGoogleSyncConfigured } from './googleAuth';
import { connectGoogleAccount, disconnectGoogleAccount, driveStoreForAccount } from './googleDriveAccount';
import { DriveClobber, GoogleDriveStore, parseDriveEtag } from './googleDriveStore';
import { STORE_PDF_ANNOTATIONS, STORE_SETTINGS } from '../shared/constants';
import { debugError, debugLog, debugWarn } from '../shared/debugLog';
import { PdfAnnotationCache, isEmptyAnnotationCache, parsePdfAnnotationCache } from '../shared/pdfAnnotations';
import { PDF_DOC_STATE_STORAGE_KEY, PdfDocRecord, PdfDocRecords, parsePdfDocRecords } from '../shared/pdfIdentity';
import {
  PDF_SYNC_SNAPSHOT_VERSION,
  PdfSyncSnapshot,
  boundPdfSyncSnapshot,
  mergePdfSyncSnapshots,
  parsePdfSyncSnapshot,
  pdfSyncSnapshotDataEquals,
} from '../shared/pdfSync';
import { stableJson } from '../shared/threeWayMerge';

export const PDF_SYNC_CONFIG_SETTING_KEY = 'researchPdfSyncConfig';
export const PDF_SYNC_STATE_SETTING_KEY = 'researchPdfSyncState';
export const PDF_SYNC_FILE_NAME = 'researchpdf-sync-v1.json';
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
  error: string | null;
  pendingLocalChanges: boolean;
  syncing: boolean;
}

interface PdfSyncState {
  etag: string | null;
  base: PdfSyncSnapshot | null;
  lastSyncAt: string | null;
  error: string | null;
  pendingLocalChanges: boolean;
  repair: DriveClobber | null;
}

export type PdfSyncResult =
  | { success: true; lastSyncAt: string; merged: boolean }
  | { success: false; error: string };

class StaleConfigError extends CloudSyncError {
  constructor() {
    super('동기화 중 Google 계정 연결이 바뀌어 이전 결과를 적용하지 않았습니다.');
    this.name = 'StaleConfigError';
  }
}

let activeSync: Promise<PdfSyncResult> | null = null;
let configGeneration = 0;

// ─── Config / state ───

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
  return { etag: null, base: null, lastSyncAt: null, error: null, pendingLocalChanges: false, repair: null };
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
    error: typeof value.error === 'string' ? value.error : null,
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

export async function getPdfSyncStatus(): Promise<PdfSyncPublicStatus> {
  const [config, state] = await Promise.all([getPdfSyncConfig(), getState()]);
  return {
    googleConfigured: isGoogleSyncConfigured(),
    googleConnected: Boolean(config.googleAccountId),
    googleAccountEmail: config.googleAccountEmail,
    enabled: config.enabled,
    lastSyncAt: state.lastSyncAt,
    error: state.error,
    pendingLocalChanges: state.pendingLocalChanges,
    syncing: activeSync !== null,
  };
}

// ─── Local snapshot ───

async function readDocRecords(): Promise<PdfDocRecords> {
  try {
    const stored = await chrome.storage.local.get(PDF_DOC_STATE_STORAGE_KEY);
    return parsePdfDocRecords(stored[PDF_DOC_STATE_STORAGE_KEY]);
  } catch {
    return {};
  }
}

export async function exportPdfSyncSnapshot(): Promise<PdfSyncSnapshot> {
  const [records, rows] = await Promise.all([readDocRecords(), dbGetAll<unknown>(STORE_PDF_ANNOTATIONS)]);
  const annotations = rows
    .map(parsePdfAnnotationCache)
    .filter((cache): cache is PdfAnnotationCache => cache !== null && !isEmptyAnnotationCache(cache));
  return boundPdfSyncSnapshot({
    version: PDF_SYNC_SNAPSHOT_VERSION,
    exportedAt: new Date().toISOString(),
    docs: Object.values(records),
    annotations,
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
  // first is safe even if the transaction below fails.
  const current = await readDocRecords();
  const expectedDocs = new Map(expected.docs.map((doc) => [doc.docId, doc]));
  const next: PdfDocRecords = { ...current };
  const mergedDocIds = new Set<string>();
  merged.docs.forEach((doc) => {
    mergedDocIds.add(doc.docId);
    const local = current[doc.docId];
    const unchanged = stableJson(local ?? null) === stableJson(expectedDocs.get(doc.docId) ?? null);
    if (unchanged || !local || local.updatedAt <= doc.updatedAt) next[doc.docId] = doc;
    else { pending = true; skippedDocs.add(doc.docId); }
  });
  Object.keys(current).forEach((docId) => {
    if (mergedDocIds.has(docId)) return;
    if (stableJson(current[docId]) === stableJson(expectedDocs.get(docId) ?? null)) delete next[docId];
    else { pending = true; skippedDocs.add(docId); }
  });
  if (!guard()) throw new StaleConfigError();
  await chrome.storage.local.set({ [PDF_DOC_STATE_STORAGE_KEY]: next });

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
    throw new CloudSyncError('Google Drive의 동기화 파일이 유효한 ResearchPDF 문서가 아닙니다.');
  }
  const snapshot = parsePdfSyncSnapshot(raw);
  if (!snapshot) throw new CloudSyncError('Google Drive의 동기화 파일을 이 버전에서 읽을 수 없습니다.');
  return snapshot;
}

function storeFor(config: PdfSyncConfig): GoogleDriveStore {
  return driveStoreForAccount({ id: config.googleAccountId, email: config.googleAccountEmail }, PDF_SYNC_FILE_NAME);
}

function assertReady(config: PdfSyncConfig): void {
  if (!isGoogleSyncConfigured()) throw new CloudSyncError('이 빌드에는 Google 동기화가 구성되어 있지 않습니다.');
  if (!config.googleAccountId) throw new CloudSyncError('설정에서 Google 계정을 먼저 연결하세요.');
  if (!config.enabled) throw new CloudSyncError('클라우드 동기화가 꺼져 있습니다.');
}

function safeError(error: unknown): string {
  return error instanceof CloudSyncError ? error.message : '클라우드 동기화에 실패했습니다.';
}

// ─── Sync run ───

async function performSync(): Promise<PdfSyncResult> {
  const config = await getPdfSyncConfig();
  const generation = configGeneration;
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
        await saveState({ lastSyncAt, error: null });
        debugLog('sync', 'terminal: success (unchanged)');
        return { success: true, lastSyncAt, merged: false };
      }

      const read = await store.read();
      await assertConfigCurrent(config, generation);
      let remote: PdfSyncSnapshot | null = read.kind === 'file' ? parseRemote(read.text) : null;
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

      const body = JSON.stringify(cloudSnapshot);
      const written = remote && remoteEtag ? await store.update(body, remoteEtag) : await store.create(body);
      debugLog('sync', `drive write ${written.kind}`, () => ({ attempt }));
      if (written.kind === 'precondition-failed') {
        if (preconditionRetries >= MAX_PRECONDITION_RETRIES) {
          throw new CloudSyncError('다른 기기와 동시에 동기화되어 충돌했습니다. 다시 시도하세요.');
        }
        preconditionRetries += 1;
        continue;
      }
      if (written.kind === 'clobbered') {
        await assertConfigCurrent(config, generation);
        await saveState({ repair: written.clobber });
        if (clobberRepairRetries >= MAX_CLOBBER_REPAIR_RETRIES) {
          throw new CloudSyncError('다른 기기와 동시에 동기화되어 충돌했습니다. 다시 시도하세요.');
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
          error: null,
          pendingLocalChanges: pending,
          repair: null,
        }),
        () => configGeneration === generation,
      );
      debugLog('sync', 'terminal: success', () => ({ merged: remote !== null, pendingLocalChanges }));
      return { success: true, lastSyncAt, merged: remote !== null };
    }
  } catch (error) {
    const message = safeError(error);
    debugError('sync', 'terminal: failure', () => ({ error: message }));
    if (!(error instanceof StaleConfigError)) {
      try {
        await assertConfigCurrent(config, generation);
        await saveState({ error: message });
      } catch {
        // Keep the original failure; state persistence must not obscure it.
      }
    }
    return { success: false, error: message };
  }
}

/** Single-flight: concurrent callers share one run. */
export function syncPdfNow(): Promise<PdfSyncResult> {
  if (!activeSync) activeSync = performSync().finally(() => { activeSync = null; });
  return activeSync;
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

export async function connectPdfSyncGoogle(): Promise<
  | { success: true; status: PdfSyncPublicStatus }
  | { success: false; error: string }
> {
  try {
    const account = await connectGoogleAccount();
    await commitConfig(() => ({ googleAccountId: account.id, googleAccountEmail: account.email, enabled: true }));
    debugLog('sync', 'google account connected');
    void syncPdfNow();
    return { success: true, status: await getPdfSyncStatus() };
  } catch (error) {
    return { success: false, error: safeError(error) };
  }
}

/** Forgets the account here and revokes its token; the Drive file stays for other devices. */
export async function disconnectPdfSyncGoogle(): Promise<{ success: true; status: PdfSyncPublicStatus }> {
  await commitConfig(() => emptyConfig());
  await disconnectGoogleAccount();
  debugLog('sync', 'google account disconnected');
  return { success: true, status: await getPdfSyncStatus() };
}

export async function setPdfSyncEnabled(enabled: boolean): Promise<PdfSyncPublicStatus> {
  await commitConfig((previous) => ({ ...previous, enabled: enabled && Boolean(previous.googleAccountId) }));
  return getPdfSyncStatus();
}

// Exposed for tests only.
export function getExpectedDocRecordsForTest(): Promise<Record<string, PdfDocRecord>> {
  return readDocRecords();
}
