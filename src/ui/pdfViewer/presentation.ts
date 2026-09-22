// Presentation ("프레젠테이션") mode: fullscreen, one page per screen, arrow
// keys / click / wheel to turn pages. PDF.js's own PDFPresentationMode is not
// part of the components build, so this drives PDFViewer's public state.

import { ScrollMode, SpreadMode, type EventBus, type PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';

// Mirrors PDF.js PresentationModeState.
const STATE_NORMAL = 1;
const STATE_CHANGING = 2;
const STATE_FULLSCREEN = 3;

interface Saved {
  scrollMode: number;
  spreadMode: number;
  scaleValue: string;
  page: number;
}

export class PresentationMode {
  private saved: Saved | null = null;
  private wheelLock = 0;

  constructor(
    private readonly container: HTMLDivElement,
    private readonly pdfViewer: PDFViewer,
    private readonly eventBus: EventBus,
  ) {
    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement === this.container) this.enter();
      else if (this.saved) this.exit();
    });
    container.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    container.addEventListener('click', (e) => this.onClick(e));
  }

  get active(): boolean {
    return this.saved !== null;
  }

  async request(): Promise<void> {
    if (this.active) return;
    try {
      await this.container.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      /* fullscreen refused (e.g. no user gesture) */
    }
  }

  async leave(): Promise<void> {
    if (document.fullscreenElement === this.container) await document.exitFullscreen();
  }

  /** Keyboard handling while presenting; returns true when consumed. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.active) return false;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowDown': case 'PageDown': case ' ': case 'Enter':
        this.pdfViewer.currentPageNumber += 1; return true;
      case 'ArrowLeft': case 'ArrowUp': case 'PageUp': case 'Backspace':
        this.pdfViewer.currentPageNumber -= 1; return true;
      case 'Home': this.pdfViewer.currentPageNumber = 1; return true;
      case 'End': this.pdfViewer.currentPageNumber = this.pdfViewer.pagesCount; return true;
      default: return false;
    }
  }

  private enter(): void {
    const v = this.pdfViewer;
    this.saved = { scrollMode: v.scrollMode, spreadMode: v.spreadMode, scaleValue: v.currentScaleValue, page: v.currentPageNumber };
    v.presentationModeState = STATE_CHANGING;
    this.container.classList.add('pdfPresentationMode');
    document.body.classList.add('vt-presenting');
    v.scrollMode = ScrollMode.PAGE;
    v.spreadMode = SpreadMode.NONE;
    v.currentScaleValue = 'page-fit';
    v.currentPageNumber = this.saved.page;
    v.presentationModeState = STATE_FULLSCREEN;
    this.eventBus.dispatch('presentationmodechanged', { source: this, state: STATE_FULLSCREEN });
  }

  private exit(): void {
    const saved = this.saved;
    if (!saved) return;
    const v = this.pdfViewer;
    v.presentationModeState = STATE_CHANGING;
    this.container.classList.remove('pdfPresentationMode');
    document.body.classList.remove('vt-presenting');
    v.scrollMode = saved.scrollMode;
    v.spreadMode = saved.spreadMode;
    v.currentScaleValue = saved.scaleValue;
    v.currentPageNumber = v.currentPageNumber;
    v.presentationModeState = STATE_NORMAL;
    this.saved = null;
    this.eventBus.dispatch('presentationmodechanged', { source: this, state: STATE_NORMAL });
  }

  private onWheel(e: WheelEvent): void {
    if (!this.active) return;
    e.preventDefault();
    const now = Date.now();
    if (now - this.wheelLock < 400) return;
    this.wheelLock = now;
    this.pdfViewer.currentPageNumber += e.deltaY > 0 ? 1 : -1;
  }

  private onClick(e: MouseEvent): void {
    if (!this.active) return;
    const target = e.target as HTMLElement;
    if (target.closest('a, button, input, .annotationLayer, .vocab-t-hl')) return;
    if (window.getSelection()?.toString()) return;
    this.pdfViewer.currentPageNumber += e.shiftKey ? -1 : 1;
  }
}
