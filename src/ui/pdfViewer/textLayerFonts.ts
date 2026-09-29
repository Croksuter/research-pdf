// ─── Hidden text in the PDF's own fonts ───
//
// PDF.js lays each run of selectable text out in a generic family (mostly
// `sans-serif`) and stretches the whole run to the PDF's width. The ends line
// up, but inside a line of Times the sans-serif letters drift by several
// characters, so a drag selects something other than what is under the
// pointer. The page canvas was just drawn with the document's own fonts,
// which PDF.js registered as FontFaces named after each font's `loadedName` —
// the same name text items carry as `fontName`. Putting that name first in
// the text layer's family lays the hidden text out with the real glyph
// widths and ascent (PDF.js measures on a canvas in this document, so the
// measurement and the layout agree).
//
// That only works when the font maps Unicode to the right glyphs. Many
// simple fonts do (their codes are ASCII); a CID font's codes are glyph ids,
// and Unicode text laid out with it gets arbitrary widths. After each page's
// text layer renders, every font is judged by the stretch PDF.js had to apply
// to its runs: the right glyphs need almost none and need it consistently.
// A font that fails goes back to the generic family, re-stretched to the
// same width. Pure judgement below; the DOM part is `fitTextLayerFonts`.

import type { PDFPageProxy } from 'pdfjs-dist';
import { recordTextLayerChunk } from './textLayerPositions';

const patched = new WeakSet<object>();

/**
 * Makes every text-content stream of this document's pages name the PDF's
 * own fonts first, and keeps the text layer's items (its stream is the one
 * asking for marked content) for `placeTextLayerRuns`.
 */
export function useEmbeddedFontsForText(page: PDFPageProxy): void {
  const proto = Object.getPrototypeOf(page) as { streamTextContent: (...args: unknown[]) => ReadableStream };
  if (patched.has(proto)) return;
  patched.add(proto);
  const original = proto.streamTextContent;
  proto.streamTextContent = function streamTextContent(this: object, ...args: unknown[]): ReadableStream {
    const stream = original.apply(this, args);
    const page = this;
    const forTextLayer = (args[0] as { includeMarkedContent?: unknown } | undefined)?.includeMarkedContent === true;
    let first = true;
    return stream.pipeThrough(new TransformStream({
      transform(chunk: unknown, controller) {
        withEmbeddedFonts(chunk);
        if (forTextLayer) {
          recordTextLayerChunk(page, chunk, first);
          first = false;
        }
        controller.enqueue(chunk);
      },
    }));
  };
}

const LOADED_NAME = /^[\w-]{1,64}$/u;

export function withEmbeddedFonts<T>(chunk: T): T {
  const styles = (chunk as { styles?: Record<string, { fontFamily?: unknown }> } | null)?.styles;
  if (!styles) return chunk;
  for (const [name, style] of Object.entries(styles)) {
    if (typeof style?.fontFamily !== 'string' || style.fontFamily.startsWith('"') || !LOADED_NAME.test(name)) continue;
    style.fontFamily = `"${name}", ${style.fontFamily}`;
  }
  return chunk;
}

/**
 * `"g_d0_f1", sans-serif` → `sans-serif`; null when the family does not lead
 * with a PDF.js font (Chrome reads the family back without the quotes).
 */
export function genericFallback(family: string): string | null {
  const match = /^"?g_[\w-]+"?,\s*(.+)$/u.exec(family);
  return match ? match[1] : null;
}

const MIN_RUN_CHARS = 6;
const MAX_SPREAD = 0.06;
const MAX_OFFSET = 0.15;
const SINGLE_TOLERANCE = 0.08;

/**
 * Whether a font's runs fit: `scales` are PDF.js's stretch factors for runs
 * of at least a few characters. Justified lines stretch a little, all alike;
 * wrong glyphs stretch by varying amounts. With too few runs to tell, each
 * must be close to 1.
 */
export function fontFits(scales: readonly number[]): boolean {
  const usable = scales.filter((s) => Number.isFinite(s) && s > 0);
  if (usable.length === 0) return true;
  if (usable.length < 3) return usable.every((s) => Math.abs(s - 1) <= SINGLE_TOLERANCE);
  const sorted = [...usable].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (Math.abs(median - 1) > MAX_OFFSET) return false;
  const deviations = sorted.map((s) => Math.abs(s - median)).sort((a, b) => a - b);
  return deviations[Math.floor(deviations.length * 0.8)] <= MAX_SPREAD;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function measure(text: string, fontSize: number, family: string): number {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return 0;
  measureCtx.font = `${fontSize}px ${family}`;
  return measureCtx.measureText(text).width;
}

/** Judges each font in a rendered text layer and puts failing ones back on their generic family. */
export function fitTextLayerFonts(textLayer: HTMLElement): void {
  const byFamily = new Map<string, HTMLElement[]>();
  for (const span of Array.from(textLayer.querySelectorAll<HTMLElement>(':scope span[role="presentation"]'))) {
    const family = span.style.fontFamily;
    if (!genericFallback(family)) continue;
    const list = byFamily.get(family) ?? [];
    list.push(span);
    byFamily.set(family, list);
  }
  for (const [family, spans] of byFamily) {
    const scales = spans
      .filter((s) => (s.textContent ?? '').length >= MIN_RUN_CHARS && s.style.getPropertyValue('--scale-x'))
      .map((s) => Number.parseFloat(s.style.getPropertyValue('--scale-x')));
    if (fontFits(scales)) continue;
    const fallback = genericFallback(family) as string;
    for (const span of spans) {
      const text = span.textContent ?? '';
      const scale = Number.parseFloat(span.style.getPropertyValue('--scale-x'));
      const fontSize = Number.parseFloat(getComputedStyle(span).fontSize);
      span.style.fontFamily = fallback;
      if (!Number.isFinite(scale) || !text || !(fontSize > 0)) continue;
      const target = measure(text, fontSize, family) * scale;
      const natural = measure(text, fontSize, fallback);
      if (target > 0 && natural > 0) span.style.setProperty('--scale-x', String(target / natural));
    }
  }
}
