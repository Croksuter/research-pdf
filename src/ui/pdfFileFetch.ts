// ─── Web PDF fetches around the local file cache ───
//
// Used by the viewer (store after a first open, revalidate after a cached
// open) and the hub (prefetch documents that are not on screen yet). Runs in
// extension pages, which fetch cross-origin with the granted host access —
// the same access the viewer itself loads PDFs with.

import { DEFAULT_PDF_FILE_CACHE_ENABLED, PDF_FILE_CACHE_ENABLED_SETTING_KEY } from '../shared/constants';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PDF_CACHE_MAX_FILE_BYTES, arxivStampAliases, needsRevalidation } from '../shared/pdfCachePolicy';
import { sha256Hex } from '../shared/pdfIdentity';
import { getSetting } from '../db/settingsRepository';
import { hasCachedPdf, markPdfValidated, storeCachedPdf, type CachedPdf } from '../db/pdfFileCache';
import { debugLog } from '../shared/debugLog';

export type FetchedPdf =
  | { status: 'ok'; bytes: Uint8Array; etag: string | null; lastModified: string | null; finalUrl: string }
  | { status: 'not-modified'; etag: string | null; lastModified: string | null }
  | { status: 'failed' };

export async function pdfFileCacheEnabled(): Promise<boolean> {
  try {
    return await getSetting(PDF_FILE_CACHE_ENABLED_SETTING_KEY, DEFAULT_PDF_FILE_CACHE_ENABLED);
  } catch {
    return false;
  }
}

function looksLikePdf(bytes: Uint8Array): boolean {
  // `%PDF-` within the first KiB (some servers prepend junk; PDF.js allows it).
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

/** GET with optional validators; never throws. Refuses non-PDF bodies (login pages) and oversize files. */
export async function fetchPdf(url: string, validators?: { etag: string | null; lastModified: string | null }): Promise<FetchedPdf> {
  try {
    const headers: Record<string, string> = {};
    if (validators?.etag) headers['If-None-Match'] = validators.etag;
    if (validators?.lastModified) headers['If-Modified-Since'] = validators.lastModified;
    const response = await fetch(url, { headers, cache: validators ? 'no-cache' : 'default', redirect: 'follow' });
    const etag = response.headers.get('etag');
    const lastModified = response.headers.get('last-modified');
    if (response.status === 304) return { status: 'not-modified', etag, lastModified };
    if (!response.ok) return { status: 'failed' };
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > PDF_CACHE_MAX_FILE_BYTES) {
      void response.body?.cancel();
      return { status: 'failed' };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > PDF_CACHE_MAX_FILE_BYTES || !looksLikePdf(bytes)) return { status: 'failed' };
    return { status: 'ok', bytes, etag, lastModified, finalUrl: response.url || url };
  } catch {
    return { status: 'failed' };
  }
}

/** Paper aliases from the arXiv watermark on page 1 (see `arxivStampAliases`). */
export async function paperAliasesOf(doc: PDFDocumentProxy): Promise<string[]> {
  try {
    const content = await (await doc.getPage(1)).getTextContent();
    return arxivStampAliases((content.items as Array<{ str?: unknown }>).map((item) => (typeof item.str === 'string' ? item.str : '')).join(' '));
  } catch {
    return [];
  }
}

/** Stores bytes the viewer already holds (a first open finished downloading, or a local file). */
export async function cachePdfBytes(
  url: string,
  bytes: Uint8Array,
  validators?: { etag: string | null; lastModified: string | null; finalUrl?: string },
  paperAliases: string[] = [],
): Promise<string | null> {
  if (!(await pdfFileCacheEnabled())) return null;
  try {
    const sha256 = await sha256Hex(bytes);
    const stored = await storeCachedPdf({
      url,
      alsoUrls: validators?.finalUrl && validators.finalUrl !== url ? [validators.finalUrl] : [],
      paperAliases,
      bytes,
      sha256,
      etag: validators?.etag ?? null,
      lastModified: validators?.lastModified ?? null,
    });
    debugLog('cache', stored ? 'stored' : 'not stored', () => ({ url, bytes: bytes.byteLength, paperAliases }));
    return stored ? sha256 : null;
  } catch {
    return null; // quota or a closed database: the cache is an optimisation only
  }
}

/**
 * The validators for a URL the viewer just downloaded through PDF.js (which
 * does not expose response headers): one HEAD request, which also reveals
 * where a redirect ended so that URL finds the same copy.
 */
export async function headValidators(url: string): Promise<{ etag: string | null; lastModified: string | null; finalUrl: string }> {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (!response.ok) return { etag: null, lastModified: null, finalUrl: url };
    return { etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'), finalUrl: response.url || url };
  } catch {
    return { etag: null, lastModified: null, finalUrl: url };
  }
}

/** Downloads `url` into the cache unless it is there already. */
export async function prefetchPdf(url: string): Promise<boolean> {
  if (!(await pdfFileCacheEnabled()) || await hasCachedPdf(url).catch(() => true)) return false;
  const fetched = await fetchPdf(url);
  if (fetched.status !== 'ok') return false;
  debugLog('cache', 'prefetched', () => ({ url }));
  return (await cachePdfBytes(url, fetched.bytes, fetched)) !== null;
}

/**
 * Checks a cached copy against the server when it is due (policy in
 * shared/pdfCachePolicy.ts). `changed` means a different file was stored:
 * the next open shows it.
 */
export async function revalidateCachedPdf(url: string, cached: CachedPdf): Promise<'fresh' | 'changed' | 'skipped' | 'failed'> {
  if (!needsRevalidation(cached.entry, Date.now())) return 'skipped';
  const fetched = await fetchPdf(url, cached.entry);
  if (fetched.status === 'failed') return 'failed';
  if (fetched.status === 'not-modified') {
    await markPdfValidated(cached.entry.alias, fetched).catch(() => undefined);
    return 'fresh';
  }
  const sha256 = await sha256Hex(fetched.bytes);
  if (sha256 === cached.sha256) {
    await markPdfValidated(cached.entry.alias, fetched).catch(() => undefined);
    return 'fresh';
  }
  await cachePdfBytes(url, fetched.bytes, fetched);
  debugLog('cache', 'server copy changed', () => ({ url }));
  return 'changed';
}
