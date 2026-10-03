// ─── The open document's own reference list ───
//
// Reads the text of the document's last pages (where the References section
// is, before any appendix) and hands it to shared/pdfReferences.ts. Once per
// document; the strip asks only when no database has the list.

import type { PDFDocumentProxy } from 'pdfjs-dist';
import { extractPdfReferences, linesFromTextItems, type PdfReference, type PdfTextItem, type TextLine } from '../../shared/pdfReferences';

// Appendices after the references can be long; books are out of scope.
const MAX_PAGES = 80;

const cache = new WeakMap<PDFDocumentProxy, Promise<PdfReference[]>>();

export function pdfReferences(doc: PDFDocumentProxy): Promise<PdfReference[]> {
  let pending = cache.get(doc);
  if (!pending) {
    pending = read(doc).catch(() => []);
    cache.set(doc, pending);
  }
  return pending;
}

async function read(doc: PDFDocumentProxy): Promise<PdfReference[]> {
  const lines: TextLine[] = [];
  for (let n = Math.max(1, doc.numPages - MAX_PAGES + 1); n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const items = content.items.filter((item): item is typeof item & PdfTextItem => 'str' in item);
    lines.push(...linesFromTextItems(n, items, page.view[2] - page.view[0]));
  }
  return extractPdfReferences(lines);
}
