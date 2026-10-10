// ─── A document's copy in the user's Drive folder (document info, home) ───
//
// The background does the work (background/pdfDriveFiles.ts); this asks it
// and shows how it went. Keeping files in Drive is turned on in settings,
// where Google is asked for the permission.

import { syncErrorText, isSyncErrorCode } from '../../shared/syncErrors';
import type { PdfLibraryEntry } from '../../shared/pdfLibrary';
import { S } from '../pdfHub.strings';
import { ask } from './store';
import { el, icon, showToast } from './uiKit';
import { showSettings } from './tabStrip';

interface DriveFilesStatus { available: boolean; enabled: boolean; folderUrl: string | null; stored: number }
type Reply = { success?: boolean; errorCode?: unknown; status?: DriveFilesStatus; stored?: number } | undefined;

export async function driveFilesStatus(): Promise<DriveFilesStatus | null> {
  const reply = await ask<Reply>({ type: 'VOCAB_T_PDF_DRIVE_STATUS' });
  return reply?.status ?? null;
}

function failed(reply: Reply): void {
  const code = isSyncErrorCode(reply?.errorCode) ? reply.errorCode : 'failed';
  const toSettings = code === 'files-off' || code === 'files-consent' || code === 'connect-first';
  showToast(syncErrorText(code, null), toSettings ? { label: S.openSettings, run: showSettings } : undefined);
}

/** Keeps the documents' files in Drive; says how it went. */
export async function keepInDrive(docIds: string[]): Promise<boolean> {
  showToast(S.driveUploading(docIds.length));
  const reply = await ask<Reply>({ type: 'VOCAB_T_PDF_DRIVE_STORE', docIds });
  if (reply?.success) { showToast(S.driveKept(docIds.length)); return true; }
  failed(reply);
  return false;
}

/** Brings a document's Drive copy to this device (its file cache). */
export async function fetchFromDrive(docId: string): Promise<boolean> {
  const reply = await ask<Reply>({ type: 'VOCAB_T_PDF_DRIVE_FETCH', docId });
  return reply?.success === true;
}

/** The Drive part of the document info panel. */
export function driveSection(entry: PdfLibraryEntry): HTMLElement {
  const box = el('section', { className: 'rpdf-docinfo-section' });
  box.append(el('h3', { className: 'rpdf-docinfo-head', textContent: S.driveHeading }));
  const body = el('div', { className: 'rpdf-docinfo-drive' });
  box.append(body);
  const button = (label: string, run: (b: HTMLButtonElement) => void, primary = false) => {
    const b = el('button', { type: 'button', className: primary ? 'rpdf-primary rpdf-docinfo-btn' : 'rpdf-ask-btn rpdf-docinfo-btn', textContent: label });
    b.addEventListener('click', () => run(b));
    return b;
  };
  if (entry.driveFileId) {
    const fileId = entry.driveFileId;
    const open = el('a', { className: 'rpdf-docinfo-link', href: `https://drive.google.com/file/d/${fileId}/view`, target: '_blank', rel: 'noopener' });
    open.append(icon('i-drive'), el('span', { textContent: S.driveStored }));
    body.append(open, button(S.driveRemove, (b) => {
      b.disabled = true;
      void ask<Reply>({ type: 'VOCAB_T_PDF_DRIVE_REMOVE', docId: entry.docId }).then((reply) => {
        if (reply?.success) showToast(S.driveRemoved); else { b.disabled = false; failed(reply); }
      });
    }));
    return box;
  }
  const hint = el('p', { className: 'rpdf-docinfo-hint', textContent: '' });
  body.append(hint);
  void driveFilesStatus().then((status) => {
    if (status?.enabled) {
      hint.textContent = S.driveNotStored;
      body.append(button(S.driveKeep, (b) => { b.disabled = true; void keepInDrive([entry.docId]).then((ok) => { if (!ok) b.disabled = false; }); }, true));
    } else {
      hint.textContent = status?.available ? S.driveOff : S.driveNeedsSync;
      body.append(button(S.openSettings, () => showSettings()));
    }
  });
  return box;
}
