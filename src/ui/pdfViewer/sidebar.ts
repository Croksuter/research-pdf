// Sidebar: page thumbnails (lazy), document outline, attachments.

import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { byId, el, formatBytes } from './dom';

const THUMB_WIDTH = 132;

type SidebarView = 'thumbs' | 'outline' | 'attachments';

interface SidebarDeps {
  eventBus: EventBus;
  pdfViewer: PDFViewer;
  linkService: PDFLinkService;
  downloadAttachment: (data: Uint8Array, filename: string) => void;
}

interface OutlineItem {
  title: string;
  dest: string | unknown[] | null;
  url: string | null;
  items: OutlineItem[];
  bold?: boolean;
  italic?: boolean;
}

export class Sidebar {
  private readonly root = byId<HTMLElement>('vocab-t-pdf-sidebar');
  private readonly thumbsPane = byId<HTMLDivElement>('vt-sidebar-thumbs');
  private readonly outlinePane = byId<HTMLDivElement>('vt-sidebar-outline');
  private readonly attachmentsPane = byId<HTMLDivElement>('vt-sidebar-attachments');
  private readonly tabs = Array.from(this.root.querySelectorAll<HTMLButtonElement>('[data-sidebar-view]'));
  private doc: PDFDocumentProxy | null = null;
  private view: SidebarView = 'thumbs';
  private observer: IntersectionObserver | null = null;
  private rendered = new Set<number>();
  private thumbEls: HTMLElement[] = [];
  private rotation = 0;

  constructor(private readonly deps: SidebarDeps) {
    for (const tab of this.tabs) {
      tab.addEventListener('click', () => this.switchView(tab.dataset.sidebarView as SidebarView));
    }
    deps.eventBus.on('pagechanging', (evt: { pageNumber: number }) => this.markCurrent(evt.pageNumber));
    deps.eventBus.on('rotationchanging', (evt: { pagesRotation: number }) => {
      this.rotation = evt.pagesRotation;
      if (this.doc) this.buildThumbnails(this.doc);
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  toggle(open = this.root.hidden): void {
    this.root.hidden = !open;
    document.body.classList.toggle('vt-sidebar-open', open);
    if (open && this.doc) this.ensureVisibleThumbs();
    // Layout changed: let PDF.js recompute page sizes for 'auto'/'page-width'.
    this.deps.eventBus.dispatch('resize', { source: this });
  }

  async setDocument(doc: PDFDocumentProxy): Promise<void> {
    this.doc = doc;
    this.rendered.clear();
    this.buildThumbnails(doc);
    const [outline, attachments] = await Promise.all([
      doc.getOutline().catch(() => null) as Promise<OutlineItem[] | null>,
      doc.getAttachments().catch(() => null) as Promise<Record<string, { filename: string; content: Uint8Array }> | null>,
    ]);
    this.buildOutline(outline);
    this.buildAttachments(attachments);
    this.tabs.find((t) => t.dataset.sidebarView === 'outline')!.disabled = !outline?.length;
    this.tabs.find((t) => t.dataset.sidebarView === 'attachments')!.disabled = !attachments || Object.keys(attachments).length === 0;
    this.switchView('thumbs');
  }

  private switchView(view: SidebarView): void {
    this.view = view;
    for (const tab of this.tabs) tab.classList.toggle('is-active', tab.dataset.sidebarView === view);
    this.thumbsPane.hidden = view !== 'thumbs';
    this.outlinePane.hidden = view !== 'outline';
    this.attachmentsPane.hidden = view !== 'attachments';
    if (view === 'thumbs') this.ensureVisibleThumbs();
  }

  // ── Thumbnails ──

  private buildThumbnails(doc: PDFDocumentProxy): void {
    this.observer?.disconnect();
    this.rendered.clear();
    this.thumbEls = [];
    this.thumbsPane.replaceChildren();
    for (let n = 1; n <= doc.numPages; n += 1) {
      const canvasHolder = el('div', { className: 'vt-thumb-canvas' });
      const item = el('button', {
        type: 'button',
        className: 'vt-thumb',
        'data-page': String(n),
        'aria-label': `페이지 ${n}`,
      }, [canvasHolder, el('span', { className: 'vt-thumb-label', textContent: String(n) })]);
      item.addEventListener('click', () => { this.deps.pdfViewer.currentPageNumber = n; });
      this.thumbsPane.append(item);
      this.thumbEls.push(item);
    }
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) void this.renderThumb(Number((entry.target as HTMLElement).dataset.page));
      }
    }, { root: this.thumbsPane, rootMargin: '300px 0px' });
    for (const item of this.thumbEls) this.observer.observe(item);
    this.markCurrent(this.deps.pdfViewer.currentPageNumber);
  }

  private ensureVisibleThumbs(): void {
    // IntersectionObserver only fires on change; re-observe to catch a pane that
    // was hidden while thumbnails were created.
    if (!this.observer) return;
    for (const item of this.thumbEls) { this.observer.unobserve(item); this.observer.observe(item); }
  }

  private async renderThumb(pageNumber: number): Promise<void> {
    const doc = this.doc;
    if (!doc || this.rendered.has(pageNumber)) return;
    this.rendered.add(pageNumber);
    const holder = this.thumbEls[pageNumber - 1]?.querySelector<HTMLDivElement>('.vt-thumb-canvas');
    if (!holder) return;
    try {
      const page = await doc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1, rotation: this.rotation });
      const scale = THUMB_WIDTH / base.width;
      const viewport = page.getViewport({ scale: scale * (window.devicePixelRatio || 1), rotation: this.rotation });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.width = `${THUMB_WIDTH}px`;
      canvas.style.height = `${Math.round(base.height * scale)}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      await page.render({ canvasContext: ctx, viewport } as Parameters<typeof page.render>[0]).promise;
      holder.replaceChildren(canvas);
    } catch {
      this.rendered.delete(pageNumber);
    }
  }

  private markCurrent(pageNumber: number): void {
    for (const item of this.thumbEls) {
      const active = Number(item.dataset.page) === pageNumber;
      item.classList.toggle('is-current', active);
      if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
      if (active && this.isOpen && this.view === 'thumbs') item.scrollIntoView({ block: 'nearest' });
    }
  }

  // ── Outline ──

  private buildOutline(outline: OutlineItem[] | null): void {
    this.outlinePane.replaceChildren();
    if (!outline?.length) {
      this.outlinePane.append(el('p', { className: 'vt-sidebar-empty', textContent: '목차가 없습니다.' }));
      return;
    }
    const build = (items: OutlineItem[], depth: number): HTMLUListElement => {
      const list = el('ul', { className: 'vt-outline-list', role: depth === 0 ? 'tree' : 'group' });
      for (const item of items) {
        const hasChildren = item.items?.length > 0;
        const row = el('div', { className: 'vt-outline-row' });
        const toggle = el('button', {
          type: 'button',
          className: 'vt-outline-toggle',
          'aria-label': '하위 항목 접기/펼치기',
          hidden: !hasChildren,
        }, ['▸']);
        const link = el('button', { type: 'button', className: 'vt-outline-link' }, [item.title || '(제목 없음)']);
        if (item.bold) link.style.fontWeight = '600';
        if (item.italic) link.style.fontStyle = 'italic';
        link.addEventListener('click', () => {
          if (item.dest) void this.deps.linkService.goToDestination(item.dest as string);
          else if (item.url) window.open(item.url, '_blank', 'noopener');
        });
        row.append(toggle, link);
        const li = el('li', { role: 'treeitem' }, [row]);
        if (hasChildren) {
          const sub = build(item.items, depth + 1);
          sub.hidden = depth >= 1;
          toggle.textContent = sub.hidden ? '▸' : '▾';
          toggle.addEventListener('click', () => {
            sub.hidden = !sub.hidden;
            toggle.textContent = sub.hidden ? '▸' : '▾';
          });
          li.append(sub);
        }
        list.append(li);
      }
      return list;
    };
    this.outlinePane.append(build(outline, 0));
  }

  // ── Attachments ──

  private buildAttachments(attachments: Record<string, { filename: string; content: Uint8Array }> | null): void {
    this.attachmentsPane.replaceChildren();
    const entries = attachments ? Object.values(attachments) : [];
    if (entries.length === 0) {
      this.attachmentsPane.append(el('p', { className: 'vt-sidebar-empty', textContent: '첨부파일이 없습니다.' }));
      return;
    }
    const list = el('ul', { className: 'vt-attachment-list' });
    for (const item of entries) {
      const btn = el('button', { type: 'button', className: 'vt-attachment' }, [
        el('span', { className: 'vt-attachment-name', textContent: item.filename }),
        el('span', { className: 'vt-attachment-size', textContent: formatBytes(item.content?.byteLength ?? 0) }),
      ]);
      btn.addEventListener('click', () => this.deps.downloadAttachment(item.content, item.filename));
      list.append(el('li', {}, [btn]));
    }
    this.attachmentsPane.append(list);
  }
}
