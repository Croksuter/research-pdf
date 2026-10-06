import { dbDelete, dbGet, dbGetAll, dbPut } from './database';
import { STORE_PDF_ANNOTATIONS } from '../shared/constants';
import { isRecord } from '../shared/guards';
import {
  isEmptyAnnotationCache,
  parsePdfAnnotationCache,
  type PdfAnnotationCache,
} from '../shared/pdfAnnotations';

// The store holds one row per document with drawings. Drawings are the user's
// work, so a document that still has any is never evicted, however many there
// are; only rows that hold nothing (or are unreadable) are swept, and that
// sweep reads every row, so it runs at most once per interval per page.
export const PDF_ANNOTATION_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
let lastSweepAt = 0;

export async function getPdfAnnotationCache(docId: string): Promise<PdfAnnotationCache | null> {
  const row = await dbGet<unknown>(STORE_PDF_ANNOTATIONS, docId);
  const cache = parsePdfAnnotationCache(row);
  return cache && cache.docId === docId ? cache : null;
}

/** Stores the cache; an empty one is removed instead so the store only holds documents with drawings. */
export async function putPdfAnnotationCache(cache: PdfAnnotationCache, now: number = Date.now()): Promise<void> {
  if (isEmptyAnnotationCache(cache)) {
    await dbDelete(STORE_PDF_ANNOTATIONS, cache.docId);
    return;
  }
  await dbPut(STORE_PDF_ANNOTATIONS, cache);
  if (now - lastSweepAt >= PDF_ANNOTATION_SWEEP_INTERVAL_MS) {
    lastSweepAt = now;
    await sweepEmptyPdfAnnotationCaches();
  }
}

export async function deletePdfAnnotationCache(docId: string): Promise<void> {
  await dbDelete(STORE_PDF_ANNOTATIONS, docId);
}

/** Removes rows without drawings (or unreadable ones); never one with drawings. Answers how many went. */
export async function sweepEmptyPdfAnnotationCaches(): Promise<number> {
  const rows = await dbGetAll<unknown>(STORE_PDF_ANNOTATIONS);
  let removed = 0;
  for (const row of rows) {
    const cache = parsePdfAnnotationCache(row);
    if (cache && !isEmptyAnnotationCache(cache)) continue;
    const key = cache?.docId ?? (isRecord(row) && typeof row.docId === 'string' ? row.docId : null);
    if (key === null) continue;
    await dbDelete(STORE_PDF_ANNOTATIONS, key);
    removed += 1;
  }
  return removed;
}
