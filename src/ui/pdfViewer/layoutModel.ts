// ─── Layout model: where the figures and tables of a page are, by sight ───
//
// PP-DocLayout-S (assets/models/NOTICE.md), run with ONNX Runtime Web (wasm,
// one thread: extension pages are not cross-origin isolated) on the page
// rendered at rotation 0. Loaded the first time auto-detect needs it (the
// runtime and model are ~18 MB, never fetched otherwise); runs one page at a
// time. Interpreting the output with the PDF's own text and graphics is
// shared/layoutDetect.ts.

import type { PDFPageProxy } from 'pdfjs-dist';
import { AnnotationMode } from 'pdfjs-dist';
import { LAYOUT_INPUT_SIZE, layoutDetections, layoutInput, type LayoutDetection } from '../../shared/layoutDetect';
import { debugLog } from '../../shared/debugLog';

// The page is rendered this tall before being squeezed to 480×480: enough
// detail for small panels, cheap to render.
const RENDER_HEIGHT = 960;
const MODEL_PATH = 'models/pp-doclayout-s.onnx';

type Ort = typeof import('onnxruntime-web/wasm');
interface Loaded { ort: Ort; session: Awaited<ReturnType<Ort['InferenceSession']['create']>> }

let loading: Promise<Loaded | null> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function load(): Promise<Loaded | null> {
  loading ??= (async () => {
    const started = performance.now();
    const ort = await import(/* webpackChunkName: "ort" */ 'onnxruntime-web/wasm');
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/');
    const bytes = await (await fetch(chrome.runtime.getURL(MODEL_PATH))).arrayBuffer();
    const session = await ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['wasm'] });
    debugLog('viewer', `layout model loaded in ${Math.round(performance.now() - started)}ms`);
    return { ort, session };
  })().catch((error: unknown) => {
    debugLog('viewer', 'layout model unavailable', () => ({ error: error instanceof Error ? error.message : String(error) }));
    return null;
  });
  return loading;
}

/** The model's detections on a page, in PDF points (rotation-0, y down); null if the model cannot run. */
export function detectLayout(page: PDFPageProxy): Promise<LayoutDetection[] | null> {
  const run = queue.then(async () => {
    const loaded = await load();
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
  queue = run.catch(() => undefined);
  return run.catch(() => null);
}
