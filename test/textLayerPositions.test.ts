import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { planRun, recordTextLayerChunk, recordedTextLayerItems } from '../src/ui/pdfViewer/textLayerPositions';

const require = createRequire(import.meta.url);
const { patchPdfWorker } = require('../scripts/pdfjs-worker-patch.cjs') as { patchPdfWorker: (source: string) => string };

// A 10-unit font in which every character is 0.5 em wide.
const half = () => 0.5;
const item = (str: string, charStarts: number[] | null, transform = [10, 0, 0, 10, 0, 0]) => ({ str, transform, charStarts });

describe('laying runs out on glyph positions', () => {
  it('leaves characters that already land right as plain text', () => {
    const plan = planRun(item('abc', [0, 5, 10, 15]), half);
    expect(plan).toEqual({ scaleX: 1, segments: [{ text: 'abc', spacingEm: null }] });
  });

  it('gives a word gap and a kern exactly the spacing the PDF has', () => {
    // "ab cd": the gap after "b" is 1.2 em instead of the space's 0.5; "c" is kerned 0.1 em tight.
    const plan = planRun(item('ab cd', [0, 5, 10, 22, 26, 31]), half);
    expect(plan?.segments).toEqual([
      { text: 'ab', spacingEm: null },
      { text: ' ', spacingEm: 0.7 },
      { text: 'c', spacingEm: -0.1 },
      { text: 'd', spacingEm: null },
    ]);
  });

  it('keeps the run\'s horizontal scale and measures positions before it', () => {
    // Tz 150 %: advances in the PDF are 1.5 × the font's.
    const plan = planRun(item('ab', [0, 7.5, 15], [15, 0, 0, 10, 0, 0]), half);
    expect(plan).toEqual({ scaleX: 1.5, segments: [{ text: 'ab', spacingEm: null }] });
  });

  it('never splits a surrogate pair', () => {
    const plan = planRun(item('a😀b', [0, 5, 20, 20, 25]), (ch) => (ch.length === 2 ? 1 : 0.5));
    expect(plan?.segments.map((s) => s.text)).toEqual(['a', '😀', 'b']);
    expect(plan?.segments[1].spacingEm).toBeCloseTo(0.5);
  });

  it('refuses items without usable positions', () => {
    expect(planRun(item('abc', null), half)).toBeNull();
    expect(planRun(item('abc', [0, 5, 10]), half)).toBeNull();
    expect(planRun(item('abc', [0, 5, 10, Number.NaN]), half)).toBeNull();
    expect(planRun(item('abc', [0, 5, 10, 15], [0, 0, 0, 0, 0, 0]), half)).toBeNull();
  });

  it('records the text layer\'s items in span order, one list per page', () => {
    const page = {};
    recordTextLayerChunk(page, { items: [{ type: 'beginMarkedContent' }, { str: 'a', transform: [1, 0, 0, 1, 0, 0] }, { str: '', hasEOL: true }] }, true);
    recordTextLayerChunk(page, { items: [{ str: 'b', transform: [1, 0, 0, 1, 0, 0] }] }, false);
    const other = {};
    recordTextLayerChunk(other, { items: [{ str: 'x', transform: [1, 0, 0, 1, 0, 0] }] }, true);
    expect(recordedTextLayerItems(page).map((i) => i.str)).toEqual(['a', 'b']);
    expect(recordedTextLayerItems(other).map((i) => i.str)).toEqual(['x']);
    // A new stream for the page (a re-render) starts over.
    recordTextLayerChunk(page, { items: [{ str: 'c', transform: [1, 0, 0, 1, 0, 0] }] }, true);
    expect(recordedTextLayerItems(page).map((i) => i.str)).toEqual(['c']);
  });
});

describe('PDF.js worker patch', () => {
  const worker = readFileSync(resolve(__dirname, '../node_modules/pdfjs-dist/build/pdf.worker.mjs'), 'utf8');

  it('applies to the installed PDF.js and emits charStarts', () => {
    const patched = patchPdfWorker(worker);
    expect(patched).toContain('charStarts: rpdfCharStarts(textChunk, text, bidiResult)');
    expect(patched.match(/rpdfStarts\.push/gu)).toHaveLength(3);
  });

  it('refuses a worker it does not recognise instead of shipping it half-patched', () => {
    expect(() => patchPdfWorker(worker.replace('const TRACKING_SPACE_FACTOR = 0.102;', ''))).toThrow(/position helper/u);
    expect(() => patchPdfWorker(patchPdfWorker(worker))).toThrow(/anchor found/u);
  });
});
