import { beforeEach, describe, expect, it } from 'vitest';
import { clearAllStores } from './helpers';
import {
  deletePdfAnnotationCache,
  getPdfAnnotationCache,
  putPdfAnnotationCache,
  trimPdfAnnotationCaches,
} from '../src/db/pdfAnnotationRepository';
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

  it('trims the least-recently-updated documents past the cap, keeping the one just written', async () => {
    for (let i = 0; i < 5; i += 1) await putPdfAnnotationCache(cache(`fp:${i}:1`, 100 + i));
    await putPdfAnnotationCache(cache('fp:new:1', 1));
    expect(await trimPdfAnnotationCaches('fp:new:1', 3)).toBe(3);
    expect(await getPdfAnnotationCache('fp:new:1')).not.toBeNull();
    expect(await getPdfAnnotationCache('fp:0:1')).toBeNull();
    expect(await getPdfAnnotationCache('fp:1:1')).toBeNull();
    expect(await getPdfAnnotationCache('fp:2:1')).toBeNull();
    expect(await getPdfAnnotationCache('fp:4:1')).not.toBeNull();
  });
});
