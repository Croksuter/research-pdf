// ─── Selectable text on the glyphs' exact positions ───
//
// PDF.js positions each run of hidden text at its start and stretches the
// whole run to the PDF's width, so the letters inside land wherever the
// browser's font puts them: word gaps set by TJ offsets (LaTeX), wider
// sentence spacing and kerning all drift, and a selection boundary can fall
// in the middle of a rendered glyph. Our patched worker
// (scripts/pdfjs-worker-patch.cjs) sends where every character of a run
// starts (`charStarts`). Here each run is laid out on them: characters whose
// natural advance already lands on the next start stay plain text, the rest
// (every word gap, the odd kerning pair) get the exact letter-spacing. The
// run keeps only its horizontal scale (Tz), so a boundary between two
// characters is the boundary between their glyphs, at any zoom (all in em).
//
// PDF.js's find highlighter rewrites a run's contents; while a match is
// highlighted the run falls back to PDF.js's own stretch, and it is laid out
// again once the highlight goes.

import type { PDFPageProxy } from 'pdfjs-dist';

export interface TextRunItem {
  str: string;
  transform: number[];
  charStarts?: number[] | null;
}

export interface RunSegment {
  text: string;
  /** Extra advance after each character, in em; null for plain text. */
  spacingEm: number | null;
}

const EPSILON_EM = 0.004;

/**
 * Splits a run into plain text and characters that need letter-spacing to
 * start the next character where the PDF does. `advance` is a character's
 * natural width in em in the layer's font. Null when the item has no usable
 * positions.
 */
export function planRun(item: TextRunItem, advance: (ch: string) => number): { segments: RunSegment[]; scaleX: number } | null {
  const { str, transform: t, charStarts } = item;
  if (!charStarts || charStarts.length !== str.length + 1 || !Array.isArray(t) || t.length < 4) return null;
  const fontSize = Math.hypot(t[2], t[3]);
  const scaleX = fontSize > 0 ? Math.hypot(t[0], t[1]) / fontSize : 0;
  if (!(fontSize > 0) || !(scaleX > 0) || !charStarts.every(Number.isFinite)) return null;
  // Target positions in the run's unscaled em, from its start.
  const target = (i: number) => (charStarts[i] - charStarts[0]) / fontSize / scaleX;
  const segments: RunSegment[] = [];
  let plain = '';
  let cursor = 0;
  for (let i = 0; i < str.length;) {
    // A surrogate pair is one character.
    const code = str.charCodeAt(i);
    const width = code >= 0xd800 && code <= 0xdbff && i + 1 < str.length ? 2 : 1;
    const ch = str.slice(i, i + width);
    const natural = advance(ch);
    const next = target(i + width);
    const delta = next - (cursor + natural);
    if (Math.abs(delta) > EPSILON_EM) {
      if (plain) segments.push({ text: plain, spacingEm: null });
      plain = '';
      segments.push({ text: ch, spacingEm: Math.round(delta * 10_000) / 10_000 });
      cursor = next;
    } else {
      plain += ch;
      cursor += natural;
    }
    i += width;
  }
  if (plain) segments.push({ text: plain, spacingEm: null });
  return { segments, scaleX };
}

// ─── Items per page (recorded from the text layer's own stream) ───

const pageItems = new WeakMap<object, TextRunItem[]>();

/** Called by the text-content stream wrapper for the text layer's stream. */
export function recordTextLayerChunk(page: object, chunk: unknown, first: boolean): void {
  const items = (chunk as { items?: unknown[] } | null)?.items;
  const list = first ? [] : pageItems.get(page) ?? [];
  if (Array.isArray(items)) {
    for (const item of items) {
      const run = item as Partial<TextRunItem> & { type?: unknown };
      // Marked-content boundaries and empty items make no span.
      if (run.type !== undefined || typeof run.str !== 'string' || run.str === '') continue;
      list.push(run as TextRunItem);
    }
  }
  pageItems.set(page, list);
}

/** The items recorded for a page's text layer (one per span, in order). */
export function recordedTextLayerItems(page: object): readonly TextRunItem[] {
  return pageItems.get(page) ?? [];
}

// ─── DOM ───

let measureCtx: CanvasRenderingContext2D | null = null;
const advanceCache = new Map<string, number>();

function advanceIn(family: string): (ch: string) => number {
  return (ch) => {
    const key = `${family}\u0000${ch}`;
    let em = advanceCache.get(key);
    if (em === undefined) {
      measureCtx ??= document.createElement('canvas').getContext('2d');
      if (!measureCtx) return 0;
      measureCtx.font = `100px ${family}`;
      em = measureCtx.measureText(ch).width / 100;
      if (advanceCache.size > 20_000) advanceCache.clear();
      advanceCache.set(key, em);
    }
    return em;
  };
}

interface LaidOutRun {
  item: TextRunItem;
  segments: RunSegment[];
  scaleX: number;
}

const laidOut = new WeakMap<HTMLElement, LaidOutRun>();
// One span per text item, in item order. Not by `role`: PDF.js's
// accessibility code swaps a run's role for `aria-owns` where it overlaps a
// link. Marked-content containers and image placeholders are not items.
const RUN_SELECTOR = 'span:not(.markedContent):not([role="img"])';
const observers = new WeakMap<HTMLElement, MutationObserver>();

function render(span: HTMLElement, run: LaidOutRun): void {
  span.replaceChildren(...run.segments.map((segment) => {
    if (segment.spacingEm === null) return document.createTextNode(segment.text);
    const k = document.createElement('i');
    k.className = 'vt-k';
    k.textContent = segment.text;
    k.style.letterSpacing = `${segment.spacingEm}em`;
    return k;
  }));
  span.classList.add('vt-exact');
  span.style.setProperty('--vt-scale-x', String(run.scaleX));
}

function isOurs(span: HTMLElement, run: LaidOutRun): boolean {
  return span.childNodes.length === run.segments.length && span.textContent === run.item.str;
}

/** After the find highlighter touched runs: stretch while highlighted, exact again after. */
function watch(textLayer: HTMLElement): void {
  if (observers.has(textLayer)) return;
  const observer = new MutationObserver((records) => {
    const spans = new Set<HTMLElement>();
    for (const record of records) {
      const node = record.target instanceof HTMLElement ? record.target : record.target.parentElement;
      const span = node?.closest<HTMLElement>(RUN_SELECTOR);
      if (span && laidOut.has(span)) spans.add(span);
    }
    for (const span of spans) {
      const run = laidOut.get(span) as LaidOutRun;
      if (span.querySelector('.highlight')) span.classList.remove('vt-exact');
      else if (!isOurs(span, run) && span.textContent === run.item.str) render(span, run);
    }
    observer.takeRecords(); // our own changes
  });
  observer.observe(textLayer, { childList: true, subtree: true, characterData: true });
  observers.set(textLayer, observer);
}

/**
 * Lays a freshly rendered text layer's runs out on the recorded positions.
 * Returns how many runs were placed (0 when the spans and items disagree).
 */
export function placeTextLayerRuns(textLayer: HTMLElement, page: PDFPageProxy | object | undefined): number {
  const items = page ? pageItems.get(page) : undefined;
  if (!items) return 0;
  const spans = Array.from(textLayer.querySelectorAll<HTMLElement>(RUN_SELECTOR));
  if (spans.length !== items.length) return 0;
  let placed = 0;
  spans.forEach((span, index) => {
    const item = items[index];
    if (span.textContent !== item.str) return;
    const plan = planRun(item, advanceIn(span.style.fontFamily || 'sans-serif'));
    if (!plan) return;
    const run: LaidOutRun = { item, ...plan };
    laidOut.set(span, run);
    render(span, run);
    placed += 1;
  });
  observers.get(textLayer)?.takeRecords();
  watch(textLayer);
  return placed;
}
