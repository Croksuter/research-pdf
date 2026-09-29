import { describe, expect, it } from 'vitest';

import {
  PDF_LIBRARY_MAX,
  PDF_LIBRARY_MAX_AGE_MS,
  PDF_LIBRARY_MAX_URLS,
  applyPdfLibraryUpdate,
  boundPdfLibrary,
  libraryEntryName,
  mergePdfLibraryEntries,
  parsePdfLibrary,
  parsePdfLibraryUpdate,
  pinnedLibraryEntries,
  relativeTimeKo,
  searchPdfLibrary,
  type PdfLibrary,
  type PdfLibraryEntry,
} from '../src/shared/pdfLibrary';
import { parsePdfLibraryUpdateRequest } from '../src/shared/messages';

const NOW = Date.UTC(2026, 8, 30, 12);

function entry(docId: string, overrides: Partial<PdfLibraryEntry> = {}): PdfLibraryEntry {
  return {
    docId, urls: [], fileName: null, docTitle: null, title: null, venue: null, year: null,
    numPages: 12, openedAt: NOW - 1_000, pinned: false, pinChangedAt: 0, ...overrides,
  };
}

describe('library updates', () => {
  it('records an open: newest URL first, names kept, numbers refreshed', () => {
    let lib: PdfLibrary = {};
    lib = applyPdfLibraryUpdate(lib, { kind: 'opened', docId: 'd1', url: 'https://arxiv.org/pdf/1706.03762#page=2', fileName: '1706.03762.pdf', numPages: 15 }, NOW - 50);
    lib = applyPdfLibraryUpdate(lib, { kind: 'meta', docId: 'd1', docTitle: null, title: 'Attention Is All You Need', venue: 'NeurIPS', year: 2017 }, NOW - 40);
    lib = applyPdfLibraryUpdate(lib, { kind: 'opened', docId: 'd1', url: 'https://mirror.org/a.pdf', fileName: null, numPages: 15 }, NOW);
    expect(lib.d1).toMatchObject({
      urls: ['https://mirror.org/a.pdf', 'https://arxiv.org/pdf/1706.03762'],
      fileName: '1706.03762.pdf',
      title: 'Attention Is All You Need',
      venue: 'NeurIPS',
      year: 2017,
      openedAt: NOW,
    });
  });

  it('names a row by paper, then the PDF title, then the file', () => {
    let lib = applyPdfLibraryUpdate({}, { kind: 'opened', docId: 'd', url: 'https://a.org/x.pdf', fileName: 'x.pdf', numPages: 1 }, NOW);
    const name = () => libraryEntryName(lib.d, () => 'from-url');
    expect(name()).toBe('x.pdf');
    lib = applyPdfLibraryUpdate(lib, { kind: 'meta', docId: 'd', docTitle: 'Beta Methods', title: null, venue: null, year: null }, NOW);
    expect(name()).toBe('Beta Methods');
    lib = applyPdfLibraryUpdate(lib, { kind: 'meta', docId: 'd', docTitle: null, title: 'The Paper', venue: null, year: null }, NOW);
    expect(name()).toBe('The Paper');
    expect(lib.d.docTitle).toBe('Beta Methods');
    expect(libraryEntryName(entry('e'), () => 'from-url')).toBe('PDF');
  });

  it('keeps a local file without an address, and caps the URLs', () => {
    let lib = applyPdfLibraryUpdate({}, { kind: 'opened', docId: 'local', url: null, fileName: 'notes.pdf', numPages: 2 }, NOW);
    expect(lib.local.urls).toEqual([]);
    for (let i = 0; i < PDF_LIBRARY_MAX_URLS + 2; i += 1) {
      lib = applyPdfLibraryUpdate(lib, { kind: 'opened', docId: 'local', url: `https://a.org/${i}.pdf`, fileName: null, numPages: 2 }, NOW + i);
    }
    expect(lib.local.urls).toHaveLength(PDF_LIBRARY_MAX_URLS);
    expect(lib.local.urls[0]).toBe(`https://a.org/${PDF_LIBRARY_MAX_URLS + 1}.pdf`);
  });

  it('pins only documents it knows, and a no-op pin changes nothing', () => {
    const lib = applyPdfLibraryUpdate({}, { kind: 'opened', docId: 'd1', url: null, fileName: 'a.pdf', numPages: 1 }, NOW);
    expect(applyPdfLibraryUpdate(lib, { kind: 'pin', docId: 'missing', pinned: true }, NOW)).toBe(lib);
    expect(applyPdfLibraryUpdate(lib, { kind: 'pin', docId: 'd1', pinned: false }, NOW)).toBe(lib);
    const pinned = applyPdfLibraryUpdate(lib, { kind: 'pin', docId: 'd1', pinned: true }, NOW);
    expect(pinned.d1).toMatchObject({ pinned: true, pinChangedAt: NOW });
    // Two changes within one millisecond still order.
    const unpinned = applyPdfLibraryUpdate(pinned, { kind: 'pin', docId: 'd1', pinned: false }, NOW);
    expect(unpinned.d1.pinChangedAt).toBeGreaterThan(NOW);
  });

  it('parses update messages strictly', () => {
    expect(parsePdfLibraryUpdate({ kind: 'opened', docId: 'd', url: 'javascript:alert(1)', fileName: 'x', numPages: 1 })).toBeNull();
    expect(parsePdfLibraryUpdate({ kind: 'opened', docId: 'd', url: null, fileName: 'x', numPages: 0 })).toBeNull();
    expect(parsePdfLibraryUpdate({ kind: 'pin', docId: 'd', pinned: 'yes' })).toBeNull();
    expect(parsePdfLibraryUpdate({ kind: 'meta', docId: 'd', title: ' T ', venue: null, year: 20170 })).toEqual({ kind: 'meta', docId: 'd', docTitle: null, title: 'T', venue: null, year: null });
    expect(parsePdfLibraryUpdateRequest({ type: 'VOCAB_T_PDF_LIBRARY_UPDATE', update: { kind: 'pin', docId: 'd', pinned: true } }))
      .toEqual({ type: 'VOCAB_T_PDF_LIBRARY_UPDATE', update: { kind: 'pin', docId: 'd', pinned: true } });
    expect(parsePdfLibraryUpdateRequest({ type: 'VOCAB_T_PDF_LIBRARY_UPDATE', update: { kind: 'pin', docId: 'd', pinned: true }, extra: 1 })).toBeNull();
  });

  it('drops malformed stored rows and rows filed under another id', () => {
    const good = entry('d1', { urls: ['https://a.org/x.pdf#p', 'ftp://x', 'https://a.org/x.pdf'] });
    expect(parsePdfLibrary({ d1: good, d2: entry('other'), d3: { docId: 'd3' } })).toEqual({ d1: { ...good, urls: ['https://a.org/x.pdf'] } });
  });
});

describe('library merge and bounds', () => {
  it('joins per field and gives the same row whichever side is local', () => {
    const a = entry('d', { openedAt: 200, title: 'A', urls: ['https://a.org/1.pdf'], pinned: true, pinChangedAt: 50 });
    const b = entry('d', { openedAt: 100, title: null, venue: 'ICML', urls: ['https://b.org/1.pdf'], pinned: false, pinChangedAt: 150 });
    const merged = mergePdfLibraryEntries(a, b);
    expect(merged).toMatchObject({ openedAt: 200, title: 'A', venue: 'ICML', pinned: false, pinChangedAt: 150 });
    expect(merged.urls).toEqual(['https://a.org/1.pdf', 'https://b.org/1.pdf']);
    expect(mergePdfLibraryEntries(b, a)).toEqual(merged);
    expect(mergePdfLibraryEntries(merged, merged)).toEqual(merged);
    // A tie on the pin timestamp keeps the pin, on both sides.
    const tieA = entry('d', { pinned: true, pinChangedAt: 10 });
    const tieB = entry('d', { pinned: false, pinChangedAt: 10 });
    expect(mergePdfLibraryEntries(tieA, tieB).pinned).toBe(true);
    expect(mergePdfLibraryEntries(tieB, tieA).pinned).toBe(true);
  });

  it('keeps pins whatever their age and the most recent of the rest', () => {
    const old = entry('old', { openedAt: NOW - PDF_LIBRARY_MAX_AGE_MS - 1 });
    const oldPinned = entry('pin', { openedAt: NOW - PDF_LIBRARY_MAX_AGE_MS - 1, pinned: true, pinChangedAt: 1 });
    const many = Array.from({ length: PDF_LIBRARY_MAX + 3 }, (_, i) => entry(`d${String(i).padStart(5, '0')}`, { openedAt: NOW - i }));
    const kept = boundPdfLibrary([old, oldPinned, ...many], NOW);
    expect(kept).toHaveLength(PDF_LIBRARY_MAX);
    expect(kept.some((e) => e.docId === 'pin')).toBe(true);
    expect(kept.some((e) => e.docId === 'old')).toBe(false);
    expect(kept.some((e) => e.docId === `d${String(PDF_LIBRARY_MAX + 2).padStart(5, '0')}`)).toBe(false);
  });
});

describe('library display', () => {
  it('orders pins by when they were pinned and searches every word', () => {
    const lib: PdfLibrary = {
      a: entry('a', { pinned: true, pinChangedAt: 30, title: 'Attention Is All You Need', openedAt: 5 }),
      b: entry('b', { pinned: true, pinChangedAt: 10, fileName: 'resnet.pdf', openedAt: 9 }),
      c: entry('c', { urls: ['https://arxiv.org/pdf/2401.00001'], venue: 'NeurIPS', openedAt: 7 }),
    };
    expect(pinnedLibraryEntries(lib).map((e) => e.docId)).toEqual(['b', 'a']);
    expect(searchPdfLibrary(Object.values(lib), '').map((e) => e.docId)).toEqual(['b', 'c', 'a']);
    expect(searchPdfLibrary(Object.values(lib), 'attention need').map((e) => e.docId)).toEqual(['a']);
    expect(searchPdfLibrary(Object.values(lib), 'neurips 2401').map((e) => e.docId)).toEqual(['c']);
    expect(searchPdfLibrary(Object.values(lib), 'attention resnet')).toEqual([]);
  });

  it('says how long ago in Korean', () => {
    expect(relativeTimeKo(NOW - 5_000, NOW)).toBe('방금');
    expect(relativeTimeKo(NOW - 5 * 60_000, NOW)).toBe('5분 전');
    expect(relativeTimeKo(NOW - 3 * 3_600_000, NOW)).toBe('3시간 전');
    expect(relativeTimeKo(NOW - 2 * 86_400_000, NOW)).toBe('2일 전');
    expect(relativeTimeKo(NOW - 30 * 86_400_000, NOW)).toMatch(/^\d+월 \d+일$/u);
  });
});
