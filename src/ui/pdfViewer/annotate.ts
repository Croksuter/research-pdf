// Annotation toolbar: highlighter / pen / text, color, thickness, opacity,
// delete, undo, redo. Drives PDF.js's AnnotationEditorUIManager, so the
// drawn annotations are part of the document and survive "다운로드". The
// tool, colors, thickness and opacity last used come back in every document
// (localStorage: this device).

import { AnnotationEditorParamsType, AnnotationEditorType } from 'pdfjs-dist';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { EventBus, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { byId } from './dom';
import { S } from './viewerParts.strings';

export const HIGHLIGHT_COLORS = 'yellow=#FFFF98,green=#53FFBC,blue=#80EBFF,pink=#FFCBE6,red=#FF4F5F';

const INK_COLORS = ['#000000', '#e02424', '#1d4ed8', '#16a34a', '#f59e0b', '#7c3aed'];
const HIGHLIGHT_SWATCHES = HIGHLIGHT_COLORS.split(',').map((pair) => pair.split('=')[1]);
const TOOLS_STORAGE_KEY = 'rpdfAnnotateTools';

interface ToolPrefs { tool: number; inkColor: string; highlightColor: string; thickness: number; opacity: number }

function readToolPrefs(): Partial<Record<keyof ToolPrefs, unknown>> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(TOOLS_STORAGE_KEY) ?? 'null');
    return raw && typeof raw === 'object' ? raw as Partial<Record<keyof ToolPrefs, unknown>> : {};
  } catch {
    return {};
  }
}

interface EditorStates {
  isEditing?: boolean;
  hasSomethingToUndo?: boolean;
  hasSomethingToRedo?: boolean;
  hasSelectedEditor?: boolean;
}

export class AnnotationToolbar {
  private readonly bar = byId<HTMLElement>('vocab-t-pdf-annotate-bar');
  private readonly toggleBtn = byId<HTMLButtonElement>('vt-annotate-toggle');
  private readonly undoBtn = byId<HTMLButtonElement>('vt-undo');
  private readonly redoBtn = byId<HTMLButtonElement>('vt-redo');
  private readonly deleteBtn = byId<HTMLButtonElement>('vt-annotate-delete');
  private readonly toolButtons = Array.from(this.bar.querySelectorAll<HTMLButtonElement>('[data-editor-mode]'));
  private readonly swatches = byId<HTMLDivElement>('vt-annotate-colors');
  private readonly thickness = byId<HTMLInputElement>('vt-annotate-thickness');
  private readonly opacity = byId<HTMLInputElement>('vt-annotate-opacity');
  private uiManager: AnnotationEditorUIManager | null = null;
  private mode: number = AnnotationEditorType.NONE;
  private selected = false;
  private inkColor = INK_COLORS[0];
  /** Told when the bar opens or closes. */
  onOpenChange: ((open: boolean) => void) | null = null;
  private highlightColor = HIGHLIGHT_SWATCHES[0];
  /** The tool the bar opens with: the one last used. */
  private tool: number = AnnotationEditorType.HIGHLIGHT;

  constructor(private readonly pdfViewer: PDFViewer, eventBus: EventBus) {
    eventBus.on('annotationeditoruimanager', (evt: { uiManager: AnnotationEditorUIManager }) => {
      this.uiManager = evt.uiManager;
      this.toggleBtn.disabled = false;
    });
    // (PDF.js 6's name; it was `annotationeditorstateschanged` before.)
    eventBus.on('editingstateschanged', (evt: { details: EditorStates }) => this.applyStates(evt.details));
    eventBus.on('annotationeditormodechanged', (evt: { mode: number }) => this.reflectMode(evt.mode));

    this.toggleBtn.addEventListener('click', () => this.toggle());
    for (const btn of this.toolButtons) {
      btn.addEventListener('click', () => {
        const next = Number(btn.dataset.editorMode);
        this.setMode(this.mode === next ? AnnotationEditorType.NONE : next);
      });
    }
    this.undoBtn.addEventListener('click', () => this.uiManager?.undo());
    this.redoBtn.addEventListener('click', () => this.uiManager?.redo());
    this.deleteBtn.addEventListener('click', () => this.uiManager?.delete());
    this.thickness.addEventListener('input', () => this.pushParams());
    this.opacity.addEventListener('input', () => this.pushParams());
    this.thickness.addEventListener('change', () => this.saveToolPrefs());
    this.opacity.addEventListener('change', () => this.saveToolPrefs());
    this.restoreToolPrefs();
    this.renderSwatches();
    this.applyStates({});
  }

  get isOpen(): boolean {
    return !this.bar.hidden;
  }

  /**
   * A tool is active. PDF.js then handles Ctrl/⌘+Z / Y and Escape itself (on
   * window, whatever else did with the event), so the viewer must not too.
   */
  get editing(): boolean {
    return this.mode !== AnnotationEditorType.NONE;
  }

  /** An annotation is selected (Escape deselects it). */
  get hasSelectedEditor(): boolean {
    return this.editing && this.selected;
  }

  undo(): void { this.uiManager?.undo(); }
  redo(): void { this.uiManager?.redo(); }

  toggle(open = this.bar.hidden): void {
    this.bar.hidden = !open;
    this.toggleBtn.classList.toggle('is-active', open);
    this.toggleBtn.setAttribute('aria-pressed', String(open));
    document.body.classList.toggle('vt-annotating', open);
    if (!open) this.setMode(AnnotationEditorType.NONE);
    else if (this.mode === AnnotationEditorType.NONE) this.setMode(this.tool);
    this.onOpenChange?.(open);
  }

  setMode(mode: number): void {
    if (!this.uiManager) return;
    this.pdfViewer.annotationEditorMode = { mode };
    this.reflectMode(mode);
    this.pushParams();
    if (mode !== AnnotationEditorType.NONE && mode !== this.tool) {
      this.tool = mode;
      this.saveToolPrefs();
    }
  }

  private restoreToolPrefs(): void {
    const saved = readToolPrefs();
    const inRange = (input: HTMLInputElement, value: unknown) =>
      typeof value === 'number' && value >= Number(input.min) && value <= Number(input.max);
    if (typeof saved.inkColor === 'string' && INK_COLORS.includes(saved.inkColor)) this.inkColor = saved.inkColor;
    if (typeof saved.highlightColor === 'string' && HIGHLIGHT_SWATCHES.includes(saved.highlightColor)) this.highlightColor = saved.highlightColor;
    if (inRange(this.thickness, saved.thickness)) this.thickness.value = String(saved.thickness);
    if (inRange(this.opacity, saved.opacity)) this.opacity.value = String(saved.opacity);
    if (this.toolButtons.some((btn) => Number(btn.dataset.editorMode) === saved.tool)) this.tool = saved.tool as number;
  }

  private saveToolPrefs(): void {
    const prefs: ToolPrefs = {
      tool: this.tool,
      inkColor: this.inkColor,
      highlightColor: this.highlightColor,
      thickness: Number(this.thickness.value),
      opacity: Number(this.opacity.value),
    };
    try {
      localStorage.setItem(TOOLS_STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      /* this document only */
    }
  }

  private reflectMode(mode: number): void {
    this.mode = mode;
    for (const btn of this.toolButtons) {
      const active = Number(btn.dataset.editorMode) === mode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    }
    const isHighlight = mode === AnnotationEditorType.HIGHLIGHT;
    const isInk = mode === AnnotationEditorType.INK;
    const isText = mode === AnnotationEditorType.FREETEXT;
    this.swatches.hidden = !(isHighlight || isInk || isText);
    this.thickness.parentElement!.hidden = !(isHighlight || isInk);
    this.opacity.parentElement!.hidden = !isInk;
    this.renderSwatches();
  }

  private renderSwatches(): void {
    const isHighlight = this.mode === AnnotationEditorType.HIGHLIGHT;
    const colors = isHighlight ? HIGHLIGHT_SWATCHES : INK_COLORS;
    const current = isHighlight ? this.highlightColor : this.inkColor;
    this.swatches.replaceChildren();
    for (const color of colors) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vt-swatch' + (color === current ? ' is-active' : '');
      btn.style.setProperty('--swatch', color);
      btn.title = color;
      btn.setAttribute('aria-label', S.swatch(color));
      btn.addEventListener('click', () => {
        if (isHighlight) this.highlightColor = color; else this.inkColor = color;
        this.renderSwatches();
        this.pushParams();
        this.saveToolPrefs();
      });
      this.swatches.append(btn);
    }
  }

  private pushParams(): void {
    const m = this.uiManager;
    if (!m) return;
    const thickness = Number(this.thickness.value);
    const opacity = Number(this.opacity.value) / 100;
    switch (this.mode) {
      case AnnotationEditorType.HIGHLIGHT:
        m.updateParams(AnnotationEditorParamsType.HIGHLIGHT_COLOR, this.highlightColor);
        m.updateParams(AnnotationEditorParamsType.HIGHLIGHT_THICKNESS, thickness);
        break;
      case AnnotationEditorType.INK:
        m.updateParams(AnnotationEditorParamsType.INK_COLOR, this.inkColor);
        m.updateParams(AnnotationEditorParamsType.INK_THICKNESS, thickness);
        m.updateParams(AnnotationEditorParamsType.INK_OPACITY, opacity);
        break;
      case AnnotationEditorType.FREETEXT:
        m.updateParams(AnnotationEditorParamsType.FREETEXT_COLOR, this.inkColor);
        break;
      default:
        break;
    }
  }

  private applyStates(states: EditorStates): void {
    this.undoBtn.disabled = !states.hasSomethingToUndo;
    this.redoBtn.disabled = !states.hasSomethingToRedo;
    this.deleteBtn.disabled = !states.hasSelectedEditor;
    this.selected = !!states.hasSelectedEditor;
  }
}
