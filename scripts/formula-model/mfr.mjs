// Minimal image -> LaTeX with breezedeus/pix2text-mfr(-1.5) ONNX, greedy decoding,
// run with onnxruntime-web (wasm EP, 1 thread) in Node — the same runtime the
// extension ships — and @napi-rs/canvas for image decode/resize.
//
// usage: node scripts/formula-model/mfr.mjs assets/models/pix2text-mfr [--pad] [--maxlen N] <image> [image...]
//   (assets/models/pix2text-mfr has no config.json: copy the one build.sh downloads next to the models)
//   modelDir holds config.json, tokenizer.json and one of three model layouts:
//     stock (HF as published): encoder_model.onnx + decoder_model.onnx (full prefix every step)
//     split (hoist.py)       : encoder_kv.onnx + decoder_step.onnx (cross K/V computed once)
//     cached (kvcache.py)    : encoder_kv.onnx + decoder_with_past.onnx (one token per step)
//   --pad      letterbox the image into a white square before the 384x384 resize
//              (default: plain stretch, which is what TrOCRProcessor does; --pad is much worse)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const RPDF = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../node_modules');
const ort = require(`${RPDF}/onnxruntime-web`);
const { createCanvas, loadImage } = require(`${RPDF}/@napi-rs/canvas`);

ort.env.wasm.numThreads = 1;

const SIZE = 384;          // preprocessor_config.json size
const SPECIAL = new Set([0, 1, 2, 3, 4]); // <pad> <s> </s> <unk> <mask>

// ── args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const modelDir = args.shift();
let pad = false, maxLen = 512, encName = 'encoder_model.onnx', decName = 'decoder_model.onnx';
const images = [];
while (args.length) {
  const a = args.shift();
  if (a === '--pad') pad = true;
  else if (a === '--maxlen') maxLen = Number(args.shift());
  else if (a === '--enc') encName = args.shift();
  else if (a === '--dec') decName = args.shift();
  else images.push(a);
}

// Special ids differ by version (v1.0 starts with id 2, v1.5 with id 1): read config.json.
const cfg = JSON.parse(fs.readFileSync(path.join(modelDir, 'config.json'), 'utf8'));
const BOS = cfg.decoder_start_token_id, EOS = cfg.eos_token_id;
const V = cfg.decoder.vocab_size;
maxLen = Math.min(maxLen, cfg.decoder.max_position_embeddings);

// ── tokenizer: byte-level BPE, decode only ──────────────────────────────
function byteDecoder() {
  // GPT-2 bytes_to_unicode, inverted: unicode char -> byte
  const bs = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n++); }
  const m = new Map();
  bs.forEach((b, i) => m.set(String.fromCodePoint(cs[i]), b));
  return m;
}
const tok = JSON.parse(fs.readFileSync(path.join(modelDir, 'tokenizer.json'), 'utf8'));
const idToToken = [];
for (const [t, id] of Object.entries(tok.model.vocab)) idToToken[id] = t;
for (const t of tok.added_tokens) idToToken[t.id] = t.content;
const b2 = byteDecoder();
const utf8 = new TextDecoder('utf-8');
function decodeIds(ids) {
  const s = ids.filter((id) => !SPECIAL.has(id)).map((id) => idToToken[id] ?? '').join('');
  const bytes = [];
  for (const ch of s) { const b = b2.get(ch); if (b !== undefined) bytes.push(b); }
  return utf8.decode(new Uint8Array(bytes));
}

// ── pix2text LatexOCR.post_process, ported ──────────────────────────────
const WS = [String.raw`\\ +`, String.raw`\\quad\s*`, String.raw`\\qquad\s*`, String.raw`\\,\s*`, String.raw`\\:\s*`, String.raw`\\;\s*`, String.raw`\\enspace\s*`, String.raw`\\thinspace\s*`, String.raw`\\!\s*`];
const EMPTY = ['hat', 'text', 'tilde', 'bar', 'vec', 'acute', 'grave', 'breve', 'overline', 'dot', 'ddot', 'widehat', 'widetilde']
  .map((c) => new RegExp(String.raw`\\${c}\s*{\s*}`, 'g'))
  .concat([/\^\s*{\s*}/g, /_\s*{\s*}/g]);
function postProcess(t) {
  t = t.replace(/^\^\s*{\s*(.*?)\s*}/, '$1').replace(/^_\s*{\s*(.*?)\s*}/, '$1').trim();      // remove_redundant_script
  t = t.replace(new RegExp(`(?:${WS.join('|')})+$`), '').trim();                             // remove_trailing_whitespace
  t = t.replace(/\\\./g, '\\ .').replace(/\\=/g, '\\ =').replace(/\\-/g, '\\ -').replace(/\\~/g, '\\ ~'); // replace_illegal_symbols
  for (let i = 0; i < 10; i++) { const n = EMPTY.reduce((s, r) => s.replace(r, ''), t).trim(); if (n === t) break; t = n; } // remove_empty_text
  t = t.replace(/\s+/g, ' ').trim();                 // (fix_latex's \left/\right pairing omitted; it ends by collapsing spaces)
  // remove_unnecessary_spaces
  t = t.replace(/\\([a-zA-Z]+)\s+(?![a-zA-Z])/g, '\\$1');
  t = t.replace(/(\{)\s+/g, '$1').replace(/\s+(\})/g, '$1');
  t = t.replace(/(?<=[^\\])\s*([+\-=])\s*/g, '$1');
  t = t.replace(/\s*(\^|_)\s*/g, '$1');
  return t.trim();
}

// ── compact form: drop every token-separator space LaTeX ignores in math mode.
// Keeps a space only where it ends a control word before a letter (\alpha x) or
// is a control space (\ ). Also unwraps a single-row \begin{aligned}...\\ \end{aligned}.
function compact(t) {
  t = t.trim();
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (!/\s/.test(c)) { out += c; continue; }
    while (i + 1 < t.length && /\s/.test(t[i + 1])) i++;
    const next = t[i + 1] ?? '';
    const ctrlWord = /(^|[^\\])(\\\\)*\\[a-zA-Z]+$/.test(out);          // ends with \cmd (odd backslashes before letters)
    const ctrlSpace = /(^|[^\\])(\\\\)*\\$/.test(out);                      // odd number of trailing backslashes
    if ((ctrlWord && /[a-zA-Z]/.test(next)) || ctrlSpace) out += ' ';
  }
  const m = out.match(/^\\begin\{aligned\}\{([^&]*)\}\\\\\\end\{aligned\}$/);
  if (m && !m[1].includes('\\\\')) out = m[1];
  return out;
}

// ── preprocessing: RGB on white, resize to 384x384, (x/255-0.5)/0.5, NCHW ──
async function preprocess(file) {
  const img = await loadImage(fs.readFileSync(file));
  const c = createCanvas(SIZE, SIZE);
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, SIZE, SIZE); // transparent pixels -> white
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  if (pad) {
    const s = SIZE / Math.max(img.width, img.height);
    const w = img.width * s, h = img.height * s;
    g.drawImage(img, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
  } else {
    g.drawImage(img, 0, 0, SIZE, SIZE);
  }
  const { data } = g.getImageData(0, 0, SIZE, SIZE);
  const plane = SIZE * SIZE;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    out[i] = data[i * 4] / 127.5 - 1;
    out[plane + i] = data[i * 4 + 1] / 127.5 - 1;
    out[2 * plane + i] = data[i * 4 + 2] / 127.5 - 1;
  }
  return { tensor: new ort.Tensor('float32', out, [1, 3, SIZE, SIZE]), w: img.width, h: img.height };
}

// ── greedy decoding with decoder_with_past.onnx: one token per step, self-attention
// K/V carried between steps (past_* in, present_* out), cross K/V from encoder_kv ──
async function recognizeCached(enc, dec, pixel) {
  const t0 = performance.now();
  const cross = await enc.run({ pixel_values: pixel });          // cross_k_0..5, cross_v_0..5 [1,578,256]
  const t1 = performance.now();
  const layers = cfg.decoder.decoder_layers, heads = cfg.decoder.decoder_attention_heads, hd = cfg.decoder.d_model / heads;
  let past = {};
  for (let l = 0; l < layers; l++) for (const kv of 'kv') past[`past_${kv}_${l}`] = new ort.Tensor('float32', new Float32Array(0), [1, heads, 0, hd]);
  const ids = [BOS];
  let logProbSum = 0, steps = 0;
  while (ids.length < maxLen) {
    const input = new ort.Tensor('int64', BigInt64Array.of(BigInt(ids[ids.length - 1])), [1, 1]);
    const out = await dec.run({ input_ids: input, ...cross, ...past });
    const L = out.logits.data;                                    // [1,1,V]
    let best = 0, max = -Infinity;
    for (let v = 0; v < V; v++) if (L[v] > max) { max = L[v]; best = v; }
    let z = 0;
    for (let v = 0; v < V; v++) z += Math.exp(L[v] - max);
    logProbSum += -Math.log(z); steps++;
    for (const t of Object.values(past)) t.dispose?.();
    past = {};
    for (let l = 0; l < layers; l++) for (const kv of 'kv') past[`past_${kv}_${l}`] = out[`present_${kv}_${l}`];
    out.logits.dispose?.(); input.dispose?.();
    if (best === EOS) break;
    ids.push(best);
  }
  const t2 = performance.now();
  for (const t of [...Object.values(past), ...Object.values(cross)]) t.dispose?.();
  return { ids, encMs: t1 - t0, decMs: t2 - t1, score: Math.exp(logProbSum / steps) };
}

// ── greedy decoding (no KV cache: the decoder reruns on the whole prefix) ──
async function recognize(enc, dec, pixel) {
  const t0 = performance.now();
  const encOut = await enc.run({ pixel_values: pixel });
  // Stock export: feed last_hidden_state as encoder_hidden_states. Split export
  // (encoder_kv.onnx): feed the 12 precomputed cross-attention K/V tensors as-is.
  const encFeeds = encOut.last_hidden_state ? { encoder_hidden_states: encOut.last_hidden_state } : encOut;
  const t1 = performance.now();
  const ids = [BOS];
  let logProbSum = 0, steps = 0;
  while (ids.length < maxLen) {
    const input = new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]);
    const { logits } = await dec.run({ input_ids: input, ...encFeeds });
    const L = logits.data;
    const off = (ids.length - 1) * V; // last position
    let best = 0, max = -Infinity;
    for (let v = 0; v < V; v++) if (L[off + v] > max) { max = L[off + v]; best = v; }
    let z = 0;
    for (let v = 0; v < V; v++) z += Math.exp(L[off + v] - max);
    logProbSum += -Math.log(z); steps++;   // log of the chosen token's softmax prob
    input.dispose?.(); logits.dispose?.();
    if (best === EOS) break;
    ids.push(best);
  }
  const t2 = performance.now();
  for (const t of Object.values(encOut)) t.dispose?.();
  return { ids, encMs: t1 - t0, decMs: t2 - t1, score: Math.exp(logProbSum / steps) };
}

const cached = fs.existsSync(path.join(modelDir, 'decoder_with_past.onnx'));
if (cached) { encName = 'encoder_kv.onnx'; decName = 'decoder_with_past.onnx'; }
else if (fs.existsSync(path.join(modelDir, 'encoder_kv.onnx'))) { encName = 'encoder_kv.onnx'; decName = 'decoder_step.onnx'; }
const tl0 = performance.now();
const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
const enc = await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(path.join(modelDir, encName))), opts);
const dec = await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(path.join(modelDir, decName))), opts);
console.log(`# ${modelDir} start=${BOS} eos=${EOS} vocab=${V} maxLen=${maxLen}; ort-web ${ort.env.versions?.web ?? ''} wasm 1-thread; ${encName} + ${decName} loaded in ${Math.round(performance.now() - tl0)} ms; ${pad ? 'pad-to-square' : 'stretch'} resize`);
for (const file of images) {
  const { tensor, w, h } = await preprocess(file);
  const r = await (cached ? recognizeCached : recognize)(enc, dec, tensor);
  const raw = decodeIds(r.ids);
  console.log(`\n${path.basename(file)} (${w}x${h}) tokens=${r.ids.length - 1} enc=${Math.round(r.encMs)}ms dec=${Math.round(r.decMs)}ms score=${r.score.toFixed(3)}`);
  console.log(`  raw : ${raw}`);
  console.log(`  p2t : ${postProcess(raw)}`);
  console.log(`  tidy: ${compact(raw)}`);
}
