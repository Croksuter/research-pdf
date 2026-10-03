// ─── Library: every document the hub has shown (pure) ───
//
// One row per document identity (`docId`, shared/pdfIdentity.ts): the URLs it
// was opened from, its names, when it was last opened and whether it is
// pinned. The hub's home page lists it and pinned rows become tabs in every
// hub. Reading positions and drawings stay in their own records; the home page
// joins them in by `docId`, nothing is stored twice.
//
// Stored in chrome.storage.local (written by the background only, see
// background/pdfLibraryStore.ts) and synced through Drive with the rest of the
// viewer's state. The merge is a join — per field, never a deletion — so it
// can be applied over local rows at any time without losing a concurrent
// write: the most recent open wins the names, the latest pin change wins the
// pin, URLs are unioned. Every device then applies the same bounds.

export const PDF_LIBRARY_STORAGE_KEY = 'rpdfLibrary';
export const PDF_LIBRARY_MAX = 1_000;
export const PDF_LIBRARY_MAX_PINNED = 100;
export const PDF_LIBRARY_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
export const PDF_LIBRARY_MAX_URLS = 5;
const DOC_ID_MAX_CHARS = 128;
const URL_MAX_CHARS = 2_048;
const TEXT_MAX_CHARS = 300;
const MAX_PAGES = 100_000;

export interface PdfLibraryEntry {
  docId: string;
  /** Source URLs (http, https or file), most recent first, without fragment. */
  urls: string[];
  fileName: string | null;
  /** The PDF's own Title metadata. */
  docTitle: string | null;
  /** Detected paper title and venue (paper strip). */
  title: string | null;
  venue: string | null;
  year: number | null;
  numPages: number;
  openedAt: number;
  pinned: boolean;
  /** When `pinned` last changed (0 = never): the latest change wins a merge. */
  pinChangedAt: number;
}

export type PdfLibrary = Record<string, PdfLibraryEntry>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A source URL the library keeps: http(s) or file, fragment dropped. */
export function librarySourceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > URL_MAX_CHARS) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'file:') return null;
    parsed.hash = '';
    return parsed.href;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, TEXT_MAX_CHARS) : null;
}

function time(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function parsePdfLibraryEntry(value: unknown): PdfLibraryEntry | null {
  if (!isRecord(value)) return null;
  const { docId, numPages } = value;
  if (typeof docId !== 'string' || !docId || docId.length > DOC_ID_MAX_CHARS) return null;
  if (!Number.isInteger(numPages) || (numPages as number) < 1 || (numPages as number) > MAX_PAGES) return null;
  const openedAt = time(value.openedAt);
  const pinChangedAt = time(value.pinChangedAt);
  if (openedAt === null || pinChangedAt === null || typeof value.pinned !== 'boolean' || !Array.isArray(value.urls)) return null;
  const urls = [...new Set(value.urls.map(librarySourceUrl).filter((url): url is string => url !== null))].slice(0, PDF_LIBRARY_MAX_URLS);
  const year = Number.isInteger(value.year) && (value.year as number) > 0 && (value.year as number) < 10_000 ? value.year as number : null;
  return {
    docId,
    urls,
    fileName: text(value.fileName),
    docTitle: text(value.docTitle),
    title: text(value.title),
    venue: text(value.venue),
    year,
    numPages: numPages as number,
    openedAt,
    pinned: value.pinned,
    pinChangedAt,
  };
}

export function parsePdfLibrary(value: unknown): PdfLibrary {
  if (!isRecord(value)) return {};
  const out: PdfLibrary = {};
  for (const [key, raw] of Object.entries(value)) {
    const entry = parsePdfLibraryEntry(raw);
    if (entry && entry.docId === key) out[key] = entry;
  }
  return out;
}

/** Strict list form (sync snapshot): one bad row refuses the whole list. */
export function parsePdfLibraryList(value: unknown, max: number): PdfLibraryEntry[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const seen = new Set<string>();
  const out: PdfLibraryEntry[] = [];
  for (const raw of value) {
    const entry = parsePdfLibraryEntry(raw);
    if (!entry || seen.has(entry.docId)) return null;
    seen.add(entry.docId);
    out.push(entry);
  }
  return out;
}

export function libraryEntryUpdatedAt(entry: PdfLibraryEntry): number {
  return Math.max(entry.openedAt, entry.pinChangedAt);
}

// A total order on two rows of one document, so both sides of a merge pick
// the same one whatever their order.
function order(a: PdfLibraryEntry, b: PdfLibraryEntry, key: (e: PdfLibraryEntry) => number): [PdfLibraryEntry, PdfLibraryEntry] {
  const ka = key(a);
  const kb = key(b);
  if (ka !== kb) return ka > kb ? [a, b] : [b, a];
  return JSON.stringify(a) >= JSON.stringify(b) ? [a, b] : [b, a];
}

/** Joins two rows of the same document; commutative and idempotent. */
export function mergePdfLibraryEntries(a: PdfLibraryEntry, b: PdfLibraryEntry): PdfLibraryEntry {
  const [newer, older] = order(a, b, (e) => e.openedAt);
  const [pin] = order(a, b, (e) => e.pinChangedAt * 2 + (e.pinned ? 1 : 0));
  return {
    docId: newer.docId,
    urls: [...new Set([...newer.urls, ...older.urls])].slice(0, PDF_LIBRARY_MAX_URLS),
    fileName: newer.fileName ?? older.fileName,
    docTitle: newer.docTitle ?? older.docTitle,
    title: newer.title ?? older.title,
    venue: newer.venue ?? older.venue,
    year: newer.year ?? older.year,
    numPages: newer.numPages,
    openedAt: newer.openedAt,
    pinned: pin.pinned,
    pinChangedAt: pin.pinChangedAt,
  };
}

/**
 * The rows kept: the ones a project refers to (`keep`, shared/pdfProjects.ts)
 * and legacy pins (the most recently changed first, up to a cap), then the
 * most recently opened within the age limit. Sorted by `docId`.
 */
export function boundPdfLibrary(entries: readonly PdfLibraryEntry[], now: number = Date.now(), keep: ReadonlySet<string> = new Set()): PdfLibraryEntry[] {
  const pinned = entries
    .filter((e) => e.pinned || keep.has(e.docId))
    .sort((a, b) => Number(keep.has(b.docId)) - Number(keep.has(a.docId)) || b.pinChangedAt - a.pinChangedAt || b.openedAt - a.openedAt || a.docId.localeCompare(b.docId))
    .slice(0, Math.max(PDF_LIBRARY_MAX_PINNED, Math.min(keep.size, PDF_LIBRARY_MAX)));
  const kept = new Set(pinned.map((e) => e.docId));
  const recent = entries
    .filter((e) => !kept.has(e.docId) && now - e.openedAt <= PDF_LIBRARY_MAX_AGE_MS)
    .sort((a, b) => b.openedAt - a.openedAt || a.docId.localeCompare(b.docId))
    .slice(0, Math.max(0, PDF_LIBRARY_MAX - pinned.length));
  return [...pinned, ...recent].sort((a, b) => a.docId.localeCompare(b.docId));
}

export function mergePdfLibraries(left: readonly PdfLibraryEntry[], right: readonly PdfLibraryEntry[], now: number = Date.now(), keep: ReadonlySet<string> = new Set()): PdfLibraryEntry[] {
  const byId = new Map<string, PdfLibraryEntry>();
  for (const entry of [...left, ...right]) {
    const existing = byId.get(entry.docId);
    byId.set(entry.docId, existing ? mergePdfLibraryEntries(existing, entry) : entry);
  }
  return boundPdfLibrary([...byId.values()], now, keep);
}

export function libraryFromList(entries: readonly PdfLibraryEntry[]): PdfLibrary {
  return Object.fromEntries(entries.map((e) => [e.docId, e]));
}

// ─── Updates (applied by the background's serialized writer) ───

export type PdfLibraryUpdate =
  | { kind: 'opened'; docId: string; url: string | null; fileName: string | null; numPages: number }
  // Names found after opening: the PDF's Title metadata, the detected paper.
  // Null leaves a field as it was.
  | { kind: 'meta'; docId: string; docTitle: string | null; title: string | null; venue: string | null; year: number | null }
  | { kind: 'pin'; docId: string; pinned: boolean };

export function applyPdfLibraryUpdate(library: PdfLibrary, update: PdfLibraryUpdate, now: number = Date.now(), keep: ReadonlySet<string> = new Set()): PdfLibrary {
  const current = library[update.docId];
  let next: PdfLibraryEntry | null = null;
  if (update.kind === 'opened') {
    const url = librarySourceUrl(update.url);
    next = {
      docId: update.docId,
      urls: [...new Set([...(url ? [url] : []), ...(current?.urls ?? [])])].slice(0, PDF_LIBRARY_MAX_URLS),
      fileName: text(update.fileName) ?? current?.fileName ?? null,
      docTitle: current?.docTitle ?? null,
      title: current?.title ?? null,
      venue: current?.venue ?? null,
      year: current?.year ?? null,
      numPages: update.numPages,
      openedAt: Math.max(now, current?.openedAt ?? 0),
      pinned: current?.pinned ?? false,
      pinChangedAt: current?.pinChangedAt ?? 0,
    };
  } else if (!current) {
    return library; // meta and pins only ever apply to a document that was opened
  } else if (update.kind === 'meta') {
    next = {
      ...current,
      docTitle: text(update.docTitle) ?? current.docTitle,
      title: text(update.title) ?? current.title,
      venue: text(update.venue) ?? current.venue,
      year: update.year ?? current.year,
    };
  } else {
    if (current.pinned === update.pinned) return library;
    next = { ...current, pinned: update.pinned, pinChangedAt: Math.max(now, current.pinChangedAt + 1) };
  }
  const entries = Object.values({ ...library, [next.docId]: next });
  return libraryFromList(boundPdfLibrary(entries, now, keep));
}

export function parsePdfLibraryUpdate(value: unknown): PdfLibraryUpdate | null {
  if (!isRecord(value) || typeof value.docId !== 'string' || !value.docId || value.docId.length > DOC_ID_MAX_CHARS) return null;
  const { docId } = value;
  switch (value.kind) {
    case 'opened': {
      const numPages = value.numPages;
      if (!Number.isInteger(numPages) || (numPages as number) < 1 || (numPages as number) > MAX_PAGES) return null;
      if (value.url !== null && librarySourceUrl(value.url) === null) return null;
      return { kind: 'opened', docId, url: value.url as string | null, fileName: text(value.fileName), numPages: numPages as number };
    }
    case 'meta': {
      const year = Number.isInteger(value.year) && (value.year as number) > 0 && (value.year as number) < 10_000 ? value.year as number : null;
      return { kind: 'meta', docId, docTitle: text(value.docTitle), title: text(value.title), venue: text(value.venue), year };
    }
    case 'pin':
      return typeof value.pinned === 'boolean' ? { kind: 'pin', docId, pinned: value.pinned } : null;
    default:
      return null;
  }
}

// ─── Display helpers (home page) ───

/** Pinned rows the hub can open as tabs, in pin order (oldest pin leftmost). */
export function pinnedLibraryEntries(library: PdfLibrary): PdfLibraryEntry[] {
  return Object.values(library)
    .filter((e) => e.pinned)
    .sort((a, b) => a.pinChangedAt - b.pinChangedAt || a.docId.localeCompare(b.docId));
}

/** The name a row is listed under: the paper, the PDF's title, the file. */
export function libraryEntryName(entry: PdfLibraryEntry, displayName: (url: string) => string): string {
  return entry.title ?? entry.docTitle ?? entry.fileName ?? (entry.urls[0] ? displayName(entry.urls[0]) : 'PDF');
}

/** Rows matching every word of `query` in a title, file name or URL; most recent first. */
export function searchPdfLibrary(entries: readonly PdfLibraryEntry[], query: string): PdfLibraryEntry[] {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const sorted = [...entries].sort((a, b) => b.openedAt - a.openedAt);
  if (words.length === 0) return sorted;
  return sorted.filter((e) => {
    const hay = [e.title, e.docTitle, e.fileName, e.venue, ...e.urls.map(safeDecode)].filter(Boolean).join('\n').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

function safeDecode(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

/** "방금", "5분 전", "3시간 전", "2일 전", then a date. */
export function relativeTimeKo(then: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - then);
  const minute = 60_000;
  if (diff < minute) return '방금';
  if (diff < 60 * minute) return `${Math.floor(diff / minute)}분 전`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))}시간 전`;
  if (diff < 7 * 24 * 60 * minute) return `${Math.floor(diff / (24 * 60 * minute))}일 전`;
  const date = new Date(then);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return sameYear ? `${date.getMonth() + 1}월 ${date.getDate()}일` : `${date.getFullYear()}. ${date.getMonth() + 1}. ${date.getDate()}.`;
}
