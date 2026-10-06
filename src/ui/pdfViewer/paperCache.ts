// ─── Paper lookup cache (IndexedDB) ───
//
// What the paper strip and its reference list fetched (paper records,
// reference lists), kept for a week and bounded: the least recently used
// entries go first. A database of its own, so it never competes with the
// viewer's main one (drawings, file cache) for upgrades, and never with
// chrome.storage.local, whose quota holds positions, the library and
// projects. Best effort throughout: a failure is a miss.
//
// Earlier builds kept these under `vtPaperMeta:*` / `vtPaperRefs:*` keys in
// chrome.storage.local, unbounded; those are removed once.

const DB_NAME = 'ResearchPDF-papers';
const DB_VERSION = 1;
const STORE = 'entries';
const BY_USED = 'by_usedAt';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PAPER_CACHE_MAX_ENTRIES = 600;
// The store is trimmed every this many writes, not on each.
const TRIM_EVERY = 20;
const MIGRATED_KEY = '__migrated:storage.local';
const LEGACY_PREFIXES = ['vtPaperMeta:', 'vtPaperRefs:'];

interface Row {
  key: string;
  value: unknown;
  fetchedAt: number;
  usedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let writes = 0;
let migration: Promise<void> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' }).createIndex(BY_USED, 'usedAt', { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  }).catch((error: unknown) => { dbPromise = null; throw error; });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

/** The cached value under `key` if younger than the TTL (and marks it used); null otherwise. */
export async function readPaperCache<T>(key: string, now = Date.now()): Promise<T | null> {
  try {
    void migrateLegacyPaperCache();
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const row = await new Promise<Row | undefined>((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result as Row | undefined);
      request.onerror = () => reject(request.error);
    });
    if (!row) return null;
    if (now - row.fetchedAt > TTL_MS) {
      store.delete(key);
      await done(tx);
      return null;
    }
    store.put({ ...row, usedAt: now });
    await done(tx);
    return row.value as T;
  } catch {
    return null;
  }
}

export async function writePaperCache(key: string, value: unknown, now = Date.now()): Promise<void> {
  try {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ key, value, fetchedAt: now, usedAt: now } satisfies Row);
    await done(tx);
    writes += 1;
    if (writes % TRIM_EVERY === 1) await trimPaperCache(PAPER_CACHE_MAX_ENTRIES, now);
  } catch {
    /* best effort */
  }
}

export async function dropPaperCache(key: string): Promise<void> {
  try {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    await done(tx);
  } catch {
    /* best effort */
  }
}

/** Drops expired entries, then the least recently used beyond `max`. Returns how many went. */
export async function trimPaperCache(max = PAPER_CACHE_MAX_ENTRIES, now = Date.now()): Promise<number> {
  const db = await open();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const count = (query?: IDBValidKey) => new Promise<number>((resolve, reject) => {
    const request = store.count(query);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  // (The migration marker is not an entry.)
  const total = await count() - await count(MIGRATED_KEY);
  let removed = 0;
  let keep = total;
  await new Promise<void>((resolve, reject) => {
    // Oldest use first: expired rows and the overflow both sit at the front.
    const request = store.index(BY_USED).openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(); return; }
      const row = cursor.value as Row;
      if ((keep > max || now - row.fetchedAt > TTL_MS) && row.key !== MIGRATED_KEY) {
        cursor.delete();
        removed += 1;
        keep -= 1;
        cursor.continue();
      } else {
        // Within the cap, and from here on used more recently. An expired row
        // further on goes when it is read, or once it is among the oldest.
        resolve();
      }
    };
  });
  await done(tx);
  return removed;
}

/** Removes the old chrome.storage.local copies of these caches, once per profile. */
export function migrateLegacyPaperCache(): Promise<void> {
  migration ??= (async () => {
    try {
      const db = await open();
      const seen = await new Promise<boolean>((resolve) => {
        const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(MIGRATED_KEY);
        request.onsuccess = () => resolve(!!request.result);
        request.onerror = () => resolve(false);
      });
      if (seen || typeof chrome === 'undefined' || !chrome.storage?.local) return;
      const local = chrome.storage.local as chrome.storage.LocalStorageArea & { getKeys?: () => Promise<string[]> };
      const keys = typeof local.getKeys === 'function' ? await local.getKeys() : Object.keys(await local.get(null));
      const legacy = keys.filter((key) => LEGACY_PREFIXES.some((prefix) => key.startsWith(prefix)));
      if (legacy.length) await local.remove(legacy);
      const tx = db.transaction(STORE, 'readwrite');
      // Never expires and never counts as least recently used (see trimPaperCache).
      tx.objectStore(STORE).put({ key: MIGRATED_KEY, value: legacy.length, fetchedAt: Number.MAX_SAFE_INTEGER, usedAt: Number.MAX_SAFE_INTEGER } satisfies Row);
      await done(tx);
    } catch {
      migration = null; // tried again on the next read
    }
  })();
  return migration;
}

/** For tests: forgets the open connection and the per-page state. */
export function resetPaperCacheForTests(): void {
  void dbPromise?.then((db) => db.close()).catch(() => undefined);
  dbPromise = null;
  migration = null;
  writes = 0;
}
