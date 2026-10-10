// ─── Formula recognition: an image of a formula → LaTeX ───
//
// pix2text-mfr-1.5 (assets/models/NOTICE.md), a TrOCR-style model: a DeiT
// encoder reads the image squeezed to 384×384, a small decoder writes LaTeX
// tokens one at a time. The bundled copy is int8 and split so each step
// costs ~3 ms — the encoder hands over the decoder's cross-attention keys
// and values once, the decoder carries its own between steps — so a formula
// reads in about a second on one wasm thread. Loaded on first use (~31 MB);
// runs take turns with the layout model (ortRuntime.ts).

import { FORMULA_SPECIAL_IDS, decodeTokens, tidyLatex } from '../../shared/latexTidy';
import { debugLog } from '../../shared/debugLog';
import { type Ort, type OrtSession, createSession, loadOrt, takeTurn } from './ortRuntime';

const DIR = 'models/pix2text-mfr/';
const SIZE = 384;
// config.json of pix2text-mfr-1.5.
const START = 1;
const END = 2;
const LAYERS = 6;
const HEADS = 8;
const HEAD_DIM = 32;
// A formula worth reading ends long before this; a run that gets here was
// reading prose (an area with a paragraph in it).
const MAX_TOKENS = 400;
// Below this mean token probability the reading is shown, marked unsure.
const SURE = 0.9;

interface Loaded { ort: Ort; encoder: OrtSession; decoder: OrtSession; pieces: string[] }

let loading: Promise<Loaded> | null = null;

function load(): Promise<Loaded> {
  loading ??= (async () => {
    const started = performance.now();
    const [ort, encoder, decoder, tokenizer] = await Promise.all([
      loadOrt(),
      createSession(`${DIR}encoder_kv.onnx`),
      createSession(`${DIR}decoder_with_past.onnx`),
      fetch(chrome.runtime.getURL(`${DIR}tokenizer.json`)).then((r) => r.json() as Promise<{ model: { vocab: Record<string, number> }; added_tokens?: Array<{ id: number; content: string }> }>),
    ]);
    const pieces: string[] = [];
    for (const [piece, id] of Object.entries(tokenizer.model.vocab)) pieces[id] = piece;
    for (const t of tokenizer.added_tokens ?? []) pieces[t.id] = t.content;
    debugLog('viewer', `formula model loaded in ${Math.round(performance.now() - started)}ms`);
    return { ort, encoder, decoder, pieces };
  })();
  // A failed load is tried again next time.
  loading.catch(() => { loading = null; });
  return loading;
}

export type FormulaProgress = { phase: 'load' } | { phase: 'read' };

export interface FormulaReading {
  latex: string;
  /** The model was sure of every token (mean probability ≥ 0.9). */
  sure: boolean;
}

/** Thrown when the area held no formula the model could finish. */
export class NotAFormula extends Error {
  constructor() { super('not a formula'); }
}

/** The model's input: RGB on white, stretched to 384×384 (as its processor does; padding to a square reads worse), scaled to −1…1, CHW. */
function pixels(image: HTMLCanvasElement): Float32Array {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, SIZE, SIZE);
  const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
  const plane = SIZE * SIZE;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i += 1) {
    out[i] = data[i * 4] / 127.5 - 1;
    out[plane + i] = data[i * 4 + 1] / 127.5 - 1;
    out[2 * plane + i] = data[i * 4 + 2] / 127.5 - 1;
  }
  return out;
}

/** Reads the formula in `image` (a region rendered on white). */
export async function recognizeFormula(image: HTMLCanvasElement, onProgress: (progress: FormulaProgress) => void = () => undefined): Promise<FormulaReading> {
  if (!loading) onProgress({ phase: 'load' });
  const { ort, encoder, decoder, pieces } = await load();
  const input = pixels(image);
  return takeTurn(async () => {
    onProgress({ phase: 'read' });
    const started = performance.now();
    const cross = await encoder.run({ pixel_values: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) });
    let past: Record<string, InstanceType<Ort['Tensor']>> = {};
    for (let l = 0; l < LAYERS; l += 1) {
      for (const kv of ['k', 'v']) past[`past_${kv}_${l}`] = new ort.Tensor('float32', new Float32Array(0), [1, HEADS, 0, HEAD_DIM]);
    }
    const ids: number[] = [];
    let token = START;
    let logProb = 0;
    let finished = false;
    try {
      while (ids.length < MAX_TOKENS) {
        const out = await decoder.run({ input_ids: new ort.Tensor('int64', BigInt64Array.of(BigInt(token)), [1, 1]), ...cross, ...past });
        const logits = out.logits.data as Float32Array;
        let best = 0;
        for (let v = 1; v < logits.length; v += 1) if (logits[v] > logits[best]) best = v;
        let sum = 0;
        for (let v = 0; v < logits.length; v += 1) sum += Math.exp(logits[v] - logits[best]);
        logProb -= Math.log(sum);
        for (const t of Object.values(past)) t.dispose();
        past = {};
        for (let l = 0; l < LAYERS; l += 1) {
          for (const kv of ['k', 'v']) past[`past_${kv}_${l}`] = out[`present_${kv}_${l}`];
        }
        out.logits.dispose();
        if (best === END) { finished = true; break; }
        ids.push(best);
        token = best;
      }
    } finally {
      for (const t of [...Object.values(past), ...Object.values(cross)]) t.dispose();
    }
    const raw = decodeTokens(ids.filter((id) => id >= FORMULA_SPECIAL_IDS).map((id) => pieces[id] ?? ''));
    const score = Math.exp(logProb / (ids.length + 1));
    debugLog('viewer', `formula read in ${Math.round(performance.now() - started)}ms`, () => ({ tokens: ids.length, score, raw }));
    if (!finished || ids.length === 0) throw new NotAFormula();
    return { latex: tidyLatex(raw), sure: score >= SURE };
  });
}
