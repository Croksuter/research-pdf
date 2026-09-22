import { describe, expect, it } from 'vitest';
import {
  PDF_DOC_RECORD_MAX_AGE_MS,
  buildPdfDocId,
  findPdfDocRecord,
  fingerprintIsUsable,
  hasTrailerId,
  isWeakFingerprint,
  parsePdfDocRecords,
  sha256Hex,
  upsertPdfDocRecord,
  type PdfDocRecord,
} from '../src/shared/pdfIdentity';

const FP = '3f9a1c7e5b2d4a6f8e0c9b7a6d5e4f31';
const FP2 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SHA = 'c'.repeat(32) + 'd'.repeat(32);
const SHA2 = '1'.repeat(64);

function record(overrides: Partial<PdfDocRecord> = {}): PdfDocRecord {
  return {
    docId: `fp:${FP}:12`,
    fingerprint: FP,
    fingerprintModified: null,
    numPages: 12,
    sha256: null,
    sourceUrl: null,
    fileName: 'a.pdf',
    page: 3,
    zoom: 'page-width',
    updatedAt: 1_000,
    ...overrides,
  };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('isWeakFingerprint', () => {
  it('rejects missing, malformed, and low-entropy fingerprints', () => {
    expect(isWeakFingerprint(null)).toBe(true);
    expect(isWeakFingerprint('')).toBe(true);
    expect(isWeakFingerprint('abc')).toBe(true);
    expect(isWeakFingerprint('f'.repeat(32))).toBe(true);
    expect(isWeakFingerprint('01'.repeat(16))).toBe(true);
    expect(isWeakFingerprint('0123'.repeat(8))).toBe(true);
    expect(isWeakFingerprint(FP.toUpperCase())).toBe(true);
  });

  it('accepts an ordinary 16-byte /ID rendered as hex', () => {
    expect(isWeakFingerprint(FP)).toBe(false);
    expect(isWeakFingerprint('012345'.repeat(5) + '01')).toBe(false);
  });
});

describe('hasTrailerId', () => {
  it('finds a hex or literal-string /ID array in the trailer', () => {
    expect(hasTrailerId(bytes(`%PDF-1.4\ntrailer\n<< /Size 9 /Root 1 0 R /ID [<${FP}> <${FP2}>] >>\nstartxref\n`))).toBe(true);
    expect(hasTrailerId(bytes('trailer << /ID [ <AB CD> <EF 01> ] >>'))).toBe(true);
    expect(hasTrailerId(bytes('trailer << /ID [(abc\\)def) (ghi)] >>'))).toBe(true);
  });

  it('reports no /ID when the trailer lacks one or it is not a two-element array', () => {
    expect(hasTrailerId(bytes('%PDF-1.4\ntrailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n'))).toBe(false);
    expect(hasTrailerId(bytes('trailer << /ID [<AB>] >>'))).toBe(false);
    expect(hasTrailerId(bytes(''))).toBe(false);
  });

  it('scans the head and tail of a large file, not the middle', () => {
    const filler = 'x'.repeat(200_000);
    const idAtEnd = `${filler}\ntrailer << /ID [<${FP}> <${FP}>] >>`;
    const idAtStart = `%PDF-1.5 /Linearized 1 /ID [<${FP}> <${FP}>]\n${filler}`;
    const idInMiddle = `${'y'.repeat(100_000)}/ID [<${FP}> <${FP}>]${filler}`;
    expect(hasTrailerId(bytes(idAtEnd))).toBe(true);
    expect(hasTrailerId(bytes(idAtStart))).toBe(true);
    expect(hasTrailerId(bytes(idInMiddle))).toBe(false);
  });
});

describe('buildPdfDocId', () => {
  it('keys a usable fingerprint together with the page count', () => {
    expect(buildPdfDocId({ fingerprint: FP, numPages: 12, sha256: null })).toBe(`fp:${FP}:12`);
    // A page-split derivative keeps the original /ID but must not share the key.
    expect(buildPdfDocId({ fingerprint: FP, numPages: 3, sha256: null })).toBe(`fp:${FP}:3`);
  });

  it('falls back to the SHA-256 when the fingerprint is weak or synthesized', () => {
    expect(buildPdfDocId({ fingerprint: 'f'.repeat(32), numPages: 12, sha256: SHA })).toBe(`sha:${SHA}`);
    expect(buildPdfDocId({ fingerprint: null, numPages: 12, sha256: SHA })).toBe(`sha:${SHA}`);
    // PDF.js substitutes an MD5 of the first 1 KB when the trailer has no /ID;
    // the bytes inspection reveals that and the hash takes over.
    expect(buildPdfDocId({ fingerprint: FP, numPages: 12, sha256: SHA, trailerHasId: false })).toBe(`sha:${SHA}`);
    expect(buildPdfDocId({ fingerprint: FP, numPages: 12, sha256: SHA, trailerHasId: true })).toBe(`fp:${FP}:12`);
  });

  it('returns null when neither key is available', () => {
    expect(buildPdfDocId({ fingerprint: 'f'.repeat(32), numPages: 12, sha256: null })).toBeNull();
    expect(buildPdfDocId({ fingerprint: FP, numPages: 0, sha256: null })).toBeNull();
    expect(buildPdfDocId({ fingerprint: FP, numPages: 12, sha256: 'nope', trailerHasId: false })).toBeNull();
  });

  it('fingerprintIsUsable mirrors the decision so callers know when to hash', () => {
    expect(fingerprintIsUsable({ fingerprint: FP })).toBe(true);
    expect(fingerprintIsUsable({ fingerprint: FP, trailerHasId: false })).toBe(false);
    expect(fingerprintIsUsable({ fingerprint: '0'.repeat(32) })).toBe(false);
  });
});

describe('sha256Hex', () => {
  it('hashes bytes to lower-case hex', async () => {
    expect(await sha256Hex(bytes('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('findPdfDocRecord', () => {
  it('matches by docId first, then by the sha256 alias', () => {
    const byFp = record();
    const bySha = record({ docId: `sha:${SHA}`, fingerprint: null, sha256: SHA });
    const records = { [byFp.docId]: byFp, [bySha.docId]: bySha };
    expect(findPdfDocRecord(records, { docId: byFp.docId, sha256: null })).toBe(byFp);
    expect(findPdfDocRecord(records, { docId: `fp:${FP2}:12`, sha256: SHA })).toBe(bySha);
    expect(findPdfDocRecord(records, { docId: `fp:${FP2}:12`, sha256: SHA2 })).toBeNull();
    expect(findPdfDocRecord(records, { docId: null, sha256: null })).toBeNull();
  });

  it('does not match a different page count even with the same fingerprint', () => {
    const records = { [`fp:${FP}:12`]: record() };
    expect(findPdfDocRecord(records, { docId: `fp:${FP}:3`, sha256: null })).toBeNull();
  });
});

describe('upsertPdfDocRecord', () => {
  it('replaces the entry under its docId and any entry that aliases the same bytes', () => {
    const old = record({ page: 1, updatedAt: 500 });
    const aliasOnly = record({ docId: `sha:${SHA}`, fingerprint: null, sha256: SHA, updatedAt: 600 });
    const fresh = record({ page: 9, sha256: SHA, updatedAt: 1_000 });
    const next = upsertPdfDocRecord({ [old.docId]: old, [aliasOnly.docId]: aliasOnly }, fresh, 1_000);
    expect(Object.keys(next)).toEqual([fresh.docId]);
    expect(next[fresh.docId].page).toBe(9);
  });

  it('drops expired entries and the least-recently-updated ones beyond the cap', () => {
    const now = PDF_DOC_RECORD_MAX_AGE_MS + 100;
    const stale = record({ docId: 'fp:stale', updatedAt: 0 });
    const a = record({ docId: 'fp:a', updatedAt: now - 30 });
    const b = record({ docId: 'fp:b', updatedAt: now - 20 });
    const c = record({ docId: 'fp:c', updatedAt: now - 10 });
    const fresh = record({ docId: 'fp:new', updatedAt: now });
    const next = upsertPdfDocRecord({ [stale.docId]: stale, [a.docId]: a, [b.docId]: b, [c.docId]: c }, fresh, now, { max: 3 });
    expect(Object.keys(next).sort()).toEqual(['fp:b', 'fp:c', 'fp:new']);
  });

  it('never prunes the record just written even when the cap is tiny', () => {
    const a = record({ docId: 'fp:a', updatedAt: 999_999 });
    const fresh = record({ docId: 'fp:new', updatedAt: 1 });
    expect(Object.keys(upsertPdfDocRecord({ [a.docId]: a }, fresh, 1_000_000, { max: 1 }))).toEqual(['fp:new']);
  });
});

describe('parsePdfDocRecords', () => {
  it('keeps well-formed entries and drops malformed or mis-keyed ones', () => {
    const good = record();
    const parsed = parsePdfDocRecords({
      [good.docId]: good,
      'fp:wrong-key': record({ docId: 'fp:other' }),
      'fp:bad-page': record({ docId: 'fp:bad-page', page: -1, zoom: 'huge', fingerprint: 'zz' }),
      junk: 'not a record',
      missing: { docId: 'missing' },
    });
    expect(Object.keys(parsed).sort()).toEqual(['fp:bad-page', good.docId].sort());
    expect(parsed[good.docId]).toEqual(good);
    expect(parsed['fp:bad-page']).toMatchObject({ page: null, zoom: null, fingerprint: null });
  });

  it('returns an empty map for anything that is not an object', () => {
    expect(parsePdfDocRecords(undefined)).toEqual({});
    expect(parsePdfDocRecords([])).toEqual({});
    expect(parsePdfDocRecords('x')).toEqual({});
  });
});
