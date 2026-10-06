// ─── Upkeep: library rows brought up to the current build (pure) ───
//
// Opening a document derives things about it — today its kind as a paper, its
// PDF title — and a build that derives more than the one before leaves the
// rows it never opened behind. A hub that has settled loads ui/pdfUpkeep.ts
// in a hidden frame, which revisits those rows one at a time, quietly. Which
// rows are done is kept per device (`rpdfUpkeep`, never synced): a row is
// visited once per PDF_UPKEEP_VERSION, so bump it when opening starts to
// derive something new, and say what in rowNeedsUpkeep.

import type { PdfLibrary, PdfLibraryEntry } from './pdfLibrary';

export const PDF_UPKEEP_VERSION = 1;
export const PDF_UPKEEP_STORAGE_KEY = 'rpdfUpkeep';
export const PDF_UPKEEP_PAGE = 'pdf-upkeep.html';
/** Posted by the upkeep frame to its hub when it has finished. */
export const PDF_UPKEEP_DONE_MESSAGE = 'rpdf-upkeep-done';

export interface PdfUpkeepState {
  /** docId → the upkeep version the row was brought up to. */
  done: Record<string, number>;
}

export function parsePdfUpkeepState(value: unknown): PdfUpkeepState {
  const done: Record<string, number> = {};
  const raw = typeof value === 'object' && value !== null ? (value as { done?: unknown }).done : undefined;
  if (typeof raw === 'object' && raw !== null) {
    for (const [docId, version] of Object.entries(raw)) {
      if (Number.isInteger(version) && (version as number) > 0) done[docId] = version as number;
    }
  }
  return { done };
}

/** What a row lacks that opening it now would fill in. */
export function rowNeedsUpkeep(entry: PdfLibraryEntry): boolean {
  // Version 1: the kind (rows from before kinds existed). A row the user
  // already classified has nothing to gain.
  return entry.paperKind === null && entry.userKind === null;
}

/** Rows to revisit, the most recently opened first. */
export function rowsNeedingUpkeep(library: PdfLibrary, state: PdfUpkeepState, version: number = PDF_UPKEEP_VERSION): PdfLibraryEntry[] {
  return Object.values(library)
    .filter((entry) => (state.done[entry.docId] ?? 0) < version && rowNeedsUpkeep(entry))
    .sort((a, b) => b.openedAt - a.openedAt || a.docId.localeCompare(b.docId));
}

/** `state` with `docIds` marked done, and rows the library no longer has dropped. */
export function markPdfUpkeepDone(state: PdfUpkeepState, docIds: readonly string[], library: PdfLibrary, version: number = PDF_UPKEEP_VERSION): PdfUpkeepState {
  const done: Record<string, number> = {};
  for (const [docId, v] of Object.entries(state.done)) if (library[docId]) done[docId] = v;
  for (const docId of docIds) done[docId] = version;
  return { done };
}
