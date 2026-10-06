// "문서 속성" dialog — the same fields Chrome's viewer shows.

import type { PDFDocumentProxy } from 'pdfjs-dist';
import { byId, el, formatBytes, formatPdfDate } from './dom';
import { S } from './viewerParts.strings';

interface PropertiesInput {
  doc: PDFDocumentProxy;
  fileName: string;
  byteLength: number | null;
}

function pageSizeLabel(width: number, height: number): string {
  // PDF user units are 1/72 inch.
  const wIn = width / 72;
  const hIn = height / 72;
  const wMm = wIn * 25.4;
  const hMm = hIn * 25.4;
  const orientation = width > height ? S.landscape : S.portrait;
  const named = [
    ['A4', 210, 297], ['A3', 297, 420], ['Letter', 215.9, 279.4], ['Legal', 215.9, 355.6],
  ] as const;
  const short = Math.min(wMm, hMm);
  const long = Math.max(wMm, hMm);
  const name = named.find(([, a, b]) => Math.abs(short - a) < 1.5 && Math.abs(long - b) < 1.5)?.[0];
  return `${wMm.toFixed(1)} × ${hMm.toFixed(1)} mm (${wIn.toFixed(2)} × ${hIn.toFixed(2)} in, ${name ? `${name}, ` : ''}${orientation})`;
}

export async function showDocumentProperties({ doc, fileName, byteLength }: PropertiesInput): Promise<void> {
  const dialog = byId<HTMLDialogElement>('vocab-t-pdf-properties');
  const table = byId<HTMLTableSectionElement>('vt-props-body');
  table.replaceChildren();

  const [meta, page] = await Promise.all([doc.getMetadata().catch(() => null), doc.getPage(1)]);
  const info = (meta?.info ?? {}) as Record<string, unknown>;
  const view = page.view;
  const rows: Array<[string, string]> = [
    [S.propFileName, fileName],
    [S.propFileSize, byteLength === null ? '' : formatBytes(byteLength)],
    [S.propTitle, String(info.Title ?? '')],
    [S.propAuthor, String(info.Author ?? '')],
    [S.propSubject, String(info.Subject ?? '')],
    [S.propKeywords, String(info.Keywords ?? '')],
    [S.propCreated, formatPdfDate(info.CreationDate)],
    [S.propModified, formatPdfDate(info.ModDate)],
    [S.propCreator, String(info.Creator ?? '')],
    [S.propProducer, String(info.Producer ?? '')],
    [S.propVersion, String(info.PDFFormatVersion ?? '')],
    [S.propPageCount, String(doc.numPages)],
    [S.propPageSize, pageSizeLabel(view[2] - view[0], view[3] - view[1])],
    [S.propFastWebView, info.IsLinearized ? S.yes : S.no],
  ];
  for (const [label, value] of rows) {
    table.append(el('tr', {}, [el('th', { textContent: label }), el('td', { textContent: value || '–' })]));
  }
  dialog.showModal();
}
