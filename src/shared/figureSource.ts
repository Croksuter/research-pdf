// ─── Figure copy: which figure it is, and the source line that credits it ───
//
// A captured region of a page is named after the caption beside it ("Figure 2:",
// "Fig. 2.", "Table 1", "TABLE IV"), found among the page's text lines, and
// credited with a one-line source for a slide (`Source: Hao et al. (2024).
// Title. arXiv. Fig. 2.`) or the paper strip's full APA reference. Pure; the
// DOM and rendering side is ui/pdfViewer/figureCapture.ts.

import { type PaperMeta, dedupeAuthors, formatApa, splitAuthor } from './paperIdentifiers';

export type FigureKind = 'figure' | 'table';

export interface FigureLabel {
  kind: FigureKind;
  number: string;
}

/** A box in page space, y growing downwards (a rotation-0 viewport). */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface TextLine extends Box {
  text: string;
}

/** One text item already placed in page space: its baseline start and size. */
export interface PlacedText {
  str: string;
  x: number;
  baseline: number;
  width: number;
  height: number;
}

// "Figure 2:", "Fig. 2.", "FIGURE 3", "Table 1:", "TABLE IV", "Tab. 2", "Figure S3", "Figure 2a", "Figure 1.3:",
// and in Korean, Japanese and Chinese papers "그림 2:", "표 1.", "図 3", "图 4", "表 5".
// "Figure 1.3" (theses, books) keeps its section number. "그림 1에서" is prose, not a caption.
const CAPTION = /^(figure|fig\.?|table|tab\.|그림|표|図|图|表)\s*([A-Z]?\d+(?:\.\d+)*[a-z]?|[IVXLC]+)(?=$|[\s:.|：．—–-])\s*([:.|：．—–-])?/iu;
const TABLE_WORDS = new Set(['table', 'tab.', '표', '表']);

/** Groups text items into lines: same baseline, no column-sized gap between them. */
export function groupLines(items: PlacedText[]): TextLine[] {
  const sorted = items
    .filter((item) => item.str.length > 0 && item.height > 0)
    .sort((a, b) => a.baseline - b.baseline || a.x - b.x);
  const lines: Array<TextLine & { baseline: number; height: number }> = [];
  for (const item of sorted) {
    const line = lines.find((l) => Math.abs(l.baseline - item.baseline) < l.height * 0.5
      && item.x >= l.right - l.height * 0.5 && item.x - l.right < l.height * 2.5);
    if (line) {
      const gap = item.x - line.right;
      line.text += (gap > item.height * 0.15 && !/\s$/u.test(line.text) && !/^\s/u.test(item.str) ? ' ' : '') + item.str;
      line.right = Math.max(line.right, item.x + item.width);
      line.top = Math.min(line.top, item.baseline - item.height);
    } else {
      lines.push({
        text: item.str,
        left: item.x,
        right: item.x + item.width,
        top: item.baseline - item.height,
        bottom: item.baseline,
        baseline: item.baseline,
        height: item.height,
      });
    }
  }
  return lines.map(({ text, left, top, right, bottom }) => ({ text: text.trim(), left, top, right, bottom }));
}

/** The caption label a line starts with, and whether punctuation follows it (a real caption, not "Figure 2 shows"). */
export function captionLabel(text: string): (FigureLabel & { punctuated: boolean }) | null {
  const match = CAPTION.exec(text.trim());
  if (!match) return null;
  const word = match[1].toLowerCase();
  const number = match[2];
  // Roman numerals only in the IEEE style: "TABLE IV".
  if (/^[IVXLC]+$/u.test(number) && !(word === 'table' && match[1] === 'TABLE')) return null;
  return { kind: TABLE_WORDS.has(word) ? 'table' : 'figure', number, punctuated: !!match[3] };
}

/**
 * The caption that names the captured region: inside it, just below it
 * (figures) or just above it (tables), overlapping it horizontally.
 */
export function findFigureLabel(lines: TextLine[], region: Box): FigureLabel | null {
  const height = region.bottom - region.top;
  const reach = Math.max(48, height * 0.4);
  let best: { label: FigureLabel; score: number } | null = null;
  for (const line of lines) {
    const label = captionLabel(line.text);
    if (!label) continue;
    if (line.right <= region.left || line.left >= region.right) continue;
    let score: number;
    if (line.top >= region.top - 2 && line.bottom <= region.bottom + 2) score = 0;
    else if (line.top >= region.bottom - 2) score = line.top - region.bottom + (label.kind === 'table' ? 24 : 0);
    else if (line.bottom <= region.top + 2) score = region.top - line.bottom + (label.kind === 'figure' ? 24 : 0);
    else score = 0; // straddles an edge
    if (score > reach) continue;
    if (!label.punctuated) score += 16;
    if (!best || score < best.score) best = { label: { kind: label.kind, number: label.number }, score };
  }
  return best?.label ?? null;
}

export type SourceStyle = 'short' | 'apa';

export interface SourceInput {
  meta: PaperMeta | null;
  /** The document's own name, for a PDF that is not a recognised paper. */
  docTitle: string;
  label: FigureLabel | null;
  /** 1-based; named when no caption was found. */
  pageNumber: number;
  style: SourceStyle;
  /** "Source:", "출처:" or "". */
  prefix: string;
}

export function formatFigureLabel(label: FigureLabel | null, pageNumber: number): string {
  if (!label) return `p. ${pageNumber}`;
  return label.kind === 'figure' ? `Fig. ${label.number}` : `Table ${label.number}`;
}

/** "Hao", "Hao & Kim", "Hao et al." */
export function shortAuthors(authors: string[]): string {
  const names = dedupeAuthors(authors).map((name) => splitAuthor(name).last).filter(Boolean);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]} et al.`;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.?!]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

function shortVenue(meta: PaperMeta): string {
  if (meta.arxivId && (!meta.venue || /arxiv/iu.test(meta.venue))) return 'arXiv';
  return meta.venue ?? '';
}

export function formatFigureSource(input: SourceInput): string {
  const { meta, prefix } = input;
  const label = sentence(formatFigureLabel(input.label, input.pageNumber));
  let body: string;
  if (!meta) {
    body = `${sentence(input.docTitle || 'PDF')} ${label}`;
  } else if (input.style === 'apa') {
    body = `${sentence(formatApa(meta))} ${label}`;
  } else {
    const authors = shortAuthors(meta.authors);
    const year = meta.year ? `(${meta.year})` : '';
    const parts = authors
      ? [sentence(year ? `${authors} ${year}` : authors), sentence(meta.title)]
      : [sentence(year ? `${meta.title.trim().replace(/\.$/u, '')} ${year}` : meta.title)];
    const venue = shortVenue(meta);
    if (venue) parts.push(sentence(venue));
    parts.push(label);
    body = parts.join(' ');
  }
  return prefix ? `${prefix} ${body}` : body;
}

// ─── Options ───

/**
 * What a capture puts on the clipboard at once: nothing (the panel's buttons
 * copy), the image alone (slides would otherwise pick the text), the image
 * with its source in one item (documents: Docs, Notion), or the source alone.
 */
export type FigureCopyAction = 'none' | 'image' | 'image-source' | 'source';
export const COPY_ACTIONS: readonly FigureCopyAction[] = ['none', 'image', 'image-source', 'source'];
/**
 * What stays after a capture: the area and its panel (source to edit,
 * options), or only a notice with a thumbnail and the copy buttons — a card
 * at the bottom right or a bar at the bottom.
 */
export type FigureCaptureResult = 'panel' | 'card' | 'bar';
export const CAPTURE_RESULTS: readonly FigureCaptureResult[] = ['panel', 'card', 'bar'];

export interface FigureCopyOptions {
  /** Draw the reader's highlights, pen and text notes into the image. */
  annotations: boolean;
  dpi: number;
  background: 'white' | 'transparent';
  copy: FigureCopyAction;
  /** The source drawn under the image, copied or saved. */
  embed: boolean;
  style: SourceStyle;
  prefix: string;
  /** Capture mode outlines the figures and tables of the pages shown (the layout model runs on them). */
  autoDetect: boolean;
  /** Capture mode stays on after a copy. */
  continuous: boolean;
  result: FigureCaptureResult;
  /** The notice goes by itself after a while (held while pointed at or keyboard-focused), or only when closed. */
  dismiss: 'auto' | 'manual';
}

export const FIGURE_COPY_OPTIONS_SETTING_KEY = 'figureCopyOptions';
/** Every page that changes the options posts them here, so open viewers and the settings page follow. */
export const FIGURE_COPY_OPTIONS_CHANNEL = 'rpdf-figure-copy-options';
export const DPI_CHOICES = [150, 300, 600] as const;
export const PREFIX_CHOICES = ['Source:', '출처:', ''] as const;

export const DEFAULT_FIGURE_COPY_OPTIONS: FigureCopyOptions = {
  annotations: false,
  dpi: 300,
  background: 'white',
  copy: 'image',
  embed: false,
  style: 'short',
  prefix: 'Source:',
  autoDetect: true,
  continuous: false,
  result: 'card',
  dismiss: 'auto',
};

/** Stored options, with anything missing or unknown back at its default. */
export function normalizeFigureCopyOptions(raw: unknown): FigureCopyOptions {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof FigureCopyOptions | 'source', unknown>>;
  const d = DEFAULT_FIGURE_COPY_OPTIONS;
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  // Before `copy` and `embed`, one `source` said both: separate | together | embed.
  const legacyCopy: FigureCopyAction = value.source === 'together' ? 'image-source' : d.copy;
  return {
    annotations: bool(value.annotations, d.annotations),
    dpi: (DPI_CHOICES as readonly number[]).includes(value.dpi as number) ? value.dpi as number : d.dpi,
    background: value.background === 'transparent' ? 'transparent' : 'white',
    copy: COPY_ACTIONS.includes(value.copy as FigureCopyAction) ? value.copy as FigureCopyAction : legacyCopy,
    embed: bool(value.embed, value.source === 'embed'),
    style: value.style === 'apa' ? 'apa' : 'short',
    prefix: (PREFIX_CHOICES as readonly string[]).includes(value.prefix as string) ? value.prefix as string : d.prefix,
    autoDetect: bool(value.autoDetect, d.autoDetect),
    continuous: bool(value.continuous, d.continuous),
    result: CAPTURE_RESULTS.includes(value.result as FigureCaptureResult) ? value.result as FigureCaptureResult : d.result,
    dismiss: value.dismiss === 'manual' ? 'manual' : 'auto',
  };
}
