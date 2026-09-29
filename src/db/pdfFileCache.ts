// ─── Local PDF file cache (IndexedDB) ───
//
// First layer of the viewer's storage: the bytes of web PDFs this device has
// opened, so a reopen never waits for the network. Files are stored once by
// content hash; any number of URL / arXiv aliases point at them (policy in
// shared/pdfCachePolicy.ts). Local files are stored the same way — bytes in
// here — when their arXiv watermark lets that paper's web URLs find them.
// Only this device reads it: nothing here is ever
// synced — Drive carries drawings and reading positions, not files.

import { STORE_PDF_FILE_BYTES, STORE_PDF_FILES, STORE_PDF_URLS } from '../shared/constants';
import {
  PDF_CACHE_MAX_FILE_BYTES,
  pdfCacheAliases,
  pickEvictions,
  type PdfFileStat,
  type PdfUrlEntry,
} from '../shared/pdfCachePolicy';
import { openDB } from './database';

interface PdfFileMeta extends PdfFileStat {
  storedAt: number;
}

interface PdfFileBytes {
  sha256: string;
  bytes: ArrayBuffer;
}

export interface CachedPdf {
  sha256: string;
  bytes: Uint8Array;
  /** The alias that matched (its validators drive revalidation). */
  entry: PdfUrlEntry;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** The cached copy for `url` (any of its aliases), marked as just used; null on a miss. */
export async function readCachedPdf(url: string, now = Date.now()): Promise<CachedPdf | null> {
  const aliases = pdfCacheAliases(url);
  if (aliases.length === 0) return null;
  const db = await openDB();
  const tx = db.transaction([STORE_PDF_URLS, STORE_PDF_FILES, STORE_PDF_FILE_BYTES], 'readwrite');
  const urls = tx.objectStore(STORE_PDF_URLS);
  const files = tx.objectStore(STORE_PDF_FILES);
  const blobs = tx.objectStore(STORE_PDF_FILE_BYTES);
  let hit: CachedPdf | null = null;
  for (const alias of aliases) {
    const entry = await result(urls.get(alias) as IDBRequest<PdfUrlEntry | undefined>);
    if (!entry) continue;
    const [meta, stored] = await Promise.all([
      result(files.get(entry.sha256) as IDBRequest<PdfFileMeta | undefined>),
      result(blobs.get(entry.sha256) as IDBRequest<PdfFileBytes | undefined>),
    ]);
    if (!meta || !stored) { urls.delete(alias); continue; }
    urls.put({ ...entry, lastUsedAt: now });
    files.put({ ...meta, lastUsedAt: now });
    hit = { sha256: entry.sha256, bytes: new Uint8Array(stored.bytes), entry };
    break;
  }
  await done(tx);
  return hit;
}

/**
 * Stores `bytes` for `url` (and `alsoUrls`, e.g. the URL a redirect ended
 * at), evicting least-recently-used files to stay within budget. Files over
 * the per-file cap are not cached. `paperAliases` (from the file's arXiv
 * watermark, `arxivStampAliases`) let that paper's web URLs find a file
 * opened from disk; they never take over an alias that already leads to a
 * different file, and a versionless one is re-checked on its first web use.
 */
export async function storeCachedPdf(input: {
  url: string;
  alsoUrls?: string[];
  paperAliases?: string[];
  bytes: Uint8Array;
  sha256: string;
  etag: string | null;
  lastModified: string | null;
  now?: number;
}): Promise<boolean> {
  const now = input.now ?? Date.now();
  const aliases = [...new Set([input.url, ...(input.alsoUrls ?? [])].flatMap(pdfCacheAliases))];
  const paperAliases = (input.paperAliases ?? []).filter((alias) => !aliases.includes(alias));
  const size = input.bytes.byteLength;
  if (aliases.length + paperAliases.length === 0 || size === 0 || size > PDF_CACHE_MAX_FILE_BYTES) return false;
  const db = await openDB();
  const tx = db.transaction([STORE_PDF_URLS, STORE_PDF_FILES, STORE_PDF_FILE_BYTES], 'readwrite');
  const urls = tx.objectStore(STORE_PDF_URLS);
  const files = tx.objectStore(STORE_PDF_FILES);
  const blobs = tx.objectStore(STORE_PDF_FILE_BYTES);
  const all = await result(files.getAll() as IDBRequest<PdfFileMeta[]>);
  const existing = all.find((f) => f.sha256 === input.sha256);
  const others = all.filter((f) => f.sha256 !== input.sha256);
  for (const sha256 of pickEvictions(others, existing ? 0 : size)) {
    files.delete(sha256);
    blobs.delete(sha256);
    const orphaned = await result(urls.index('by_sha256').getAllKeys(sha256));
    for (const alias of orphaned) urls.delete(alias);
  }
  if (!existing) {
    // A copy, so the caller's buffer can go on to PDF.js (which transfers it).
    blobs.put({ sha256: input.sha256, bytes: input.bytes.slice().buffer } satisfies PdfFileBytes);
  }
  files.put({ sha256: input.sha256, size, storedAt: existing?.storedAt ?? now, lastUsedAt: now } satisfies PdfFileMeta);
  for (const alias of aliases) {
    urls.put({ alias, sha256: input.sha256, etag: input.etag, lastModified: input.lastModified, validatedAt: now, lastUsedAt: now } satisfies PdfUrlEntry);
  }
  for (const alias of paperAliases) {
    const current = await result(urls.get(alias) as IDBRequest<PdfUrlEntry | undefined>);
    if (current) {
      if (current.sha256 === input.sha256) urls.put({ ...current, lastUsedAt: now });
      continue;
    }
    urls.put({ alias, sha256: input.sha256, etag: null, lastModified: null, validatedAt: 0, lastUsedAt: now } satisfies PdfUrlEntry);
  }
  await done(tx);
  return true;
}

/** Records a successful revalidation (304, or 200 with the same bytes). */
export async function markPdfValidated(alias: string, validators: { etag: string | null; lastModified: string | null }, now = Date.now()): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_PDF_URLS, 'readwrite');
  const urls = tx.objectStore(STORE_PDF_URLS);
  const entry = await result(urls.get(alias) as IDBRequest<PdfUrlEntry | undefined>);
  if (entry) {
    urls.put({
      ...entry,
      etag: validators.etag ?? entry.etag,
      lastModified: validators.lastModified ?? entry.lastModified,
      validatedAt: now,
    } satisfies PdfUrlEntry);
  }
  await done(tx);
}

/** True when a copy for `url` exists (without touching it). */
export async function hasCachedPdf(url: string): Promise<boolean> {
  const db = await openDB();
  const tx = db.transaction(STORE_PDF_URLS, 'readonly');
  const urls = tx.objectStore(STORE_PDF_URLS);
  for (const alias of pdfCacheAliases(url)) {
    if (await result(urls.count(alias)) > 0) return true;
  }
  return false;
}

export async function pdfFileCacheUsage(): Promise<{ files: number; bytes: number }> {
  const db = await openDB();
  const tx = db.transaction(STORE_PDF_FILES, 'readonly');
  const all = await result(tx.objectStore(STORE_PDF_FILES).getAll() as IDBRequest<PdfFileMeta[]>);
  return { files: all.length, bytes: all.reduce((sum, f) => sum + f.size, 0) };
}

export async function clearPdfFileCache(): Promise<void> {
  const db = await openDB();
  const tx = db.transaction([STORE_PDF_URLS, STORE_PDF_FILES, STORE_PDF_FILE_BYTES], 'readwrite');
  tx.objectStore(STORE_PDF_URLS).clear();
  tx.objectStore(STORE_PDF_FILES).clear();
  tx.objectStore(STORE_PDF_FILE_BYTES).clear();
  await done(tx);
}
