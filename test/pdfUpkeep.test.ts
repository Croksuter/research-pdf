import { noUserFields } from '../src/shared/pdfLibrary';
import { describe, expect, it } from 'vitest';

import type { PdfLibrary, PdfLibraryEntry } from '../src/shared/pdfLibrary';
import { PDF_UPKEEP_VERSION, markPdfUpkeepDone, parsePdfUpkeepState, rowsNeedingUpkeep } from '../src/shared/pdfUpkeep';

function entry(docId: string, overrides: Partial<PdfLibraryEntry> = {}): PdfLibraryEntry {
  return {
    docId, urls: [], fileName: null, docTitle: null, title: null, venue: null, year: null,
    numPages: 3, openedAt: 1_000, pinned: false, pinChangedAt: 0, paperKind: null, userKind: null, userKindAt: 0, ...noUserFields(), ...overrides,
  };
}

describe('library upkeep', () => {
  const library: PdfLibrary = {
    old: entry('old', { openedAt: 10 }),
    recent: entry('recent', { openedAt: 30 }),
    known: entry('known', { paperKind: 'journal' }),
    chosen: entry('chosen', { userKind: 'document' }),
    visited: entry('visited', { openedAt: 20 }),
  };

  it('revisits rows without a kind, the most recently opened first, once per version', () => {
    const state = parsePdfUpkeepState({ done: { visited: PDF_UPKEEP_VERSION } });
    expect(rowsNeedingUpkeep(library, state).map((e) => e.docId)).toEqual(['recent', 'old']);
    // A later version revisits rows an earlier one finished.
    expect(rowsNeedingUpkeep(library, state, PDF_UPKEEP_VERSION + 1).map((e) => e.docId)).toEqual(['recent', 'visited', 'old']);
  });

  it('marks rows done and forgets rows the library dropped', () => {
    const state = markPdfUpkeepDone({ done: { gone: 1, old: 1 } }, ['recent'], library);
    expect(state).toEqual({ done: { old: 1, recent: PDF_UPKEEP_VERSION } });
    expect(rowsNeedingUpkeep(library, state).map((e) => e.docId)).toEqual(['visited']);
  });

  it('reads a damaged record as nothing done', () => {
    expect(parsePdfUpkeepState(undefined)).toEqual({ done: {} });
    expect(parsePdfUpkeepState({ done: { a: 'x', b: 0, c: 2 } })).toEqual({ done: { c: 2 } });
  });
});
