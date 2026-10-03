import { it } from 'vitest';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { detectFigures, graphicBoxes } from '../../src/shared/figureDetect';
import { captionLabel, groupLines, type PlacedText } from '../../src/shared/figureSource';
import { LAYOUT_INPUT_SIZE, combineLayout, layoutDetections, layoutInput } from '../../src/shared/layoutDetect';

const DIR = process.env.EVAL_DIR ?? '';
const MODEL = new URL('../../assets/models/pp-doclayout-s.onnx', import.meta.url).pathname;
const SCALE = 2;

it.skipIf(!DIR)('rule-based vs hybrid on the PDFs in EVAL_DIR', async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const ort = await import('onnxruntime-web');
  const { createCanvas } = await import('@napi-rs/canvas');
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(new Uint8Array(readFileSync(MODEL)));
  const out: unknown[] = [];
  const files = readdirSync(DIR).filter((f) => f.endsWith('.pdf')).sort().filter((f) => !process.env.ONLY || f.includes(process.env.ONLY));
  for (const name of files) {
    let doc;
    try { doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(`${DIR}/${name}`)), isEvalSupported: false }).promise; } catch { continue; }
    for (let p = 1; p <= Math.min(doc.numPages, Number(process.env.MAX_PAGES ?? 14)); p += 1) {
      const page = await doc.getPage(p);
      const vp1 = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const placed: PlacedText[] = [];
      for (const item of content.items as Array<{ str?: string; transform: number[]; width: number }>) {
        if (!item.str) continue;
        const [a, b] = item.transform;
        if (Math.abs(b) > Math.abs(a)) continue;
        const tx = pdfjs.Util.transform(vp1.transform, item.transform);
        placed.push({ str: item.str, x: tx[4], baseline: tx[5], width: item.width, height: Math.hypot(tx[2], tx[3]) });
      }
      const lines = groupLines(placed);
      const ops = await page.getOperatorList();
      const graphics = graphicBoxes(ops.fnArray, ops.argsArray, pdfjs.OPS as never, vp1.transform);
      const ruleBased = detectFigures(lines, graphics, { width: vp1.width, height: vp1.height });
      const vp = page.getViewport({ scale: SCALE });
      const canvas = createCanvas(Math.round(vp.width), Math.round(vp.height));
      await page.render({ canvasContext: canvas.getContext('2d') as never, viewport: vp, canvas: canvas as never }).promise;
      const small = createCanvas(LAYOUT_INPUT_SIZE, LAYOUT_INPUT_SIZE);
      small.getContext('2d').drawImage(canvas, 0, 0, LAYOUT_INPUT_SIZE, LAYOUT_INPUT_SIZE);
      const input = layoutInput(small.getContext('2d').getImageData(0, 0, LAYOUT_INPUT_SIZE, LAYOUT_INPUT_SIZE).data);
      const t0 = Date.now();
      const res = await session.run({
        image: new ort.Tensor('float32', input, [1, 3, LAYOUT_INPUT_SIZE, LAYOUT_INPUT_SIZE]),
        scale_factor: new ort.Tensor('float32', new Float32Array([LAYOUT_INPUT_SIZE / vp.height, LAYOUT_INPUT_SIZE / vp.width]), [1, 2]),
      });
      const ms = Date.now() - t0;
      const [detName, numName] = session.outputNames;
      const dets = layoutDetections(res[detName].data as Float32Array, Number((res[numName].data as ArrayLike<number | bigint>)[0]), SCALE);
      const hybrid = combineLayout({ dets, lines, graphics, page: { width: vp1.width, height: vp1.height }, ruleBased });
      const captions = lines.filter((l) => captionLabel(l.text) ?? captionLabel(l.text.replace(/^\d{1,5}\s+/u, ''))).map((l) => l.text.slice(0, 50));
      out.push({ file: name, page: p, ms, captions, ruleBased, hybrid, raw: dets.filter((d) => d.score >= 0.3 && /image|chart|table|title/.test(d.cls)) });
    }
  }
  writeFileSync(`${DIR}/compare.json`, JSON.stringify(out));
}, 1_800_000);
