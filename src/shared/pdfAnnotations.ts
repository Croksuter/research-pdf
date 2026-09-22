// ─── PDF annotation cache: model + reconciliation ───
//
// Annotations drawn in the viewer live in PDF.js's annotationStorage until the
// user downloads the file. This module keeps a browser-side copy of that
// storage keyed by document identity (shared/pdfIdentity.ts) so the drawings
// come back when the same PDF is reopened from anywhere, and decides what to
// do when the file itself also carries annotations.
//
// Cache entries are the save-format objects PDF.js produces for
// `annotationStorage.serializable` (the same payload `saveDocument()` sends to
// the worker), so restoring is `AnnotationEditorLayer.deserialize(data)` and
// nothing here needs to understand strokes or quad points. Two entry kinds:
//
//   items    — annotations to (re)create: new drawings, plus file annotations
//              the user edited, re-expressed as delete(id) + new drawing.
//   deleted  — file annotation ids the user removed.
//
// Reconciliation against the file's own annotations ("file marks"):
//   1. A cached item that the file already contains (same type, page, rect)
//      is dropped — this is what happens after the user downloads the
//      annotated file and reopens that copy.
//   2. Deletes are trusted only while they still point at the annotation they
//      were recorded against (same id, subtype, rect); object ids are
//      renumbered by full rewrites.
//   3. If the file revision (PDF.js `fingerprints[1]`) is the one the cache was
//      last reconciled with, or only one side has anything the other lacks,
//      the merge is silent. Otherwise both sides diverged and the user picks:
//      file only, browser only, both, or per-annotation.

import { PDF_DOC_ID_MAX_CHARS } from './pdfIdentity';

export const PDF_ANNOTATION_CACHE_VERSION = 1;
export const PDF_ANNOTATION_CACHE_MAX_DOCS = 200;
export const PDF_ANNOTATION_MAX_ITEMS = 5_000;
/** PDF user-space units (1/72 in) two rects may differ by and still be "the same". */
export const RECT_MATCH_TOLERANCE = 1.5;
const MAX_PAGES = 100_000;
const MAX_LABEL_CHARS = 60;

// PDF.js AnnotationEditorType values for the editors the viewer can create.
export const EDITOR_TYPE_FREETEXT = 3;
export const EDITOR_TYPE_HIGHLIGHT = 9;
export const EDITOR_TYPE_STAMP = 13;
export const EDITOR_TYPE_INK = 15;
const EDITOR_TYPES = new Set([EDITOR_TYPE_FREETEXT, EDITOR_TYPE_HIGHLIGHT, EDITOR_TYPE_STAMP, EDITOR_TYPE_INK]);

// PDF annotation subtypes ↔ editor types (for matching cached items to file marks).
const SUBTYPE_TO_EDITOR: Record<string, number> = {
  FreeText: EDITOR_TYPE_FREETEXT,
  Highlight: EDITOR_TYPE_HIGHLIGHT,
  Stamp: EDITOR_TYPE_STAMP,
  Ink: EDITOR_TYPE_INK,
};
// Subtypes that are not user marks and never take part in conflicts.
const NON_MARK_SUBTYPES = new Set(['Link', 'Widget', 'Popup', 'Screen', 'PrinterMark', 'TrapNet', 'Watermark', '3D', 'RichMedia']);

export type PdfRect = [number, number, number, number];

export interface CachedAnnotationItem {
  /** Content-derived key: type + page + rounded rect. */
  key: string;
  pageIndex: number;
  annotationType: number;
  rect: PdfRect;
  /** PDF.js save-format data (JSON-safe; stamps carry `bitmapUrl`). */
  data: Record<string, unknown>;
  createdAt: number;
}

export interface CachedAnnotationDelete {
  id: string;
  pageIndex: number;
  popupRef: string;
  subtype: string | null;
  rect: PdfRect | null;
}

export interface PdfAnnotationCache {
  docId: string;
  version: number;
  /** PDF.js `fingerprints[1]` of the file this cache was last reconciled with. */
  baseFingerprintModified: string | null;
  items: CachedAnnotationItem[];
  deleted: CachedAnnotationDelete[];
  updatedAt: number;
}

export interface FileAnnotationSummary {
  id: string;
  pageIndex: number;
  subtype: string;
  rect: PdfRect;
  contents: string | null;
  popupRef: string | null;
}

export interface AnnotationApplyPlan {
  items: CachedAnnotationItem[];
  deletes: CachedAnnotationDelete[];
}

export type AnnotationReconciliation =
  | { kind: 'silent'; plan: AnnotationApplyPlan; cache: PdfAnnotationCache }
  | {
      kind: 'conflict';
      fileOnly: FileAnnotationSummary[];
      cacheOnly: CachedAnnotationItem[];
      /** Deletes that survived verification; applied whatever the user picks. */
      deletes: CachedAnnotationDelete[];
      cache: PdfAnnotationCache;
    };

export type AnnotationConflictChoice =
  | { kind: 'file' }
  | { kind: 'browser' }
  | { kind: 'both' }
  | { kind: 'pick'; keepFileIds: ReadonlySet<string>; keepItemKeys: ReadonlySet<string> };

// ─── Helpers ───

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPageIndex(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < MAX_PAGES;
}

export function parseRect(value: unknown): PdfRect | null {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return null;
  const arr = Array.from(value as ArrayLike<unknown>);
  if (arr.length !== 4 || !arr.every(isFiniteNumber)) return null;
  const [a, b, c, d] = arr as number[];
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

/** Typed arrays (and nested ones) become plain arrays so the value survives JSON/IndexedDB round trips. */
export function toPlainJson(value: unknown): unknown {
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
  if (Array.isArray(value)) return value.map(toPlainJson);
  if (value instanceof Map) return toPlainJson(Object.fromEntries(value));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || typeof v === 'function') continue;
      out[k] = toPlainJson(v);
    }
    return out;
  }
  return value;
}

export function rectsMatch(a: PdfRect, b: PdfRect, tolerance = RECT_MATCH_TOLERANCE): boolean {
  return a.every((v, i) => Math.abs(v - b[i]) <= tolerance);
}

export function cachedItemKey(annotationType: number, pageIndex: number, rect: PdfRect): string {
  return `${annotationType}:${pageIndex}:${rect.map((v) => Math.round(v * 10) / 10).join(',')}`;
}

export function isMarkSubtype(subtype: string): boolean {
  return !NON_MARK_SUBTYPES.has(subtype);
}

// ─── Snapshot: annotationStorage → cache entries ───

export interface SnapshotInput {
  /** `[key, value]` pairs from `annotationStorage.serializable.map` (values already JSON-safe). */
  entries: Array<[string, unknown]>;
  /** Cached items not yet restored into the viewer (their pages have not rendered); kept verbatim. */
  pending: CachedAnnotationItem[];
  /** Previous cache, to keep `createdAt` and delete metadata stable. */
  previous: PdfAnnotationCache | null;
  fileMarks: FileAnnotationSummary[] | null;
  now: number;
}

/**
 * Turns the live annotation storage into cache entries. Edited file
 * annotations (`id` set) become delete + new; form-field values and other
 * non-editor entries are ignored.
 */
export function snapshotAnnotations(input: SnapshotInput): Pick<PdfAnnotationCache, 'items' | 'deleted'> {
  const previousItems = new Map((input.previous?.items ?? []).map((item) => [item.key, item]));
  const previousDeletes = new Map((input.previous?.deleted ?? []).map((d) => [d.id, d]));
  const marksById = new Map((input.fileMarks ?? []).map((m) => [m.id, m]));
  const items = new Map<string, CachedAnnotationItem>();
  const deleted = new Map<string, CachedAnnotationDelete>();

  const recordDelete = (id: string, pageIndex: number, popupRef: unknown) => {
    const mark = marksById.get(id);
    const prev = previousDeletes.get(id);
    deleted.set(id, {
      id,
      pageIndex,
      popupRef: typeof popupRef === 'string' ? popupRef : '',
      subtype: mark?.subtype ?? prev?.subtype ?? null,
      rect: mark?.rect ?? prev?.rect ?? null,
    });
  };

  for (const [, raw] of input.entries) {
    const value = toPlainJson(raw);
    if (!isRecord(value)) continue;
    if (value.deleted === true && typeof value.id === 'string' && value.id) {
      recordDelete(value.id, isPageIndex(value.pageIndex) ? value.pageIndex : 0, value.popupRef);
      continue;
    }
    const annotationType = value.annotationType;
    if (typeof annotationType !== 'number' || !EDITOR_TYPES.has(annotationType)) continue;
    const rect = parseRect(value.rect);
    if (!rect || !isPageIndex(value.pageIndex)) continue;
    const pageIndex = value.pageIndex;
    if (typeof value.id === 'string' && value.id) {
      // An edited file annotation: the file's copy goes, ours replaces it.
      recordDelete(value.id, pageIndex, value.popupRef);
    }
    const data: Record<string, unknown> = { ...value };
    delete data.id;
    delete data.annotationElementId;
    delete data.bitmapId;
    delete data.bitmap;
    const key = cachedItemKey(annotationType, pageIndex, rect);
    items.set(key, {
      key,
      pageIndex,
      annotationType,
      rect,
      data,
      createdAt: previousItems.get(key)?.createdAt ?? input.now,
    });
  }
  for (const item of input.pending) {
    if (!items.has(item.key)) items.set(item.key, item);
  }
  return {
    items: Array.from(items.values()).slice(0, PDF_ANNOTATION_MAX_ITEMS),
    deleted: Array.from(deleted.values()),
  };
}

// ─── Reconciliation against the file's own annotations ───

function verifiedDeletes(
  deletes: CachedAnnotationDelete[],
  marksById: Map<string, FileAnnotationSummary>,
  sameRevision: boolean,
): CachedAnnotationDelete[] {
  return deletes.filter((d) => {
    const mark = marksById.get(d.id);
    if (!mark) return false;
    if (sameRevision) return true;
    if (d.subtype !== null && d.subtype !== mark.subtype) return false;
    if (d.rect !== null && !rectsMatch(d.rect, mark.rect)) return false;
    return d.subtype !== null || d.rect !== null;
  });
}

export function reconcileAnnotations(
  cache: PdfAnnotationCache,
  fileMarks: FileAnnotationSummary[],
  fingerprintModified: string | null,
): AnnotationReconciliation {
  const marks = fileMarks.filter((m) => isMarkSubtype(m.subtype));
  const marksById = new Map(marks.map((m) => [m.id, m]));
  const sameRevision = cache.baseFingerprintModified === fingerprintModified;

  // 1. Items the file already contains.
  const matchedMarkIds = new Set<string>();
  const cacheOnly: CachedAnnotationItem[] = [];
  for (const item of cache.items) {
    const twin = marks.find((m) =>
      !matchedMarkIds.has(m.id)
      && m.pageIndex === item.pageIndex
      && SUBTYPE_TO_EDITOR[m.subtype] === item.annotationType
      && rectsMatch(m.rect, item.rect));
    if (twin) matchedMarkIds.add(twin.id);
    else cacheOnly.push(item);
  }

  // 2. Deletes that still point at what they were recorded against.
  const deletes = verifiedDeletes(cache.deleted, marksById, sameRevision);
  const deletedIds = new Set(deletes.map((d) => d.id));

  const fileOnly = marks.filter((m) => !matchedMarkIds.has(m.id) && !deletedIds.has(m.id));
  const next: PdfAnnotationCache = {
    ...cache,
    baseFingerprintModified: fingerprintModified,
    items: cacheOnly,
    deleted: deletes,
  };

  // 3. Silent unless both sides diverged on a changed file.
  if (sameRevision || cacheOnly.length === 0 || fileOnly.length === 0) {
    return { kind: 'silent', plan: { items: cacheOnly, deletes }, cache: next };
  }
  return { kind: 'conflict', fileOnly, cacheOnly, deletes, cache: next };
}

/** Turns the user's choice on a conflict into an apply plan and the cache to store. */
export function resolveAnnotationConflict(
  conflict: Extract<AnnotationReconciliation, { kind: 'conflict' }>,
  choice: AnnotationConflictChoice,
): { plan: AnnotationApplyPlan; cache: PdfAnnotationCache } {
  const dropFile = (marks: FileAnnotationSummary[]): CachedAnnotationDelete[] => marks.map((m) => ({
    id: m.id,
    pageIndex: m.pageIndex,
    popupRef: m.popupRef ?? '',
    subtype: m.subtype,
    rect: m.rect,
  }));
  let items: CachedAnnotationItem[];
  let deletes: CachedAnnotationDelete[];
  switch (choice.kind) {
    case 'file':
      items = [];
      deletes = conflict.deletes;
      break;
    case 'browser':
      items = conflict.cacheOnly;
      deletes = [...conflict.deletes, ...dropFile(conflict.fileOnly)];
      break;
    case 'both':
      items = conflict.cacheOnly;
      deletes = conflict.deletes;
      break;
    case 'pick':
      items = conflict.cacheOnly.filter((item) => choice.keepItemKeys.has(item.key));
      deletes = [...conflict.deletes, ...dropFile(conflict.fileOnly.filter((m) => !choice.keepFileIds.has(m.id)))];
      break;
  }
  return {
    plan: { items, deletes },
    cache: { ...conflict.cache, items, deleted: deletes },
  };
}

// ─── Labels for the conflict UI ───

const EDITOR_LABELS: Record<number, string> = {
  [EDITOR_TYPE_FREETEXT]: '텍스트',
  [EDITOR_TYPE_HIGHLIGHT]: '형광펜',
  [EDITOR_TYPE_STAMP]: '이미지',
  [EDITOR_TYPE_INK]: '펜',
};
const SUBTYPE_LABELS: Record<string, string> = {
  FreeText: '텍스트', Highlight: '형광펜', Stamp: '이미지', Ink: '펜', Text: '메모', Underline: '밑줄',
  StrikeOut: '취소선', Squiggly: '물결 밑줄', Square: '사각형', Circle: '원', Line: '선', Polygon: '다각형',
  PolyLine: '꺾은선', Caret: '삽입 표시', FileAttachment: '첨부 파일', Sound: '소리', Redact: '가림',
};

function excerpt(text: unknown): string {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/gu, ' ').trim();
  if (!flat) return '';
  return flat.length > MAX_LABEL_CHARS ? `${flat.slice(0, MAX_LABEL_CHARS - 1)}…` : flat;
}

export function describeCachedItem(item: CachedAnnotationItem): string {
  const type = EDITOR_LABELS[item.annotationType] ?? '주석';
  const text = excerpt(item.data.value) || excerpt(item.data.comment);
  return text ? `${type} · ${item.pageIndex + 1}쪽 · “${text}”` : `${type} · ${item.pageIndex + 1}쪽`;
}

export function describeFileAnnotation(mark: FileAnnotationSummary): string {
  const type = SUBTYPE_LABELS[mark.subtype] ?? mark.subtype;
  const text = excerpt(mark.contents);
  return text ? `${type} · ${mark.pageIndex + 1}쪽 · “${text}”` : `${type} · ${mark.pageIndex + 1}쪽`;
}

// ─── Stored-row validation ───

function parseItem(value: unknown): CachedAnnotationItem | null {
  if (!isRecord(value)) return null;
  const rect = parseRect(value.rect);
  if (!rect || !isPageIndex(value.pageIndex) || typeof value.annotationType !== 'number' || !EDITOR_TYPES.has(value.annotationType)) return null;
  if (!isRecord(value.data) || typeof value.key !== 'string' || !value.key) return null;
  return {
    key: value.key,
    pageIndex: value.pageIndex,
    annotationType: value.annotationType,
    rect,
    data: value.data,
    createdAt: isFiniteNumber(value.createdAt) ? value.createdAt : 0,
  };
}

function parseDelete(value: unknown): CachedAnnotationDelete | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || !isPageIndex(value.pageIndex)) return null;
  return {
    id: value.id,
    pageIndex: value.pageIndex,
    popupRef: typeof value.popupRef === 'string' ? value.popupRef : '',
    subtype: typeof value.subtype === 'string' ? value.subtype : null,
    rect: parseRect(value.rect),
  };
}

export function parsePdfAnnotationCache(value: unknown): PdfAnnotationCache | null {
  if (!isRecord(value)) return null;
  if (typeof value.docId !== 'string' || !value.docId || value.docId.length > PDF_DOC_ID_MAX_CHARS) return null;
  if (value.version !== PDF_ANNOTATION_CACHE_VERSION) return null;
  if (!Array.isArray(value.items) || !Array.isArray(value.deleted)) return null;
  return {
    docId: value.docId,
    version: PDF_ANNOTATION_CACHE_VERSION,
    baseFingerprintModified: typeof value.baseFingerprintModified === 'string' ? value.baseFingerprintModified : null,
    items: value.items.map(parseItem).filter((i): i is CachedAnnotationItem => i !== null).slice(0, PDF_ANNOTATION_MAX_ITEMS),
    deleted: value.deleted.map(parseDelete).filter((d): d is CachedAnnotationDelete => d !== null),
    updatedAt: isFiniteNumber(value.updatedAt) ? value.updatedAt : 0,
  };
}

export function isEmptyAnnotationCache(cache: Pick<PdfAnnotationCache, 'items' | 'deleted'>): boolean {
  return cache.items.length === 0 && cache.deleted.length === 0;
}
