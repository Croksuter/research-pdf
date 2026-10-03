// ─── Figure copy: where the figures and tables of a page are (pure) ───
//
// Auto-detect capture (ui/pdfViewer/figureCapture.ts) outlines the figures
// and tables of each rendered page so one click copies one. The page's
// drawing operations (PDF.js operator list) give the boxes of its images and
// vector paths; its text lines give the captions:
//
//   • graphics that touch or nearly touch are one cluster (a plot is many
//     paths); a cluster big enough is a figure candidate, and the short text
//     lines on it (axis labels, legends) are part of it;
//   • a "Figure N" caption names the candidate just above it (else just
//     below) and takes in the other candidates of the same block above it
//     (sub-figures);
//   • a "Table N" caption names the table below it (else above): between its
//     horizontal rules when it has them (booktabs), otherwise the run of
//     closely spaced lines;
//   • candidates no caption claimed are offered unnamed.
//
// Everything is in a rotation-0 viewport at scale 1: PDF points, y down.

import { captionLabel, type Box, type FigureLabel, type TextLine } from './figureSource';

export interface DetectedFigure {
  box: Box;
  label: FigureLabel | null;
}

/** The operator ids this module reads (PDF.js `OPS`). */
export interface OpsLike {
  save: number;
  restore: number;
  transform: number;
  constructPath: number;
  endPath: number;
  paintImageXObject: number;
  paintInlineImageXObject: number;
  paintImageMaskXObject: number;
  paintImageXObjectRepeat: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  beginGroup: number;
  endGroup: number;
}

type Matrix = [number, number, number, number, number, number];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function boxOf(m: Matrix, x0: number, y0: number, x1: number, y1: number): Box {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

const MAX_BOXES = 4_000;

/**
 * Boxes of what a page paints (images, filled or stroked paths), from its
 * operator list, in viewport space (`viewportTransform` of a rotation-0,
 * scale-1 viewport). Clipping-only paths are skipped.
 */
export function graphicBoxes(fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>, ops: OpsLike, viewportTransform: number[]): Box[] {
  let ctm = viewportTransform.slice(0, 6) as Matrix;
  const stack: Matrix[] = [];
  const boxes: Box[] = [];
  for (let i = 0; i < fnArray.length && boxes.length < MAX_BOXES; i += 1) {
    const fn = fnArray[i];
    const args = argsArray[i] as unknown[] | null;
    switch (fn) {
      case ops.save:
        stack.push(ctm);
        break;
      case ops.restore:
        ctm = stack.pop() ?? ctm;
        break;
      case ops.transform:
        if (args && args.length >= 6) ctm = multiply(ctm, args.slice(0, 6) as Matrix);
        break;
      case ops.paintFormXObjectBegin: {
        stack.push(ctm);
        const matrix = args?.[0];
        if (Array.isArray(matrix) && matrix.length >= 6) ctm = multiply(ctm, matrix.slice(0, 6) as Matrix);
        break;
      }
      case ops.paintFormXObjectEnd:
        ctm = stack.pop() ?? ctm;
        break;
      case ops.beginGroup: {
        stack.push(ctm);
        const matrix = (args?.[0] as { matrix?: unknown } | undefined)?.matrix;
        if (Array.isArray(matrix) && matrix.length >= 6) ctm = multiply(ctm, matrix.slice(0, 6) as Matrix);
        break;
      }
      case ops.endGroup:
        ctm = stack.pop() ?? ctm;
        break;
      case ops.paintImageXObject:
      case ops.paintInlineImageXObject:
      case ops.paintImageMaskXObject:
      case ops.paintImageXObjectRepeat:
        boxes.push(boxOf(ctm, 0, 0, 1, 1));
        break;
      case ops.constructPath: {
        const paint = args?.[0];
        const minMax = args?.[2] as ArrayLike<number> | null | undefined;
        if (paint === ops.endPath || !minMax || minMax.length < 4) break;
        const [x0, y0, x1, y1] = [minMax[0], minMax[1], minMax[2], minMax[3]];
        if (![x0, y0, x1, y1].every(Number.isFinite) || x1 < x0 || y1 < y0) break;
        boxes.push(boxOf(ctm, x0, y0, x1, y1));
        break;
      }
      default:
        break;
    }
  }
  return boxes;
}

// ─── Detection ───

const width = (b: Box) => b.right - b.left;
const height = (b: Box) => b.bottom - b.top;
const union = (a: Box, b: Box): Box => ({ left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) });
const hOverlap = (a: Box, b: Box) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
const near = (a: Box, b: Box, gap: number) => a.left - gap <= b.right && b.left - gap <= a.right && a.top - gap <= b.bottom && b.top - gap <= a.bottom;

/** A thin horizontal line: a table rule. */
const isRule = (b: Box) => height(b) <= 2.5 && width(b) >= 30;

const CLUSTER_GAP = 8;
const MIN_FIGURE = { w: 40, h: 30 };
const MIN_UNLABELED = { w: 80, h: 60 };
const PAD = 3;

/** Merges boxes that overlap or nearly touch, until none do. */
export function clusterBoxes(boxes: readonly Box[], gap = CLUSTER_GAP): Box[] {
  let clusters = [...boxes];
  for (let changed = true; changed;) {
    changed = false;
    const next: Box[] = [];
    for (const box of clusters) {
      const hit = next.findIndex((c) => near(c, box, gap));
      if (hit >= 0) { next[hit] = union(next[hit], box); changed = true; } else next.push({ ...box });
    }
    clusters = next;
  }
  return clusters;
}

interface Candidate { box: Box; used: boolean }

export function detectFigures(lines: readonly TextLine[], graphics: readonly Box[], page: { width: number; height: number }): DetectedFigure[] {
  const onPage = graphics.filter((b) => width(b) * height(b) > 1 || isRule(b))
    .map((b) => ({ left: Math.max(0, b.left), top: Math.max(0, b.top), right: Math.min(page.width, b.right), bottom: Math.min(page.height, b.bottom) }))
    .filter((b) => b.right > b.left && b.bottom >= b.top)
    // A page-sized fill is the background, not a figure.
    .filter((b) => !(width(b) > page.width * 0.9 && height(b) > page.height * 0.9));
  const captions = lines.map((line) => ({ line, label: captionLabel(line.text) })).filter((c) => c.label && c.label.punctuated);
  // A caption is a block: its first line and the lines it wraps onto.
  // A wrapped line starts where the caption does (or is centred under it), and
  // no rule separates them: a table's header right under its caption is not
  // part of the caption.
  const thin = onPage.filter(isRule);
  const captionLines = new Set<TextLine>();
  for (const { line } of captions) {
    captionLines.add(line);
    let last = line;
    for (const next of [...lines].filter((l) => l.top > line.top).sort((a, b) => a.top - b.top)) {
      if (next.top - line.bottom > 120) break;
      if (hOverlap(next, line) < width(next) * 0.5) continue;
      if (next.top - last.bottom > Math.max(4, height(last) * 0.6)) break;
      const aligned = Math.abs(next.left - line.left) < 8 || Math.abs((next.left + next.right) - (line.left + line.right)) < 16;
      const ruled = thin.some((r) => r.top >= last.bottom - 1 && r.bottom <= next.top + 1 && hOverlap(r, next) > 0);
      if (!aligned || ruled || captionLabel(next.text)) break;
      captionLines.add(next);
      last = next;
    }
  }

  // Figure candidates: clusters of graphics that are not only table rules.
  const candidates: Candidate[] = clusterBoxes(onPage.filter((b) => !isRule(b)))
    .filter((c) => width(c) >= MIN_FIGURE.w && height(c) >= MIN_FIGURE.h)
    .map((box) => {
      // The short lines on and around it: axis labels, legends, panel letters.
      let grown = box;
      for (const line of lines) {
        if (captionLines.has(line)) continue;
        const onIt = near(box, line, 10) && line.left >= box.left - 24 && line.right <= box.right + 24;
        if (onIt) grown = union(grown, line);
      }
      return { box: grown, used: false };
    });
  // Dashed gridlines of a plot are not table rules.
  const rules = onPage.filter((r) => isRule(r) && !candidates.some((c) => contains(c.box, r, 2)));
  const barriers = [...captionLines, ...candidates.map((c) => c.box)];

  const found: DetectedFigure[] = [];
  const take = (box: Box, label: FigureLabel | null) => found.push({
    box: { left: Math.max(0, box.left - PAD), top: Math.max(0, box.top - PAD), right: Math.min(page.width, box.right + PAD), bottom: Math.min(page.height, box.bottom + PAD) },
    label,
  });

  // Figures: the candidate right above the caption, plus its neighbours in the same block.
  for (const { line, label } of captions) {
    if (!label || label.kind !== 'figure') continue;
    const overlapsCaption = (c: Candidate) => hOverlap(c.box, line) >= Math.min(width(c.box), width(line)) * 0.3;
    const above = candidates
      .filter((c) => !c.used && overlapsCaption(c) && c.box.bottom <= line.top + 6 && line.top - c.box.bottom < 80)
      .sort((a, b) => b.box.bottom - a.box.bottom)[0];
    const below = above ? null : candidates
      .filter((c) => !c.used && overlapsCaption(c) && c.box.top >= line.bottom - 6 && c.box.top - line.bottom < 60)
      .sort((a, b) => a.box.top - b.box.top)[0];
    const first = above ?? below;
    if (!first) continue;
    first.used = true;
    let box = first.box;
    for (let grew = true; grew;) {
      grew = false;
      for (const c of candidates) {
        if (c.used || !overlapsCaption(c)) continue;
        const sameSide = above ? c.box.bottom <= line.top + 6 : c.box.top >= line.bottom - 6;
        // Sub-figures: close by, or side by side in the same band.
        const sameBand = Math.max(0, Math.min(box.bottom, c.box.bottom) - Math.max(box.top, c.box.top)) >= Math.min(height(box), height(c.box)) * 0.5;
        if (sameSide && (near(box, c.box, 40) || sameBand)) { box = union(box, c.box); c.used = true; grew = true; }
      }
    }
    // Panel titles and labels just outside the merged figure.
    for (const l of lines) {
      if (captionLines.has(l) || !near(box, l, 12) || width(l) > width(box) + 40) continue;
      if (l.left >= box.left - 40 && l.right <= box.right + 40) box = union(box, l);
    }
    // Never into the caption itself.
    if (above) box = { ...box, bottom: Math.min(box.bottom, line.top - PAD - 1) };
    else box = { ...box, top: Math.max(box.top, blockOf(line, captionLines).bottom + PAD + 1) };
    take(box, { kind: 'figure', number: label.number });
  }

  // A caption inside a cluster (a background box drawn past it): the part above it.
  for (const { line, label } of captions) {
    if (!label || label.kind !== 'figure' || found.some((f) => f.label?.kind === 'figure' && f.label.number === label.number)) continue;
    const around = candidates.find((c) => !c.used && line.top > c.box.top + MIN_FIGURE.h && line.top < c.box.bottom && hOverlap(c.box, line) > width(line) * 0.3);
    if (around) { around.used = true; take({ ...around.box, bottom: line.top - PAD - 1 }, { kind: 'figure', number: label.number }); }
  }

  // Captions set beside their figure (wrapfigure): level with it, just right or left of it.
  for (const { line, label } of captions) {
    if (!label || label.kind !== 'figure' || found.some((f) => f.label?.kind === 'figure' && f.label.number === label.number)) continue;
    const beside = candidates.find((c) => !c.used && line.top >= c.box.top - 4 && line.top <= c.box.bottom
      && ((line.left >= c.box.right - 10 && line.left - c.box.right < 40) || (line.right <= c.box.left + 10 && c.box.left - line.right < 40)));
    if (beside) { beside.used = true; take(beside.box, { kind: 'figure', number: label.number }); }
  }

  // Tables: on the side of the caption whose rule is nearer (styles differ:
  // ACL/NeurIPS put the caption above, CVPR/IEEE journals often below).
  const lineGap = medianGap(lines);
  for (const { line, label } of captions) {
    if (!label || label.kind !== 'table') continue;
    const block = blockOf(line, captionLines);
    const below = tableRules(block, rules, barriers, 'below');
    const above = tableRules(block, rules, barriers, 'above');
    let box: Box | null = null;
    if (below && (!above || below.gap <= above.gap)) box = below.box;
    else if (above) box = above.box;
    else box = tableLines(block, lines, captionLines, lineGap);
    if (box) {
      for (const l of linesIn(lines, box)) if (!captionLines.has(l)) box = union(box, l);
      take(box, { kind: 'table', number: label.number });
    }
  }

  for (const c of candidates) {
    if (!c.used && width(c.box) >= MIN_UNLABELED.w && height(c.box) >= MIN_UNLABELED.h) take(c.box, null);
  }
  // A table found by its rules may also have been a candidate: keep the named one.
  const kept = found.filter((f, i) => !found.some((g, j) => j !== i && g.label && !f.label && contains(g.box, f.box, 6)));
  return kept.sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left);
}

function contains(outer: Box, inner: Box, slack: number): boolean {
  return inner.left >= outer.left - slack && inner.right <= outer.right + slack && inner.top >= outer.top - slack && inner.bottom <= outer.bottom + slack;
}

function medianGap(lines: readonly TextLine[]): number {
  const sorted = [...lines].sort((a, b) => a.top - b.top);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const g = sorted[i].top - sorted[i - 1].bottom;
    if (g > 0 && g < 30) gaps.push(g);
  }
  gaps.sort((a, b) => a - b);
  return gaps.length ? gaps[Math.floor(gaps.length / 2)] : 3;
}

function linesIn(lines: readonly TextLine[], box: Box): TextLine[] {
  return lines.filter((l) => l.top >= box.top - 2 && l.bottom <= box.bottom + 2 && hOverlap(l, box) > 0);
}

/** A caption's block: its first line and the wrapped lines just under it. */
function blockOf(caption: TextLine, captionLines: Set<TextLine>): Box {
  let box: Box = caption;
  for (const l of captionLines) {
    if (l !== caption && l.top > caption.top && l.top - box.bottom < 6 && hOverlap(l, caption) > 0) box = union(box, l);
  }
  return box;
}

/**
 * The rules of the table on one side of a caption block: the nearest one
 * within 30 pt, then each next one until a barrier (another caption, a
 * figure) or a gap that no table has. `gap` is the caption–table distance.
 */
function tableRules(block: Box, rules: readonly Box[], barriers: readonly Box[], side: 'below' | 'above'): { box: Box; gap: number } | null {
  const inColumn = (r: Box) => hOverlap(r, block) >= Math.min(width(r), width(block)) * 0.5;
  const ordered = rules
    .filter((r) => inColumn(r) && (side === 'below' ? r.top >= block.bottom - 2 : r.bottom <= block.top + 2))
    .sort((a, b) => (side === 'below' ? a.top - b.top : b.bottom - a.bottom));
  if (ordered.length < 2) return null;
  const gap = side === 'below' ? ordered[0].top - block.bottom : block.top - ordered[0].bottom;
  if (gap > 30) return null;
  const crosses = (from: Box, to: Box) => barriers.some((b) => b !== block && hOverlap(b, block) > 0 && !near(b, block, 1)
    && (side === 'below' ? b.top >= from.bottom - 1 && b.bottom <= to.top + 1 : b.bottom <= from.top + 1 && b.top >= to.bottom - 1));
  const taken = [ordered[0]];
  for (const rule of ordered.slice(1)) {
    const prev = taken[taken.length - 1];
    const distance = side === 'below' ? rule.top - prev.bottom : prev.top - rule.bottom;
    if (distance > 260 || crosses(prev, rule)) break;
    taken.push(rule);
  }
  if (taken.length < 2) return null;
  const box = taken.reduce(union);
  return height(box) > 8 ? { box, gap } : null;
}

/** A table without rules: the closely spaced lines right under its caption block. */
function tableLines(block: Box, lines: readonly TextLine[], captionLines: Set<TextLine>, lineGap: number): Box | null {
  const run: TextLine[] = [];
  let bottom = block.bottom;
  const sorted = lines.filter((l) => !captionLines.has(l) && l.top >= block.bottom - 1 && hOverlap(l, block) > 0).sort((a, b) => a.top - b.top);
  for (const line of sorted) {
    if (line.top - bottom > Math.max(14, lineGap * 3)) break;
    run.push(line);
    bottom = line.bottom;
    if (run.length > 80) break;
  }
  if (run.length < 3) return null;
  return run.reduce<Box>((acc, l) => union(acc, l), run[0]);
}
