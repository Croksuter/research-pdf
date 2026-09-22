import { dbDelete, dbGet, dbGetAll, dbPut } from './database';
import { STORE_PDF_ANNOTATIONS } from '../shared/constants';
import {
  PDF_ANNOTATION_CACHE_MAX_DOCS,
  isEmptyAnnotationCache,
  parsePdfAnnotationCache,
  type PdfAnnotationCache,
} from '../shared/pdfAnnotations';

export async function getPdfAnnotationCache(docId: string): Promise<PdfAnnotationCache | null> {
  const row = await dbGet<unknown>(STORE_PDF_ANNOTATIONS, docId);
  const cache = parsePdfAnnotationCache(row);
  return cache && cache.docId === docId ? cache : null;
}

/** Stores the cache; an empty one is removed instead so the store only holds documents with drawings. */
export async function putPdfAnnotationCache(cache: PdfAnnotationCache): Promise<void> {
  if (isEmptyAnnotationCache(cache)) {
    await dbDelete(STORE_PDF_ANNOTATIONS, cache.docId);
    return;
  }
  await dbPut(STORE_PDF_ANNOTATIONS, cache);
  await trimPdfAnnotationCaches(cache.docId);
}

export async function deletePdfAnnotationCache(docId: string): Promise<void> {
  await dbDelete(STORE_PDF_ANNOTATIONS, docId);
}

/** Keeps the store bounded: least-recently-updated documents go first, never the one just written. */
export async function trimPdfAnnotationCaches(keepDocId: string | null = null, max = PDF_ANNOTATION_CACHE_MAX_DOCS): Promise<number> {
  const rows = (await dbGetAll<unknown>(STORE_PDF_ANNOTATIONS))
    .map(parsePdfAnnotationCache)
    .filter((c): c is PdfAnnotationCache => c !== null);
  if (rows.length <= max) return 0;
  const victims = rows
    .filter((c) => c.docId !== keepDocId)
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, rows.length - max);
  for (const victim of victims) await dbDelete(STORE_PDF_ANNOTATIONS, victim.docId);
  return victims.length;
}
