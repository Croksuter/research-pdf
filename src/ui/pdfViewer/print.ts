// Printing: PDF.js has no print service in the components build, so pages are
// rasterized into <img> elements inside a print-only container and the page is
// printed with `window.print()`. Annotations (including freshly drawn ones and
// form values) are included via the print annotation storage.

import type { PDFDocumentProxy } from 'pdfjs-dist';
import { AnnotationMode } from 'pdfjs-dist';
import { byId, el } from './dom';

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

  try {
    const scale = PRINT_DPI / CSS_DPI;
    for (let n = 1; n <= doc.numPages; n += 1) {
      if (cancelled) break;
      progressText.textContent = `인쇄 준비 중… ${n} / ${doc.numPages}`;
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
      const img = el('img', { alt: `페이지 ${n}` });
      // Portrait vs landscape sheets are sized by CSS; the image scales to fit.
      img.src = canvas.toDataURL('image/png');
      const sheet = el('div', { className: viewport.width > viewport.height ? 'vt-print-page is-landscape' : 'vt-print-page' }, [img]);
      container.append(sheet);
      progressBar.value = n;
      page.cleanup();
    }
    if (!cancelled) {
      progress.hidden = true;
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      window.print();
    }
  } finally {
    cancelBtn.removeEventListener('click', onCancel);
    progress.hidden = true;
    // Leave the images until the print dialog closes; afterprint clears them.
    const clear = () => { container.replaceChildren(); window.removeEventListener('afterprint', clear); };
    window.addEventListener('afterprint', clear);
    setTimeout(clear, 60_000);
    printing = false;
  }
}
