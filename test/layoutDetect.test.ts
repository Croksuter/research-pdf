import { describe, expect, it } from 'vitest';

import { combineLayout, layoutDetections, layoutInput, layoutRegions, type LayoutDetection } from '../src/shared/layoutDetect';
import type { Box, TextLine } from '../src/shared/figureSource';

const PAGE = { width: 612, height: 792 };
const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom });
const line = (text: string, left: number, top: number, right: number, h = 9): TextLine => ({ text, left, top, right, bottom: top + h });
const det = (cls: LayoutDetection['cls'], score: number, b: Box): LayoutDetection => ({ cls, score, box: b });
const names = (found: ReturnType<typeof combineLayout>) => found.map((f) => (f.label ? `${f.label.kind} ${f.label.number}` : 'none'));

describe('layout model output', () => {
  it('normalises the input and maps rows back to PDF points', () => {
    const rgba = new Uint8ClampedArray(480 * 480 * 4).fill(255);
    const input = layoutInput(rgba);
    expect(input.length).toBe(3 * 480 * 480);
    expect(input[0]).toBeCloseTo((1 - 0.485) / 0.229, 5);
    // Rendered at 2 px per point: class 1 (image) at (100,200)-(300,400) px.
    expect(layoutDetections([1, 0.9, 100, 200, 300, 400, 99, 0.5, 0, 0, 1, 1], 2, 2)).toEqual([
      { cls: 'image', score: 0.9, box: box(50, 100, 150, 200) },
    ]);
  });

  it('keeps one region per figure: panels and image+chart duplicates fold into the whole', () => {
    const regions = layoutRegions([
      det('image', 0.79, box(58, 60, 538, 268)),
      det('image', 0.57, box(60, 88, 211, 266)),
      det('chart', 0.47, box(54, 368, 539, 662)),
      det('image', 0.74, box(54, 358, 539, 667)),
      det('table', 0.2, box(0, 0, 10, 10)), // under the threshold
    ]);
    expect(regions.map((r) => [r.kind, Math.round(r.box.top)])).toEqual([['figure', 358], ['figure', 60]]);
  });
});

describe('combining the model with the PDF', () => {
  it('names figures from the model\'s caption regions, unpunctuated and line-numbered ones included', () => {
    const found = combineLayout({
      dets: [
        det('image', 0.79, box(58, 60, 538, 268)),
        det('figure_title', 0.72, box(45, 277, 553, 339)),
        det('image', 0.74, box(54, 358, 539, 667)),
        det('figure_title', 0.7, box(41, 673, 553, 715)),
      ],
      lines: [
        line('Fig. 1 The superiority of scientifically derived colour maps. By knowing', 45, 280, 553),
        line('321 Fig. 2 Colour vision tests. Available perceptually uniform maps', 41, 676, 553),
      ],
      graphics: [],
      page: PAGE,
      ruleBased: [],
    });
    expect(names(found)).toEqual(['figure 1', 'figure 2']);
  });

  it('snaps to the PDF graphics and the labels on them, never taking the caption', () => {
    const found = combineLayout({
      dets: [det('chart', 0.8, box(130, 60, 470, 280)), det('figure_title', 0.8, box(68, 286, 538, 328))],
      lines: [
        line('Aggregate Performance', 200, 66, 380),
        line('a', 138, 62, 144),
        line('Figure 1.3: Aggregate performance for all benchmarks', 68, 288, 538),
      ],
      graphics: [box(142, 80, 462, 272), box(150, 90, 300, 200)],
      page: PAGE,
      ruleBased: [],
    });
    expect(names(found)).toEqual(['figure 1.3']);
    const b = found[0].box;
    expect(b.top).toBeLessThanOrEqual(62); // title and panel letter in
    expect(b.left).toBeLessThanOrEqual(138);
    expect(b.bottom).toBeLessThan(286); // caption out
  });

  it('prefers the caption under a figure and over a table, and names a figure from a heading above it', () => {
    const found = combineLayout({
      dets: [
        det('table', 0.9, box(100, 100, 500, 200)),
        det('table_title', 0.8, box(100, 80, 500, 95)),
        det('image', 0.8, box(170, 300, 450, 460)),
      ],
      lines: [line('Table 2: Results on the test set.', 100, 82, 500), line('321 Figure 1.', 90, 280, 140)],
      graphics: [],
      page: PAGE,
      ruleBased: [],
    });
    expect(names(found)).toEqual(['table 2', 'figure 1']);
  });

  it('adds what only the rules found, and names an unnamed region the rules named', () => {
    const found = combineLayout({
      dets: [det('image', 0.8, box(100, 100, 300, 250))],
      lines: [],
      graphics: [],
      page: PAGE,
      ruleBased: [
        { box: box(98, 98, 302, 252), label: { kind: 'figure', number: '3' } },
        { box: box(100, 500, 500, 600), label: { kind: 'table', number: '1' } },
      ],
    });
    expect(names(found)).toEqual(['figure 3', 'table 1']);
  });
});
