// ─── ResearchPDF sync document: model, validation, merge ───
//
// What follows a user between Chrome profiles and devices is exactly the
// viewer's own durable state: per-document reading position/zoom
// (`PdfDocRecord`, keyed by document identity), the browser-side
// annotation cache (`PdfAnnotationCache`, the drawings PDF.js re-creates on
// open), since version 2 the library of opened documents
// (shared/pdfLibrary.ts), since version 3 the projects — their documents,
// pins and saved tabs (shared/pdfProjects.ts) — and since version 4 their
// looks, folders and order, and each document's kind (paper or not); since
// version 5 the order of each project's pins. Nothing else: paper-strip lookups are caches,
// settings are per device, and there are no credentials in here.
//
// Merge rules mirror the vocabulary engine (shared/threeWayMerge.ts):
//   • reading positions: one row per document, newest `updatedAt` wins;
//   • annotations: per document AND per drawing. Two devices drawing on the
//     same paper both keep their strokes; a drawing erased on one device
//     disappears everywhere once a base exists, and a drawing edited on both
//     sides keeps the local copy;
//   • library: a per-field join (shared/pdfLibrary.ts), no deletions;
//   • projects and folders: a join too — latest rename, final deletions,
//     latest change per member, latest saved tabs, latest look and placement
//     (shared/pdfProjects.ts);
//   • the merged set is bounded exactly like local storage (reading positions
//     by count and age; drawings never, a document with drawings is always
//     kept), so every device converges on the same set instead of one
//     device's pruning being read as the user deleting things.

import { PdfAnnotationCache, PDF_ANNOTATION_CACHE_VERSION, isEmptyAnnotationCache, parsePdfAnnotationCache } from './pdfAnnotations';
import { PdfDocRecord, boundPdfDocRecords, parsePdfDocRecord } from './pdfIdentity';
import { PDF_LIBRARY_MAX, PdfLibraryEntry, boundPdfLibrary, mergePdfLibraries, parsePdfLibraryList } from './pdfLibrary';
import {
  PdfProject,
  PdfProjectFolder,
  boundPdfProjectFolders,
  boundPdfProjects,
  mergePdfProjectFolderLists,
  mergePdfProjectLists,
  parsePdfProjectFolderList,
  parsePdfProjectList,
  projectDocIds,
} from './pdfProjects';
import { byId, chooseThreeWay, mergeRows, stableJson } from './threeWayMerge';
import { isRecord } from './guards';

// Version 2 added `library`, version 3 `projects`, version 4 `folders` (and
// new fields in projects and library rows), version 5 the pin order in
// project members. An older build's document
// still reads, with what it lacks empty; older builds refuse a newer version
// rather than write it back without what they do not know.
export const PDF_SYNC_SNAPSHOT_VERSION = 5;
export const PDF_SYNC_MAX_DOCS = 5_000;

export interface PdfSyncSnapshot {
  version: typeof PDF_SYNC_SNAPSHOT_VERSION;
  exportedAt: string;
  docs: PdfDocRecord[];
  annotations: PdfAnnotationCache[];
  library: PdfLibraryEntry[];
  projects: PdfProject[];
  folders: PdfProjectFolder[];
}


/** Strict: a document another build cannot read back is refused, never repaired. */
export function parsePdfSyncSnapshot(value: unknown): PdfSyncSnapshot | null {
  if (!isRecord(value) || ![1, 2, 3, 4, PDF_SYNC_SNAPSHOT_VERSION].includes(value.version as number)) return null;
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
  const library = value.version === 1 ? [] : parsePdfLibraryList(value.library, PDF_LIBRARY_MAX);
  if (!library) return null;
  const projects = value.version === 1 || value.version === 2 ? [] : parsePdfProjectList(value.projects);
  if (!projects) return null;
  const folders = value.version === 4 || value.version === PDF_SYNC_SNAPSHOT_VERSION ? parsePdfProjectFolderList(value.folders) : [];
  if (!folders) return null;
  return { version: PDF_SYNC_SNAPSHOT_VERSION, exportedAt: value.exportedAt, docs, annotations, library, projects, folders };
}

const byDocId = <T extends { docId: string }>(rows: T[]): T[] => [...rows].sort((a, b) => a.docId.localeCompare(b.docId));
const byProjectId = <T extends { id: string }>(rows: T[]): T[] => [...rows].sort((a, b) => a.id.localeCompare(b.id));

/** Same content, regardless of row order or `exportedAt`. */
export function pdfSyncSnapshotDataEquals(left: PdfSyncSnapshot, right: PdfSyncSnapshot): boolean {
  const data = (s: PdfSyncSnapshot) => stableJson({
    docs: byDocId(s.docs), annotations: byDocId(s.annotations), library: byDocId(s.library), projects: byProjectId(s.projects), folders: byProjectId(s.folders),
  });
  return data(left) === data(right);
}

/**
 * Documents whose position or drawings differ between two snapshots: what a
 * sync changed locally. Lets an open viewer know its document was updated by
 * another device.
 */
export function changedPdfDocIds(before: PdfSyncSnapshot, after: PdfSyncSnapshot): string[] {
  const changed = new Set<string>();
  const compare = <T extends { docId: string }>(left: T[], right: T[]) => {
    const leftById = new Map(left.map((row) => [row.docId, stableJson(row)]));
    const rightById = new Map(right.map((row) => [row.docId, stableJson(row)]));
    for (const id of new Set([...leftById.keys(), ...rightById.keys()])) {
      if (leftById.get(id) !== rightById.get(id)) changed.add(id);
    }
  };
  compare(before.docs, after.docs);
  compare(before.annotations, after.annotations);
  return [...changed].sort();
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
  const docs = boundPdfDocRecords(snapshot.docs, now);
  // Drawings are the user's work: every document that has any is kept.
  const annotations = snapshot.annotations
    .filter((cache) => !isEmptyAnnotationCache(cache))
    .sort((a, b) => a.docId.localeCompare(b.docId));
  const projects = boundPdfProjects(snapshot.projects, now);
  return {
    ...snapshot, docs, annotations, library: boundPdfLibrary(snapshot.library, now, projectDocIds(projects)), projects,
    folders: boundPdfProjectFolders(snapshot.folders, now),
  };
}

export function mergePdfSyncSnapshots(
  local: PdfSyncSnapshot,
  remote: PdfSyncSnapshot,
  base: PdfSyncSnapshot | null,
  now: number = Date.now(),
): PdfSyncSnapshot {
  const docs = mergeRows(local.docs, remote.docs, base?.docs ?? null, 'docId', 'updatedAt');
  const annotations = mergeAnnotationSets(local.annotations, remote.annotations, base?.annotations ?? null);
  const projects = mergePdfProjectLists(local.projects, remote.projects, now);
  const folders = mergePdfProjectFolderLists(local.folders, remote.folders, now);
  const library = mergePdfLibraries(local.library, remote.library, now, projectDocIds(projects));
  const times = [now, Date.parse(local.exportedAt), Date.parse(remote.exportedAt)].filter(Number.isFinite);
  return boundPdfSyncSnapshot({
    version: PDF_SYNC_SNAPSHOT_VERSION,
    exportedAt: new Date(Math.max(...times)).toISOString(),
    docs,
    annotations,
    library,
    projects,
    folders,
  }, now);
}
