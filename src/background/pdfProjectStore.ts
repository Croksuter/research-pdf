// ─── Project store (chrome.storage.local, background-only writer) ───
//
// Hubs send project changes (create, rename, delete, members, pins, the open
// tabs) and the sync applies its merge; all of them go through here, one
// read-modify-write at a time. Pages read the map directly and follow
// `chrome.storage.onChanged`. Before the first write a device has no record:
// it reads as the default project seeded with the library's old pins.

import {
  PDF_PROJECTS_STORAGE_KEY,
  applyPdfProjectUpdate,
  mergePdfProjectLists,
  parsePdfProjects,
  pdfProjectsFromList,
  seedPdfProjects,
  type PdfProject,
  type PdfProjects,
  type PdfProjectUpdate,
} from '../shared/pdfProjects';
import { readPdfLibrary } from './pdfLibraryStore';

let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

export async function readPdfProjects(): Promise<PdfProjects> {
  try {
    const stored = await chrome.storage.local.get(PDF_PROJECTS_STORAGE_KEY);
    const raw = stored[PDF_PROJECTS_STORAGE_KEY];
    if (raw === undefined) return seedPdfProjects(Object.values(await readPdfLibrary()));
    return parsePdfProjects(raw);
  } catch {
    return parsePdfProjects(undefined);
  }
}

async function write(projects: PdfProjects): Promise<void> {
  await chrome.storage.local.set({ [PDF_PROJECTS_STORAGE_KEY]: projects });
}

/** Applies `change` to the stored projects; true when anything changed. */
export function mutatePdfProjects(change: (projects: PdfProjects) => PdfProjects): Promise<boolean> {
  return serialized(async () => {
    const before = await readPdfProjects();
    const after = change(before);
    if (after === before) return false;
    await write(after);
    return true;
  });
}

export function updatePdfProjects(update: PdfProjectUpdate): Promise<boolean> {
  return mutatePdfProjects((projects) => applyPdfProjectUpdate(projects, update));
}

/** Joins synced projects into the local ones (never loses a concurrent local write). */
export function mergeIntoPdfProjects(rows: readonly PdfProject[]): Promise<void> {
  return serialized(async () => {
    const before = await readPdfProjects();
    await write(pdfProjectsFromList(mergePdfProjectLists(Object.values(before), rows)));
  });
}
