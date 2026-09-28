import { beforeEach, describe, expect, it } from 'vitest';

import {
  PDF_CACHE_MAX_FILE_BYTES,
  PDF_CACHE_REVALIDATE_BLIND_MS,
  PDF_CACHE_REVALIDATE_MS,
  isImmutableAlias,
  needsRevalidation,
  pdfCacheAliases,
  pickEvictions,
} from '../src/shared/pdfCachePolicy';
import {
  clearPdfFileCache,
  hasCachedPdf,
  markPdfValidated,
  pdfFileCacheUsage,
  readCachedPdf,
  storeCachedPdf,
} from '../src/db/pdfFileCache';
import { clearAllStores } from './helpers';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);

describe('cache aliases', () => {
  it('keys every web URL by itself, fragment dropped, and never local files', () => {
    expect(pdfCacheAliases('https://a.org/p.pdf#page=3')).toEqual(['url:https://a.org/p.pdf']);
    expect(pdfCacheAliases('file:///home/me/p.pdf')).toEqual([]);
    expect(pdfCacheAliases('nonsense')).toEqual([]);
  });

  it('lets every form of one arXiv paper meet, keeping versions apart', () => {
    const paper = (url: string) => pdfCacheAliases(url)[1];
    for (const url of [
      'https://arxiv.org/pdf/1706.03762',
      'http://arxiv.org/pdf/1706.03762.pdf',
      'https://www.arxiv.org/pdf/1706.03762/',
      'https://export.arxiv.org/pdf/1706.03762',
    ]) expect(paper(url)).toBe('arxiv:1706.03762');
    expect(paper('https://arxiv.org/pdf/1706.03762v7')).toBe('arxiv:1706.03762v7');
    expect(paper('https://arxiv.org/pdf/hep-th/9901001v2.pdf')).toBe('arxiv:hep-th/9901001v2');
    expect(pdfCacheAliases('https://arxiv.org/abs/1706.03762')).toHaveLength(1);
    expect(isImmutableAlias('arxiv:1706.03762v7')).toBe(true);
    expect(isImmutableAlias('arxiv:1706.03762')).toBe(false);
  });

  it('re-checks copies on schedule, never a versioned arXiv paper', () => {
    const now = 10 * PDF_CACHE_REVALIDATE_BLIND_MS;
    const entry = { alias: 'url:https://a.org/p.pdf', etag: '"x"', lastModified: null, validatedAt: now - PDF_CACHE_REVALIDATE_MS + 1 };
    expect(needsRevalidation(entry, now)).toBe(false);
    expect(needsRevalidation({ ...entry, validatedAt: now - PDF_CACHE_REVALIDATE_MS - 1 }, now)).toBe(true);
    // Without validators a check costs a full download: rarely.
    expect(needsRevalidation({ ...entry, etag: null, validatedAt: now - PDF_CACHE_REVALIDATE_MS - 1 }, now)).toBe(false);
    expect(needsRevalidation({ ...entry, etag: null, validatedAt: now - PDF_CACHE_REVALIDATE_BLIND_MS - 1 }, now)).toBe(true);
    expect(needsRevalidation({ ...entry, alias: 'arxiv:1706.03762v7', validatedAt: 0 }, now)).toBe(false);
  });

  it('evicts least recently used files until the budget fits', () => {
    const files = [
      { sha256: 'old', size: 40, lastUsedAt: 1 },
      { sha256: 'mid', size: 40, lastUsedAt: 2 },
      { sha256: 'new', size: 40, lastUsedAt: 3 },
    ];
    expect(pickEvictions(files, 0, { maxBytes: 200, maxFiles: 10 })).toEqual([]);
    expect(pickEvictions(files, 50, { maxBytes: 150, maxFiles: 10 })).toEqual(['old']);
    expect(pickEvictions(files, 10, { maxBytes: 1_000, maxFiles: 2 })).toEqual(['old', 'mid']);
  });
});

describe('file cache store', () => {
  beforeEach(async () => { await clearAllStores(); });

  it('stores once, answers every alias, and follows a redirect target', async () => {
    await storeCachedPdf({ url: 'https://arxiv.org/pdf/1706.03762', alsoUrls: ['https://export.arxiv.org/pdf/1706.03762v7'], bytes: bytes(100), sha256: SHA_A, etag: '"e"', lastModified: null, now: 1 });
    const hit = await readCachedPdf('http://www.arxiv.org/pdf/1706.03762.pdf#page=2', 5);
    expect(hit?.sha256).toBe(SHA_A);
    expect(hit?.bytes.byteLength).toBe(100);
    expect(hit?.entry.alias).toBe('arxiv:1706.03762');
    expect((await readCachedPdf('https://arxiv.org/pdf/1706.03762v7'))?.sha256).toBe(SHA_A);
    expect(await readCachedPdf('https://arxiv.org/pdf/1706.03762v6')).toBeNull();
    expect(await hasCachedPdf('https://arxiv.org/pdf/1706.03762')).toBe(true);
    expect(await pdfFileCacheUsage()).toEqual({ files: 1, bytes: 100 });
  });

  it('points a URL at new bytes when the server copy changed, and records revalidation', async () => {
    await storeCachedPdf({ url: 'https://a.org/p.pdf', bytes: bytes(10), sha256: SHA_A, etag: '"1"', lastModified: null, now: 1 });
    await markPdfValidated('url:https://a.org/p.pdf', { etag: '"2"', lastModified: null }, 50);
    const validated = await readCachedPdf('https://a.org/p.pdf');
    expect(validated?.entry).toMatchObject({ etag: '"2"', validatedAt: 50 });
    await storeCachedPdf({ url: 'https://a.org/p.pdf', bytes: bytes(20, 2), sha256: SHA_B, etag: '"3"', lastModified: null, now: 60 });
    const hit = await readCachedPdf('https://a.org/p.pdf');
    expect(hit?.sha256).toBe(SHA_B);
    expect(hit?.bytes[0]).toBe(2);
  });

  it('keeps its own copy of the bytes, so the caller may hand them on', async () => {
    const data = bytes(10, 7);
    await storeCachedPdf({ url: 'https://a.org/p.pdf', bytes: data, sha256: SHA_A, etag: null, lastModified: null });
    data.fill(0);
    expect((await readCachedPdf('https://a.org/p.pdf'))?.bytes[0]).toBe(7);
  });

  it('refuses oversize and local files, and clears on request', async () => {
    expect(await storeCachedPdf({ url: 'https://a.org/big.pdf', bytes: new Uint8Array(PDF_CACHE_MAX_FILE_BYTES + 1), sha256: SHA_A, etag: null, lastModified: null })).toBe(false);
    expect(await storeCachedPdf({ url: 'file:///p.pdf', bytes: bytes(5), sha256: SHA_A, etag: null, lastModified: null })).toBe(false);
    await storeCachedPdf({ url: 'https://a.org/p.pdf', bytes: bytes(5), sha256: SHA_A, etag: null, lastModified: null });
    await clearPdfFileCache();
    expect(await readCachedPdf('https://a.org/p.pdf')).toBeNull();
    expect(await pdfFileCacheUsage()).toEqual({ files: 0, bytes: 0 });
  });
});
