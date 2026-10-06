import { beforeEach, describe, expect, it } from 'vitest';
import { clearAllStores } from './helpers';
import {
  PDF_ANNOTATION_SWEEP_INTERVAL_MS,
  deletePdfAnnotationCache,
  getPdfAnnotationCache,
  putPdfAnnotationCache,
  sweepEmptyPdfAnnotationCaches,
} from '../src/db/pdfAnnotationRepository';
import { dbGetAll, dbPut } from '../src/db/database';
import { STORE_PDF_ANNOTATIONS } from '../src/shared/constants';
import { PDF_ANNOTATION_CACHE_VERSION, cachedItemKey, type PdfAnnotationCache } from '../src/shared/pdfAnnotations';

function cache(docId: string, updatedAt: number, withItem = true): PdfAnnotationCache {
  const rect: [number, number, number, number] = [0, 0, 10, 10];
  return {
    docId,
    version: PDF_ANNOTATION_CACHE_VERSION,
    baseFingerprintModified: null,
    items: withItem ? [{ key: cachedItemKey(9, 0, rect), pageIndex: 0, annotationType: 9, rect, data: { annotationType: 9 }, createdAt: 1 }] : [],
    deleted: [],
    updatedAt,
  };
}

describe('pdfAnnotationRepository', () => {
  beforeEach(clearAllStores);

  it('round-trips a cache by docId', async () => {
    await putPdfAnnotationCache(cache('fp:a:3', 10));
    expect(await getPdfAnnotationCache('fp:a:3')).toEqual(cache('fp:a:3', 10));
    expect(await getPdfAnnotationCache('fp:b:3')).toBeNull();
  });

  it('removes the row when the cache becomes empty, and on explicit delete', async () => {
    await putPdfAnnotationCache(cache('fp:a:3', 10));
    await putPdfAnnotationCache(cache('fp:a:3', 20, false));
    expect(await getPdfAnnotationCache('fp:a:3')).toBeNull();
    await putPdfAnnotationCache(cache('fp:a:3', 30));
    await deletePdfAnnotationCache('fp:a:3');
    expect(await getPdfAnnotationCache('fp:a:3')).toBeNull();
  });

  it('never evicts a document with drawings, however many there are', async () => {
    for (let i = 0; i < 260; i += 1) await putPdfAnnotationCache(cache(`fp:${i}:1`, 100 + i), 1 + i);
    expect(await dbGetAll(STORE_PDF_ANNOTATIONS)).toHaveLength(260);
    expect(await getPdfAnnotationCache('fp:0:1')).not.toBeNull();
  });

  it('sweeps only rows without drawings, and at most once per interval', async () => {
    const t0 = Date.now() + 10 * PDF_ANNOTATION_SWEEP_INTERVAL_MS;
    await putPdfAnnotationCache(cache('fp:a:1', 10), t0);
    // Rows an older build (or a crash) left behind: empty, and unreadable.
    await dbPut(STORE_PDF_ANNOTATIONS, cache('fp:empty:1', 5, false));
    await dbPut(STORE_PDF_ANNOTATIONS, { docId: 'fp:junk:1', version: 99 });
    // Within the interval a save does not read the store again.
    await putPdfAnnotationCache(cache('fp:b:1', 11), t0 + 1_000);
    expect(await dbGetAll(STORE_PDF_ANNOTATIONS)).toHaveLength(4);
    await putPdfAnnotationCache(cache('fp:c:1', 12), t0 + PDF_ANNOTATION_SWEEP_INTERVAL_MS + 1);
    const left = (await dbGetAll<{ docId: string }>(STORE_PDF_ANNOTATIONS)).map((row) => row.docId).sort();
    expect(left).toEqual(['fp:a:1', 'fp:b:1', 'fp:c:1']);
    expect(await sweepEmptyPdfAnnotationCaches()).toBe(0);
  });
});
