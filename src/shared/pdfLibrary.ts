// ─── Library: every document the hub has shown (pure) ───
//
// One row per document identity (`docId`, shared/pdfIdentity.ts): the URLs it
// was opened from, its names and when it was last opened. The hub's home page
// lists it. Reading positions and drawings stay in their own records; the
// home page joins them in by `docId`, nothing is stored twice. Pins belong to
// projects now (shared/pdfProjects.ts); a row's own `pinned` is what an older
// build stored, kept and merged so the first project record can be seeded
// from it.
//
// Stored in chrome.storage.local (written by the background only, see
// background/pdfLibraryStore.ts) and synced through Drive with the rest of the
// viewer's state. The merge is a join — per field, never a deletion — so it
// can be applied over local rows at any time without losing a concurrent
// write: the most recent open wins the names, the latest pin change wins the
// pin, the latest choice of kind wins it, URLs are unioned. Every device then
// applies the same bounds.
//
// A document's kind — a journal or conference paper, a preprint, a survey, a
// report, or a plain PDF — is what the paper strip found it to be, unless the
// user said otherwise. The hub draws it as the document's icon.
//
// What the user writes about a document follows it too, each the latest
// change wins: the name they gave it, a note with links, and the copy they
// keep in their own Drive folder (background/pdfDriveFiles.ts).

import { S } from './shared.strings';
import { isRecord } from './guards';

export const PDF_LIBRARY_STORAGE_KEY = 'rpdfLibrary';
export const PDF_LIBRARY_MAX = 1_000;
export const PDF_LIBRARY_MAX_PINNED = 100;
export const PDF_LIBRARY_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
export const PDF_LIBRARY_MAX_URLS = 5;
const DOC_ID_MAX_CHARS = 128;
const URL_MAX_CHARS = 2_048;
const TEXT_MAX_CHARS = 300;
const MAX_PAGES = 100_000;
export const PDF_NOTE_MAX_CHARS = 4_000;
export const PDF_LINKS_MAX = 12;
const DRIVE_ID_MAX_CHARS = 200;

/** Paper kinds, as the paper strip classifies them (classifyPaperKind). */
export const PDF_PAPER_KINDS = ['journal', 'conference', 'preprint', 'survey', 'technical'] as const;
export type PdfPaperKind = typeof PDF_PAPER_KINDS[number];
/** What the user can set: a paper kind, or 'document' (not a paper). */
export type PdfDocKind = PdfPaperKind | 'document';

export function isPdfPaperKind(value: unknown): value is PdfPaperKind {
  return typeof value === 'string' && (PDF_PAPER_KINDS as readonly string[]).includes(value);
}

export function isPdfDocKind(value: unknown): value is PdfDocKind {
  return value === 'document' || isPdfPaperKind(value);
}

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
  /** What the paper strip found it to be; null: not identified as a paper. */
  paperKind: PdfPaperKind | null;
  /** The user's choice over `paperKind` (null: automatic). */
  userKind: PdfDocKind | null;
  /** When `userKind` last changed (0 = never). */
  userKindAt: number;
  /** The name the user gave it (null: automatic), and when (0 = never). */
  userTitle: string | null;
  userTitleAt: number;
  /** The user's note and links (web, file or a local path), and when they last changed. */
  note: string | null;
  links: string[];
  noteAt: number;
  /** Its copy in the user's Drive folder (null: none), and when that last changed. */
  driveFileId: string | null;
  driveAt: number;
}

export type PdfUserFields = Pick<PdfLibraryEntry, 'userTitle' | 'userTitleAt' | 'note' | 'links' | 'noteAt' | 'driveFileId' | 'driveAt'>;

/** The user's fields of a row nobody named, noted or stored yet. */
export function noUserFields(): PdfUserFields {
  return { userTitle: null, userTitleAt: 0, note: null, links: [], noteAt: 0, driveFileId: null, driveAt: 0 };
}

/** The kind a row is shown as: the user's choice, else the detected one, else a plain PDF. */
export function libraryEntryKind(entry: Pick<PdfLibraryEntry, 'paperKind' | 'userKind'>): PdfDocKind {
  return entry.userKind ?? entry.paperKind ?? 'document';
}

export type PdfLibrary = Record<string, PdfLibraryEntry>;


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

function text(value: unknown, max = TEXT_MAX_CHARS): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

/**
 * A link the user keeps with a document: an http(s) or file URL, or an
 * absolute local path (`/home/…`, `C:\…`, `\\server\…`) kept as written.
 */
export function pdfNoteLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const link = value.trim();
  if (!link || link.length > URL_MAX_CHARS) return null;
  if (/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(link)) return link;
  try {
    const parsed = new URL(link);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'file:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** The URL a kept link opens: itself, or a local path as a file URL. */
export function noteLinkUrl(link: string): string {
  if (/^[A-Za-z]:[\\/]/u.test(link)) return `file:///${link.replace(/\\/gu, '/').split('/').map((part, i) => (i === 0 ? part : encodeURIComponent(part))).join('/')}`;
  if (link.startsWith('\\\\')) return `file://${link.slice(2).replace(/\\/gu, '/').split('/').map(encodeURIComponent).join('/')}`;
  if (link.startsWith('/')) return `file://${link.split('/').map(encodeURIComponent).join('/')}`;
  return link;
}

/** A local path of a file URL (`/home/…`, `C:\…`), for showing; other URLs as they are. */
export function readableSource(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return safeDecode(url);
    const path = decodeURIComponent(parsed.pathname);
    if (/^\/[A-Za-z]:\//u.test(path)) return path.slice(1).replace(/\//gu, '\\');
    return parsed.host ? `\\\\${parsed.host}${path.replace(/\//gu, '\\')}` : path;
  } catch {
    return url;
  }
}

function noteLinks(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.map(pdfNoteLink).filter((l): l is string => l !== null))].slice(0, PDF_LINKS_MAX);
}

function driveId(value: unknown): string | null {
  return typeof value === 'string' && /^[\w-]{10,200}$/u.test(value) && value.length <= DRIVE_ID_MAX_CHARS ? value : null;
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
  // Kinds came later, and later still the user's name, note and Drive copy: rows without them read as never set.
  const stamp = (v: unknown) => (v === undefined ? 0 : time(v));
  const userKindAt = stamp(value.userKindAt);
  const userTitleAt = stamp(value.userTitleAt);
  const noteAt = stamp(value.noteAt);
  const driveAt = stamp(value.driveAt);
  if (userKindAt === null || userTitleAt === null || noteAt === null || driveAt === null) return null;
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
    paperKind: isPdfPaperKind(value.paperKind) ? value.paperKind : null,
    userKind: isPdfDocKind(value.userKind) ? value.userKind : null,
    userKindAt,
    userTitle: text(value.userTitle),
    userTitleAt,
    note: text(value.note, PDF_NOTE_MAX_CHARS),
    links: noteLinks(value.links) ?? [],
    noteAt,
    driveFileId: driveId(value.driveFileId),
    driveAt,
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
  const [chosen] = order(a, b, (e) => e.userKindAt);
  const [named] = order(a, b, (e) => e.userTitleAt);
  const [noted] = order(a, b, (e) => e.noteAt);
  const [stored] = order(a, b, (e) => e.driveAt);
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
    paperKind: newer.paperKind ?? older.paperKind,
    userKind: chosen.userKind,
    userKindAt: chosen.userKindAt,
    userTitle: named.userTitle,
    userTitleAt: named.userTitleAt,
    note: noted.note,
    links: noted.links,
    noteAt: noted.noteAt,
    driveFileId: stored.driveFileId,
    driveAt: stored.driveAt,
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
  | { kind: 'meta'; docId: string; docTitle: string | null; title: string | null; venue: string | null; year: number | null; paperKind?: PdfPaperKind | null }
  // The user's kind for the document (null: back to automatic).
  | { kind: 'user-kind'; docId: string; userKind: PdfDocKind | null }
  // The user's name for it (null: back to automatic).
  | { kind: 'rename'; docId: string; userTitle: string | null }
  // The user's note and links.
  | { kind: 'note'; docId: string; note: string | null; links: string[] }
  // Its copy in the user's Drive folder was stored (an id) or removed (null).
  | { kind: 'drive'; docId: string; driveFileId: string | null };

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
      paperKind: current?.paperKind ?? null,
      userKind: current?.userKind ?? null,
      userKindAt: current?.userKindAt ?? 0,
      userTitle: current?.userTitle ?? null,
      userTitleAt: current?.userTitleAt ?? 0,
      note: current?.note ?? null,
      links: current?.links ?? [],
      noteAt: current?.noteAt ?? 0,
      driveFileId: current?.driveFileId ?? null,
      driveAt: current?.driveAt ?? 0,
    };
  } else if (!current) {
    return library; // meta and kinds only ever apply to a document that was opened
  } else if (update.kind === 'meta') {
    next = {
      ...current,
      docTitle: text(update.docTitle) ?? current.docTitle,
      title: text(update.title) ?? current.title,
      venue: text(update.venue) ?? current.venue,
      year: update.year ?? current.year,
      paperKind: update.paperKind ?? current.paperKind,
    };
    if (JSON.stringify(next) === JSON.stringify(current)) return library;
  } else if (update.kind === 'user-kind') {
    if (current.userKind === update.userKind) return library;
    next = { ...current, userKind: update.userKind, userKindAt: Math.max(now, current.userKindAt + 1) };
  } else if (update.kind === 'rename') {
    const userTitle = text(update.userTitle);
    if (current.userTitle === userTitle) return library;
    next = { ...current, userTitle, userTitleAt: Math.max(now, current.userTitleAt + 1) };
  } else if (update.kind === 'note') {
    const note = text(update.note, PDF_NOTE_MAX_CHARS);
    const links = noteLinks(update.links) ?? [];
    if (current.note === note && JSON.stringify(current.links) === JSON.stringify(links)) return library;
    next = { ...current, note, links, noteAt: Math.max(now, current.noteAt + 1) };
  } else {
    if (current.driveFileId === update.driveFileId) return library;
    next = { ...current, driveFileId: update.driveFileId, driveAt: Math.max(now, current.driveAt + 1) };
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
      return { kind: 'meta', docId, docTitle: text(value.docTitle), title: text(value.title), venue: text(value.venue), year, paperKind: isPdfPaperKind(value.paperKind) ? value.paperKind : null };
    }
    case 'user-kind':
      return value.userKind === null || isPdfDocKind(value.userKind) ? { kind: 'user-kind', docId, userKind: value.userKind } : null;
    case 'rename':
      return value.userTitle === null || typeof value.userTitle === 'string' ? { kind: 'rename', docId, userTitle: text(value.userTitle) } : null;
    case 'note': {
      const links = noteLinks(value.links);
      if (!links || (value.note !== null && typeof value.note !== 'string')) return null;
      return { kind: 'note', docId, note: text(value.note, PDF_NOTE_MAX_CHARS), links };
    }
    case 'drive':
      return value.driveFileId === null || driveId(value.driveFileId) !== null ? { kind: 'drive', docId, driveFileId: value.driveFileId as string | null } : null;
    default:
      return null;
  }
}

// ─── Display helpers (home page) ───

/**
 * A file's own name, when it is one: ends in .pdf (a URL's last segment such
 * as `download` or `view` is not).
 */
export function realFileName(name: string | null): string | null {
  const trimmed = name?.trim();
  return trimmed && /\.pdf$/iu.test(trimmed) && trimmed.length > 4 ? trimmed : null;
}

/**
 * The name a document goes by: the user's, else the paper's, else the file's
 * own name (a PDF that is not a paper keeps the name it was saved under, its
 * Title metadata being often a word processor's leftover), else the Title
 * metadata, else the file name or URL anyway.
 */
export function libraryEntryName(entry: PdfLibraryEntry, displayName: (url: string) => string): string {
  return entry.userTitle ?? entry.title ?? realFileName(entry.fileName) ?? entry.docTitle ?? entry.fileName ?? (entry.urls[0] ? displayName(entry.urls[0]) : 'PDF');
}

/** Rows matching every word of `query` in a title, file name or URL; most recent first. */
export function searchPdfLibrary(entries: readonly PdfLibraryEntry[], query: string): PdfLibraryEntry[] {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const sorted = [...entries].sort((a, b) => b.openedAt - a.openedAt);
  if (words.length === 0) return sorted;
  return sorted.filter((e) => {
    const hay = [e.userTitle, e.title, e.docTitle, e.fileName, e.venue, e.note, ...e.links, ...e.urls.map(safeDecode)].filter(Boolean).join('\n').toLowerCase();
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

/** "방금", "5분 전", "3시간 전", "2일 전", then a date (in the current language). */
export function relativeTime(then: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - then);
  const minute = 60_000;
  if (diff < minute) return S.justNow;
  if (diff < 60 * minute) return S.minutesAgo(Math.floor(diff / minute));
  if (diff < 24 * 60 * minute) return S.hoursAgo(Math.floor(diff / (60 * minute)));
  if (diff < 7 * 24 * 60 * minute) return S.daysAgo(Math.floor(diff / (24 * 60 * minute)));
  const date = new Date(then);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return sameYear ? S.dateThisYear(date.getMonth() + 1, date.getDate()) : S.dateOtherYear(date.getFullYear(), date.getMonth() + 1, date.getDate());
}
