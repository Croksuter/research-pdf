// ─── Figure copy: drag a region of a page, get a clean image and its source ───
//
// The capture key (`S`, ⌘/Ctrl+Shift+X, the toolbar button) turns capture
// mode on and off. In it the figures and tables of each rendered page are
// outlined as they are found (shared/figureDetect.ts, layoutDetect.ts) and a
// click copies one; a drag anywhere, outlines included, selects a region
// instead — once the press moves, the outlines step aside until it ends.
// Alt+drag works anytime. A capture does with the clipboard what the options
// say and opens a small panel beside the region: the source line (editable),
// copy image / copy source / save PNG, and the options. Capture mode ends
// after a capture unless it is continuous.
//
// The image is not a screenshot: the region is rendered again by PDF.js at the
// chosen DPI, so it is sharp at any zoom, and the reader's drawings go in or
// stay out with the annotation mode. The region is kept in PDF points, so a
// re-copy with other options renders the very same area.
//
// Clipboard: the web clipboard holds image/png, text/plain and text/html. By
// default only the image is written (slides would otherwise pick the text or
// the HTML), and the source is a second copy; "image-source" writes all three
// for documents that paste an image with its caption; "source" the text
// alone; "none" nothing until a button asks. "embed" draws the source under
// the image. The item's blobs are promises so the write starts inside the
// gesture while the rendering and the caption search finish.

import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { AnnotationMode, OPS, Util } from 'pdfjs-dist';
import type { EventBus, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { getSetting, setSetting } from '../../db/settingsRepository';
import {
  DEFAULT_FIGURE_COPY_OPTIONS,
  DPI_CHOICES,
  FIGURE_COPY_OPTIONS_CHANNEL,
  FIGURE_COPY_OPTIONS_SETTING_KEY,
  type FigureCopyOptions,
  type FigureLabel,
  type PlacedText,
  type TextLine,
  findFigureLabel,
  formatFigureLabel,
  formatFigureSource,
  groupLines,
  normalizeFigureCopyOptions,
} from '../../shared/figureSource';
import type { PaperMeta } from '../../shared/paperIdentifiers';
import { detectFigures, graphicBoxes, type DetectedFigure, type OpsLike } from '../../shared/figureDetect';
import { combineLayout } from '../../shared/layoutDetect';
import { LayoutSkipped, detectLayout } from './layoutModel';
import { debugLog } from '../../shared/debugLog';
import { el } from './dom';
import { S } from './viewerParts.strings';

const MIN_DRAG_PX = 6;
// A 600 dpi full page is ~35 Mpx; beyond this the DPI is lowered to fit.
const MAX_PIXELS = 40_000_000;
const CSS_DPI = 96;

interface PageViewLike {
  div: HTMLElement;
  viewport: {
    rotation: number;
    width: number;
    height: number;
    convertToPdfPoint(x: number, y: number): number[];
    convertToViewportPoint(x: number, y: number): number[];
  };
}

/** A captured region, in PDF points of its page. */
interface Region {
  pageNumber: number;
  pdf: [number, number, number, number];
  rotation: number;
  rectEl: HTMLElement;
}

export interface FigureCaptureDeps {
  container: HTMLElement;
  pdfViewer: PDFViewer;
  eventBus: EventBus;
  getDoc: () => PDFDocumentProxy | null;
  getSource: () => { meta: PaperMeta | null; docTitle: string };
  onActiveChange: (active: boolean) => void;
}

export class FigureCapture {
  private options: FigureCopyOptions = DEFAULT_FIGURE_COPY_OPTIONS;
  private active = false;
  /** Pages whose figures are being looked for right now. */
  private detecting = 0;
  /** Ends the press or drag in progress, if one is. */
  private cancelDrag: (() => void) | null = null;
  private readonly channel = new BroadcastChannel(FIGURE_COPY_OPTIONS_CHANNEL);
  /** Detected figures per page of `linesDoc`, in PDF points. */
  private detected = new Map<number, Promise<Array<DetectedFigure & { pdf: [number, number, number, number] }> | null>>();
  /** Pages outlined (or being outlined) in this auto-detect session. */
  private readonly outlined = new Set<number>();
  private region: Region | null = null;
  private label: FigureLabel | null = null;
  private sourceEdited = false;
  private lines = new Map<number, Promise<TextLine[]>>();
  private linesDoc: PDFDocumentProxy | null = null;
  private generation = 0;

  private readonly hint = el('div', { className: 'vt-capture-hint', role: 'status', hidden: true });
  private readonly panel = el('div', { id: 'vocab-t-pdf-capture', className: 'vt-capture-panel', role: 'dialog', 'aria-label': S.captureDialog, hidden: true });
  private readonly status = el('span', { className: 'vt-capture-status', 'aria-live': 'polite' });
  private readonly sourceInput = el('textarea', { className: 'vt-capture-source', rows: '2', spellcheck: 'false', 'aria-label': S.captureSource });
  private readonly optionsBox = el('div', { className: 'vt-capture-options', hidden: true });
  private readonly optionsBtn = el('button', { type: 'button', className: 'vt-btn vt-btn-text', 'aria-expanded': 'false' }, [S.captureOptions]);
  private readonly controls = {
    annotations: el('input', { type: 'checkbox' }),
    dpi: select(DPI_CHOICES.map((dpi) => [String(dpi), `${dpi} dpi`])),
    background: select([['white', S.captureWhite], ['transparent', S.captureTransparent]]),
    copy: select([['none', S.captureCopyNone], ['image', S.captureCopyImageOnly], ['image-source', S.captureCopyImageSource], ['source', S.captureCopySourceOnly]]),
    embed: el('input', { type: 'checkbox' }),
    style: select([['short', S.captureShort], ['apa', S.captureApa]]),
    prefix: select([['Source:', 'Source:'], ['출처:', '출처:'], ['', S.captureNone]]),
  };

  constructor(private readonly deps: FigureCaptureDeps) {
    this.buildPanel();
    document.body.append(this.hint, this.panel);
    void getSetting<unknown>(FIGURE_COPY_OPTIONS_SETTING_KEY, null)
      .then((raw) => this.applyOptions(normalizeFigureCopyOptions(raw)))
      .catch(() => { /* defaults */ });
    // Changed in another viewer or on the settings page.
    this.channel.onmessage = (e: MessageEvent) => this.applyOptions(normalizeFigureCopyOptions(e.data));
    this.reflectOptions();

    deps.container.addEventListener('pointerdown', (e) => this.onPointerDown(e), { capture: true });
    deps.container.addEventListener('scroll', () => this.placePanel(), { passive: true });
    window.addEventListener('resize', () => this.placePanel());
    document.addEventListener('pointerdown', (e) => {
      if (this.region && !this.panel.contains(e.target as Node)) this.close();
    }, { capture: true });
    for (const name of ['scalechanging', 'rotationchanging', 'pagesdestroy']) deps.eventBus.on(name, () => this.close());
    // Auto-detect outlines follow the pages as they render (scroll, zoom).
    // Only pages on screen: the model takes a while per page, and a page
    // rendered ahead is outlined when it scrolls into view.
    deps.eventBus.on('pagerendered', (evt: { pageNumber: number }) => {
      const doc = deps.getDoc();
      if (doc && this.wantsOutline(doc, evt.pageNumber)) this.outlineSoon(evt.pageNumber);
    });
    deps.eventBus.on('updateviewarea', () => this.outlineRenderedPages());
    deps.eventBus.on('pagesdestroy', () => { this.setActive(false); this.detected.clear(); });
  }

  /** The capture key: capture mode on or off. */
  toggle(): void {
    this.setActive(!this.active);
  }

  setActive(active: boolean): void {
    if (active && !this.deps.getDoc()) return;
    this.cancelDrag?.();
    this.active = active;
    if (active) this.close();
    document.body.classList.toggle('vt-capturing', active);
    this.clearOutlines();
    if (active) this.outlineRenderedPages();
    this.updateHint();
    this.deps.onActiveChange(active);
  }

  /** Esc: ends a drag, else closes the panel, else leaves capture mode. True when it did something. */
  handleEscape(): boolean {
    if (this.cancelDrag) { this.cancelDrag(); return true; }
    if (this.region) { this.close(); return true; }
    if (this.active) { this.setActive(false); return true; }
    return false;
  }

  /** The line over the page: what a click or a drag does, and how the search for figures goes. */
  private updateHint(): void {
    this.hint.hidden = !this.active;
    if (!this.active) { this.hint.textContent = ''; return; }
    if (!this.options.autoDetect) { this.hint.textContent = S.captureHintDrag; return; }
    const found = this.deps.container.querySelectorAll('.vt-figure-box').length;
    this.hint.textContent = this.detecting > 0 ? S.captureHintFinding : found > 0 ? S.captureHintFound(found) : S.captureHintNone;
  }

  private applyOptions(next: FigureCopyOptions): void {
    const detectChanged = next.autoDetect !== this.options.autoDetect;
    this.options = next;
    this.reflectOptions();
    if (this.active && detectChanged) {
      this.clearOutlines();
      this.outlineRenderedPages();
    }
    this.updateHint();
  }

  // ─── Auto-detect ───

  /** Outlines the rendered pages on screen that have none yet. */
  private outlineRenderedPages(): void {
    const doc = this.deps.getDoc();
    if (!this.active || !this.options.autoDetect || !doc) return;
    for (let i = 0; i < doc.numPages; i += 1) {
      if (this.outlined.has(i + 1) || !this.wantsOutline(doc, i + 1)) continue;
      const view = this.deps.pdfViewer.getPageView(i) as unknown as PageViewLike | undefined;
      if (view?.div.querySelector('canvas')) this.outlineSoon(i + 1);
    }
  }

  private outlineSoon(pageNumber: number): void {
    this.detecting += 1;
    this.updateHint();
    void this.outlinePage(pageNumber)
      .catch((error: unknown) => debugLog('viewer', 'outline failed', () => ({ error: String(error) })))
      .finally(() => { this.detecting -= 1; this.updateHint(); });
  }

  private clearOutlines(): void {
    this.outlined.clear();
    this.deps.container.querySelectorAll('.vt-figure-box').forEach((node) => node.remove());
  }

  /** The figures and tables of a page (cached per document); null when the run was skipped. */
  private detect(pageNumber: number): Promise<Array<DetectedFigure & { pdf: [number, number, number, number] }> | null> {
    const doc = this.deps.getDoc();
    if (!doc) return Promise.resolve([]);
    if (this.linesDoc !== doc) { this.linesDoc = doc; this.lines.clear(); this.detected.clear(); }
    let found: Promise<Array<DetectedFigure & { pdf: [number, number, number, number] }> | null> | undefined = this.detected.get(pageNumber);
    if (!found) {
      found = (async () => {
        const page = await doc.getPage(pageNumber);
        const vp = page.getViewport({ scale: 1 });
        const [lines, ops] = await Promise.all([this.pageLinesOf(doc, pageNumber), page.getOperatorList()]);
        const boxes = graphicBoxes(ops.fnArray, ops.argsArray, OPS as unknown as OpsLike, vp.transform);
        const size = { width: vp.width, height: vp.height };
        const ruleBased = detectFigures(lines, boxes, size);
        // The layout model finds them in any layout; the PDF's own text and
        // graphics name them and make the edges exact. Without the model
        // (failed to load), the rules alone.
        // Queued model runs are skipped once nobody wants them (auto-detect
        // turned off, another document, the page scrolled away).
        const dets = await detectLayout(page, () => this.wantsOutline(doc, pageNumber));
        const figures = dets ? combineLayout({ dets, lines, graphics: boxes, page: size, ruleBased }) : ruleBased;
        debugLog('viewer', 'figures detected', () => ({ page: pageNumber, graphics: boxes.length, model: dets !== null, figures }));
        return figures.map((f) => {
          const [ax, ay] = vp.convertToPdfPoint(f.box.left, f.box.top);
          const [bx, by] = vp.convertToPdfPoint(f.box.right, f.box.bottom);
          return { ...f, pdf: [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)] as [number, number, number, number] };
        });
      })().catch((error: unknown) => {
        // Skipped: not cached, so the page is detected again when it is wanted.
        if (error instanceof LayoutSkipped) { if (this.detected.get(pageNumber) === found) this.detected.delete(pageNumber); return null; }
        debugLog('viewer', 'figure detection failed', () => ({ page: pageNumber, error: error instanceof Error ? error.message : String(error) }));
        return [];
      });
      this.detected.set(pageNumber, found);
    }
    return found;
  }

  /** Capture mode outlines this document and the page is on screen. */
  private wantsOutline(doc: PDFDocumentProxy, pageNumber: number): boolean {
    if (!this.active || !this.options.autoDetect || this.deps.getDoc() !== doc) return false;
    const visible = (this.deps.pdfViewer as unknown as { _getVisiblePages?: () => { ids?: Set<number> } })._getVisiblePages?.().ids;
    return !visible || visible.has(pageNumber);
  }

  private async outlinePage(pageNumber: number): Promise<void> {
    this.outlined.add(pageNumber);
    const figures = await this.detect(pageNumber);
    debugLog('viewer', 'outline page', () => ({ pageNumber, figures: figures?.length ?? 'skipped', active: this.active }));
    if (!figures) { this.outlined.delete(pageNumber); return; }
    if (!this.active || !this.options.autoDetect) return;
    const view = this.deps.pdfViewer.getPageView(pageNumber - 1) as unknown as PageViewLike | undefined;
    if (!view) return;
    view.div.querySelectorAll('.vt-figure-box').forEach((node) => node.remove());
    const { width, height } = view.viewport;
    for (const figure of figures) {
      const [x0, y0] = view.viewport.convertToViewportPoint(figure.pdf[0], figure.pdf[1]);
      const [x1, y1] = view.viewport.convertToViewportPoint(figure.pdf[2], figure.pdf[3]);
      const figureName = figure.label ? (figure.label.kind === 'figure' ? S.captureFigureN(figure.label.number) : S.captureTableN(figure.label.number)) : S.captureFigure;
      const box = el('button', {
        type: 'button',
        className: 'vt-figure-box',
        title: S.captureClick,
        'aria-label': S.captureCopyAria(figureName),
      }, [el('span', { className: 'vt-figure-chip', textContent: figureName })]);
      // In percent of the page, so a zoom keeps them in place until the re-render redraws them.
      Object.assign(box.style, {
        left: `${(Math.min(x0, x1) / width) * 100}%`,
        top: `${(Math.min(y0, y1) / height) * 100}%`,
        width: `${(Math.abs(x1 - x0) / width) * 100}%`,
        height: `${(Math.abs(y1 - y0) / height) * 100}%`,
      });
      box.dataset.page = String(pageNumber);
      box.dataset.pdf = figure.pdf.join(',');
      // Enter or Space on a focused outline; a pointer goes through onPointerDown.
      box.addEventListener('click', (e) => { if (e.detail === 0) this.captureOutline(box); });
      view.div.append(box);
    }
  }

  /** A click on an outline: copy that figure as if it had been dragged. */
  private captureOutline(box: HTMLElement): void {
    const pageNumber = Number(box.dataset.page);
    const pdf = (box.dataset.pdf ?? '').split(',').map(Number) as [number, number, number, number];
    const view = this.deps.pdfViewer.getPageView(pageNumber - 1) as unknown as PageViewLike | undefined;
    if (!view || pdf.length !== 4 || pdf.some((v) => !Number.isFinite(v))) return;
    this.close(); // the previous capture, still open in continuous mode
    const rectEl = el('div', { className: 'vt-capture-rect' });
    Object.assign(rectEl.style, { left: box.style.left, top: box.style.top, width: box.style.width, height: box.style.height });
    view.div.append(rectEl);
    this.afterCapture();
    this.open({ pageNumber, pdf, rotation: view.viewport.rotation, rectEl });
  }

  /** Capture mode ends with a capture, unless it is continuous. */
  private afterCapture(): void {
    if (this.active && !this.options.continuous) this.setActive(false);
  }

  private pageLinesOf(doc: PDFDocumentProxy, pageNumber: number): Promise<TextLine[]> {
    if (this.linesDoc !== doc) { this.linesDoc = doc; this.lines.clear(); this.detected.clear(); }
    let lines = this.lines.get(pageNumber);
    if (!lines) {
      lines = doc.getPage(pageNumber).then(pageLines).catch(() => []);
      this.lines.set(pageNumber, lines);
    }
    return lines;
  }

  close(): void {
    this.generation += 1;
    this.region?.rectEl.remove();
    this.region = null;
    this.panel.hidden = true;
  }

  // ─── Drawing the region ───

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || !(this.active || e.altKey)) return;
    const target = e.target as HTMLElement | null;
    // A press on an outline copies that figure, unless it turns into a drag.
    const outline = this.active ? target?.closest<HTMLElement>('.vt-figure-box') ?? null : null;
    const pageEl = target?.closest<HTMLElement>('.page');
    const pageNumber = Number(pageEl?.dataset.pageNumber);
    if (!pageEl || !Number.isFinite(pageNumber) || !this.deps.getDoc()) return;
    // Nothing underneath (text selection, annotation editors) sees this drag.
    e.preventDefault();
    e.stopPropagation();
    this.cancelDrag?.();
    this.close();
    getSelection()?.removeAllRanges();

    const box = () => {
      const r = pageEl.getBoundingClientRect();
      return { left: r.left + pageEl.clientLeft, top: r.top + pageEl.clientTop, width: pageEl.clientWidth, height: pageEl.clientHeight };
    };
    const start = box();
    const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
    const x0 = clamp(e.clientX - start.left, start.width);
    const y0 = clamp(e.clientY - start.top, start.height);
    const rectEl = el('div', { className: 'vt-capture-rect' });
    let rect = { x: x0, y: y0, w: 0, h: 0 };
    let dragging = false;

    const move = (ev: PointerEvent) => {
      const b = box();
      const x1 = clamp(ev.clientX - b.left, b.width);
      const y1 = clamp(ev.clientY - b.top, b.height);
      if (!dragging) {
        if (Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) < MIN_DRAG_PX) return;
        // A drag: the outlines step aside (CSS) until it ends.
        dragging = true;
        pageEl.append(rectEl);
        document.body.classList.add('vt-capture-dragging');
      }
      rect = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      Object.assign(rectEl.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
    };
    const stop = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
      document.body.classList.remove('vt-capture-dragging');
      this.cancelDrag = null;
    };
    const end = (ev: PointerEvent) => {
      stop();
      if (ev.type === 'pointercancel') { rectEl.remove(); return; }
      if (!dragging) {
        if (outline?.isConnected) this.captureOutline(outline);
        return;
      }
      if (rect.w < MIN_DRAG_PX || rect.h < MIN_DRAG_PX) { rectEl.remove(); return; }
      ev.preventDefault();
      const view = this.deps.pdfViewer.getPageView(pageNumber - 1) as unknown as PageViewLike | undefined;
      if (!view) { rectEl.remove(); return; }
      const [ax, ay] = view.viewport.convertToPdfPoint(rect.x, rect.y);
      const [bx, by] = view.viewport.convertToPdfPoint(rect.x + rect.w, rect.y + rect.h);
      this.afterCapture();
      this.open({
        pageNumber,
        pdf: [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)],
        rotation: view.viewport.rotation,
        rectEl,
      });
    };
    // Esc mid-drag: no capture, the outlines come back.
    this.cancelDrag = () => { stop(); rectEl.remove(); };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
  }

  // ─── Panel ───

  private open(region: Region): void {
    this.region = region;
    this.label = null;
    this.sourceEdited = false;
    const gen = ++this.generation;
    this.sourceInput.value = '';
    this.panel.hidden = false;
    this.placePanel();
    const labelReady = this.findLabel(region).then((label) => {
      if (gen !== this.generation) return;
      this.label = label;
      if (!this.sourceEdited) this.sourceInput.value = this.sourceText();
    });
    this.copyAsOptioned(labelReady);
  }

  /** What a capture does with the clipboard (the options' `copy`). */
  private copyAsOptioned(labelReady: Promise<void>): void {
    switch (this.options.copy) {
      case 'none': this.setStatus(S.captureNotCopied); return;
      case 'source': this.copySource(labelReady); return;
      default: this.copyImage(labelReady, this.options.copy === 'image-source');
    }
  }

  private buildPanel(): void {
    const closeBtn = el('button', { type: 'button', className: 'vt-btn vt-icon-btn vt-capture-close', title: S.captureClose, 'aria-label': S.captureCloseAria });
    closeBtn.innerHTML = '<svg><use href="#i-close"/></svg>';
    closeBtn.addEventListener('click', () => this.close());
    const copyImageBtn = el('button', { type: 'button', className: 'vt-btn vt-btn-text vt-btn-primary' }, [S.captureCopyImage]);
    copyImageBtn.addEventListener('click', () => this.copyImage(Promise.resolve(), this.options.copy === 'image-source'));
    const copySourceBtn = el('button', { type: 'button', className: 'vt-btn vt-btn-text' }, [S.captureCopySource]);
    copySourceBtn.addEventListener('click', () => this.copySource(Promise.resolve()));
    const saveBtn = el('button', { type: 'button', className: 'vt-btn vt-btn-text' }, [S.captureSavePng]);
    saveBtn.addEventListener('click', () => { void this.savePng(); });
    this.optionsBtn.addEventListener('click', () => {
      this.optionsBox.hidden = !this.optionsBox.hidden;
      this.optionsBtn.setAttribute('aria-expanded', String(!this.optionsBox.hidden));
      this.placePanel();
    });
    this.sourceInput.addEventListener('input', () => { this.sourceEdited = true; });

    const row = (label: string, control: HTMLElement, wide = false) =>
      el('label', { className: wide ? 'vt-capture-option vt-capture-wide' : 'vt-capture-option' }, [el('span', { textContent: label }), control]);
    const check = (control: HTMLInputElement, label: string) =>
      el('label', { className: 'vt-capture-option vt-capture-check' }, [control, el('span', { textContent: label })]);
    const c = this.controls;
    this.optionsBox.append(
      row(S.captureCopyWhen, c.copy, true),
      check(c.annotations, S.captureAnnotations),
      check(c.embed, S.captureEmbed),
      row(S.captureDpi, c.dpi),
      row(S.captureBackground, c.background),
      row(S.captureStyle, c.style),
      row(S.capturePrefix, c.prefix),
    );
    for (const [key, control] of Object.entries(c)) {
      control.addEventListener('change', () => this.onOptionChange(key as keyof FigureCopyOptions));
    }

    this.panel.append(
      el('div', { className: 'vt-capture-head' }, [this.status, closeBtn]),
      this.sourceInput,
      el('div', { className: 'vt-capture-actions' }, [copyImageBtn, copySourceBtn, saveBtn, this.optionsBtn]),
      this.optionsBox,
    );
    this.panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); }
    });
  }

  private reflectOptions(): void {
    const { controls: c, options: o } = this;
    c.annotations.checked = o.annotations;
    c.dpi.value = String(o.dpi);
    c.background.value = o.background;
    c.copy.value = o.copy;
    c.embed.checked = o.embed;
    c.style.value = o.style;
    c.prefix.value = o.prefix;
  }

  private onOptionChange(key: keyof FigureCopyOptions): void {
    const c = this.controls;
    this.options = normalizeFigureCopyOptions({
      ...this.options,
      annotations: c.annotations.checked,
      dpi: Number(c.dpi.value),
      background: c.background.value,
      copy: c.copy.value,
      embed: c.embed.checked,
      style: c.style.value,
      prefix: c.prefix.value,
    });
    void setSetting(FIGURE_COPY_OPTIONS_SETTING_KEY, this.options).catch(() => { /* kept for this page */ });
    this.channel.postMessage(this.options);
    if (key === 'style' || key === 'prefix') {
      this.sourceEdited = false;
      this.sourceInput.value = this.sourceText();
      const o = this.options;
      if (o.copy !== 'image-source' && o.copy !== 'source' && !o.embed) return;
    }
    // The open capture is copied again as the options now say.
    if (this.region) this.copyAsOptioned(Promise.resolve());
  }

  private placePanel(): void {
    const region = this.region;
    if (!region || this.panel.hidden) return;
    if (!region.rectEl.isConnected) { this.close(); return; }
    const r = region.rectEl.getBoundingClientRect();
    const bounds = this.deps.container.getBoundingClientRect();
    const w = this.panel.offsetWidth;
    const h = this.panel.offsetHeight;
    const gap = 8;
    let top = r.bottom + gap;
    if (top + h > bounds.bottom - gap) top = r.top - h - gap;
    top = Math.min(Math.max(top, bounds.top + gap), Math.max(bounds.top + gap, bounds.bottom - h - gap));
    const left = Math.min(Math.max(r.left, bounds.left + gap), Math.max(bounds.left + gap, bounds.right - w - gap));
    this.panel.style.top = `${Math.round(top)}px`;
    this.panel.style.left = `${Math.round(left)}px`;
  }

  private setStatus(text: string, kind: 'ok' | 'busy' | 'error' = 'ok'): void {
    this.status.textContent = text;
    this.status.dataset.kind = kind;
  }

  // ─── Source line ───

  private sourceText(): string {
    const region = this.region;
    if (!region) return '';
    const { meta, docTitle } = this.deps.getSource();
    return formatFigureSource({
      meta,
      docTitle,
      label: this.label,
      pageNumber: region.pageNumber,
      style: this.options.style,
      prefix: this.options.prefix,
    });
  }

  private currentSource(): string {
    return this.sourceInput.value.trim() || this.sourceText();
  }

  private findLabel(region: Region): Promise<FigureLabel | null> {
    const doc = this.deps.getDoc();
    if (!doc) return Promise.resolve(null);
    return this.pageLinesOf(doc, region.pageNumber).then(async (list) => {
      const page = await doc.getPage(region.pageNumber);
      const vp = page.getViewport({ scale: 1 });
      const [ax, ay] = vp.convertToViewportPoint(region.pdf[0], region.pdf[1]);
      const [bx, by] = vp.convertToViewportPoint(region.pdf[2], region.pdf[3]);
      const box = { left: Math.min(ax, bx), top: Math.min(ay, by), right: Math.max(ax, bx), bottom: Math.max(ay, by) };
      const label = findFigureLabel(list, box);
      debugLog('viewer', 'figure label', () => ({ page: region.pageNumber, box, label }));
      return label;
    }).catch(() => null);
  }

  // ─── Rendering and copying ───

  private async render(region: Region, withSource: string | null): Promise<{ blob: Blob; cssWidth: number }> {
    const doc = this.deps.getDoc();
    if (!doc) throw new Error(S.captureNoPdf);
    const page = await doc.getPage(region.pageNumber);
    const canvas = await renderRegion(doc, page, region, this.options);
    const out = withSource ? withCaption(canvas, withSource, this.options) : canvas;
    const blob = await new Promise<Blob>((resolve, reject) => {
      out.toBlob((b) => (b ? resolve(b) : reject(new Error(S.capturePngFailed))), 'image/png');
    });
    // Pasted at its print size: DPI → CSS pixels.
    return { blob, cssWidth: Math.round(out.width * CSS_DPI / Number(canvas.dataset.dpi)) };
  }

  /** The image (`withSource`: and the source line as text and HTML, for documents). */
  private copyImage(labelReady: Promise<void>, withSource: boolean): void {
    const region = this.region;
    if (!region) return;
    const gen = this.generation;
    const embed = this.options.embed;
    this.setStatus(S.captureCopying, 'busy');
    const source = labelReady.then(() => this.currentSource());
    const image = source.then((text) => this.render(region, embed ? text : null));
    const items: Record<string, Promise<Blob>> = { 'image/png': image.then((r) => r.blob) };
    if (withSource) {
      items['text/plain'] = source.then((text) => new Blob([text], { type: 'text/plain' }));
      items['text/html'] = Promise.all([image, source]).then(async ([r, text]) => new Blob([
        `<img src="${await dataUrl(r.blob)}" width="${r.cssWidth}" alt="${escapeHtml(text)}"><p>${escapeHtml(text)}</p>`,
      ], { type: 'text/html' }));
    }
    let write: Promise<void>;
    try {
      write = navigator.clipboard.write([new ClipboardItem(items)]);
    } catch (error) {
      write = Promise.reject(error);
    }
    void write.then(() => {
      if (gen !== this.generation) return;
      const what = formatFigureLabel(this.label, region.pageNumber);
      this.setStatus(withSource ? S.captureCopiedTogether(what) : S.captureCopiedSeparate(what));
    }, (error: unknown) => {
      if (gen !== this.generation) return;
      this.setStatus(S.captureCopyFailed(error instanceof Error ? error.message : String(error)), 'error');
    });
  }

  /** The source line alone; it may wait for the caption, so the write starts now with a promised text. */
  private copySource(labelReady: Promise<void>): void {
    const gen = this.generation;
    this.setStatus(S.captureCopying, 'busy');
    const text = labelReady.then(() => new Blob([this.currentSource()], { type: 'text/plain' }));
    let write: Promise<void>;
    try {
      write = navigator.clipboard.write([new ClipboardItem({ 'text/plain': text })]);
    } catch (error) {
      write = Promise.reject(error);
    }
    void write.then(() => {
      if (gen === this.generation) this.setStatus(S.captureSourceCopied);
    }, (error: unknown) => {
      if (gen === this.generation) this.setStatus(S.captureSourceCopyFailed(error instanceof Error ? error.message : String(error)), 'error');
    });
  }

  private async savePng(): Promise<void> {
    const region = this.region;
    if (!region) return;
    this.setStatus(S.captureSaving, 'busy');
    try {
      const { blob } = await this.render(region, this.options.embed ? this.currentSource() : null);
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: this.fileName(region) });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      this.setStatus(S.captureSaved);
    } catch (error) {
      this.setStatus(S.captureSaveFailed(error instanceof Error ? error.message : String(error)), 'error');
    }
  }

  private fileName(region: Region): string {
    const { meta, docTitle } = this.deps.getSource();
    const base = (meta?.title ?? docTitle).replace(/\.pdf$/iu, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 60) || 'figure';
    const what = formatFigureLabel(this.label, region.pageNumber).replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
    return `${base}-${what}.png`;
  }
}

// ─── Helpers ───

function select(options: Array<[string, string]>): HTMLSelectElement {
  const node = el('select', { className: 'vt-select' });
  for (const [value, label] of options) node.append(el('option', { value, textContent: label }));
  return node;
}

/** The page's text as lines in a rotation-0 viewport at scale 1 (PDF points, y down). */
async function pageLines(page: PDFPageProxy): Promise<TextLine[]> {
  const content = await page.getTextContent();
  const vp = page.getViewport({ scale: 1 });
  const placed: PlacedText[] = [];
  for (const item of content.items) {
    if (!('str' in item) || !item.str) continue;
    // Judged as shown, not as stored: on a /Rotate 90 page upright text is
    // stored vertical.
    const tx = Util.transform(vp.transform, item.transform);
    if (Math.abs(tx[1]) > Math.abs(tx[0])) continue; // vertical text is never a caption
    placed.push({ str: item.str, x: tx[4], baseline: tx[5], width: item.width, height: Math.hypot(tx[2], tx[3]) });
  }
  return groupLines(placed);
}

async function renderRegion(doc: PDFDocumentProxy, page: PDFPageProxy, region: Region, options: FigureCopyOptions): Promise<HTMLCanvasElement> {
  let dpi = options.dpi;
  const bounds = (scale: number) => {
    const vp = page.getViewport({ scale, rotation: region.rotation });
    const [ax, ay] = vp.convertToViewportPoint(region.pdf[0], region.pdf[1]);
    const [bx, by] = vp.convertToViewportPoint(region.pdf[2], region.pdf[3]);
    const left = Math.floor(Math.min(ax, bx));
    const top = Math.floor(Math.min(ay, by));
    return { left, top, width: Math.ceil(Math.max(ax, bx)) - left, height: Math.ceil(Math.max(ay, by)) - top };
  };
  let box = bounds(dpi / 72);
  if (box.width * box.height > MAX_PIXELS) {
    dpi = Math.floor(dpi * Math.sqrt(MAX_PIXELS / (box.width * box.height)));
    box = bounds(dpi / 72);
  }
  const viewport = page.getViewport({ scale: dpi / 72, rotation: region.rotation, offsetX: -box.left, offsetY: -box.top });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, box.width);
  canvas.height = Math.max(1, box.height);
  canvas.dataset.dpi = String(dpi);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  await page.render({
    canvasContext: ctx,
    viewport,
    intent: 'print',
    background: options.background === 'transparent' ? 'rgba(0,0,0,0)' : '#ffffff',
    annotationMode: options.annotations ? AnnotationMode.ENABLE_STORAGE : AnnotationMode.DISABLE,
    printAnnotationStorage: options.annotations ? doc.annotationStorage.print : undefined,
  } as Parameters<typeof page.render>[0]).promise;
  return canvas;
}

/** The image with the source line set under it, 8 pt at the image's DPI. */
function withCaption(image: HTMLCanvasElement, text: string, options: FigureCopyOptions): HTMLCanvasElement {
  const dpi = Number(image.dataset.dpi) || options.dpi;
  const fontPx = Math.round(8 * dpi / 72);
  const pad = Math.round(fontPx * 0.6);
  const font = `${fontPx}px system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans KR', sans-serif`;
  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) return image;
  measure.font = font;
  const maxWidth = Math.max(image.width - pad * 2, fontPx * 8);
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/u).filter(Boolean)) {
    const next = current ? `${current} ${word}` : word;
    if (current && measure.measureText(next).width > maxWidth) { lines.push(current); current = word; } else current = next;
  }
  if (current) lines.push(current);
  const lineHeight = Math.round(fontPx * 1.3);
  const out = document.createElement('canvas');
  out.width = image.width;
  out.height = image.height + pad * 2 + lineHeight * lines.length;
  out.dataset.dpi = String(dpi);
  const ctx = out.getContext('2d');
  if (!ctx) return image;
  if (options.background === 'white') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
  }
  ctx.drawImage(image, 0, 0);
  ctx.font = font;
  ctx.fillStyle = '#555555';
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => ctx.fillText(line, pad, image.height + pad + i * lineHeight, maxWidth));
  return out;
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}
