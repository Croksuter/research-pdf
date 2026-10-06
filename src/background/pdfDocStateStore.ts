// ─── Reading positions (chrome.storage.local, background-only writer) ───
//
// One map under one key (`vtPdfDocs`, shared/pdfIdentity.ts), and every write
// rewrites the whole map. Viewer frames send their saves here
// (`VOCAB_T_PDF_DOC_STATE_SAVE`, ui/pdfViewer/docState.ts) and the Drive sync
// applies its merge through the same queue, so two frames saving together, or
// a frame saving while the sync applies, can no longer drop each other's row.
// Pages read the map directly and follow `chrome.storage.onChanged`.

import { debugWarn } from '../shared/debugLog';
import {
  PDF_DOC_STATE_STORAGE_KEY,
  parsePdfDocRecords,
  upsertPdfDocRecord,
  type PdfDocRecord,
  type PdfDocRecords,
} from '../shared/pdfIdentity';
import { createSerialQueue } from './serialQueue';

const serialized = createSerialQueue();

export async function readPdfDocRecords(): Promise<PdfDocRecords> {
  try {
    const stored = await chrome.storage.local.get(PDF_DOC_STATE_STORAGE_KEY);
    return parsePdfDocRecords(stored[PDF_DOC_STATE_STORAGE_KEY]);
  } catch {
    return {};
  }
}

async function write(records: PdfDocRecords): Promise<void> {
  try {
    await chrome.storage.local.set({ [PDF_DOC_STATE_STORAGE_KEY]: records });
  } catch (error) {
    // Usually the storage quota: the position is lost, but say so.
    debugWarn('bg:docs', 'failed to store reading positions', () => ({ error: error instanceof Error ? error.message : String(error) }));
    throw error;
  }
}

/** A viewer's save. A newer row already stored (another device's, by sync) is kept. */
export function savePdfDocRecord(record: PdfDocRecord): Promise<boolean> {
  return serialized(async () => {
    const current = await readPdfDocRecords();
    if ((current[record.docId]?.updatedAt ?? -Infinity) > record.updatedAt) return false;
    await write(upsertPdfDocRecord(current, record));
    return true;
  });
}

/**
 * Read-modify-write of the whole map in the queue: `change` sees the map as it
 * is right now and answers the map to store (null: leave it) and a result.
 */
export function mutatePdfDocRecords<T>(change: (current: PdfDocRecords) => { next: PdfDocRecords | null; result: T }): Promise<T> {
  return serialized(async () => {
    const { next, result } = change(await readPdfDocRecords());
    if (next) await write(next);
    return result;
  });
}
