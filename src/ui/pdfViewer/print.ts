// Printing: PDF.js has no print service in the components build, so pages are
// rasterized into <img> elements inside a print-only container and the page is
// printed with `window.print()`. Annotations (including freshly drawn ones and
// form values) are included via the print annotation storage. Each page goes
// through one canvas at a time into a PNG blob (an object URL, revoked after
// printing), so a long document never holds every page as pixels or as a
// data-URL string at once.

import type { PDFDocumentProxy } from 'pdfjs-dist';
import { AnnotationMode } from 'pdfjs-dist';
import { byId, el } from './dom';
import { S } from './viewerParts.strings';

const PRINT_DPI = 150;
const CSS_DPI = 96;

let printing = false;

export function isPrinting(): boolean {
  return printing;
}

export async function printDocument(doc: PDFDocumentProxy): Promise<void> {
  if (printing) return;
  printing = true;
  const container = byId<HTMLDivElement>('vocab-t-pdf-print');
  const progress = byId<HTMLDivElement>('vocab-t-pdf-print-progress');
  const progressText = byId<HTMLSpanElement>('vt-print-progress-text');
  const progressBar = byId<HTMLProgressElement>('vt-print-progress-bar');
  container.replaceChildren();
  progress.hidden = false;
  progressBar.max = doc.numPages;
  progressBar.value = 0;
  let cancelled = false;
  const cancelBtn = byId<HTMLButtonElement>('vt-print-cancel');
  const onCancel = () => { cancelled = true; };
  cancelBtn.addEventListener('click', onCancel, { once: true });

  const urls: string[] = [];
  const loads: Array<Promise<unknown>> = [];
  try {
    const scale = PRINT_DPI / CSS_DPI;
    for (let n = 1; n <= doc.numPages; n += 1) {
      if (cancelled) break;
      progressText.textContent = S.printPreparing(n, doc.numPages);
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas 2d context unavailable');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({
        canvasContext: ctx,
        viewport,
        intent: 'print',
        annotationMode: AnnotationMode.ENABLE_STORAGE,
        printAnnotationStorage: doc.annotationStorage.print,
      } as Parameters<typeof page.render>[0]).promise;
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      // Release the pixels now rather than whenever the canvas is collected.
      canvas.width = 0;
      canvas.height = 0;
      if (!blob) throw new Error('page image could not be encoded');
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const img = el('img', { alt: S.pageN(n) });
      loads.push(new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; }));
      // Portrait vs landscape sheets are sized by CSS; the image scales to fit.
      img.src = url;
      const sheet = el('div', { className: viewport.width > viewport.height ? 'vt-print-page is-landscape' : 'vt-print-page' }, [img]);
      container.append(sheet);
      progressBar.value = n;
      page.cleanup();
    }
    if (!cancelled) {
      progress.hidden = true;
      await Promise.all(loads);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      window.print();
    }
  } finally {
    cancelBtn.removeEventListener('click', onCancel);
    progress.hidden = true;
    // Leave the images until the print dialog closes; afterprint clears them.
    const clear = () => {
      container.replaceChildren();
      for (const url of urls.splice(0)) URL.revokeObjectURL(url);
      window.removeEventListener('afterprint', clear);
    };
    window.addEventListener('afterprint', clear);
    setTimeout(clear, 60_000);
    printing = false;
  }
}
