// ─── ResearchPDF viewer page ───
//
// A PDF.js host that mirrors Chrome's built-in viewer feature set (sidebar
// with thumbnails / outline / attachments, page navigation, zoom + fit toggle,
// rotation, find, annotations with undo/redo, download, print, two-page view,
// presentation mode, document properties, password prompt, drag & drop) while
// keeping the page text as ordinary DOM. The background service worker routes
// local and web PDF navigations here (see shared/localPdf.ts) because Chrome's
// own viewer is a privileged guest frame an extension cannot script, and this
// page can remember drawings and reading position per document.

import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import {
  DownloadManager,
  EventBus,
  LinkTarget,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
  SpreadMode,
} from 'pdfjs-dist/web/pdf_viewer.mjs';
import { APP_NAME } from '../shared/brand';
import { initDebugLogging } from '../shared/debugLog';
import { WEB_PDF_HOST_ORIGINS, isWebPdfSourceUrl, parsePdfViewerFile, pdfDisplayName } from '../shared/localPdf';
import { AnnotationToolbar, HIGHLIGHT_COLORS } from './pdfViewer/annotate';
import { byId } from './pdfViewer/dom';
import { PresentationMode } from './pdfViewer/presentation';
import { isPrinting, printDocument } from './pdfViewer/print';
import { PaperStrip } from './pdfViewer/paperStrip';
import { showDocumentProperties } from './pdfViewer/properties';
import { Sidebar } from './pdfViewer/sidebar';
import { derivePdfDocIdentity, inspectPdfBytes, loadPdfDocRecord, savePdfDocRecord, type PdfBytesInfo } from './pdfViewer/docState';
import { AnnotationCache } from './pdfViewer/annotationCache';
import { requestPdfSync } from './pdfViewer/syncHint';
import { showAnnotationConflictDialog } from './pdfViewer/annotationConflict';
import type { PdfDocIdentity, PdfDocRecord } from '../shared/pdfIdentity';

const FIND_STATE_NOT_FOUND = 1;
const FIND_STATE_PENDING = 3;
const ZOOM_STEP = 1.1;
const MIN_SCALE = 0.1;
const MAX_SCALE = 10;
const PASSWORD_INCORRECT = 2;

// Same runtime debug flag the content bundle honours (chrome.storage.local).
initDebugLogging();

// ─── Elements ───

const container = byId<HTMLDivElement>('viewerContainer');
const pageInput = byId<HTMLInputElement>('vt-page');
const pageCount = byId<HTMLSpanElement>('vt-page-count');
const zoomOutBtn = byId<HTMLButtonElement>('vt-zoom-out');
const zoomInBtn = byId<HTMLButtonElement>('vt-zoom-in');
const zoomSelect = byId<HTMLSelectElement>('vt-zoom');
const fitToggleBtn = byId<HTMLButtonElement>('vt-fit-toggle');
const rotateBtn = byId<HTMLButtonElement>('vt-rotate');
const sidebarToggleBtn = byId<HTMLButtonElement>('vt-sidebar-toggle');
const findToggleBtn = byId<HTMLButtonElement>('vt-find-toggle');
const findBar = byId<HTMLDivElement>('vocab-t-pdf-findbar');
const findInput = byId<HTMLInputElement>('vt-find-input');
const findPrevBtn = byId<HTMLButtonElement>('vt-find-prev');
const findNextBtn = byId<HTMLButtonElement>('vt-find-next');
const findCloseBtn = byId<HTMLButtonElement>('vt-find-close');
const findCase = byId<HTMLInputElement>('vt-find-case');
const findWord = byId<HTMLInputElement>('vt-find-word');
const findStatus = byId<HTMLSpanElement>('vt-find-status');
const fileNameEl = byId<HTMLSpanElement>('vt-file-name');
const downloadBtn = byId<HTMLButtonElement>('vt-download');
const printBtn = byId<HTMLButtonElement>('vt-print');
const moreBtn = byId<HTMLButtonElement>('vt-more');
const menu = byId<HTMLDivElement>('vt-menu');
const menuTwoPage = byId<HTMLButtonElement>('vt-menu-two-page');
const menuAnnotations = byId<HTMLButtonElement>('vt-menu-annotations');
const menuRotateCcw = byId<HTMLButtonElement>('vt-menu-rotate-ccw');
const menuFirst = byId<HTMLButtonElement>('vt-menu-first');
const menuLast = byId<HTMLButtonElement>('vt-menu-last');
const menuPresent = byId<HTMLButtonElement>('vt-menu-present');
const menuProperties = byId<HTMLButtonElement>('vt-menu-properties');
const menuOpenFile = byId<HTMLButtonElement>('vt-menu-open-file');
const openNativeBtn = byId<HTMLButtonElement>('vt-open-native');
const openFileInput = byId<HTMLInputElement>('vt-open-file-input');
const messageBox = byId<HTMLDivElement>('vocab-t-pdf-message');
const messageText = byId<HTMLParagraphElement>('vt-message-text');
const messageAction = byId<HTMLButtonElement>('vt-message-action');
const progress = byId<HTMLDivElement>('vocab-t-pdf-progress');
const progressBar = byId<HTMLDivElement>('vt-progress-bar');
const dropOverlay = byId<HTMLDivElement>('vocab-t-pdf-drop');
const passwordDialog = byId<HTMLDialogElement>('vocab-t-pdf-password');
const passwordForm = byId<HTMLFormElement>('vt-password-form');
const passwordInput = byId<HTMLInputElement>('vt-password-input');
const passwordHint = byId<HTMLParagraphElement>('vt-password-hint');
const passwordCancel = byId<HTMLButtonElement>('vt-password-cancel');
const propertiesDialog = byId<HTMLDialogElement>('vocab-t-pdf-properties');
const propsClose = byId<HTMLButtonElement>('vt-props-close');

function showMessage(text: string, action?: { label: string; onClick: () => void }) {
  messageText.textContent = text;
  messageAction.hidden = !action;
  messageAction.onclick = action ? action.onClick : null;
  if (action) messageAction.textContent = action.label;
  messageBox.hidden = false;
}

function hideMessage() {
  messageBox.hidden = true;
}

function extensionUrl(path: string): string {
  return chrome.runtime.getURL(path);
}

// ─── PDF.js wiring ───

pdfjsLib.GlobalWorkerOptions.workerSrc = extensionUrl('pdfjs/pdf.worker.mjs');

const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK });
const findController = new PDFFindController({ eventBus, linkService });
const downloadManager = new DownloadManager();
const pdfViewer = new PDFViewer({
  container,
  eventBus,
  linkService,
  findController,
  downloadManager,
  // Text layer on (it is the whole point); interactive forms on; annotation
  // editing available (NONE = idle, editors enabled on demand).
  textLayerMode: 1,
  annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
  annotationEditorMode: pdfjsLib.AnnotationEditorType.NONE,
  annotationEditorHighlightColors: HIGHLIGHT_COLORS,
  imageResourcesPath: extensionUrl('pdfjs/images/'),
  viewerAlert: byId<HTMLDivElement>('vocab-t-pdf-viewer-alert'),
} as unknown as ConstructorParameters<typeof PDFViewer>[0]);
linkService.setViewer(pdfViewer);

const sidebar = new Sidebar({
  eventBus,
  pdfViewer,
  linkService,
  downloadAttachment: (data, filename) => downloadManager.download(data, '', filename),
});
const annotate = new AnnotationToolbar(pdfViewer, eventBus);
const presentation = new PresentationMode(container, pdfViewer, eventBus);
const paperStrip = new PaperStrip(() => eventBus.dispatch('resize', { source: paperStrip }));
// Drawings persist per document identity and come back on reopen; when the
// file itself also carries annotations the user resolves it in a dialog.
const annotationCache = new AnnotationCache(eventBus, pdfViewer, (conflict) =>
  showAnnotationConflictDialog(conflict, { preview: (pageIndex, rect) => annotationCache.flash(pageIndex, rect) }));

let currentDoc: PDFDocumentProxy | null = null;
let currentFileUrl: string | null = null;
let currentFileName = 'document.pdf';
let currentByteLength: number | null = null;
let loadingTask: PDFDocumentLoadingTask | null = null;
// Content-derived identity of the open document (shared/pdfIdentity.ts) and
// the stored record it resolved to, applied once at `pagesinit`.
let currentIdentity: PdfDocIdentity | null = null;
let pendingRestore: PdfDocRecord | null = null;

const isFramed = window.top !== window.self;
// Inside an iframe/<embed>/<object> the viewer replaces only that frame; a
// tab-level "reopen natively" would navigate the whole host page away.
if (isFramed) openNativeBtn.hidden = true;

// ─── Toolbar: pages ───

function updatePageControls() {
  const total = pdfViewer.pagesCount;
  const current = pdfViewer.currentPageNumber;
  pageInput.value = String(current);
  pageInput.max = String(total);
  pageCount.textContent = total ? String(total) : '–';
}

pageInput.addEventListener('change', () => {
  const requested = Number.parseInt(pageInput.value, 10);
  if (Number.isFinite(requested) && requested >= 1 && requested <= pdfViewer.pagesCount) {
    pdfViewer.currentPageNumber = requested;
  } else {
    updatePageControls();
  }
});
pageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') pageInput.blur();
});
pageInput.addEventListener('focus', () => pageInput.select());

// ─── Toolbar: zoom / fit / rotate ───

function syncZoomSelect() {
  const value = pdfViewer.currentScaleValue;
  const hasOption = Array.from(zoomSelect.options).some((o) => o.value === value && o.value !== 'custom');
  const custom = zoomSelect.querySelector<HTMLOptionElement>('option[value="custom"]');
  if (hasOption) {
    zoomSelect.value = value;
    if (custom) custom.hidden = true;
  } else if (custom) {
    custom.textContent = `${Math.round(pdfViewer.currentScale * 100)}%`;
    custom.hidden = false;
    zoomSelect.value = 'custom';
  }
  const fitPage = value === 'page-fit';
  fitToggleBtn.querySelector('use')?.setAttribute('href', fitPage ? '#i-fit-width' : '#i-fit-page');
  fitToggleBtn.title = fitPage ? '너비에 맞춤' : '페이지에 맞춤';
}

function zoomBy(factor: number) {
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, pdfViewer.currentScale * factor));
  pdfViewer.currentScaleValue = String(Math.round(next * 100) / 100);
}
zoomOutBtn.addEventListener('click', () => zoomBy(1 / ZOOM_STEP));
zoomInBtn.addEventListener('click', () => zoomBy(ZOOM_STEP));
zoomSelect.addEventListener('change', () => {
  if (zoomSelect.value !== 'custom') pdfViewer.currentScaleValue = zoomSelect.value;
});
fitToggleBtn.addEventListener('click', () => {
  pdfViewer.currentScaleValue = pdfViewer.currentScaleValue === 'page-fit' ? 'page-width' : 'page-fit';
});

function rotate(delta: number) {
  pdfViewer.pagesRotation = (pdfViewer.pagesRotation + delta + 360) % 360;
}
rotateBtn.addEventListener('click', () => rotate(90));

// ─── Toolbar: sidebar / find ───

sidebarToggleBtn.addEventListener('click', () => {
  sidebar.toggle();
  sidebarToggleBtn.setAttribute('aria-pressed', String(sidebar.isOpen));
  sidebarToggleBtn.classList.toggle('is-active', sidebar.isOpen);
});

function openFindBar() {
  findBar.hidden = false;
  findToggleBtn.setAttribute('aria-pressed', 'true');
  findToggleBtn.classList.add('is-active');
  findInput.focus();
  findInput.select();
}

function closeFindBar() {
  findBar.hidden = true;
  findToggleBtn.setAttribute('aria-pressed', 'false');
  findToggleBtn.classList.remove('is-active');
  eventBus.dispatch('findbarclose', { source: window });
  findStatus.textContent = '';
  findStatus.classList.remove('is-notfound');
  container.focus();
}

findToggleBtn.addEventListener('click', () => (findBar.hidden ? openFindBar() : closeFindBar()));
findCloseBtn.addEventListener('click', closeFindBar);

function dispatchFind(type: '' | 'again' | 'casesensitivitychange' | 'entirewordchange', findPrevious = false) {
  const query = findInput.value;
  if (!query) {
    findStatus.textContent = '';
    findStatus.classList.remove('is-notfound');
    eventBus.dispatch('findbarclose', { source: window });
    return;
  }
  eventBus.dispatch('find', {
    source: window,
    type,
    query,
    caseSensitive: findCase.checked,
    entireWord: findWord.checked,
    highlightAll: true,
    findPrevious,
    matchDiacritics: false,
  });
}

findInput.addEventListener('input', () => dispatchFind(''));
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    dispatchFind('again', e.shiftKey);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeFindBar();
  }
});
findPrevBtn.addEventListener('click', () => dispatchFind('again', true));
findNextBtn.addEventListener('click', () => dispatchFind('again', false));
findCase.addEventListener('change', () => dispatchFind('casesensitivitychange'));
findWord.addEventListener('change', () => dispatchFind('entirewordchange'));

function renderFindStatus(state: number, matches: { current: number; total: number } | undefined) {
  findStatus.classList.toggle('is-notfound', state === FIND_STATE_NOT_FOUND);
  if (state === FIND_STATE_PENDING) findStatus.textContent = '검색 중…';
  else if (state === FIND_STATE_NOT_FOUND) findStatus.textContent = '없음';
  else if (matches && matches.total > 0) findStatus.textContent = `${matches.current} / ${matches.total}`;
  else findStatus.textContent = '';
}
eventBus.on('updatefindcontrolstate', (evt: { state: number; matchesCount?: { current: number; total: number } }) => {
  renderFindStatus(evt.state, evt.matchesCount);
});
eventBus.on('updatefindmatchescount', (evt: { matchesCount: { current: number; total: number } }) => {
  if (findInput.value) renderFindStatus(0, evt.matchesCount);
});

// ─── Toolbar: download / print / menu ───

function ensureDoc(): PDFDocumentProxy | null {
  if (!currentDoc) showMessage('열린 PDF가 없습니다.');
  return currentDoc;
}

async function downloadCurrent() {
  const doc = ensureDoc();
  if (!doc) return;
  try {
    // Annotations / form values live in the annotation storage; only then is a
    // full incremental save needed.
    const data = doc.annotationStorage.size > 0 ? await doc.saveDocument() : await doc.getData();
    downloadManager.download(data, currentFileUrl ?? '', currentFileName);
  } catch (error) {
    showMessage(`다운로드하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
  }
}
downloadBtn.addEventListener('click', () => { void downloadCurrent(); });
printBtn.addEventListener('click', () => { const doc = ensureDoc(); if (doc) void printDocument(doc); });

function openMenu(open: boolean) {
  menu.hidden = !open;
  moreBtn.setAttribute('aria-expanded', String(open));
  if (open) menu.querySelector<HTMLButtonElement>('.vt-menu-item')?.focus();
}
moreBtn.addEventListener('click', (e) => { e.stopPropagation(); openMenu(menu.hidden); });
document.addEventListener('click', (e) => {
  if (!menu.hidden && !menu.contains(e.target as Node)) openMenu(false);
});
menu.addEventListener('click', () => openMenu(false));
menu.addEventListener('keydown', (e) => {
  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('.vt-menu-item:not([hidden])'));
  const idx = items.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(idx + 1) % items.length]?.focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(idx - 1 + items.length) % items.length]?.focus(); }
  else if (e.key === 'Escape') { openMenu(false); moreBtn.focus(); }
});

menuTwoPage.addEventListener('click', () => {
  const on = pdfViewer.spreadMode !== SpreadMode.ODD;
  pdfViewer.spreadMode = on ? SpreadMode.ODD : SpreadMode.NONE;
  menuTwoPage.setAttribute('aria-checked', String(on));
});
menuAnnotations.addEventListener('click', () => {
  const hidden = document.body.classList.toggle('vt-hide-annotations');
  menuAnnotations.setAttribute('aria-checked', String(!hidden));
});
menuRotateCcw.addEventListener('click', () => rotate(-90));
menuFirst.addEventListener('click', () => { pdfViewer.currentPageNumber = 1; });
menuLast.addEventListener('click', () => { pdfViewer.currentPageNumber = pdfViewer.pagesCount; });
menuPresent.addEventListener('click', () => { if (ensureDoc()) void presentation.request(); });
menuProperties.addEventListener('click', () => {
  const doc = ensureDoc();
  if (doc) void showDocumentProperties({ doc, fileName: currentFileName, byteLength: currentByteLength });
});
propsClose.addEventListener('click', () => propertiesDialog.close());
menuOpenFile.addEventListener('click', () => openFileInput.click());
openFileInput.addEventListener('change', () => {
  const file = openFileInput.files?.[0];
  if (file) void loadFromFile(file);
  openFileInput.value = '';
});

// ─── Native viewer escape hatch ───

openNativeBtn.addEventListener('click', () => {
  if (!currentFileUrl) return;
  // The background records a one-shot bypass for this tab so its own
  // navigation listener does not bounce the document straight back here.
  chrome.runtime.sendMessage({ type: 'VOCAB_T_OPEN_NATIVE_PDF', url: currentFileUrl }, (response) => {
    if (chrome.runtime.lastError || !response?.success) {
      showMessage('기본 뷰어로 열지 못했습니다. 설정에서 PDF 뷰어 옵션을 끄고 다시 시도하세요.');
    }
  });
});

// ─── Viewer events ───

eventBus.on('pagesinit', () => {
  pdfViewer.currentScaleValue = 'auto';
  const hash = location.hash.slice(1);
  const restore = pendingRestore;
  pendingRestore = null;
  if (hash) {
    // An explicit `#page=…` (link, tab restore after reload) wins over the
    // remembered position.
    linkService.setHash(hash);
  } else if (restore) {
    if (restore.zoom) pdfViewer.currentScaleValue = restore.zoom;
    if (restore.page && restore.page <= pdfViewer.pagesCount) pdfViewer.currentPageNumber = restore.page;
  }
  updatePageControls();
  syncZoomSelect();
});
eventBus.on('pagechanging', updatePageControls);
eventBus.on('scalechanging', syncZoomSelect);

// ─── Tab state for restore-after-reload ───
// Chrome closes every page of a reloaded extension; the background recreates
// this tab from the last reported source URL + page + zoom (see background.ts).
let viewerStateTimer: ReturnType<typeof setTimeout> | null = null;
function reportViewerState() {
  if (!currentFileUrl || isFramed) return;
  if (viewerStateTimer) clearTimeout(viewerStateTimer);
  viewerStateTimer = setTimeout(() => {
    viewerStateTimer = null;
    chrome.runtime.sendMessage({
      type: 'VOCAB_T_VIEWER_STATE',
      sourceUrl: currentFileUrl,
      page: pdfViewer.currentPageNumber || null,
      zoom: pdfViewer.currentScaleValue || null,
    }, () => { void chrome.runtime.lastError; });
  }, 400);
}
eventBus.on('pagesinit', reportViewerState);
eventBus.on('pagechanging', reportViewerState);
eventBus.on('scalechanging', reportViewerState);

// ─── Per-document state (reading position keyed by document identity) ───
// Unlike the tab record above this is keyed by the document's own identity,
// so the same PDF opened from a URL, a local copy, or a dropped file resumes
// where it was left — including files opened via the picker, which have no
// source URL at all.
let docStateTimer: ReturnType<typeof setTimeout> | null = null;
function rememberDocState() {
  const identity = currentIdentity;
  if (!identity) return;
  if (docStateTimer) clearTimeout(docStateTimer);
  docStateTimer = setTimeout(() => {
    docStateTimer = null;
    if (currentIdentity !== identity) return;
    void savePdfDocRecord({
      ...identity,
      sourceUrl: currentFileUrl,
      fileName: currentFileName,
      page: pdfViewer.currentPageNumber || null,
      zoom: pdfViewer.currentScaleValue || null,
      updatedAt: Date.now(),
    });
  }, 400);
}
eventBus.on('pagesinit', rememberDocState);
eventBus.on('pagechanging', rememberDocState);
eventBus.on('scalechanging', rememberDocState);
window.addEventListener('resize', () => eventBus.dispatch('resize', { source: window }));
eventBus.on('resize', () => {
  const value = pdfViewer.currentScaleValue;
  if (value === 'auto' || value === 'page-fit' || value === 'page-width') pdfViewer.currentScaleValue = value;
});

// ─── Trackpad pinch / Ctrl+wheel zoom (Chrome viewer parity) ───
//
// Chrome reports a trackpad pinch as a `wheel` event with ctrlKey set; left
// alone it zooms the whole extension page (toolbar included). Inside the
// document area it is turned into a PDF scale change anchored at the pointer,
// exactly like Chrome's built-in viewer; anywhere else it is swallowed so the
// viewer chrome never zooms. Touchscreen pinch is handled by PDFViewer itself
// (`supportsPinchToZoom`).

const PINCH_DRAWING_DELAY_MS = 400;
let wheelTicks = 0;

document.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  if (!currentDoc || !container.contains(e.target as Node)) return;
  const origin: [number, number] = [e.clientX, e.clientY];
  // A pinch arrives as pixel deltas on the Y axis only, with small increments;
  // a mouse wheel with Ctrl held reports line/page deltas or large pixel steps.
  const scaleFactor = Math.exp(-e.deltaY / 100);
  const isPinch = e.deltaMode === WheelEvent.DOM_DELTA_PIXEL && e.deltaX === 0 && e.deltaZ === 0
    && Math.abs(scaleFactor - 1) < 0.05;
  if (isPinch) {
    pdfViewer.updateScale({ drawingDelay: PINCH_DRAWING_DELAY_MS, scaleFactor, origin });
    return;
  }
  // One mouse-wheel notch (~100-120 px, one line, or one page) ≈ one zoom step.
  const delta = e.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? e.deltaY / 100
    : e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY / 3 : e.deltaY;
  wheelTicks += -delta;
  const steps = Math.trunc(wheelTicks);
  if (steps !== 0) {
    wheelTicks -= steps;
    pdfViewer.updateScale({ drawingDelay: PINCH_DRAWING_DELAY_MS, steps, origin });
  }
}, { passive: false });

// ─── Keyboard shortcuts (Chrome viewer parity) ───

document.addEventListener('keydown', (e) => {
  if (presentation.handleKey(e)) { e.preventDefault(); return; }
  const target = e.target as HTMLElement | null;
  const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey) {
    switch (e.key.toLowerCase()) {
      case 'f': e.preventDefault(); openFindBar(); return;
      case 'g': if (!findBar.hidden) { e.preventDefault(); dispatchFind('again', e.shiftKey); } return;
      case 'p': e.preventDefault(); if (currentDoc && !isPrinting()) void printDocument(currentDoc); return;
      case 's': e.preventDefault(); void downloadCurrent(); return;
      case '=': case '+': e.preventDefault(); zoomBy(ZOOM_STEP); return;
      case '-': e.preventDefault(); zoomBy(1 / ZOOM_STEP); return;
      case '0': e.preventDefault(); pdfViewer.currentScaleValue = 'auto'; return;
      case '[': e.preventDefault(); rotate(-90); return;
      case ']': e.preventDefault(); rotate(90); return;
      case 'z': if (!typing && !e.shiftKey) { e.preventDefault(); annotate.undo(); } return;
      case 'y': if (!typing) { e.preventDefault(); annotate.redo(); } return;
      default: return;
    }
  }
  if (typing) return;
  switch (e.key) {
    case 'Home': e.preventDefault(); pdfViewer.currentPageNumber = 1; break;
    case 'End': e.preventDefault(); pdfViewer.currentPageNumber = pdfViewer.pagesCount; break;
    case 'Escape':
      if (!findBar.hidden) closeFindBar();
      else if (annotate.isOpen) annotate.toggle(false);
      break;
    default: break;
  }
});

// ─── Drag & drop ───

let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth += 1;
  dropOverlay.hidden = false;
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.hidden = true;
});
document.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  dragDepth = 0;
  dropOverlay.hidden = true;
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  e.preventDefault();
  if (file.type === 'application/pdf' || /\.pdf$/iu.test(file.name)) void loadFromFile(file);
  else showMessage('PDF 파일만 열 수 있습니다.');
});

// ─── Loading ───

function askPassword(reason: number): Promise<string | null> {
  passwordHint.textContent = reason === PASSWORD_INCORRECT
    ? '암호가 올바르지 않습니다. 다시 입력하세요.'
    : '이 문서를 열려면 암호를 입력하세요.';
  passwordInput.value = '';
  return new Promise((resolve) => {
    const finish = (value: string | null) => {
      passwordForm.onsubmit = null;
      passwordCancel.onclick = null;
      passwordDialog.onclose = null;
      if (passwordDialog.open) passwordDialog.close();
      resolve(value);
    };
    passwordForm.onsubmit = (e) => { e.preventDefault(); finish(passwordInput.value); };
    passwordCancel.onclick = () => finish(null);
    passwordDialog.onclose = () => finish(null);
    passwordDialog.showModal();
    passwordInput.focus();
  });
}

function setProgress(ratio: number | null) {
  progress.hidden = ratio === null;
  progressBar.classList.toggle('is-indeterminate', ratio !== null && !Number.isFinite(ratio));
  if (ratio !== null && Number.isFinite(ratio)) progressBar.style.width = `${Math.round(Math.min(1, ratio) * 100)}%`;
}

function openExtensionSettings() {
  chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
}

async function openDocument(task: PDFDocumentLoadingTask, label: string, bytesInfo: PdfBytesInfo | null = null): Promise<PDFDocumentProxy> {
  if (loadingTask) await loadingTask.destroy().catch(() => { /* ignore */ });
  loadingTask = task;
  const openSync = requestPdfSync('open');
  currentIdentity = null;
  pendingRestore = null;
  setProgress(Number.NaN);
  task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
    if (total > 0) { currentByteLength = total; setProgress(loaded / total); }
  };
  task.onPassword = (updatePassword: (password: string) => void, reason: number) => {
    void askPassword(reason).then((password) => {
      if (password === null) {
        showMessage('암호를 입력하지 않아 문서를 열 수 없습니다.');
        void task.destroy();
      } else {
        updatePassword(password);
      }
    });
  };
  const doc = await task.promise;
  setProgress(null);
  hideMessage();
  currentDoc = doc;
  currentFileName = /\.pdf$/iu.test(label) ? label : `${label}.pdf`;
  document.title = `${label} · ${APP_NAME}`;
  fileNameEl.textContent = label;
  // Resolve the identity before the first page renders so `pagesinit` can
  // apply the remembered position; identity failures never block opening.
  // The cloud pull started with the load; it must land before the position
  // and drawings are read so another device's work is what comes back.
  await openSync;
  try {
    currentIdentity = await derivePdfDocIdentity(doc, bytesInfo);
    pendingRestore = currentIdentity ? await loadPdfDocRecord(currentIdentity) : null;
  } catch {
    currentIdentity = null;
    pendingRestore = null;
  }
  if (loadingTask !== task) return doc; // superseded while resolving
  pdfViewer.setDocument(doc);
  linkService.setDocument(doc, null);
  void annotationCache.attach(doc, currentIdentity);
  await sidebar.setDocument(doc);
  void paperStrip.show(doc, currentFileUrl);
  void doc.getMetadata().then(({ info }) => {
    const title = (info as { Title?: unknown } | undefined)?.Title;
    if (typeof title === 'string' && title.trim()) document.title = `${title.trim()} · ${APP_NAME}`;
  }).catch(() => { /* metadata is optional */ });
  if (currentByteLength === null) {
    void doc.getData().then((data) => { currentByteLength = data.byteLength; }).catch(() => { /* optional */ });
  }
  return doc;
}

function documentOptions(): Record<string, unknown> {
  return {
    cMapUrl: extensionUrl('pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: extensionUrl('pdfjs/standard_fonts/'),
    wasmUrl: extensionUrl('pdfjs/wasm/'),
    iccUrl: extensionUrl('pdfjs/iccs/'),
    enableXfa: true,
  };
}

async function loadFromFile(file: File) {
  currentFileUrl = null;
  currentByteLength = file.size;
  openNativeBtn.hidden = true;
  fileNameEl.title = file.name;
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    // Hash before handing the buffer to PDF.js: it is transferred to the worker.
    const bytesInfo = await inspectPdfBytes(data);
    await openDocument(pdfjsLib.getDocument({ data, ...documentOptions() }), file.name, bytesInfo);
  } catch (error) {
    setProgress(null);
    showMessage(`PDF를 열지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadFromUrl(fileUrl: string) {
  currentFileUrl = fileUrl;
  currentByteLength = null;
  const isWeb = isWebPdfSourceUrl(fileUrl);
  const displayName = pdfDisplayName(fileUrl);
  fileNameEl.title = fileUrl;
  try {
    await openDocument(pdfjsLib.getDocument({ url: fileUrl, ...documentOptions() }), displayName);
  } catch (error) {
    setProgress(null);
    const message = error instanceof Error ? error.message : String(error);
    if (isWeb) {
      // Cross-origin fetch from an extension page needs host access; that is
      // the one failure a user can fix in place.
      const hostAccess = await chrome.permissions.contains({ origins: [...WEB_PDF_HOST_ORIGINS] }).catch(() => false);
      if (!hostAccess) {
        showMessage(
          `${APP_NAME}가 이 사이트에서 PDF를 받아올 권한이 없습니다. 권한을 허용하면 이 탭을 다시 불러옵니다.`,
          {
            label: '사이트 접근 권한 허용',
            onClick: () => {
              void chrome.permissions.request({ origins: [...WEB_PDF_HOST_ORIGINS] }).then((granted) => {
                if (granted) location.reload();
              });
            },
          },
        );
        return;
      }
    } else {
      // XHR to file:// is refused when the extension lacks file-URL access;
      // that is the one failure a user can fix without touching the file.
      const fileAccess = await chrome.extension.isAllowedFileSchemeAccess();
      if (!fileAccess) {
        showMessage(
          `${APP_NAME}가 로컬 파일을 읽을 수 없습니다. 확장 프로그램 설정에서 "파일 URL에 대한 액세스 허용"을 켠 뒤 이 탭을 새로고침하세요.`,
          { label: '확장 프로그램 설정 열기', onClick: openExtensionSettings },
        );
        return;
      }
    }
    showMessage(`PDF를 열지 못했습니다: ${message}`, isFramed ? undefined : {
      label: '기본 뷰어로 열기',
      onClick: () => openNativeBtn.click(),
    });
  }
}

function boot() {
  const fileUrl = parsePdfViewerFile(location.search);
  if (!fileUrl) {
    showMessage('열 PDF가 지정되지 않았습니다. PDF 파일을 이 창에 끌어다 놓거나 메뉴에서 "파일 열기…"를 선택하세요.', {
      label: '파일 열기…',
      onClick: () => openFileInput.click(),
    });
    return;
  }
  void loadFromUrl(fileUrl);
}

boot();
