import { describe, expect, it } from 'vitest';

import { clusterBoxes, detectFigures, graphicBoxes, type OpsLike } from '../src/shared/figureDetect';
import type { Box, TextLine } from '../src/shared/figureSource';

const PAGE = { width: 612, height: 792 };
const line = (text: string, left: number, top: number, right: number, h = 9): TextLine => ({ text, left, top, right, bottom: top + h });
const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom });
const rule = (left: number, y: number, right: number): Box => ({ left, top: y, right, bottom: y + 0.5 });
const labels = (found: ReturnType<typeof detectFigures>) => found.map((f) => (f.label ? `${f.label.kind} ${f.label.number}` : 'none'));

describe('figure detection', () => {
  it('reads image and path boxes from an operator list through save/transform/restore', () => {
    const OPS: OpsLike = {
      save: 10, restore: 11, transform: 12, constructPath: 91, endPath: 28, paintImageXObject: 85, paintInlineImageXObject: 86,
      paintImageMaskXObject: 83, paintImageXObjectRepeat: 88, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75, beginGroup: 76, endGroup: 77,
    };
    // Viewport: PDF y up → y down on a 792-pt page.
    const vp = [1, 0, 0, -1, 0, 792];
    const boxes = graphicBoxes(
      [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore, OPS.constructPath, OPS.constructPath],
      [null, [200, 0, 0, 100, 72, 600], ['img1', 10, 10], null, [22, [], [72, 100, 300, 101]], [OPS.endPath, [], [0, 0, 612, 792]]],
      OPS, vp,
    );
    expect(boxes).toEqual([box(72, 92, 272, 192), box(72, 691, 300, 692)]); // the clip-only path is skipped
  });

  it('merges a plot\'s many paths into one cluster', () => {
    expect(clusterBoxes([box(100, 100, 150, 150), box(155, 100, 200, 150), box(400, 400, 420, 420)])).toEqual([box(100, 100, 200, 150), box(400, 400, 420, 420)]);
  });

  it('names a figure by the caption under it, joins side-by-side panels, keeps their labels and never the caption', () => {
    const found = detectFigures([
      line('Scaled Attention Multi-Head Attention', 150, 60, 440),
      line('Figure 2: (left) Scaled attention. (right) Multi-head attention consists of', 72, 290, 540),
      line('several attention layers running in parallel.', 72, 300, 400),
      line('Body text paragraph well below the figure.', 72, 340, 540),
    ], [box(160, 75, 260, 270), box(330, 80, 470, 270)], PAGE);
    expect(labels(found)).toEqual(['figure 2']);
    const f = found[0].box;
    expect(f.left).toBeLessThanOrEqual(150);
    expect(f.right).toBeGreaterThanOrEqual(470);
    expect(f.top).toBeLessThanOrEqual(60);
    expect(f.bottom).toBeLessThan(290);
  });

  it('finds a table on the side of its caption with the nearer rule — above (ACL) or below (CVPR)', () => {
    // Caption above, booktabs rules below; the header row right under the caption is not caption text.
    const acl = detectFigures([
      line('Table 2: The Transformer achieves better BLEU scores than previous models.', 108, 72, 504),
      line('English-to-German and English-to-French tests.', 108, 82, 400),
      line('Model BLEU Training Cost', 131, 96, 480),
      line('ByteNet 23.75', 131, 128, 300),
      line('Transformer (big) 28.4 41.0', 131, 230, 300),
    ], [rule(131, 95, 481), rule(131, 125, 481), rule(131, 216, 481), rule(131, 243, 481)], PAGE);
    expect(labels(acl)).toEqual(['table 2']);
    expect(acl[0].box.top).toBeLessThanOrEqual(95);
    expect(acl[0].box.bottom).toBeGreaterThanOrEqual(243);
    // Captions under their tables, two tables stacked: each takes its own.
    const cvpr = detectFigures([
      line('Table 3. Error rates on ImageNet validation.', 50, 220, 290),
      line('Table 4. Error rates of single-model results.', 50, 400, 290),
    ], [rule(60, 70, 280), rule(60, 120, 280), rule(60, 212, 280), rule(60, 255, 280), rule(60, 300, 280), rule(60, 392, 280)], PAGE);
    expect(labels(cvpr)).toEqual(['table 3', 'table 4']);
    expect([cvpr[0].box.top, cvpr[0].box.bottom].map(Math.round)).toEqual([67, 216]);
    expect([cvpr[1].box.top, cvpr[1].box.bottom].map(Math.round)).toEqual([252, 396]);
  });

  it('does not take a plot\'s dashed gridlines for a table', () => {
    const found = detectFigures([
      line('Table 1. Architectures.', 100, 60, 400),
      line('Figure 4. Training on ImageNet.', 80, 400, 520),
    ], [box(80, 250, 520, 390), rule(90, 300, 510), rule(90, 340, 510)], PAGE);
    expect(labels(found)).toEqual(['figure 4']);
  });

  it('offers big unnamed graphics, and names one whose caption sits beside it or inside its box', () => {
    expect(labels(detectFigures([], [box(100, 100, 300, 250)], PAGE))).toEqual(['none']);
    expect(labels(detectFigures([], [box(100, 100, 130, 120)], PAGE))).toEqual([]);
    const side = detectFigures([line('Figure 4: Advantage of geometric fan out.', 420, 120, 540)], [box(80, 100, 400, 260)], PAGE);
    expect(labels(side)).toEqual(['figure 4']);
    const inside = detectFigures([line('Figure 4: Advantage of geometric fan out.', 72, 196, 540)], [box(92, 69, 526, 250)], PAGE);
    expect(labels(inside)).toEqual(['figure 4']);
    expect(inside[0].box.bottom).toBeLessThan(196);
  });
});
