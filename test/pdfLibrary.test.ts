import { describe, expect, it } from 'vitest';

import {
  PDF_LIBRARY_MAX,
  PDF_LIBRARY_MAX_AGE_MS,
  PDF_LIBRARY_MAX_URLS,
  applyPdfLibraryUpdate,
  boundPdfLibrary,
  libraryEntryKind,
  libraryEntryName,
  mergePdfLibraryEntries,
  parsePdfLibrary,
  parsePdfLibraryUpdate,
  relativeTime,
  searchPdfLibrary,
  type PdfLibrary,
  noUserFields,
  noteLinkUrl,
  readableSource,
  type PdfLibraryEntry,
} from '../src/shared/pdfLibrary';
import { parsePdfLibraryUpdateRequest } from '../src/shared/messages';

const NOW = Date.UTC(2026, 8, 30, 12);

function entry(docId: string, overrides: Partial<PdfLibraryEntry> = {}): PdfLibraryEntry {
  return {
    docId, urls: [], fileName: null, docTitle: null, title: null, venue: null, year: null,
    numPages: 12, openedAt: NOW - 1_000, pinned: false, pinChangedAt: 0, paperKind: null, userKind: null, userKindAt: 0, ...noUserFields(), ...overrides,
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

  it('names a row by the user, then the paper, then the file\'s own name, then the PDF title', () => {
    let lib = applyPdfLibraryUpdate({}, { kind: 'opened', docId: 'd', url: 'https://a.org/x.pdf', fileName: 'x.pdf', numPages: 1 }, NOW);
    const name = () => libraryEntryName(lib.d, () => 'from-url');
    expect(name()).toBe('x.pdf');
    // Not a paper: the file keeps its name over the Title metadata.
    lib = applyPdfLibraryUpdate(lib, { kind: 'meta', docId: 'd', docTitle: 'Microsoft Word - draft.docx', title: null, venue: null, year: null }, NOW);
    expect(name()).toBe('x.pdf');
    lib = applyPdfLibraryUpdate(lib, { kind: 'meta', docId: 'd', docTitle: null, title: 'The Paper', venue: null, year: null }, NOW);
    expect(name()).toBe('The Paper');
    expect(lib.d.docTitle).toBe('Microsoft Word - draft.docx');
    lib = applyPdfLibraryUpdate(lib, { kind: 'rename', docId: 'd', userTitle: '  My name  ' }, NOW);
    expect(name()).toBe('My name');
    lib = applyPdfLibraryUpdate(lib, { kind: 'rename', docId: 'd', userTitle: null }, NOW + 1);
    expect(name()).toBe('The Paper');
    expect(libraryEntryName(entry('e'), () => 'from-url')).toBe('PDF');
    // A URL's last segment that is no file name gives way to the Title metadata.
    let web = applyPdfLibraryUpdate({}, { kind: 'opened', docId: 'w', url: 'https://a.org/download?id=3', fileName: 'download', numPages: 1 }, NOW);
    web = applyPdfLibraryUpdate(web, { kind: 'meta', docId: 'w', docTitle: 'Annual Report', title: null, venue: null, year: null }, NOW);
    expect(libraryEntryName(web.w, () => 'from-url')).toBe('Annual Report');
  });

  it('keeps the user\'s note, links and Drive copy, the latest change winning a merge', () => {
    let lib = applyPdfLibraryUpdate({}, { kind: 'opened', docId: 'd', url: null, fileName: 'a.pdf', numPages: 1 }, NOW);
    lib = applyPdfLibraryUpdate(lib, { kind: 'note', docId: 'd', note: ' read §3 ', links: ['https://x.org/a#b', '/home/me/papers/a.pdf', 'javascript:alert(1)', 'C:\\Papers\\a.pdf'] }, NOW);
    expect(lib.d).toMatchObject({ note: 'read §3', links: ['https://x.org/a#b', '/home/me/papers/a.pdf', 'C:\\Papers\\a.pdf'], noteAt: NOW });
    lib = applyPdfLibraryUpdate(lib, { kind: 'drive', docId: 'd', driveFileId: '1AbCdEfGhIjKlMnOp' }, NOW);
    expect(lib.d.driveFileId).toBe('1AbCdEfGhIjKlMnOp');
    const elsewhere = { ...lib.d, note: 'older', noteAt: NOW - 5, driveFileId: null, driveAt: NOW + 5, userTitle: 'Theirs', userTitleAt: NOW + 1 };
    const merged = mergePdfLibraryEntries(lib.d, elsewhere);
    expect(merged).toMatchObject({ note: 'read §3', driveFileId: null, userTitle: 'Theirs' });
    expect(mergePdfLibraryEntries(elsewhere, lib.d)).toEqual(merged);
    expect(parsePdfLibraryUpdate({ kind: 'drive', docId: 'd', driveFileId: '../x' })).toBeNull();
    expect(parsePdfLibraryUpdate({ kind: 'note', docId: 'd', note: 'x', links: 'nope' })).toBeNull();
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

  it('keeps an older build\'s pin through later opens (pins themselves live in projects now)', () => {
    let lib = applyPdfLibraryUpdate({}, { kind: 'opened', docId: 'd1', url: null, fileName: 'a.pdf', numPages: 1 }, NOW);
    lib = { d1: { ...lib.d1, pinned: true, pinChangedAt: 5 } };
    lib = applyPdfLibraryUpdate(lib, { kind: 'opened', docId: 'd1', url: 'https://a.org/a.pdf', fileName: null, numPages: 1 }, NOW + 1);
    expect(lib.d1).toMatchObject({ pinned: true, pinChangedAt: 5 });
  });

  it('parses update messages strictly', () => {
    expect(parsePdfLibraryUpdate({ kind: 'opened', docId: 'd', url: 'javascript:alert(1)', fileName: 'x', numPages: 1 })).toBeNull();
    expect(parsePdfLibraryUpdate({ kind: 'opened', docId: 'd', url: null, fileName: 'x', numPages: 0 })).toBeNull();
    expect(parsePdfLibraryUpdate({ kind: 'pin', docId: 'd', pinned: true })).toBeNull();
    expect(parsePdfLibraryUpdate({ kind: 'meta', docId: 'd', title: ' T ', venue: null, year: 20170 })).toEqual({ kind: 'meta', docId: 'd', docTitle: null, title: 'T', venue: null, year: null, paperKind: null });
    expect(parsePdfLibraryUpdateRequest({ type: 'VOCAB_T_PDF_LIBRARY_UPDATE', update: { kind: 'user-kind', docId: 'd', userKind: 'survey' } }))
      .toEqual({ type: 'VOCAB_T_PDF_LIBRARY_UPDATE', update: { kind: 'user-kind', docId: 'd', userKind: 'survey' } });
    expect(parsePdfLibraryUpdateRequest({ type: 'VOCAB_T_PDF_LIBRARY_UPDATE', update: { kind: 'user-kind', docId: 'd', userKind: null }, extra: 1 })).toBeNull();
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
  it('searches every word', () => {
    const lib: PdfLibrary = {
      a: entry('a', { pinned: true, pinChangedAt: 30, title: 'Attention Is All You Need', openedAt: 5 }),
      b: entry('b', { pinned: true, pinChangedAt: 10, fileName: 'resnet.pdf', openedAt: 9 }),
      c: entry('c', { urls: ['https://arxiv.org/pdf/2401.00001'], venue: 'NeurIPS', openedAt: 7 }),
    };
    expect(searchPdfLibrary(Object.values(lib), '').map((e) => e.docId)).toEqual(['b', 'c', 'a']);
    expect(searchPdfLibrary(Object.values(lib), 'attention need').map((e) => e.docId)).toEqual(['a']);
    expect(searchPdfLibrary(Object.values(lib), 'neurips 2401').map((e) => e.docId)).toEqual(['c']);
    expect(searchPdfLibrary(Object.values(lib), 'attention resnet')).toEqual([]);
  });

  it('says how long ago in Korean', () => {
    expect(relativeTime(NOW - 5_000, NOW)).toBe('방금');
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5분 전');
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3시간 전');
    expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe('2일 전');
    expect(relativeTime(NOW - 30 * 86_400_000, NOW)).toMatch(/^\d+월 \d+일$/u);
  });
});

describe('document kinds', () => {
  it('keeps the detected kind, lets the user override it, and the latest choice wins a merge', () => {
    let lib: PdfLibrary = { d1: entry('d1') };
    expect(libraryEntryKind(lib.d1)).toBe('document');
    lib = applyPdfLibraryUpdate(lib, { kind: 'meta', docId: 'd1', docTitle: null, title: 'T', venue: 'NeurIPS', year: 2017, paperKind: 'conference' }, NOW);
    expect(libraryEntryKind(lib.d1)).toBe('conference');
    // A later lookup without a kind keeps it.
    lib = applyPdfLibraryUpdate(lib, { kind: 'meta', docId: 'd1', docTitle: 'x', title: null, venue: null, year: null }, NOW);
    expect(lib.d1.paperKind).toBe('conference');
    lib = applyPdfLibraryUpdate(lib, { kind: 'user-kind', docId: 'd1', userKind: 'document' }, NOW + 1);
    expect(libraryEntryKind(lib.d1)).toBe('document');
    const elsewhere = { ...lib.d1, userKind: 'journal' as const, userKindAt: NOW + 10, openedAt: NOW - 5_000 };
    expect(mergePdfLibraryEntries(lib.d1, elsewhere)).toMatchObject({ userKind: 'journal', paperKind: 'conference' });
    expect(mergePdfLibraryEntries(elsewhere, lib.d1)).toEqual(mergePdfLibraryEntries(lib.d1, elsewhere));
    expect(parsePdfLibraryUpdate({ kind: 'user-kind', docId: 'd1', userKind: 'novel' })).toBeNull();
    expect(parsePdfLibraryUpdate({ kind: 'user-kind', docId: 'd1', userKind: null })).toEqual({ kind: 'user-kind', docId: 'd1', userKind: null });
  });
});

describe('links and sources', () => {
  it('opens a kept local path as a file URL, and shows a file URL as a path', () => {
    expect(noteLinkUrl('/home/me/my papers/a.pdf')).toBe('file:///home/me/my%20papers/a.pdf');
    expect(noteLinkUrl('C:\\Papers\\a b.pdf')).toBe('file:///C:/Papers/a%20b.pdf');
    expect(noteLinkUrl('\\\\nas\\share\\a.pdf')).toBe('file://nas/share/a.pdf');
    expect(noteLinkUrl('https://x.org/a')).toBe('https://x.org/a');
    expect(readableSource('file:///home/me/my%20papers/a.pdf')).toBe('/home/me/my papers/a.pdf');
    expect(readableSource('file:///C:/Papers/a.pdf')).toBe('C:\\Papers\\a.pdf');
    expect(readableSource('https://x.org/a%20b.pdf')).toBe('https://x.org/a b.pdf');
  });
});
