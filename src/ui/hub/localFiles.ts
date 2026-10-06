// ─── Local files ───
//
// A PDF opened from disk has no address to reopen it from, so its bytes are
// kept (IndexedDB, per hub tab session: sessionStorage names the session)
// while a tab or a recently-closed entry of this hub tab refers to it, in
// any of the projects it showed. A reload (a new language), a project switch
// in place and a browser restart that restores the tab bring them back.

import { fileIdentity, parseClosedTabs, parseLocalTabs, type HubLocalTab } from '../../shared/hubTabs';
import { S } from '../pdfHub.strings';
import { type HubTab, activeKey, isHub, projectId, tabs } from './store';
import { showToast } from './uiKit';
import { createTab, insertTab, updateTabLabel } from './tabStrip';
import { CLOSED_STORAGE_KEY, closed } from './session';

export const LOCAL_TABS_KEY = 'rpdfLocalTabs';
export const SESSION_KEY = 'rpdfHubSession';
export const NEXT_FILE_ID_KEY = 'rpdfNextFileId';
export const FILES_DB = 'rpdf-hub-files';
export const FILES_STORE = 'files';
// Copies no hub tab has claimed for this long are dropped (tabs gone with their session).
export const LOCAL_FILE_MAX_AGE_MS = 30 * 86_400_000;

export const localFiles = new Map<number, File>();
export const localFileIds = new Map<string, number>();

export function sessionValue(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

export function setSessionValue(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* kept in memory for this page */
  }
}

export const hubSession = (() => {
  const known = sessionValue(SESSION_KEY);
  if (known) return known;
  const fresh = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  setSessionValue(SESSION_KEY, fresh);
  return fresh;
})();

export let fileIdFloor = 1;
export function nextFileId(): number {
  const next = Math.max(fileIdFloor, Number(sessionValue(NEXT_FILE_ID_KEY)) || 1);
  fileIdFloor = next + 1;
  setSessionValue(NEXT_FILE_ID_KEY, String(next + 1));
  return next;
}

export let filesDb: Promise<IDBDatabase> | null = null;
export function openFilesDb(): Promise<IDBDatabase> {
  filesDb ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(FILES_DB, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(FILES_STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return filesDb;
}

export interface StoredLocalFile { session: string; file: File; touchedAt: number }

export async function withFiles<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openFilesDb();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(FILES_STORE, mode);
    const request = run(tx.objectStore(FILES_STORE));
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const fileKey = (id: number) => `${hubSession}:${id}`;
export const pendingFileWrites = new Set<Promise<unknown>>();

export function track(write: Promise<unknown>): void {
  const done = write.catch(() => undefined).finally(() => pendingFileWrites.delete(done));
  pendingFileWrites.add(done);
}

/** The handle for `file`: the one it already has here (the same file opened again), or a new one, stored. */
export function localFileId(file: File): number {
  const identity = fileIdentity(file);
  const known = localFileIds.get(identity);
  if (known !== undefined && localFiles.has(known)) return known;
  const id = nextFileId();
  localFiles.set(id, file);
  localFileIds.set(identity, id);
  const record: StoredLocalFile = { session: hubSession, file, touchedAt: Date.now() };
  track(withFiles('readwrite', (store) => store.put(record, fileKey(id))));
  return id;
}

/** Waits for local files still being written (before a reload or a switch). */
export function flushLocalFiles(): Promise<unknown> {
  return Promise.all([...pendingFileWrites]);
}

export function localTabsKey(id = projectId): string {
  return `${LOCAL_TABS_KEY}:${id}`;
}

// Nothing is recorded before the boot put the recorded ones back.
export let localTabsRestored = false;

/** Records this project's local-file tabs (where they stand, which is in front) in the session. */
export function saveLocalTabs(): void {
  if (!localTabsRestored) return;
  const list: HubLocalTab[] = [];
  tabs.forEach((t, index) => {
    if (t.url || t.fileId === null) return;
    list.push({ fileId: t.fileId, index, title: t.title, paperTitle: t.paperTitle, active: t.key === activeKey });
  });
  const value = list.length ? JSON.stringify(list) : null;
  if (sessionValue(localTabsKey()) !== value) setSessionValue(localTabsKey(), value);
}

/** Every file handle this hub tab's session still refers to: open or recently closed, in any project. */
export function referencedFileIds(): Set<number> {
  const ids = new Set<number>();
  for (const t of tabs) if (t.fileId !== null) ids.add(t.fileId);
  for (const e of closed) if (e.fileId !== null) ids.add(e.fileId);
  try {
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i) ?? '';
      const raw = JSON.parse(sessionStorage.getItem(key) ?? 'null') as unknown;
      if (key.startsWith(`${LOCAL_TABS_KEY}:`)) for (const t of parseLocalTabs(raw)) ids.add(t.fileId);
      else if (key.startsWith(`${CLOSED_STORAGE_KEY}:`)) for (const e of parseClosedTabs(raw)) if (e.fileId !== null) ids.add(e.fileId);
    }
  } catch {
    /* keep what is in memory */
  }
  return ids;
}

export let pruneTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleLocalFilePrune(): void {
  if (pruneTimer || !isHub) return;
  pruneTimer = setTimeout(() => { pruneTimer = null; void pruneLocalFiles(); }, 1_000);
}

/** Drops the copies nothing refers to any more. */
export async function pruneLocalFiles(): Promise<void> {
  const keep = referencedFileIds();
  for (const [id, file] of [...localFiles]) {
    if (keep.has(id)) continue;
    localFiles.delete(id);
    if (localFileIds.get(fileIdentity(file)) === id) localFileIds.delete(fileIdentity(file));
  }
  const prefix = `${hubSession}:`;
  await withFiles('readwrite', (store) => {
    const cursor = store.openKeyCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      const key = String(c.key);
      if (key.startsWith(prefix) && !keep.has(Number(key.slice(prefix.length)))) store.delete(c.key);
      c.continue();
    };
  }).catch(() => undefined);
}

/**
 * Loads the copies this session refers to into memory, marks them as still
 * wanted, and drops copies of sessions long gone. Returns the files by handle.
 */
export async function restoreLocalFiles(): Promise<void> {
  const wanted = referencedFileIds();
  const now = Date.now();
  await withFiles('readwrite', (store) => {
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      const record = c.value as StoredLocalFile;
      const key = String(c.key);
      if (record?.session === hubSession) {
        const id = Number(key.slice(hubSession.length + 1));
        if (wanted.has(id) && record.file instanceof Blob) {
          localFiles.set(id, record.file);
          localFileIds.set(fileIdentity(record.file), id);
          c.update({ ...record, touchedAt: now });
        } else {
          c.delete();
        }
      } else if (!record || now - (record.touchedAt ?? 0) > LOCAL_FILE_MAX_AGE_MS) {
        c.delete();
      }
      c.continue();
    };
  }).catch(() => undefined);
}

/** Puts this project's local-file tabs back where they were; the one in front, if one was. */
export function restoreLocalTabs(): HubTab | null {
  let front: HubTab | null = null;
  let missing = 0;
  let records: HubLocalTab[] = [];
  try { records = parseLocalTabs(JSON.parse(sessionValue(localTabsKey()) ?? 'null')); } catch { /* none */ }
  for (const record of records) {
    const file = localFiles.get(record.fileId);
    if (!file) { missing += 1; continue; }
    const tab = createTab({ url: null, hash: '', file, fileId: record.fileId });
    tab.title = record.title;
    tab.paperTitle = record.paperTitle;
    updateTabLabel(tab);
    insertTab(tab, record.index);
    if (record.active) front = tab;
  }
  localTabsRestored = true;
  if (missing) showToast(S.localFilesLost(missing));
  return front;
}
