// ─── Figure copy: figures and tables from a layout model, made exact (pure) ───
//
// Auto-detect capture runs a small document-layout model (PP-DocLayout-S,
// ui/pdfViewer/layoutModel.ts) on the rendered page: it finds figure, chart
// and table regions and their captions in any layout, scanned pages
// included. Its boxes are approximate and unnamed, so they are combined with
// what the PDF itself says:
//
//   • regions: image / chart → figure, table → table; nested or overlapping
//     ones are one region (a multi-panel figure is often found whole and
//     panel by panel);
//   • names: the caption regions the model found are read with the page's
//     text lines ("Fig. 1", "Figure 2:", "TABLE IV", margin line numbers
//     ignored) and each goes to the nearest region of its kind, preferring
//     below for figures and above for tables;
//   • edges: a region is snapped to the PDF's own graphics and the short
//     text on them (axis labels, legends) inside it, so the copy is neither
//     cut nor padded; a scanned page keeps the model's box;
//   • the rule-based detector (shared/figureDetect.ts) fills in named figures
//     and tables the model missed.
//
// Coordinates: a rotation-0 viewport at scale 1, PDF points, y down.

import { type DetectedFigure } from './figureDetect';
import { captionLabel, type Box, type FigureKind, type FigureLabel, type TextLine } from './figureSource';

export const LAYOUT_CLASSES = [
  'paragraph_title', 'image', 'text', 'number', 'abstract', 'content', 'figure_title', 'formula', 'table', 'table_title', 'reference',
  'doc_title', 'footnote', 'header', 'algorithm', 'footer', 'seal', 'chart_title', 'chart', 'formula_number', 'header_image', 'footer_image', 'aside_text',
] as const;
export type LayoutClass = typeof LAYOUT_CLASSES[number];

export interface LayoutDetection {
  cls: LayoutClass;
  score: number;
  box: Box;
}

export const LAYOUT_INPUT_SIZE = 480;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/** RGBA pixels already resized to 480×480 → the model's CHW float input. */
export function layoutInput(rgba: ArrayLike<number>): Float32Array {
  const n = LAYOUT_INPUT_SIZE * LAYOUT_INPUT_SIZE;
  const data = new Float32Array(3 * n);
  for (let i = 0; i < n; i += 1) {
    for (let c = 0; c < 3; c += 1) data[c * n + i] = (rgba[i * 4 + c] / 255 - MEAN[c]) / STD[c];
  }
  return data;
}

/**
 * The model's `[M, 6]` rows (`class, score, x1, y1, x2, y2` in the pixels of
 * the image it was given) as detections in PDF points: `pixelsPerPoint` is
 * the scale that image was rendered at.
 */
export function layoutDetections(rows: ArrayLike<number>, count: number, pixelsPerPoint: number): LayoutDetection[] {
  const out: LayoutDetection[] = [];
  for (let i = 0; i < count; i += 1) {
    const [cls, score, x1, y1, x2, y2] = Array.from({ length: 6 }, (_, k) => Number(rows[i * 6 + k]));
    const name = LAYOUT_CLASSES[Math.round(cls)];
    if (!name || !Number.isFinite(score)) continue;
    out.push({ cls: name, score, box: { left: x1 / pixelsPerPoint, top: y1 / pixelsPerPoint, right: x2 / pixelsPerPoint, bottom: y2 / pixelsPerPoint } });
  }
  return out;
}

const REGION_SCORE = 0.35;
const CAPTION_SCORE = 0.35;
const PAD = 3;

const width = (b: Box) => b.right - b.left;
const height = (b: Box) => b.bottom - b.top;
const area = (b: Box) => Math.max(0, width(b)) * Math.max(0, height(b));
const union = (a: Box, b: Box): Box => ({ left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) });
const intersection = (a: Box, b: Box) => area({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
const hOverlap = (a: Box, b: Box) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
/** Share of `inner` inside `outer`. */
const inside = (inner: Box, outer: Box) => (area(inner) > 0 ? intersection(inner, outer) / area(inner) : 0);

interface Region { kind: FigureKind; box: Box; score: number }

/** One region per figure / table: nested and overlapping detections of a kind merged. */
export function layoutRegions(dets: readonly LayoutDetection[]): Region[] {
  const raw = dets
    .filter((d) => d.score >= REGION_SCORE && (d.cls === 'image' || d.cls === 'chart' || d.cls === 'table'))
    .map((d) => ({ kind: (d.cls === 'table' ? 'table' : 'figure') as FigureKind, box: d.box, score: d.score }))
    .sort((a, b) => area(b.box) - area(a.box));
  const regions: Region[] = [];
  for (const r of raw) {
    // A panel inside a figure, or the same thing found twice (image + chart).
    const host = regions.find((g) => inside(r.box, g.box) > 0.7 || intersection(r.box, g.box) / Math.min(area(r.box), area(g.box)) > 0.6);
    if (host) {
      if (host.kind !== r.kind && r.score > host.score + 0.2) host.kind = r.kind;
      continue;
    }
    regions.push({ ...r });
  }
  return regions;
}

/** The caption label in a caption region: its first labelled line (margin line numbers skipped). */
function regionLabel(region: Box, lines: readonly TextLine[]): { label: FigureLabel; line: TextLine } | null {
  const candidates = lines
    .filter((l) => inside(l, { left: region.left - 4, top: region.top - 4, right: region.right + 4, bottom: region.bottom + 4 }) > 0.6)
    .sort((a, b) => a.top - b.top || a.left - b.left);
  for (const line of candidates) {
    const label = captionLabel(line.text) ?? captionLabel(line.text.replace(/^\d{1,5}\s+/u, ''));
    if (label) return { label: { kind: label.kind, number: label.number }, line };
  }
  return null;
}

/**
 * A model box made exact. Figures: the PDF graphics it covers, grown by the
 * graphics and short text touching them (tick labels, axis titles, legends,
 * panel letters) — never a caption or a body paragraph. Tables: every line
 * and rule it overlaps, whole. Without vector content (a scanned page, an
 * image with a margin the model saw) its own box.
 */
function snap(kind: FigureKind, box: Box, graphics: readonly Box[], lines: readonly TextLine[], captionLines: ReadonlySet<TextLine>): Box {
  const loose = { left: box.left - 6, top: box.top - 6, right: box.right + 6, bottom: box.bottom + 6 };
  const free = lines.filter((l) => !captionLines.has(l));
  if (kind === 'table') {
    const parts: Box[] = [...free.filter((l) => inside(l, loose) > 0.3), ...graphics.filter((g) => inside(g, loose) > 0.6)];
    if (parts.length === 0) return box;
    const exact = parts.reduce(union);
    return area(exact) >= area(box) * 0.5 ? exact : box;
  }
  const parts = graphics.filter((g) => area(g) > 1 && inside(g, loose) > 0.5 && area(g) < area(box) * 4);
  if (parts.length === 0) return box;
  let exact = parts.reduce(union);
  // Text within the graphics (labels inside a diagram); a paragraph the
  // model's box happened to reach into is not.
  const drawn = exact;
  for (const l of free) if (inside(l, { left: drawn.left - 2, top: drawn.top - 2, right: drawn.right + 2, bottom: drawn.bottom + 2 }) > 0.8) exact = union(exact, l);
  for (let pass = 0; pass < 2; pass += 1) {
    for (const l of free) {
      if (inside(l, exact) > 0.8) continue;
      // Tick labels, axis titles, chart titles, legends: right at the edge,
      // not prose (a paragraph's line, a caption).
      const touching = l.right >= exact.left - 10 && l.left <= exact.right + 10 && l.bottom >= exact.top - 10 && l.top <= exact.bottom + 10;
      if (touching && !isProse(l) && width(l) <= width(exact) + 20) exact = union(exact, l);
    }
    for (const g of graphics) {
      if (area(g) > 1 && area(g) < area(box) && intersection(g, { left: exact.left - 4, top: exact.top - 4, right: exact.right + 4, bottom: exact.bottom + 4 }) > 0 && inside(g, exact) < 1) {
        // A graphic crossing the edge (an axis drawn past the model's box).
        if (inside(g, loose) > 0.3) exact = union(exact, g);
      }
    }
  }
  if (area(exact) < area(box) * 0.5) return box;
  return shave(exact, free);
}

/** A line of running text: many words, or a sentence. */
function isProse(l: TextLine): boolean {
  const words = l.text.trim().split(/\s+/u).length;
  return words > 8 || (words > 3 && /[.;:]$/u.test(l.text.trim()));
}

/**
 * Prose lines at the top or bottom edge of a figure box are not the figure:
 * a paragraph above it or a caption below that a large drawn frame covers.
 */
function shave(box: Box, lines: readonly TextLine[]): Box {
  let b = box;
  for (let pass = 0; pass < 4; pass += 1) {
    const edge = lines.filter((l) => isProse(l) && inside(l, b) > 0.8 && width(l) > width(b) * 0.5);
    const top = edge.find((l) => l.top - b.top < 6);
    const bottom = edge.find((l) => b.bottom - l.bottom < 6);
    if (!top && !bottom) break;
    if (top) b = { ...b, top: top.bottom + 1 };
    if (bottom) b = { ...b, bottom: bottom.top - 1 };
    if (height(b) < 20) return box;
  }
  return b;
}

export interface LayoutInputs {
  dets: readonly LayoutDetection[];
  lines: readonly TextLine[];
  graphics: readonly Box[];
  page: { width: number; height: number };
  /** The rule-based detector's result, to fill in what the model missed. */
  ruleBased: readonly DetectedFigure[];
}

export function combineLayout({ dets, lines, graphics, page, ruleBased }: LayoutInputs): DetectedFigure[] {
  const captions = dets
    .filter((d) => d.score >= CAPTION_SCORE && (d.cls === 'figure_title' || d.cls === 'table_title' || d.cls === 'chart_title'))
    .sort((a, b) => b.score - a.score);
  const named: Array<{ box: Box; label: FigureLabel; line: TextLine }> = [];
  for (const c of captions) {
    if (named.some((n) => intersection(n.box, c.box) > area(c.box) * 0.5)) continue;
    const found = regionLabel(c.box, lines);
    if (found && !named.some((n) => n.label.kind === found.label.kind && n.label.number === found.label.number)) named.push({ box: c.box, ...found });
  }
  // Lines of the captions (the model's caption regions, and any labelled
  // line): never part of a figure.
  const captionLines = new Set(lines.filter((l) => captions.some((c) => inside(l, c.box) > 0.6) || captionLabel(l.text)?.punctuated));

  const pageArea = page.width * page.height;
  const regions = layoutRegions(dets).map((r) => ({ ...r, box: snap(r.kind, r.box, graphics, lines, captionLines), label: null as FigureLabel | null }));
  const nameOf = (l: FigureLabel) => `${l.kind} ${l.number}`;
  const used = new Set<string>();
  // 1. A figure the rules found and named, where the model found it too.
  for (const region of regions) {
    const rule = ruleBased.find((f) => f.label && f.label.kind === region.kind && !used.has(nameOf(f.label))
      && intersection(f.box, region.box) > Math.max(area(f.box), area(region.box)) * 0.5);
    if (rule?.label) { region.label = rule.label; used.add(nameOf(rule.label)); }
  }
  // 2. Captions to regions, cheapest pairs first (a caption under one table
  //    is also over the next one: the nearer pairing wins).
  const pairs: Array<{ region: typeof regions[number]; n: typeof named[number]; cost: number }> = [];
  for (const n of named) {
    if (used.has(nameOf(n.label))) continue;
    for (const region of regions) {
      if (region.label) continue;
      // The model sometimes calls a table drawn as a picture an image (or a
      // chart a table): a caption right at it names it all the same.
      const penalty = region.kind === n.label.kind ? 0 : 40;
      let cost = Infinity;
      if (hOverlap(region.box, n.box) >= Math.min(width(region.box), width(n.box)) * 0.3) {
        const below = n.box.top - region.box.bottom; // caption under the region
        const above = region.box.top - n.box.bottom; // caption over the region
        const preferred = n.label.kind === 'figure' ? below : above;
        const other = n.label.kind === 'figure' ? above : below;
        if (preferred >= -8 && preferred < 90) cost = Math.max(0, preferred);
        if (other >= -8 && other < 90) cost = Math.min(cost, Math.max(0, other) + 12);
      } else {
        // Beside it (a caption set next to the figure).
        const level = n.box.top < region.box.bottom && n.box.bottom > region.box.top;
        const gap = Math.max(n.box.left - region.box.right, region.box.left - n.box.right);
        if (level && gap <= 40) cost = gap + 30;
      }
      if (cost < Infinity && (penalty === 0 || cost < 20)) pairs.push({ region, n, cost: cost + penalty });
    }
  }
  pairs.sort((a, b) => a.cost - b.cost);
  for (const { region, n } of pairs) {
    if (region.label || used.has(nameOf(n.label))) continue;
    region.label = n.label;
    region.kind = n.label.kind;
    used.add(nameOf(n.label));
    // A caption the model's box ran into: the figure ends above it.
    if (n.label.kind === 'figure' && n.line.top > region.box.top + height(region.box) * 0.5 && n.line.top < region.box.bottom) {
      region.box = { ...region.box, bottom: n.line.top - 2 };
    }
  }
  // 3. Panels of one figure found separately: unnamed figure regions in the
  //    same band as a named one, under the same caption, join it.
  for (const region of regions) {
    if (region.kind !== 'figure' || !region.label) continue;
    const caption = named.find((n) => region.label && nameOf(n.label) === nameOf(region.label));
    for (const other of regions) {
      if (other === region || other.label) continue;
      const band = Math.min(region.box.bottom, other.box.bottom) - Math.max(region.box.top, other.box.top) >= Math.min(height(region.box), height(other.box)) * 0.5;
      const stacked = hOverlap(region.box, other.box) > 0 && Math.max(region.box.top - other.box.bottom, other.box.top - region.box.bottom) < 24;
      const underCaption = !caption || (other.box.left >= caption.box.left - 12 && other.box.right <= caption.box.right + 12);
      if ((band || stacked) && underCaption && !(caption && other.box.top > caption.box.bottom)) {
        region.box = union(region.box, other.box);
        other.label = region.label; // merged: dropped below
        (other as { merged?: boolean }).merged = true;
      }
    }
  }
  // 4. Still unnamed: a labelled line close above or below it ("Figure 1."
  //    set as a heading over the figure, a caption the model did not box).
  for (const region of regions) {
    if (region.label || (region as { merged?: boolean }).merged) continue;
    let best: { label: FigureLabel; gap: number } | null = null;
    for (const line of lines) {
      const raw = captionLabel(line.text) ?? captionLabel(line.text.replace(/^\d{1,5}\s+/u, ''));
      if (!raw || raw.kind !== region.kind || used.has(`${raw.kind} ${raw.number}`)) continue;
      // In its column, or a heading set at the margin to its left.
      if (line.left > region.box.right || line.right < region.box.left - 150) continue;
      const gap = line.top >= region.box.bottom - 4 ? line.top - region.box.bottom : region.box.top - line.bottom;
      if (gap < -4 || gap > 60) continue;
      if (!best || gap < best.gap) best = { label: { kind: raw.kind, number: raw.number }, gap };
    }
    if (best) { region.label = best.label; used.add(`${best.label.kind} ${best.label.number}`); }
  }

  // Never into a caption: a labelled line inside a box ends it there (under a
  // figure, over a table).
  for (const region of regions) {
    for (const line of lines) {
      const raw = captionLabel(line.text) ?? captionLabel(line.text.replace(/^\d{1,5}\s+/u, ''));
      if (!raw || inside(line, region.box) < 0.6 || hOverlap(line, region.box) < width(region.box) * 0.3) continue;
      const rel = (line.top - region.box.top) / Math.max(1, height(region.box));
      if (rel > 0.5) region.box = { ...region.box, bottom: Math.min(region.box.bottom, line.top - 2) };
      else if (rel < 0.2 && region.kind === 'table') region.box = { ...region.box, top: Math.max(region.box.top, line.bottom + 2) };
    }
  }
  // A panel left over inside a named figure is not another figure.
  for (const region of regions) {
    if (region.label) continue;
    if (regions.some((o) => o !== region && o.label && inside(region.box, o.box) > 0.6)) (region as { merged?: boolean }).merged = true;
  }

  // Unnamed regions must look like a figure: not a logo, not the whole page of text.
  const kept = regions.filter((r) => !(r as { merged?: boolean }).merged
    && (r.label || (width(r.box) >= 90 && height(r.box) >= 60 && area(r.box) < pageArea * 0.55)));
  const found: DetectedFigure[] = kept.map((r) => ({
    box: { left: Math.max(0, r.box.left - PAD), top: Math.max(0, r.box.top - PAD), right: Math.min(page.width, r.box.right + PAD), bottom: Math.min(page.height, r.box.bottom + PAD) },
    label: r.label,
  }));
  // The rule-based detector's named results the model did not cover.
  for (const f of ruleBased) {
    if (!f.label) continue;
    const covered = found.some((g) => intersection(g.box, f.box) > Math.min(area(g.box), area(f.box)) * 0.5);
    const sameName = found.some((g) => g.label && f.label && g.label.kind === f.label.kind && g.label.number === f.label.number);
    if (!covered && !sameName) found.push(f);
    else if (covered && !sameName) {
      const g = found.find((h) => !h.label && intersection(h.box, f.box) > Math.min(area(h.box), area(f.box)) * 0.5);
      if (g && g.label === null) g.label = f.label;
    }
  }
  return found.sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left);
}
