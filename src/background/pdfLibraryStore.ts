// ─── Library store (chrome.storage.local, background-only writer) ───
//
// Viewer frames report opens and detected titles, the hub reports pins; all
// of them go through here, one read-modify-write at a time, so two frames
// finishing together cannot drop each other's row. The Drive sync applies its
// merge through the same queue. Pages read the map directly and follow
// `chrome.storage.onChanged`.

import {
  PDF_LIBRARY_STORAGE_KEY,
  applyPdfLibraryUpdate,
  libraryFromList,
  mergePdfLibraries,
  parsePdfLibrary,
  type PdfLibrary,
  type PdfLibraryEntry,
  type PdfLibraryUpdate,
} from '../shared/pdfLibrary';

let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

export async function readPdfLibrary(): Promise<PdfLibrary> {
  try {
    const stored = await chrome.storage.local.get(PDF_LIBRARY_STORAGE_KEY);
    return parsePdfLibrary(stored[PDF_LIBRARY_STORAGE_KEY]);
  } catch {
    return {};
  }
}

async function write(library: PdfLibrary): Promise<void> {
  await chrome.storage.local.set({ [PDF_LIBRARY_STORAGE_KEY]: library });
}

export function updatePdfLibrary(update: PdfLibraryUpdate): Promise<boolean> {
  return serialized(async () => {
    const before = await readPdfLibrary();
    const after = applyPdfLibraryUpdate(before, update);
    if (after === before) return false;
    await write(after);
    return true;
  });
}

/** Joins synced rows into the local ones (never loses a concurrent local write). */
export function mergeIntoPdfLibrary(rows: readonly PdfLibraryEntry[]): Promise<void> {
  return serialized(async () => {
    const before = await readPdfLibrary();
    await write(libraryFromList(mergePdfLibraries(Object.values(before), rows)));
  });
}
