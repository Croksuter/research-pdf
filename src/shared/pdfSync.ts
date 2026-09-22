// ─── ResearchPDF sync document: model, validation, merge ───
//
// What follows a user between Chrome profiles and devices is exactly the
// viewer's own durable state: per-document reading position/zoom
// (`PdfDocRecord`, keyed by document identity) and the browser-side
// annotation cache (`PdfAnnotationCache`, the drawings PDF.js re-creates on
// open). Nothing else: paper-strip lookups are caches, settings are per
// device, and there are no credentials in here.
//
// Merge rules mirror the vocabulary engine (shared/threeWayMerge.ts):
//   • reading positions: one row per document, newest `updatedAt` wins;
//   • annotations: per document AND per drawing. Two devices drawing on the
//     same paper both keep their strokes; a drawing erased on one device
//     disappears everywhere once a base exists, and a drawing edited on both
//     sides keeps the local copy;
//   • the merged set is bounded exactly like local storage (document count and
//     age), so every device converges on the same set instead of one device's
//     pruning being read as the user deleting things.

import { PdfAnnotationCache, PDF_ANNOTATION_CACHE_MAX_DOCS, PDF_ANNOTATION_CACHE_VERSION, isEmptyAnnotationCache, parsePdfAnnotationCache } from './pdfAnnotations';
import { PDF_DOC_RECORD_MAX, PDF_DOC_RECORD_MAX_AGE_MS, PdfDocRecord, parsePdfDocRecord } from './pdfIdentity';
import { byId, chooseThreeWay, mergeRows, stableJson } from './threeWayMerge';

export const PDF_SYNC_SNAPSHOT_VERSION = 1;
export const PDF_SYNC_MAX_DOCS = 5_000;

export interface PdfSyncSnapshot {
  version: typeof PDF_SYNC_SNAPSHOT_VERSION;
  exportedAt: string;
  docs: PdfDocRecord[];
  annotations: PdfAnnotationCache[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strict: a document another build cannot read back is refused, never repaired. */
export function parsePdfSyncSnapshot(value: unknown): PdfSyncSnapshot | null {
  if (!isRecord(value) || value.version !== PDF_SYNC_SNAPSHOT_VERSION) return null;
  if (typeof value.exportedAt !== 'string' || !Number.isFinite(Date.parse(value.exportedAt))) return null;
  if (!Array.isArray(value.docs) || !Array.isArray(value.annotations)) return null;
  if (value.docs.length > PDF_SYNC_MAX_DOCS || value.annotations.length > PDF_SYNC_MAX_DOCS) return null;
  const docs: PdfDocRecord[] = [];
  const seenDocs = new Set<string>();
  for (const entry of value.docs) {
    const record = parsePdfDocRecord(entry);
    if (!record || seenDocs.has(record.docId)) return null;
    seenDocs.add(record.docId);
    docs.push(record);
  }
  const annotations: PdfAnnotationCache[] = [];
  const seenCaches = new Set<string>();
  for (const entry of value.annotations) {
    const cache = parsePdfAnnotationCache(entry);
    if (!cache || seenCaches.has(cache.docId)) return null;
    seenCaches.add(cache.docId);
    if (!isEmptyAnnotationCache(cache)) annotations.push(cache);
  }
  return { version: PDF_SYNC_SNAPSHOT_VERSION, exportedAt: value.exportedAt, docs, annotations };
}

const byDocId = <T extends { docId: string }>(rows: T[]): T[] => [...rows].sort((a, b) => a.docId.localeCompare(b.docId));

/** Same content, regardless of row order or `exportedAt`. */
export function pdfSyncSnapshotDataEquals(left: PdfSyncSnapshot, right: PdfSyncSnapshot): boolean {
  return stableJson({ docs: byDocId(left.docs), annotations: byDocId(left.annotations) })
    === stableJson({ docs: byDocId(right.docs), annotations: byDocId(right.annotations) });
}

/**
 * Merge one document's caches at drawing granularity. `base` is the cache
 * both sides last agreed on; without it the union can only add drawings.
 */
export function mergeAnnotationCaches(
  local: PdfAnnotationCache,
  remote: PdfAnnotationCache,
  base: PdfAnnotationCache | null,
): PdfAnnotationCache {
  const items = mergeRows(local.items, remote.items, base?.items ?? null, 'key', 'local');
  const deleted = mergeRows(local.deleted, remote.deleted, base?.deleted ?? null, 'id', 'local');
  const newer = remote.updatedAt > local.updatedAt ? remote : local;
  return {
    docId: local.docId,
    version: PDF_ANNOTATION_CACHE_VERSION,
    baseFingerprintModified: newer.baseFingerprintModified,
    items,
    deleted,
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
  };
}

function mergeAnnotationSets(
  localRows: PdfAnnotationCache[],
  remoteRows: PdfAnnotationCache[],
  baseRows: PdfAnnotationCache[] | null,
): PdfAnnotationCache[] {
  const local = byId(localRows, 'docId');
  const remote = byId(remoteRows, 'docId');
  const base = baseRows ? byId(baseRows, 'docId') : new Map<string, PdfAnnotationCache>();
  const ids = new Set([...local.keys(), ...remote.keys(), ...base.keys()]);
  return [...ids].sort((a, b) => a.localeCompare(b)).flatMap((docId) => {
    const localCache = local.get(docId);
    const remoteCache = remote.get(docId);
    if (localCache && remoteCache) {
      const merged = mergeAnnotationCaches(localCache, remoteCache, base.get(docId) ?? null);
      return isEmptyAnnotationCache(merged) ? [] : [merged];
    }
    // Only one side has drawings for this document: presence is decided the
    // 3-way way, so a device that erased everything wins over an unchanged peer.
    const resolved = chooseThreeWay(base.get(docId), localCache, remoteCache, 'local');
    return resolved && !isEmptyAnnotationCache(resolved) ? [resolved] : [];
  });
}

/** The same bounds local storage applies, so every device converges on one set. */
export function boundPdfSyncSnapshot(snapshot: PdfSyncSnapshot, now: number = Date.now()): PdfSyncSnapshot {
  const docs = snapshot.docs
    .filter((doc) => now - doc.updatedAt <= PDF_DOC_RECORD_MAX_AGE_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.docId.localeCompare(b.docId))
    .slice(0, PDF_DOC_RECORD_MAX)
    .sort((a, b) => a.docId.localeCompare(b.docId));
  const annotations = snapshot.annotations
    .filter((cache) => !isEmptyAnnotationCache(cache))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.docId.localeCompare(b.docId))
    .slice(0, PDF_ANNOTATION_CACHE_MAX_DOCS)
    .sort((a, b) => a.docId.localeCompare(b.docId));
  return { ...snapshot, docs, annotations };
}

export function mergePdfSyncSnapshots(
  local: PdfSyncSnapshot,
  remote: PdfSyncSnapshot,
  base: PdfSyncSnapshot | null,
  now: number = Date.now(),
): PdfSyncSnapshot {
  const docs = mergeRows(local.docs, remote.docs, base?.docs ?? null, 'docId', 'updatedAt');
  const annotations = mergeAnnotationSets(local.annotations, remote.annotations, base?.annotations ?? null);
  const times = [now, Date.parse(local.exportedAt), Date.parse(remote.exportedAt)].filter(Number.isFinite);
  return boundPdfSyncSnapshot({
    version: PDF_SYNC_SNAPSHOT_VERSION,
    exportedAt: new Date(Math.max(...times)).toISOString(),
    docs,
    annotations,
  }, now);
}
