import { beforeEach, describe, expect, it } from 'vitest';

import {
  PDF_CACHE_MAX_FILE_BYTES,
  arxivStampAliases,
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
  readCachedDoc,
  readCachedPdf,
  storeCachedPdf,
} from '../src/db/pdfFileCache';
import { clearAllStores } from './helpers';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);

describe('cache aliases', () => {
  it('keys every URL by itself, fragment dropped, local files included', () => {
    expect(pdfCacheAliases('https://a.org/p.pdf#page=3')).toEqual(['url:https://a.org/p.pdf']);
    expect(pdfCacheAliases('file:///home/me/arxiv.org/pdf/1706.03762')).toEqual(['url:file:///home/me/arxiv.org/pdf/1706.03762']);
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

  it('reads arXiv\'s own watermark, not a citation of another paper', () => {
    expect(arxivStampAliases('Attention Is All You Need arXiv:1706.03762v7 [cs.CL] 2 Aug 2023'))
      .toEqual(['arxiv:1706.03762v7', 'arxiv:1706.03762']);
    expect(arxivStampAliases('arXiv:hep-th/9901001v2 [hep-th] 1 Jan 1999')).toEqual(['arxiv:hep-th/9901001v2', 'arxiv:hep-th/9901001']);
    expect(arxivStampAliases('as shown in arXiv:2001.08361 and arXiv:2001.08361v2')).toEqual([]);
    expect(arxivStampAliases('')).toEqual([]);
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

  it('lets a local arXiv file answer that paper\'s web URLs, without taking over a web copy', async () => {
    await storeCachedPdf({ url: 'file:///home/me/attention.pdf', paperAliases: ['arxiv:1706.03762v7', 'arxiv:1706.03762'], bytes: bytes(30, 3), sha256: SHA_A, etag: null, lastModified: null, now: 10 });
    const exact = await readCachedPdf('https://arxiv.org/pdf/1706.03762v7');
    expect(exact?.sha256).toBe(SHA_A);
    const latest = await readCachedPdf('https://arxiv.org/pdf/1706.03762');
    expect(latest?.sha256).toBe(SHA_A);
    // "Latest" was only inferred from a local file: the first web open re-checks it.
    expect(needsRevalidation(latest!.entry, Date.now())).toBe(true);
    expect(needsRevalidation(exact!.entry, Date.now())).toBe(false);

    // A web copy of the newer version keeps the versionless id; a later local
    // open of the old file does not take it back.
    await storeCachedPdf({ url: 'https://arxiv.org/pdf/1706.03762', bytes: bytes(40, 4), sha256: SHA_B, etag: '"v8"', lastModified: null, now: 30 });
    await storeCachedPdf({ url: 'file:///home/me/attention.pdf', paperAliases: ['arxiv:1706.03762v7', 'arxiv:1706.03762'], bytes: bytes(30, 3), sha256: SHA_A, etag: null, lastModified: null, now: 40 });
    expect((await readCachedPdf('https://export.arxiv.org/pdf/1706.03762'))?.sha256).toBe(SHA_B);
    expect((await readCachedPdf('https://arxiv.org/pdf/1706.03762v7'))?.sha256).toBe(SHA_A);
  });

  it('keeps local files and picked ones by their document, the last to be evicted', async () => {
    expect(await storeCachedPdf({ url: 'file:///home/me/p.pdf', docId: 'doc-local', bytes: bytes(5), sha256: SHA_A, etag: null, lastModified: null })).toBe(true);
    expect((await readCachedPdf('file:///home/me/p.pdf#page=2'))?.sha256).toBe(SHA_A);
    expect((await readCachedDoc('doc-local'))?.sha256).toBe(SHA_A);
    expect(await storeCachedPdf({ url: null, docId: 'doc-picked', bytes: bytes(6, 2), sha256: SHA_B, etag: null, lastModified: null })).toBe(true);
    expect((await readCachedDoc('doc-picked'))?.bytes.byteLength).toBe(6);
    expect(await storeCachedPdf({ url: null, bytes: bytes(6, 2), sha256: SHA_B, etag: null, lastModified: null })).toBe(false); // nothing to find it by
    const files = [
      { sha256: 'web-old', size: 10, lastUsedAt: 1 },
      { sha256: 'local-older', size: 10, lastUsedAt: 0, local: true },
      { sha256: 'web-new', size: 10, lastUsedAt: 5 },
    ];
    expect(pickEvictions(files, 0, { maxBytes: 15, maxFiles: 10 })).toEqual(['web-old', 'web-new']);
  });

  it('refuses oversize files, and clears on request', async () => {
    expect(await storeCachedPdf({ url: 'https://a.org/big.pdf', bytes: new Uint8Array(PDF_CACHE_MAX_FILE_BYTES + 1), sha256: SHA_A, etag: null, lastModified: null })).toBe(false);
    await storeCachedPdf({ url: 'https://a.org/p.pdf', bytes: bytes(5), sha256: SHA_A, etag: null, lastModified: null });
    await clearPdfFileCache();
    expect(await readCachedPdf('https://a.org/p.pdf')).toBeNull();
    expect(await pdfFileCacheUsage()).toEqual({ files: 0, bytes: 0 });
  });
});
