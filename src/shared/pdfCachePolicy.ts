// ─── Local PDF file cache: policy (pure) ───
//
// The viewer keeps the bytes of every web PDF it opened in IndexedDB
// (db/pdfFileCache.ts), so reopening a paper — a reload, a restored hub, the
// same link clicked again, another URL of the same arXiv paper — renders from
// disk without touching the network. A local arXiv PDF the user already
// opened is stored the same way and serves that paper's web URLs. This module decides which URLs share a
// cached file, when a cached copy must be re-checked against the server, and
// what to evict. No IndexedDB, no fetch: unit-tested.

export const PDF_CACHE_MAX_BYTES = 1024 * 1024 * 1024; // 1 GiB
export const PDF_CACHE_MAX_FILES = 400;
/** Larger files are read from the network every time. */
export const PDF_CACHE_MAX_FILE_BYTES = 150 * 1024 * 1024;
/** A copy with ETag / Last-Modified is re-checked (a cheap 304) this often… */
export const PDF_CACHE_REVALIDATE_MS = 6 * 60 * 60 * 1000;
/** …and one without validators (a full re-download to compare) this often. */
export const PDF_CACHE_REVALIDATE_BLIND_MS = 7 * 24 * 60 * 60 * 1000;

const ARXIV_HOSTS = new Set(['arxiv.org', 'www.arxiv.org', 'export.arxiv.org']);
// /pdf/<id>[vN][.pdf]; new-style (2401.12345) and old-style (hep-th/9901001) ids.
const ARXIV_PDF_PATH = /^\/pdf\/((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[a-z]{2})?\/\d{7}))(v\d+)?(?:\.pdf)?\/?$/iu;

export interface PdfUrlEntry {
  /** An alias key from `pdfCacheAliases` (a normalized URL or `arxiv:…`). */
  alias: string;
  /** Content hash of the cached file (its key in the file store). */
  sha256: string;
  etag: string | null;
  lastModified: string | null;
  validatedAt: number;
  lastUsedAt: number;
}

export interface PdfFileStat {
  sha256: string;
  size: number;
  lastUsedAt: number;
}

function parse(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Keys under which a web PDF URL finds its cached file, most specific first.
 * Every URL keys by itself (fragment dropped); arXiv PDF URLs also key by the
 * paper — `arxiv:2401.12345v2` for a versioned one, which never changes, and
 * `arxiv:2401.12345` for a versionless one, which means "latest" and is
 * re-checked like any URL. The `.pdf` suffix, `www.`/`export.` hosts and
 * http/https variants all meet there. Local files are never cached.
 */
export function pdfCacheAliases(url: string): string[] {
  const parsed = parse(url);
  if (!parsed) return [];
  parsed.hash = '';
  const aliases = [`url:${parsed.href}`];
  if (ARXIV_HOSTS.has(parsed.hostname.toLowerCase())) {
    const match = ARXIV_PDF_PATH.exec(parsed.pathname);
    if (match) aliases.push(`arxiv:${match[1].toLowerCase()}${match[2]?.toLowerCase() ?? ''}`);
  }
  return aliases;
}

// arXiv's own watermark down the first page's margin:
// `arXiv:1706.03762v7 [cs.CL] 2 Aug 2023`. The id, version *and* category
// bracket are required: a bare `arXiv:…` on page 1 is usually a citation of
// some other paper, and matching on it would show the wrong file.
const ARXIV_STAMP = /arXiv:\s*((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(v\d+)\s*\[[a-z-]+(?:\.[A-Za-z-]+)?\]/u;

/**
 * Aliases a local file earns from its arXiv watermark, so the web URLs of
 * that paper find it: the exact version, and the versionless id (which means
 * "latest" — that match is re-checked against the server before it is
 * trusted for long; see `needsRevalidation`).
 */
export function arxivStampAliases(firstPageText: string): string[] {
  const match = ARXIV_STAMP.exec(firstPageText);
  if (!match) return [];
  const id = match[1].toLowerCase();
  return [`arxiv:${id}${match[2].toLowerCase()}`, `arxiv:${id}`];
}

/** True for an alias whose content can never change (a versioned arXiv id). */
export function isImmutableAlias(alias: string): boolean {
  return /^arxiv:.+v\d+$/u.test(alias);
}

export function needsRevalidation(entry: Pick<PdfUrlEntry, 'alias' | 'etag' | 'lastModified' | 'validatedAt'>, now: number): boolean {
  if (isImmutableAlias(entry.alias)) return false;
  const age = now - entry.validatedAt;
  return entry.etag || entry.lastModified ? age > PDF_CACHE_REVALIDATE_MS : age > PDF_CACHE_REVALIDATE_BLIND_MS;
}

/** Least-recently-used files to drop so the cache fits its budget after adding `incomingBytes`. */
export function pickEvictions(
  files: readonly PdfFileStat[],
  incomingBytes = 0,
  budget: { maxBytes: number; maxFiles: number } = { maxBytes: PDF_CACHE_MAX_BYTES, maxFiles: PDF_CACHE_MAX_FILES },
): string[] {
  const ordered = [...files].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  let bytes = files.reduce((sum, f) => sum + f.size, 0) + incomingBytes;
  let count = files.length + (incomingBytes > 0 ? 1 : 0);
  const evict: string[] = [];
  for (const file of ordered) {
    if (bytes <= budget.maxBytes && count <= budget.maxFiles) break;
    evict.push(file.sha256);
    bytes -= file.size;
    count -= 1;
  }
  return evict;
}
