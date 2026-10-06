// ─── Per-document viewer state (chrome.storage.local) ───
//
// One bounded map under a single key; see shared/pdfIdentity.ts for how
// documents are keyed. Read here directly; written only by the background
// (background/pdfDocStateStore.ts), which serializes every frame's save with
// the Drive sync's apply so none of them drops another's row.

import type { PDFDocumentProxy } from 'pdfjs-dist';
import { debugWarn } from '../../shared/debugLog';
import type { PdfDocStateSaveRequest } from '../../shared/messages';
import {
  PDF_DOC_STATE_STORAGE_KEY,
  buildPdfDocId,
  findPdfDocRecord,
  fingerprintIsUsable,
  hasTrailerId,
  parsePdfDocRecords,
  sha256Hex,
  type PdfDocIdentity,
  type PdfDocRecord,
  type PdfDocRecords,
} from '../../shared/pdfIdentity';

async function readRecords(): Promise<PdfDocRecords> {
  try {
    const stored = await chrome.storage.local.get(PDF_DOC_STATE_STORAGE_KEY);
    return parsePdfDocRecords(stored[PDF_DOC_STATE_STORAGE_KEY]);
  } catch {
    return {};
  }
}

export interface PdfBytesInfo {
  sha256: string | null;
  trailerHasId: boolean;
}

/**
 * Inspects the whole file when the caller already holds it (local file /
 * drag-drop): the SHA-256 alias is free and the trailer can be checked for a
 * real `/ID`. Run before the buffer is handed to PDF.js, which transfers it
 * to the worker.
 */
export async function inspectPdfBytes(bytes: Uint8Array): Promise<PdfBytesInfo> {
  const trailerHasId = hasTrailerId(bytes);
  let sha256: string | null = null;
  try {
    sha256 = await sha256Hex(bytes);
  } catch {
    sha256 = null;
  }
  return { sha256, trailerHasId };
}

/**
 * Derives the document identity. Without `bytesInfo` (URL loads, which are
 * range-fetched) the full document is downloaded only when the fingerprint
 * is unusable.
 */
export async function derivePdfDocIdentity(doc: PDFDocumentProxy, bytesInfo: PdfBytesInfo | null): Promise<PdfDocIdentity | null> {
  const [fingerprint = null, fingerprintModified = null] = doc.fingerprints;
  const numPages = doc.numPages;
  const trailerHasId = bytesInfo?.trailerHasId;
  let sha256 = bytesInfo?.sha256 ?? null;
  if (!sha256 && !fingerprintIsUsable({ fingerprint, trailerHasId })) {
    try {
      sha256 = await sha256Hex(await doc.getData());
    } catch {
      sha256 = null;
    }
  }
  const docId = buildPdfDocId({ fingerprint, numPages, sha256, trailerHasId });
  if (!docId) return null;
  return { docId, fingerprint, fingerprintModified, numPages, sha256 };
}

export async function loadPdfDocRecord(identity: PdfDocIdentity): Promise<PdfDocRecord | null> {
  const records = await readRecords();
  return findPdfDocRecord(records, { docId: identity.docId, sha256: identity.sha256 });
}

/**
 * Hands the position to the background's writer. The message leaves at once,
 * so a save made while the page is going away (pagehide, sleep) still lands.
 */
export async function savePdfDocRecord(record: PdfDocRecord): Promise<void> {
  const message: PdfDocStateSaveRequest = { type: 'VOCAB_T_PDF_DOC_STATE_SAVE', record };
  try {
    const response = await chrome.runtime.sendMessage(message) as { success?: boolean } | undefined;
    if (response?.success !== true) debugWarn('viewer:docs', 'reading position not stored', () => ({ docId: record.docId, response }));
  } catch (error) {
    debugWarn('viewer:docs', 'reading position not stored', () => ({ docId: record.docId, error: error instanceof Error ? error.message : String(error) }));
  }
}
