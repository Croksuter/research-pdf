// ─── Annotation cache runtime ───
//
// Keeps PDF.js's annotationStorage mirrored in IndexedDB per document
// identity and restores it when the document is reopened; the pure model and
// reconciliation rules live in shared/pdfAnnotations.ts. Restoring goes
// through the same path as PDF.js's own paste: `layer.deserialize(data)` on
// the page's AnnotationEditorLayer, which only exists once that page has
// rendered, so cached items wait per page and are added as layers appear.
// File annotations the user removed are recorded in annotationStorage as
// `{deleted: true}` (what `saveDocument()` honours), registered with the UI
// manager so they never turn into editors, and hidden in the annotation layer.

import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { EventBus, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { getPdfAnnotationCache, putPdfAnnotationCache } from '../../db/pdfAnnotationRepository';
import { mergeAnnotationCaches } from '../../shared/pdfSync';
import { requestPdfSync } from './syncHint';
import {
  EDITOR_TYPE_STAMP,
  PDF_ANNOTATION_CACHE_VERSION,
  isEmptyAnnotationCache,
  parseRect,
  reconcileAnnotations,
  resolveAnnotationConflict,
  snapshotAnnotations,
  type AnnotationApplyPlan,
  type AnnotationConflictChoice,
  type AnnotationReconciliation,
  type CachedAnnotationDelete,
  type CachedAnnotationItem,
  type FileAnnotationSummary,
  type PdfAnnotationCache,
} from '../../shared/pdfAnnotations';
import type { PdfDocIdentity } from '../../shared/pdfIdentity';
import { debugError, debugLog } from '../../shared/debugLog';

const SNAPSHOT_DEBOUNCE_MS = 800;
// Enumerating file annotations costs one worker round trip per page.
const FILE_MARKS_MAX_PAGES = 2_000;

// The slices of PDF.js internals this module touches.
interface EditorLike {
  onceAdded(focus: boolean): void;
}
interface LayerLike {
  div: HTMLDivElement;
  deserialize(data: unknown): Promise<EditorLike | null>;
  addOrRebuild(editor: EditorLike): void;
}
interface UIManagerLike {
  getLayer(pageIndex: number): LayerLike | undefined;
  addDeletedAnnotationElement(editor: { annotationElementId: string; id: string; deleted?: boolean }): void;
}
interface StorageLike {
  readonly serializable: { map: Map<string, unknown> | null };
  getRawValue(key: string): unknown;
  setValue(key: string, value: unknown): void;
}
interface PageViewLike {
  div: HTMLDivElement;
  viewport: { convertToViewportRectangle(rect: number[]): number[] };
  annotationLayer?: { div?: HTMLDivElement | null } | null;
}

export type ConflictPrompt = (conflict: Extract<AnnotationReconciliation, { kind: 'conflict' }>) => Promise<AnnotationConflictChoice>;

export class AnnotationCache {
  private uiManager: UIManagerLike | null = null;
  private doc: PDFDocumentProxy | null = null;
  private identity: PdfDocIdentity | null = null;
  private cache: PdfAnnotationCache | null = null;
  private fileMarks: FileAnnotationSummary[] | null = null;
  private readonly pending = new Map<string, CachedAnnotationItem>();
  private readonly hiddenIds = new Map<number, Set<string>>();
  private deletesToRegister: CachedAnnotationDelete[] = [];
  private restoring = new Set<number>();
  private ready = false;
  private session = 0;
  private lastSnapshot = '';
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Drawings that reached the store from outside this page (cloud sync
   * applying another device's work) while the document was open. The editor
   * never sees them, so every snapshot carries them forward; otherwise the
   * next 3-way merge would read their absence as the user erasing them.
   */
  private foreign: { items: Map<string, CachedAnnotationItem>; deleted: Map<string, CachedAnnotationDelete> } = {
    items: new Map(), deleted: new Map(),
  };

  constructor(
    eventBus: EventBus,
    private readonly pdfViewer: PDFViewer,
    private readonly promptConflict: ConflictPrompt,
  ) {
    eventBus.on('annotationeditoruimanager', (evt: { uiManager: unknown }) => {
      this.uiManager = evt.uiManager as UIManagerLike;
      this.registerDeletes();
    });
    eventBus.on('annotationeditorlayerrendered', (evt: { pageNumber: number }) => { void this.restorePage(evt.pageNumber - 1); });
    eventBus.on('annotationlayerrendered', (evt: { pageNumber: number }) => this.hideDeletedOnPage(evt.pageNumber - 1));
    eventBus.on('annotationeditorstateschanged', () => this.scheduleSnapshot());
    eventBus.on('annotationeditormodechanged', () => this.scheduleSnapshot());
    // Moves/resizes/typing change editors without any bus event; the snapshot
    // is debounced and hash-compared, so these are cheap when nothing changed.
    document.addEventListener('pointerup', () => this.scheduleSnapshot());
    document.addEventListener('keyup', () => this.scheduleSnapshot());
    document.addEventListener('visibilitychange', () => { if (document.hidden) void this.flush(); });
    window.addEventListener('pagehide', () => { void this.flush(); });
  }

  /** Called once per opened document, after `pdfViewer.setDocument(doc)`. */
  async attach(doc: PDFDocumentProxy, identity: PdfDocIdentity | null): Promise<void> {
    const session = ++this.session;
    await this.flush();
    if (session !== this.session) return;
    this.doc = doc;
    this.identity = identity;
    this.cache = null;
    this.fileMarks = null;
    this.pending.clear();
    this.hiddenIds.clear();
    this.deletesToRegister = [];
    this.restoring = new Set();
    this.ready = false;
    this.lastSnapshot = '';
    this.foreign = { items: new Map(), deleted: new Map() };
    if (!identity) return;
    try {
      const stored = await getPdfAnnotationCache(identity.docId);
      if (session !== this.session) return;
      if (!stored || isEmptyAnnotationCache(stored)) {
        this.cache = stored ?? this.emptyCache(identity);
        this.ready = true;
        return;
      }
      const marks = await this.collectFileMarks(doc);
      if (session !== this.session) return;
      this.fileMarks = marks;
      const reconciled = reconcileAnnotations(stored, marks, identity.fingerprintModified);
      let plan: AnnotationApplyPlan;
      let cache: PdfAnnotationCache;
      if (reconciled.kind === 'silent') {
        ({ plan, cache } = reconciled);
      } else {
        debugLog('pdf:annot', 'annotation conflict', () => ({ fileOnly: reconciled.fileOnly.length, cacheOnly: reconciled.cacheOnly.length }));
        const choice = await this.promptConflict(reconciled);
        if (session !== this.session) return;
        ({ plan, cache } = resolveAnnotationConflict(reconciled, choice));
      }
      this.cache = { ...cache, updatedAt: Date.now() };
      await putPdfAnnotationCache(this.cache);
      if (session !== this.session) return;
      this.applyPlan(plan);
      this.ready = true;
    } catch (error) {
      debugError('pdf:annot', 'annotation cache attach failed', () => ({ error: error instanceof Error ? error.message : String(error) }));
      this.ready = true;
    }
  }

  private emptyCache(identity: PdfDocIdentity): PdfAnnotationCache {
    return {
      docId: identity.docId,
      version: PDF_ANNOTATION_CACHE_VERSION,
      baseFingerprintModified: identity.fingerprintModified,
      items: [],
      deleted: [],
      updatedAt: 0,
    };
  }

  // ─── File annotations ───

  private async collectFileMarks(doc: PDFDocumentProxy, pages?: Iterable<number>): Promise<FileAnnotationSummary[]> {
    const marks: FileAnnotationSummary[] = [];
    const range = pages ?? Array.from({ length: Math.min(doc.numPages, FILE_MARKS_MAX_PAGES) }, (_, i) => i);
    for (const pageIndex of range) {
      const page = await doc.getPage(pageIndex + 1);
      const annotations = await page.getAnnotations({ intent: 'display' }) as Array<Record<string, unknown>>;
      for (const a of annotations) {
        const rect = parseRect(a.rect);
        if (typeof a.id !== 'string' || typeof a.subtype !== 'string' || !rect) continue;
        const contentsObj = a.contentsObj as { str?: unknown } | undefined;
        marks.push({
          id: a.id,
          pageIndex,
          subtype: a.subtype,
          rect,
          contents: typeof contentsObj?.str === 'string' ? contentsObj.str : null,
          popupRef: typeof a.popupRef === 'string' ? a.popupRef : null,
        });
      }
    }
    return marks;
  }

  // ─── Applying a plan ───

  private applyPlan(plan: AnnotationApplyPlan): void {
    for (const item of plan.items) this.pending.set(item.key, item);
    const storage = this.doc?.annotationStorage as unknown as StorageLike | undefined;
    for (const d of plan.deletes) {
      storage?.setValue(d.id, { deleted: true, id: d.id, pageIndex: d.pageIndex, popupRef: d.popupRef });
      let ids = this.hiddenIds.get(d.pageIndex);
      if (!ids) this.hiddenIds.set(d.pageIndex, ids = new Set());
      ids.add(d.id);
      if (d.popupRef) ids.add(d.popupRef);
    }
    this.deletesToRegister = plan.deletes.slice();
    this.registerDeletes();
    // Pages that rendered while the plan was being worked out.
    const numPages = this.doc?.numPages ?? 0;
    for (let i = 0; i < numPages; i += 1) {
      this.hideDeletedOnPage(i);
      void this.restorePage(i);
    }
  }

  private registerDeletes(): void {
    if (!this.uiManager) return;
    for (const d of this.deletesToRegister) {
      this.uiManager.addDeletedAnnotationElement({ annotationElementId: d.id, id: `vt_deleted_${d.id}` });
    }
    this.deletesToRegister = [];
  }

  private pageView(pageIndex: number): PageViewLike | null {
    const view = (this.pdfViewer as unknown as { getPageView(i: number): unknown }).getPageView(pageIndex);
    return (view as PageViewLike | undefined) ?? null;
  }

  private hideDeletedOnPage(pageIndex: number): void {
    const ids = this.hiddenIds.get(pageIndex);
    if (!ids?.size) return;
    const layerDiv = this.pageView(pageIndex)?.annotationLayer?.div;
    if (!layerDiv) return;
    for (const id of ids) {
      layerDiv.querySelectorAll<HTMLElement>(`[data-annotation-id="${CSS.escape(id)}"]`).forEach((elm) => { elm.hidden = true; });
    }
  }

  private async restorePage(pageIndex: number): Promise<void> {
    if (!this.uiManager || this.restoring.has(pageIndex)) return;
    const items = Array.from(this.pending.values()).filter((item) => item.pageIndex === pageIndex);
    if (items.length === 0) return;
    const layer = this.uiManager.getLayer(pageIndex);
    if (!layer) return;
    const session = this.session;
    this.restoring.add(pageIndex);
    try {
      for (const item of items) {
        if (session !== this.session) return;
        try {
          const editor = await layer.deserialize(item.data);
          if (!editor || session !== this.session) continue;
          // Highlight/stamp editors focus themselves when added outside a
          // layer enable, which would scroll the view; add them quietly.
          const proto = Object.getPrototypeOf(editor) as EditorLike;
          editor.onceAdded = () => proto.onceAdded.call(editor, false);
          layer.addOrRebuild(editor);
          layer.div.hidden = false;
        } catch (error) {
          debugError('pdf:annot', 'failed to restore annotation', () => ({ key: item.key, error: error instanceof Error ? error.message : String(error) }));
        }
        this.pending.delete(item.key);
      }
    } finally {
      this.restoring.delete(pageIndex);
    }
    this.scheduleSnapshot();
  }

  // ─── Snapshots ───

  private scheduleSnapshot(): void {
    if (!this.ready || !this.identity) return;
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      void this.snapshot();
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    await this.snapshot();
  }

  private serializedEntries(): Array<[string, unknown]> {
    const storage = this.doc?.annotationStorage as unknown as StorageLike | undefined;
    const map = storage?.serializable.map;
    if (!map) return [];
    const entries: Array<[string, unknown]> = [];
    for (const [key, value] of map) {
      let data = value as Record<string, unknown>;
      if (data && data.annotationType === EDITOR_TYPE_STAMP) {
        // The save format ships the bitmap out of band; the copy format
        // carries it inline as a data URL, which is what deserialize accepts.
        const raw = storage?.getRawValue(key) as { serialize?: (copy: boolean) => { bitmapUrl?: unknown } | null } | undefined;
        const copy = typeof raw?.serialize === 'function' ? raw.serialize(true) : null;
        if (typeof copy?.bitmapUrl === 'string') data = { ...data, bitmapUrl: copy.bitmapUrl };
      }
      entries.push([key, data]);
    }
    return entries;
  }

  private async snapshot(): Promise<void> {
    const { doc, identity } = this;
    if (!doc || !identity || !this.ready) return;
    const session = this.session;
    try {
      const entries = this.serializedEntries();
      // A delete recorded against an annotation we have not enumerated yet
      // needs its subtype/rect so it can be verified on a later revision.
      const unknownDeletePages = new Set<number>();
      const known = new Set((this.fileMarks ?? []).map((m) => m.id));
      for (const [, value] of entries) {
        const v = value as Record<string, unknown> | null;
        const id = typeof v?.id === 'string' ? v.id : null;
        if (id && !known.has(id) && Number.isInteger(v?.pageIndex)) unknownDeletePages.add(v!.pageIndex as number);
      }
      if (unknownDeletePages.size > 0) {
        const extra = await this.collectFileMarks(doc, unknownDeletePages);
        if (session !== this.session) return;
        this.fileMarks = [...(this.fileMarks ?? []), ...extra.filter((m) => !known.has(m.id))];
      }
      const { items, deleted } = snapshotAnnotations({
        entries,
        pending: Array.from(this.pending.values()),
        previous: this.cache,
        fileMarks: this.fileMarks,
        now: Date.now(),
      });
      const digest = JSON.stringify([items, deleted]);
      if (digest === this.lastSnapshot) return;
      this.lastSnapshot = digest;
      const previous = this.cache ?? this.emptyCache(identity);
      let next: PdfAnnotationCache = {
        ...previous,
        baseFingerprintModified: identity.fingerprintModified,
        items: withForeign(items, this.foreign.items, (item) => item.key),
        deleted: withForeign(deleted, this.foreign.deleted, (entry) => entry.id),
        updatedAt: Date.now(),
      };
      // Another writer (cloud sync) may have changed the stored cache since
      // this page last read or wrote it. Never overwrite that blindly: merge
      // against what this page last saw, and keep the outside drawings so they
      // survive every later snapshot too.
      const stored = await getPdfAnnotationCache(identity.docId);
      if (session !== this.session) return;
      if (stored && stored.updatedAt !== previous.updatedAt) {
        next = mergeAnnotationCaches(next, stored, previous.updatedAt === 0 ? null : previous);
        const own = new Set(items.map((item) => item.key));
        const ownDeletes = new Set(deleted.map((entry) => entry.id));
        next.items.forEach((item) => { if (!own.has(item.key)) this.foreign.items.set(item.key, item); });
        next.deleted.forEach((entry) => { if (!ownDeletes.has(entry.id)) this.foreign.deleted.set(entry.id, entry); });
        next.updatedAt = Date.now();
        debugLog('pdf:annot', 'merged an outside write into the snapshot', () => ({ foreign: this.foreign.items.size }));
      }
      this.cache = next;
      await putPdfAnnotationCache(next);
      requestPdfSync('edit');
    } catch (error) {
      debugError('pdf:annot', 'annotation snapshot failed', () => ({ error: error instanceof Error ? error.message : String(error) }));
    }
  }

  // ─── Preview helper for the conflict dialog ───

  /** Scrolls to the page and flashes an outline around a PDF-space rect. */
  flash(pageIndex: number, rect: number[]): void {
    this.pdfViewer.currentPageNumber = pageIndex + 1;
    const view = this.pageView(pageIndex);
    if (!view) return;
    document.querySelectorAll('.vt-annot-flash').forEach((elm) => elm.remove());
    const [x1, y1, x2, y2] = view.viewport.convertToViewportRectangle(rect);
    const box = document.createElement('div');
    box.className = 'vt-annot-flash';
    box.style.left = `${Math.min(x1, x2)}px`;
    box.style.top = `${Math.min(y1, y2)}px`;
    box.style.width = `${Math.abs(x2 - x1)}px`;
    box.style.height = `${Math.abs(y2 - y1)}px`;
    view.div.append(box);
    setTimeout(() => box.remove(), 2_000);
  }
}

function withForeign<T>(own: T[], foreign: Map<string, T>, keyOf: (entry: T) => string): T[] {
  if (foreign.size === 0) return own;
  const keys = new Set(own.map(keyOf));
  return [...own, ...[...foreign.values()].filter((entry) => !keys.has(keyOf(entry)))];
}
