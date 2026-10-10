// ─── ONNX Runtime Web, shared by the viewer's models ───
//
// One wasm runtime for the layout model (layoutModel.ts) and the formula
// model (formulaOcr.ts): one thread, since extension pages are not
// cross-origin isolated, loaded the first time a model needs it. Runs take
// turns, so a formula read waits for a page's layout run and never overlaps it.

export type Ort = typeof import('onnxruntime-web/wasm');
export type OrtSession = Awaited<ReturnType<Ort['InferenceSession']['create']>>;

let loading: Promise<Ort> | null = null;
let queue: Promise<unknown> = Promise.resolve();

export function loadOrt(): Promise<Ort> {
  loading ??= import(/* webpackChunkName: "ort" */ 'onnxruntime-web/wasm').then((ort) => {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/');
    return ort;
  });
  loading.catch(() => { loading = null; });
  return loading;
}

/** A session for the model at `path` (inside the extension). */
export async function createSession(path: string): Promise<OrtSession> {
  const ort = await loadOrt();
  const bytes = await (await fetch(chrome.runtime.getURL(path))).arrayBuffer();
  return ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
}

/** Runs `task` after every run queued before it. */
export function takeTurn<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.catch(() => undefined);
  return run;
}
