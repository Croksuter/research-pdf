// ─── PDF document identity ───
//
// Per-document viewer state (reading position now; annotations later) must
// survive opening the same PDF from a different place: a local copy, the
// original URL, a drag-dropped file. The key is therefore derived from the
// document, not from where it came from.
//
// Primary key: PDF.js `fingerprints[0]`, the first element of the trailer
// `/ID`. The spec keeps that element constant across incremental updates, so
// a copy the user saved with annotations still resolves to the same record,
// and it costs no extra download on range-loaded web PDFs. Two safeguards:
//
//  1. The page count is part of the key. Page-split / extracted derivatives
//     produced by spec-following tools (qpdf, pdftk…) keep the original `/ID`
//     element, so without this a 3-page excerpt would inherit the reading
//     position and notes of the 40-page original. The second `/ID` element is
//     recorded for information only — our own annotation save changes it.
//  2. Weak fingerprints fall back to a SHA-256 of the whole file. PDF.js
//     substitutes an MD5 of the first 1 KB when `/ID` is missing, and some
//     legacy generators write a constant `/ID`; both collapse unrelated
//     documents onto one key. When the full bytes are at hand (local file,
//     drag-drop) the trailer is inspected directly, which also catches the
//     first-1 KB substitution that the fingerprint alone cannot reveal.
//
// The SHA-256, when computed, is kept as an alias so a byte-identical copy
// matches even if its fingerprint key differs (it never should, but the alias
// is free once the hash exists).

export const PDF_DOC_STATE_STORAGE_KEY = 'vtPdfDocs';
export const PDF_DOC_RECORD_MAX = 300;
export const PDF_DOC_RECORD_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
export const PDF_DOC_ID_MAX_CHARS = 128;
export const PDF_VIEWER_ZOOM_PATTERN = /^(?:auto|page-fit|page-width|page-actual|page-height|\d+(?:\.\d+)?)$/u;
const PDF_DOC_MAX_PAGES = 100_000;
const FINGERPRINT_HEX = /^[0-9a-f]{32}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
// A genuine `/ID` is 16 random-ish bytes whose 32 hex digits use ~14 distinct
// symbols on average; a constant like ffff… or 0123 0123… uses a handful.
const MIN_DISTINCT_HEX_DIGITS = 6;
const TRAILER_HEAD_BYTES = 4_096;
const TRAILER_TAIL_BYTES = 65_536;
// `/ID [<hex> <hex>]` or `/ID [(literal) (literal)]`, whitespace-tolerant.
const TRAILER_ID_PATTERN = /\/ID\s*\[\s*(?:<[0-9A-Fa-f\s]+>|\((?:\\.|[^\\)])*\))\s*(?:<[0-9A-Fa-f\s]+>|\((?:\\.|[^\\)])*\))\s*\]/u;

export interface PdfDocIdentity {
  docId: string;
  /** PDF.js `fingerprints[0]` (lower-case hex) — the original `/ID`. */
  fingerprint: string | null;
  /** PDF.js `fingerprints[1]` — the modified `/ID`; changes on every incremental save. */
  fingerprintModified: string | null;
  numPages: number;
  /** SHA-256 of the whole file when it was available; also an alias for lookups. */
  sha256: string | null;
}

export interface PdfDocRecord extends PdfDocIdentity {
  sourceUrl: string | null;
  fileName: string | null;
  page: number | null;
  zoom: string | null;
  updatedAt: number;
}

export type PdfDocRecords = Record<string, PdfDocRecord>;

export function isValidFingerprint(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT_HEX.test(value);
}

/** A fingerprint too low-entropy to identify a document (constant `/ID`). */
export function isWeakFingerprint(fingerprint: string | null): boolean {
  if (!isValidFingerprint(fingerprint)) return true;
  return new Set(fingerprint).size < MIN_DISTINCT_HEX_DIGITS;
}

/**
 * Whether the trailer carries a real two-element `/ID` array. When it does
 * not, PDF.js silently substitutes an MD5 of the first 1 KB, which the
 * fingerprint string itself does not reveal. Only the head (linearized
 * first-page trailer) and tail (main trailer / xref stream dict) are scanned.
 */
export function hasTrailerId(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return false;
  const regions: Uint8Array[] = bytes.byteLength <= TRAILER_HEAD_BYTES + TRAILER_TAIL_BYTES
    ? [bytes]
    : [bytes.subarray(0, TRAILER_HEAD_BYTES), bytes.subarray(bytes.byteLength - TRAILER_TAIL_BYTES)];
  for (const region of regions) {
    if (TRAILER_ID_PATTERN.test(latin1(region))) return true;
  }
  return false;
}

function latin1(bytes: Uint8Array): string {
  // Byte-preserving decode; TextDecoder('latin1') maps to windows-1252 which
  // remaps 0x80–0x9F, but that cannot create or destroy an ASCII `/ID [` match.
  let out = '';
  const CHUNK = 8_192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface PdfDocIdInput {
  fingerprint: string | null;
  numPages: number;
  sha256: string | null;
  /** False when the bytes were inspected and no trailer `/ID` was found. */
  trailerHasId?: boolean;
}

/**
 * Decides whether the fingerprint can serve as the key. The caller must
 * supply `sha256` when this returns false (it needs the full bytes).
 */
export function fingerprintIsUsable(input: Pick<PdfDocIdInput, 'fingerprint' | 'trailerHasId'>): boolean {
  if (isWeakFingerprint(input.fingerprint)) return false;
  return input.trailerHasId !== false;
}

export function buildPdfDocId(input: PdfDocIdInput): string | null {
  const numPages = Number.isInteger(input.numPages) && input.numPages >= 1 && input.numPages <= PDF_DOC_MAX_PAGES
    ? input.numPages
    : null;
  if (fingerprintIsUsable(input) && numPages !== null) return `fp:${input.fingerprint}:${numPages}`;
  if (input.sha256 && SHA256_HEX.test(input.sha256)) return `sha:${input.sha256}`;
  return null;
}

export function findPdfDocRecord(
  records: PdfDocRecords,
  lookup: { docId: string | null; sha256: string | null },
): PdfDocRecord | null {
  if (lookup.docId && records[lookup.docId]) return records[lookup.docId];
  if (lookup.sha256) {
    for (const record of Object.values(records)) {
      if (record.sha256 === lookup.sha256) return record;
    }
  }
  return null;
}

/**
 * Returns a new map with `record` stored under its docId. Expired and
 * least-recently-updated entries are pruned so the map stays bounded; a
 * record that only aliases the new one via sha256 is replaced.
 */
export function upsertPdfDocRecord(
  records: PdfDocRecords,
  record: PdfDocRecord,
  now: number = Date.now(),
  limits: { max?: number; maxAgeMs?: number } = {},
): PdfDocRecords {
  const max = limits.max ?? PDF_DOC_RECORD_MAX;
  const maxAgeMs = limits.maxAgeMs ?? PDF_DOC_RECORD_MAX_AGE_MS;
  const next: PdfDocRecords = {};
  for (const [key, existing] of Object.entries(records)) {
    if (key === record.docId) continue;
    if (now - existing.updatedAt > maxAgeMs) continue;
    if (record.sha256 && existing.sha256 === record.sha256) continue;
    next[key] = existing;
  }
  next[record.docId] = record;
  const keys = Object.keys(next);
  if (keys.length > max) {
    keys
      .filter((key) => key !== record.docId)
      .sort((a, b) => next[a].updatedAt - next[b].updatedAt)
      .slice(0, keys.length - max)
      .forEach((key) => { delete next[key]; });
  }
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePdfDocRecord(value: unknown): PdfDocRecord | null {
  if (!isRecord(value)) return null;
  const { docId, numPages, updatedAt } = value;
  if (typeof docId !== 'string' || !docId || docId.length > PDF_DOC_ID_MAX_CHARS) return null;
  if (!Number.isInteger(numPages) || (numPages as number) < 1 || (numPages as number) > PDF_DOC_MAX_PAGES) return null;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null;
  const fingerprint = isValidFingerprint(value.fingerprint) ? value.fingerprint : null;
  const fingerprintModified = isValidFingerprint(value.fingerprintModified) ? value.fingerprintModified : null;
  const sha256 = typeof value.sha256 === 'string' && SHA256_HEX.test(value.sha256) ? value.sha256 : null;
  const page = Number.isInteger(value.page) && (value.page as number) >= 1 && (value.page as number) <= PDF_DOC_MAX_PAGES
    ? value.page as number
    : null;
  const zoom = typeof value.zoom === 'string' && PDF_VIEWER_ZOOM_PATTERN.test(value.zoom) ? value.zoom : null;
  return {
    docId,
    fingerprint,
    fingerprintModified,
    numPages: numPages as number,
    sha256,
    sourceUrl: typeof value.sourceUrl === 'string' && value.sourceUrl ? value.sourceUrl : null,
    fileName: typeof value.fileName === 'string' && value.fileName ? value.fileName : null,
    page,
    zoom,
    updatedAt,
  };
}

/** Validates a stored map; malformed entries are dropped rather than failing the whole read. */
export function parsePdfDocRecords(value: unknown): PdfDocRecords {
  if (!isRecord(value)) return {};
  const out: PdfDocRecords = {};
  for (const [key, entry] of Object.entries(value)) {
    const record = parsePdfDocRecord(entry);
    if (record && record.docId === key) out[key] = record;
  }
  return out;
}
