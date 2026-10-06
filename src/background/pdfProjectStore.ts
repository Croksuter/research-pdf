// ─── Project store (chrome.storage.local, background-only writer) ───
//
// Hubs send project changes (create, rename, delete, members, pins, the open
// tabs, looks, folders and order) and the sync applies its merge; all of them
// go through here, one read-modify-write at a time. Folders are kept under
// their own key. Pages read the map directly and follow
// `chrome.storage.onChanged`. Before the first write a device has no record:
// it reads as the default project seeded with the library's old pins.

import {
  PDF_PROJECTS_STORAGE_KEY,
  PDF_PROJECT_FOLDERS_STORAGE_KEY,
  applyPdfFolderUpdate,
  applyPdfProjectUpdate,
  pdfFolderLimitReached,
  pdfProjectLimitReached,
  mergePdfProjectFolderLists,
  mergePdfProjectLists,
  parsePdfProjectFolders,
  parsePdfProjects,
  pdfProjectFoldersFromList,
  pdfProjectsFromList,
  seedPdfProjects,
  type PdfFolderUpdate,
  type PdfProject,
  type PdfProjectFolder,
  type PdfProjectFolders,
  type PdfProjects,
  type PdfProjectUpdate,
} from '../shared/pdfProjects';
import { readPdfLibrary } from './pdfLibraryStore';
import { createSerialQueue } from './serialQueue';

const serialized = createSerialQueue();

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

export async function readPdfProjectFolders(): Promise<PdfProjectFolders> {
  try {
    return parsePdfProjectFolders((await chrome.storage.local.get(PDF_PROJECT_FOLDERS_STORAGE_KEY))[PDF_PROJECT_FOLDERS_STORAGE_KEY]);
  } catch {
    return {};
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

export type PdfProjectLimit = 'project-limit' | 'folder-limit';

/**
 * A hub's change (projects, folders, order) applied atomically; creating a
 * project or folder at the cap is refused and says which cap.
 */
export function applyPdfProjectRequest(update: PdfProjectUpdate | PdfFolderUpdate): Promise<{ changed: boolean; refused: PdfProjectLimit | null }> {
  return serialized(async () => {
    const before = { projects: await readPdfProjects(), folders: await readPdfProjectFolders() };
    if (update.kind === 'create' && !before.projects[update.id] && pdfProjectLimitReached(before.projects)) return { changed: false, refused: 'project-limit' };
    if (update.kind === 'folder-create' && !before.folders[update.id] && pdfFolderLimitReached(before.folders)) return { changed: false, refused: 'folder-limit' };
    if (update.kind === 'folder-create' || update.kind === 'folder-rename' || update.kind === 'folder-delete' || update.kind === 'arrange') {
      const after = applyPdfFolderUpdate(before, update);
      if (after === before) return { changed: false, refused: null };
      await chrome.storage.local.set({ [PDF_PROJECTS_STORAGE_KEY]: after.projects, [PDF_PROJECT_FOLDERS_STORAGE_KEY]: after.folders });
      return { changed: true, refused: null };
    }
    const after = applyPdfProjectUpdate(before.projects, update);
    if (after === before.projects) return { changed: false, refused: null };
    await write(after);
    return { changed: true, refused: null };
  });
}

/** Joins synced projects and folders into the local ones (never loses a concurrent local write). */
export function mergeIntoPdfProjects(rows: readonly PdfProject[], folders: readonly PdfProjectFolder[] = []): Promise<void> {
  return serialized(async () => {
    const before = await readPdfProjects();
    const beforeFolders = await readPdfProjectFolders();
    await chrome.storage.local.set({
      [PDF_PROJECTS_STORAGE_KEY]: pdfProjectsFromList(mergePdfProjectLists(Object.values(before), rows)),
      [PDF_PROJECT_FOLDERS_STORAGE_KEY]: pdfProjectFoldersFromList(mergePdfProjectFolderLists(Object.values(beforeFolders), folders)),
    });
  });
}
