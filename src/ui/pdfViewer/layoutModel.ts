// ─── Layout model: where the figures and tables of a page are, by sight ───
//
// PP-DocLayout-S (assets/models/NOTICE.md), run with ONNX Runtime Web
// (ortRuntime.ts) on the page rendered at rotation 0. Loaded the first time auto-detect needs it (the
// runtime and model are ~18 MB, never fetched otherwise); runs one page at a
// time. Interpreting the output with the PDF's own text and graphics is
// shared/layoutDetect.ts.

import type { PDFPageProxy } from 'pdfjs-dist';
import { AnnotationMode } from 'pdfjs-dist';
import { LAYOUT_INPUT_SIZE, layoutDetections, layoutInput, type LayoutDetection } from '../../shared/layoutDetect';
import { debugLog } from '../../shared/debugLog';
import { type Ort, type OrtSession, createSession, loadOrt, takeTurn } from './ortRuntime';

// The page is rendered this tall before being squeezed to 480×480: enough
// detail for small panels, cheap to render.
const RENDER_HEIGHT = 960;
const MODEL_PATH = 'models/pp-doclayout-s.onnx';

interface Loaded { ort: Ort; session: OrtSession }

let loading: Promise<Loaded | null> | null = null;

function load(): Promise<Loaded | null> {
  loading ??= (async () => {
    const started = performance.now();
    const ort = await loadOrt();
    const session = await createSession(MODEL_PATH);
    debugLog('viewer', `layout model loaded in ${Math.round(performance.now() - started)}ms`);
    return { ort, session };
  })().catch((error: unknown) => {
    debugLog('viewer', 'layout model unavailable', () => ({ error: error instanceof Error ? error.message : String(error) }));
    return null;
  });
  return loading;
}

/** Thrown for a queued run that was no longer wanted when its turn came. */
export class LayoutSkipped extends Error {
  constructor() { super('layout run skipped'); }
}

/**
 * The model's detections on a page, in PDF points (rotation-0, y down); null
 * if the model cannot run. `wanted` is asked when the run's turn comes (runs
 * wait for each other): false rejects with LayoutSkipped instead of running.
 */
export function detectLayout(page: PDFPageProxy, wanted: () => boolean = () => true): Promise<LayoutDetection[] | null> {
  const run = takeTurn(async () => {
    if (!wanted()) throw new LayoutSkipped();
    const loaded = await load();
    if (!wanted()) throw new LayoutSkipped();
    if (!loaded) return null;
    const base = page.getViewport({ scale: 1 });
    const scale = RENDER_HEIGHT / base.height;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    await page.render({ canvasContext: ctx, viewport, annotationMode: AnnotationMode.DISABLE } as Parameters<PDFPageProxy['render']>[0]).promise;
    const small = document.createElement('canvas');
    small.width = LAYOUT_INPUT_SIZE;
    small.height = LAYOUT_INPUT_SIZE;
    const sctx = small.getContext('2d', { willReadFrequently: true });
    if (!sctx) return null;
    sctx.drawImage(canvas, 0, 0, LAYOUT_INPUT_SIZE, LAYOUT_INPUT_SIZE);
    const input = layoutInput(sctx.getImageData(0, 0, LAYOUT_INPUT_SIZE, LAYOUT_INPUT_SIZE).data);
    const { ort, session } = loaded;
    const started = performance.now();
    const result = await session.run({
      image: new ort.Tensor('float32', input, [1, 3, LAYOUT_INPUT_SIZE, LAYOUT_INPUT_SIZE]),
      scale_factor: new ort.Tensor('float32', new Float32Array([LAYOUT_INPUT_SIZE / canvas.height, LAYOUT_INPUT_SIZE / canvas.width]), [1, 2]),
    });
    const [rowsName, countName] = session.outputNames;
    const rows = result[rowsName].data as Float32Array;
    const count = Number((result[countName].data as ArrayLike<number | bigint>)[0]);
    debugLog('viewer', `layout model ran in ${Math.round(performance.now() - started)}ms`, () => ({ detections: count }));
    // Boxes come back in the rendered canvas's pixels; the canvas was rounded up.
    return layoutDetections(rows, count, canvas.height / base.height);
  });
  return run.catch((error: unknown) => { if (error instanceof LayoutSkipped) throw error; return null; });
}
