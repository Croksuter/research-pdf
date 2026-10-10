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
import { debugLog, initDebugLogging } from '../shared/debugLog';
import { PDF_HUB_PAGE, WEB_PDF_HOST_ORIGINS, buildPdfHubEntryUrl, isWebPdfSourceUrl, parsePdfViewerFile, pdfDisplayName } from '../shared/localPdf';
import { HUB_AUX_FRAME_NAME, HUB_MESSAGE_TAG, hubKeyAction, parseHubToViewerMessage, sameTitle, type ViewerToHubMessage } from '../shared/pdfHubProtocol';
import { AnnotationToolbar, HIGHLIGHT_COLORS } from './pdfViewer/annotate';
import { FigureCapture } from './pdfViewer/figureCapture';
import { byId } from './pdfViewer/dom';
import { PresentationMode } from './pdfViewer/presentation';
import { isPrinting, printDocument } from './pdfViewer/print';
import { classifyPaperKind } from '../shared/paperIdentifiers';
import { PaperStrip } from './pdfViewer/paperStrip';
import { showDocumentProperties } from './pdfViewer/properties';
import { Sidebar } from './pdfViewer/sidebar';
import { derivePdfDocIdentity, inspectPdfBytes, loadPdfDocRecord, savePdfDocRecord, type PdfBytesInfo } from './pdfViewer/docState';
import { AnnotationCache } from './pdfViewer/annotationCache';
import { requestPdfSync } from './pdfViewer/syncHint';
import { readCachedPdf } from '../db/pdfFileCache';
import { cachePdfBytes, paperAliasesOf, pdfFileCacheEnabled, resolvePdfUrl, revalidateCachedPdf, type ResolvedPdfUrl } from './pdfFileFetch';
import { showAnnotationConflictDialog } from './pdfViewer/annotationConflict';
import { classifyViewerHash, type ViewerHashPlan } from './pdfViewer/openParams';
import type { PdfDocIdentity, PdfDocRecord } from '../shared/pdfIdentity';
import type { PdfLibraryUpdate } from '../shared/pdfLibrary';
import { fitTextLayerFonts, useEmbeddedFontsForText } from './pdfViewer/textLayerFonts';
import { placeTextLayerRuns } from './pdfViewer/textLayerPositions';
import { localizeDocument } from '../shared/i18n';
import { S } from './pdfViewer.strings';

localizeDocument(S);

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
const paperTitleEl = byId<HTMLSpanElement>('vt-paper-title');
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
const menuFitLabel = byId<HTMLSpanElement>('vt-menu-fit-label');
// Copies of toolbar buttons, shown in the menu when the viewer is narrow.
const menuStandIns = Array.from(document.querySelectorAll<HTMLButtonElement>('#vt-menu [data-menu-for]'));
const openNativeBtn = byId<HTMLButtonElement>('vt-open-native');
const captureBtn = byId<HTMLButtonElement>('vt-capture');
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
// The paper title the strip resolves is shown under the document's own name
// and names the document in the library. A paper found by its title alone
// only gets here with its first author on page 1 (a talk called "Deep
// Learning" is not LeCun's review).
const paperStrip = new PaperStrip(() => eventBus.dispatch('resize', { source: paperStrip }), (meta) => {
  setTitles({ paper: meta.title.trim() });
  if (currentIdentity) {
    recordInLibrary({ kind: 'meta', docId: currentIdentity.docId, docTitle: null, title: meta.title, venue: meta.venue, year: meta.year, paperKind: classifyPaperKind(meta) });
  }
});
// Figure copy: a dragged region rendered again as an image, with its source.
const figureCapture = new FigureCapture({
  container,
  pdfViewer,
  eventBus,
  getDoc: () => currentDoc,
  getSource: () => ({ meta: paperStrip.paperMeta, docTitle: paperTitle ?? docTitle }),
  onActiveChange: (active) => {
    captureBtn.classList.toggle('is-active', active);
    captureBtn.setAttribute('aria-pressed', String(active));
  },
});
captureBtn.title = S.captureTitle(/Mac/u.test(navigator.platform) ? '⌘⇧X' : 'Ctrl+Shift+X');
captureBtn.addEventListener('click', () => figureCapture.toggle());
// Drawings persist per document identity and come back on reopen; when the
// file itself also carries annotations the user resolves it in a dialog.
// Its previews scroll the document; that is not the reader moving, so no
// position is saved meanwhile and the page comes back when it closes.
const annotationCache = new AnnotationCache(eventBus, pdfViewer, async (conflict) => {
  let pageBefore: number | null = null;
  const touched = userTouched;
  holdPosition = true;
  try {
    return await showAnnotationConflictDialog(conflict, {
      preview: (pageIndex, rect) => {
        pageBefore ??= pdfViewer.currentPageNumber;
        annotationCache.flash(pageIndex, rect);
      },
    });
  } finally {
    if (pageBefore !== null && pdfViewer.currentPageNumber !== pageBefore) pdfViewer.currentPageNumber = pageBefore;
    holdPosition = false;
    userTouched = touched;
  }
});

let currentDoc: PDFDocumentProxy | null = null;
let currentFileUrl: string | null = null;
let currentFileName = 'document.pdf';
let currentLabel = 'PDF';
let currentByteLength: number | null = null;
let loadingTask: PDFDocumentLoadingTask | null = null;
// Content-derived identity of the open document (shared/pdfIdentity.ts) and
// the stored record it resolved to, applied once at `pagesinit`.
let currentIdentity: PdfDocIdentity | null = null;
let pendingRestore: PdfDocRecord | null = null;

const isFramed = window.top !== window.self;
// Framed by our own PDF hub (ui/pdfHub.ts), the one place a top-level PDF is
// shown; any other frame is a PDF embedded in a web page.
const inHub = isFramed && (() => {
  try {
    return window.parent.location.origin === location.origin && window.parent.location.pathname === `/${PDF_HUB_PAGE}`;
  } catch {
    return false;
  }
})();
// Embedded in a web page the viewer replaces only that frame; a tab-level
// "reopen natively" would navigate the whole host page away. From the hub
// the native copy opens in a tab of its own.
if (isFramed && !inHub) openNativeBtn.hidden = true;

function postToHub(message: ViewerToHubMessage) {
  if (inHub) window.parent.postMessage(message, location.origin);
}

// A second view of a document beside its tab's own (the hub's split view):
// reading the references there must not move where the document reopens.
let auxView = inHub && window.name === HUB_AUX_FRAME_NAME;
// In a split hub, pressing in a viewer brings its half in front.
if (inHub) {
  document.addEventListener('pointerdown', () => postToHub({ tag: HUB_MESSAGE_TAG, kind: 'focus' }), { capture: true, passive: true });
  window.addEventListener('focus', () => postToHub({ tag: HUB_MESSAGE_TAG, kind: 'focus' }));
}

// The hub's library (shared/pdfLibrary.ts) lists documents opened in the hub;
// PDFs embedded in web pages are not the user's reading list.
function recordInLibrary(update: PdfLibraryUpdate) {
  if (!inHub) return;
  try {
    chrome.runtime.sendMessage({ type: 'VOCAB_T_PDF_LIBRARY_UPDATE', update }, () => { void chrome.runtime.lastError; });
  } catch {
    /* the library is a convenience */
  }
}

// Two names per document: its own (file name, or the PDF's Title metadata)
// and, for a recognised paper, the detected paper title shown beneath it in
// the toolbar and the hub's tab. The browser tab title is the hub's; the
// viewer reports both names to it.
let docTitle = 'PDF';
let paperTitle: string | null = null;
function setTitles(next: { doc?: string; paper?: string | null }) {
  if (next.doc !== undefined) docTitle = next.doc;
  if (next.paper !== undefined) paperTitle = next.paper;
  const shownPaper = paperTitle && !sameTitle(paperTitle, docTitle) ? paperTitle : null;
  document.title = `${paperTitle ?? docTitle} · ${APP_NAME}`;
  fileNameEl.textContent = docTitle;
  paperTitleEl.textContent = shownPaper ?? '';
  paperTitleEl.hidden = !shownPaper;
  paperTitleEl.title = shownPaper ?? '';
  postToHub({ tag: HUB_MESSAGE_TAG, kind: 'doc', title: docTitle, paperTitle: shownPaper, docId: currentIdentity?.docId ?? null });
}

window.addEventListener('message', (event) => {
  if (!inHub || event.source !== window.parent || event.origin !== location.origin) return;
  const message = parseHubToViewerMessage(event.data);
  if (!message) return;
  if (message.kind === 'open-file') void loadFromFile(message.file);
  else if (message.kind === 'sleep') void prepareForSleep(message.id);
  else if (message.kind === 'primary') auxView = false;
  else if (currentDoc) applyViewParams(classifyViewerHash(message.hash));
});

// The hub unloads frames it has not shown for a while. Everything durable is
// stored first; a document the reader never moved in reopens at the page it
// showed (a link's `#page=`), since nothing else remembers that.
async function prepareForSleep(id: number): Promise<void> {
  const busy = presentation.active || isPrinting() || passwordDialog.open;
  let hash = '';
  if (!busy) {
    await Promise.all([flushDocState(), annotationCache.flushNow().catch(() => undefined)]);
    const page = pdfViewer.currentPageNumber;
    if (!userTouched && currentDoc && page > 1) hash = `#page=${page}`;
  }
  postToHub({ tag: HUB_MESSAGE_TAG, kind: 'sleep-reply', id, ok: !busy, hash });
}

// In the hub a newly opened local file gets its own hub tab instead of
// replacing this document.
function openLocalFiles(files: File[]) {
  if (inHub) postToHub({ tag: HUB_MESSAGE_TAG, kind: 'open-files', files });
  else if (files[0]) void loadFromFile(files[0]);
}

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
  fitToggleBtn.title = fitPage ? S.fitToWidth : S.fitToPage;
  menuFitLabel.textContent = fitToggleBtn.title;
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
  if (state === FIND_STATE_PENDING) findStatus.textContent = S.searching;
  else if (state === FIND_STATE_NOT_FOUND) findStatus.textContent = S.noMatches;
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
  if (!currentDoc) showMessage(S.noOpenPdf);
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
    showMessage(S.downloadFailed(error instanceof Error ? error.message : String(error)));
  }
}
downloadBtn.addEventListener('click', () => { void downloadCurrent(); });
printBtn.addEventListener('click', () => { const doc = ensureDoc(); if (doc) void printDocument(doc); });

/** Menu items on screen (the narrow-viewer stand-ins are hidden by CSS otherwise). */
function shownMenuItems(): HTMLButtonElement[] {
  return Array.from(menu.querySelectorAll<HTMLButtonElement>('.vt-menu-item:not([hidden])')).filter((item) => item.getClientRects().length > 0);
}

function openMenu(open: boolean) {
  if (open) for (const item of menuStandIns) item.disabled = byId<HTMLButtonElement>(item.dataset.menuFor!).disabled;
  menu.hidden = !open;
  moreBtn.setAttribute('aria-expanded', String(open));
  if (open) shownMenuItems().find((item) => !item.disabled)?.focus();
}
for (const item of menuStandIns) {
  item.addEventListener('click', () => byId<HTMLButtonElement>(item.dataset.menuFor!).click());
}
moreBtn.addEventListener('click', (e) => { e.stopPropagation(); openMenu(menu.hidden); });
document.addEventListener('click', (e) => {
  if (!menu.hidden && !menu.contains(e.target as Node)) openMenu(false);
});
menu.addEventListener('click', () => openMenu(false));
menu.addEventListener('keydown', (e) => {
  const items = shownMenuItems().filter((item) => !item.disabled);
  const idx = items.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(idx + 1) % items.length]?.focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(idx - 1 + items.length) % items.length]?.focus(); }
  else if (e.key === 'Escape') {
    // Closes the menu only: not capture mode, the find bar or the tools too.
    e.preventDefault();
    e.stopPropagation();
    openMenu(false);
    moreBtn.focus();
  }
});

menuTwoPage.addEventListener('click', () => {
  const on = pdfViewer.spreadMode !== SpreadMode.ODD;
  pdfViewer.spreadMode = on ? SpreadMode.ODD : SpreadMode.NONE;
  menuTwoPage.setAttribute('aria-checked', String(on));
});
// Hidden annotations and the drawing tools exclude each other: a pen on an
// invisible layer would draw nothing the reader can see.
function showAnnotations(show: boolean) {
  document.body.classList.toggle('vt-hide-annotations', !show);
  menuAnnotations.setAttribute('aria-checked', String(show));
}
menuAnnotations.addEventListener('click', () => {
  const show = document.body.classList.contains('vt-hide-annotations');
  showAnnotations(show);
  if (!show && annotate.isOpen) annotate.toggle(false);
});
annotate.onOpenChange = (open) => { if (open) showAnnotations(true); };
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
  openLocalFiles(Array.from(openFileInput.files ?? []));
  openFileInput.value = '';
});

// ─── Native viewer escape hatch ───

openNativeBtn.addEventListener('click', () => {
  if (!currentFileUrl) return;
  // The background records a one-shot bypass for this tab so its own
  // navigation listener does not bounce the document straight back here.
  chrome.runtime.sendMessage({ type: 'VOCAB_T_OPEN_NATIVE_PDF', url: currentFileUrl }, (response) => {
    if (chrome.runtime.lastError || !response?.success) {
      showMessage(S.openNativeFailed);
    }
  });
});

// ─── Viewer events ───

eventBus.on('pagesinit', () => {
  pdfViewer.currentScaleValue = 'auto';
  const plan = classifyViewerHash(location.hash);
  const restore = pendingRestore;
  pendingRestore = null;
  if (plan.kind === 'position') {
    // An explicit `#page=…` or destination (link, tab restore after reload)
    // wins over the remembered position.
    linkService.setHash(plan.hash);
  } else {
    // Otherwise the remembered position, then how the fragment says to show
    // it (`#zoom=` from Chrome's viewer, `#view=FitH`); `#toolbar=0` and the
    // like change nothing.
    if (restore?.zoom && !(plan.kind === 'view' && plan.setsZoom)) pdfViewer.currentScaleValue = restore.zoom;
    if (restore?.page && restore.page <= pdfViewer.pagesCount) pdfViewer.currentPageNumber = restore.page;
    applyViewParams(plan);
  }
  updatePageControls();
  syncZoomSelect();
});

/** A place goes to PDF.js's link service; view parameters apply where the reader is. */
function applyViewParams(plan: ViewerHashPlan) {
  if (plan.kind === 'position') {
    linkService.setHash(plan.hash);
  } else if (plan.kind === 'view') {
    if (plan.scale) pdfViewer.currentScaleValue = plan.scale;
    if (plan.linkHash) linkService.setHash(plan.linkHash);
  }
}
eventBus.on('pagechanging', updatePageControls);
eventBus.on('scalechanging', syncZoomSelect);

// ─── Per-document state (reading position keyed by document identity) ───
// Unlike the tab record above this is keyed by the document's own identity,
// so the same PDF opened from a URL, a local copy, or a dropped file resumes
// where it was left — including files opened via the picker, which have no
// source URL at all.
//
// Only a position the reader chose is saved: the one the viewer restored (or
// page 1 of a new document) must not be stamped "now", or it would outrank
// the newer position another device is about to deliver by sync.
let userTouched = false;
for (const type of ['pointerdown', 'keydown', 'wheel'] as const) {
  document.addEventListener(type, () => { if (currentDoc) userTouched = true; }, { capture: true, passive: true });
}
// While the annotation conflict dialog previews drawings (see above).
let holdPosition = false;
let docStateTimer: ReturnType<typeof setTimeout> | null = null;
/** The position waiting for the debounce (null once taken). */
let docStatePending: (() => PdfDocRecord | null) | null = null;
function rememberDocState() {
  const identity = currentIdentity;
  if (!identity || !userTouched || holdPosition || auxView) return;
  if (docStateTimer) clearTimeout(docStateTimer);
  docStatePending = () => (currentIdentity !== identity ? null : {
    ...identity,
    sourceUrl: currentFileUrl,
    fileName: currentFileName,
    page: pdfViewer.currentPageNumber || null,
    zoom: pdfViewer.currentScaleValue || null,
    updatedAt: Date.now(),
  });
  docStateTimer = setTimeout(() => { void flushDocState(); }, 400);
}
function takePendingDocState(): PdfDocRecord | null {
  if (docStateTimer) clearTimeout(docStateTimer);
  docStateTimer = null;
  const record = docStatePending?.() ?? null;
  docStatePending = null;
  return record;
}
/** Stores a pending position now instead of after the debounce. */
function flushDocState(): Promise<void> {
  const record = takePendingDocState();
  return record ? savePdfDocRecord(record).catch(() => undefined) : Promise.resolve();
}

// The frame is going away (its hub tab closed): a position still waiting
// for the debounce goes now. (savePdfDocRecord hands it to the background's
// serialized writer in this very task, so a removed frame still stores it.)
window.addEventListener('pagehide', () => { void flushDocState(); });
eventBus.on('pagechanging', rememberDocState);
// Selectable text: the PDF's fonts first, then every character on its glyph.
eventBus.on('textlayerrendered', (evt: { source?: { textLayer?: { div?: HTMLElement }; pdfPage?: object } }) => {
  const div = evt.source?.textLayer?.div;
  if (!div) return;
  fitTextLayerFonts(div);
  placeTextLayerRuns(div, evt.source?.pdfPage);
});
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
  const hubAction = inHub ? hubKeyAction(e) : null;
  if (hubAction) { e.preventDefault(); postToHub({ tag: HUB_MESSAGE_TAG, kind: 'key', action: hubAction }); return; }
  const target = e.target as HTMLElement | null;
  const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
  const mod = e.ctrlKey || e.metaKey;
  // Figure copy: S, or ⌘+Shift+X (Ctrl+Shift+X elsewhere). e.code: the Korean
  // layout reports ㄴ / ㅌ as the key.
  if (!typing && !e.altKey && !presentation.active
    && ((!mod && !e.shiftKey && e.code === 'KeyS') || (mod && e.shiftKey && e.code === 'KeyX'))) {
    e.preventDefault();
    figureCapture.toggle();
    return;
  }
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
      // With a tool active PDF.js handles these itself (see annotate.editing).
      case 'z': if (!typing && !annotate.editing) { e.preventDefault(); if (e.shiftKey) annotate.redo(); else annotate.undo(); } return;
      case 'y': if (!typing && !annotate.editing) { e.preventDefault(); annotate.redo(); } return;
      default: return;
    }
  }
  if (typing) return;
  switch (e.key) {
    case 'Home': e.preventDefault(); pdfViewer.currentPageNumber = 1; break;
    case 'End': e.preventDefault(); pdfViewer.currentPageNumber = pdfViewer.pagesCount; break;
    case 'Escape':
      // A selected drawing: PDF.js deselects it, and that is all Esc does.
      if (annotate.hasSelectedEditor) break;
      if (figureCapture.handleEscape()) break;
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
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length === 0) return;
  e.preventDefault();
  const pdfs = files.filter((file) => file.type === 'application/pdf' || /\.pdf$/iu.test(file.name));
  if (pdfs.length) openLocalFiles(pdfs);
  else showMessage(S.pdfOnly);
});

// ─── Loading ───

function askPassword(reason: number): Promise<string | null> {
  passwordHint.textContent = reason === PASSWORD_INCORRECT
    ? S.passwordWrong
    : S.passwordPrompt;
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

/** The reader cancelled the password prompt: nothing more to try or report. */
class PasswordCancelled extends Error {
  constructor() { super('password cancelled'); }
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
  // Local first: the Drive pull runs alongside and never delays rendering;
  // it reports which documents it changed (see onRemoteUpdate below).
  const openSync = requestPdfSync('open');
  userTouched = false;
  currentIdentity = null;
  pendingRestore = null;
  setProgress(Number.NaN);
  task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
    if (total > 0) { currentByteLength = total; setProgress(loaded / total); }
  };
  let cancelled = false;
  task.onPassword = (updatePassword: (password: string) => void, reason: number) => {
    void askPassword(reason).then((password) => {
      if (password === null) {
        cancelled = true;
        setProgress(null);
        showMessage(S.passwordCancelled);
        void task.destroy();
      } else {
        updatePassword(password);
      }
    });
  };
  let doc: PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (error) {
    throw cancelled ? new PasswordCancelled() : error;
  }
  setProgress(null);
  hideMessage();
  currentDoc = doc;
  currentFileName = /\.pdf$/iu.test(label) ? label : `${label}.pdf`;
  currentLabel = label;
  setTitles({ doc: label, paper: null });
  // Resolve the identity before the first page renders so `pagesinit` can
  // apply the remembered position; identity failures never block opening.
  try {
    currentIdentity = await derivePdfDocIdentity(doc, bytesInfo);
    pendingRestore = currentIdentity ? await loadPdfDocRecord(currentIdentity) : null;
  } catch {
    currentIdentity = null;
    pendingRestore = null;
  }
  if (loadingTask !== task) return doc; // superseded while resolving
  // Selectable text in the PDF's own fonts, so a drag selects what it covers.
  try {
    useEmbeddedFontsForText(await doc.getPage(1));
  } catch {
    /* PDF.js's generic fonts are still selectable */
  }
  if (currentIdentity) {
    setTitles({}); // tells the hub the document's identity
    recordInLibrary({ kind: 'opened', docId: currentIdentity.docId, url: currentFileUrl, fileName: currentFileName, numPages: doc.numPages });
  }
  pdfViewer.setDocument(doc);
  linkService.setDocument(doc, null);
  void annotationCache.attach(doc, currentIdentity);
  await sidebar.setDocument(doc);
  void paperStrip.show(doc, currentFileUrl);
  void doc.getMetadata().then(({ info }) => {
    const title = (info as { Title?: unknown } | undefined)?.Title;
    if (typeof title !== 'string' || !title.trim() || loadingTask !== task) return;
    setTitles({ doc: title.trim() });
    if (currentIdentity) recordInLibrary({ kind: 'meta', docId: currentIdentity.docId, docTitle: title, title: null, venue: null, year: null });
  }).catch(() => { /* metadata is optional */ });
  if (currentByteLength === null) {
    void doc.getData().then((data) => { currentByteLength = data.byteLength; }).catch(() => { /* optional */ });
  }
  void openSync.then(({ changedDocIds }) => {
    if (currentDoc === doc && currentIdentity && changedDocIds.includes(currentIdentity.docId)) void onRemoteUpdate(doc);
  });
  return doc;
}

// Another device changed this document's drawings or position while it was
// opening. Untouched, it is reopened in place from the bytes already in
// memory (no network); once the reader has started, they choose when.
async function onRemoteUpdate(doc: PDFDocumentProxy): Promise<void> {
  debugLog('viewer', 'document updated by sync', () => ({ touched: userTouched }));
  if (userTouched) {
    showMessage(S.changedElsewhere, {
      label: S.reload,
      onClick: () => { hideMessage(); void reopenInPlace(doc); },
    });
    return;
  }
  await reopenInPlace(doc);
}

async function reopenInPlace(doc: PDFDocumentProxy): Promise<void> {
  try {
    const data = await doc.getData();
    if (currentDoc !== doc) return;
    // Same identity rules as the original load: URL loads never pass byte
    // info (see docState.ts), dropped files always do.
    const bytesInfo = currentFileUrl ? null : await inspectPdfBytes(data);
    await openDocument(pdfjsLib.getDocument({ data, ...documentOptions() }), currentLabel, bytesInfo);
  } catch (error) {
    if (error instanceof PasswordCancelled) return;
    showMessage(S.reloadFailed(error instanceof Error ? error.message : String(error)));
  }
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
    if (error instanceof PasswordCancelled) return;
    showMessage(S.openFailed(error instanceof Error ? error.message : String(error)));
  }
}

// Every opened file goes to the local cache once fully loaded (PDF.js keeps
// fetching the rest in the background): a web PDF under its URL, and any
// file — local ones included — under its arXiv watermark, so that paper's
// web URLs open from it. A local file without one could never be looked up
// (local opens always read the file itself) and is not stored.
async function keepLocalCopy(fileUrl: string, doc: PDFDocumentProxy, resolved: ResolvedPdfUrl | null): Promise<void> {
  try {
    const [data, paperAliases] = await Promise.all([doc.getData(), paperAliasesOf(doc)]);
    if (currentDoc !== doc || (!resolved && paperAliases.length === 0)) return;
    await cachePdfBytes(fileUrl, data, resolved ?? undefined, paperAliases);
  } catch {
    /* the cache is an optimisation only */
  }
}

async function loadFromUrl(fileUrl: string) {
  currentFileUrl = fileUrl;
  currentByteLength = null;
  const isWeb = isWebPdfSourceUrl(fileUrl);
  const displayName = pdfDisplayName(fileUrl);
  fileNameEl.title = fileUrl;
  // First layer: this device's copy of the file, if it has one.
  // (That copy may come from a local file of the same arXiv paper.)
  const cached = isWeb && await pdfFileCacheEnabled() ? await readCachedPdf(fileUrl).catch(() => null) : null;
  if (cached) {
    try {
      currentByteLength = cached.bytes.byteLength;
      // No byte info: the identity must come out exactly as for a URL load.
      const doc = await openDocument(pdfjsLib.getDocument({ data: cached.bytes, ...documentOptions() }), displayName);
      debugLog('cache', 'opened from local copy', () => ({ url: fileUrl }));
      void revalidateCachedPdf(fileUrl, cached).then((outcome) => {
        if (outcome === 'changed' && currentDoc === doc) {
          showMessage(S.newVersion, { label: S.openNewVersion, onClick: () => location.reload() });
        }
      });
      return;
    } catch (error) {
      // The same file from the network would ask for the same password.
      if (error instanceof PasswordCancelled) return;
      debugLog('cache', 'local copy unusable, loading from the network', () => ({ error: error instanceof Error ? error.message : String(error) }));
    }
  }
  try {
    // One server for every range request (see resolvePdfUrl); the document
    // keeps its original URL everywhere else.
    const resolved = isWeb ? await resolvePdfUrl(fileUrl) : null;
    const doc = await openDocument(pdfjsLib.getDocument({ url: resolved?.finalUrl ?? fileUrl, ...documentOptions() }), displayName);
    void keepLocalCopy(fileUrl, doc, resolved);
  } catch (error) {
    setProgress(null);
    if (error instanceof PasswordCancelled) return;
    const message = error instanceof Error ? error.message : String(error);
    if (isWeb) {
      // Cross-origin fetch from an extension page needs host access; that is
      // the one failure a user can fix in place.
      const hostAccess = await chrome.permissions.contains({ origins: [...WEB_PDF_HOST_ORIGINS] }).catch(() => false);
      if (!hostAccess) {
        showMessage(
          S.noSiteAccess(APP_NAME),
          {
            label: S.allowSiteAccess,
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
      // (The toggle only unlocks what the manifest's `file:///*` host
      // permission asks for; without it every local load fails here.)
      const fileAccess = await chrome.extension.isAllowedFileSchemeAccess();
      if (!fileAccess) {
        showMessage(
          S.noFileAccess(APP_NAME),
          { label: S.openExtensionSettings, onClick: openExtensionSettings },
        );
        return;
      }
    }
    showMessage(S.openFailed(message), isFramed && !inHub ? undefined : {
      label: S.openNativeAction,
      onClick: () => openNativeBtn.click(),
    });
  }
}

function boot() {
  const fileUrl = parsePdfViewerFile(location.search);
  if (!isFramed) {
    // Top-level PDFs live in the window's hub (old tabs restored by Chrome,
    // bookmarks, links to the viewer page).
    const hubBase = extensionUrl(PDF_HUB_PAGE);
    location.replace(fileUrl ? buildPdfHubEntryUrl(fileUrl + location.hash, hubBase) : hubBase);
    return;
  }
  // A hub tab for a local file: the file arrives by postMessage.
  if (inHub && new URLSearchParams(location.search).get('hub') === 'file') return;
  if (!fileUrl) {
    showMessage(S.noPdfSpecified, {
      label: S.openFile,
      onClick: () => openFileInput.click(),
    });
    return;
  }
  if (isFramed && !inHub) {
    // Embedded in a web page. One that is nothing but this PDF (a
    // publisher's "view PDF" wrapper) hands it to the hub, which replaces
    // the page; anything smaller is read right here.
    void askToPromote(fileUrl).then((promoted) => {
      if (promoted) showMessage(S.openingInTab);
      else void loadFromUrl(fileUrl);
    });
    return;
  }
  void loadFromUrl(fileUrl);
}

function askToPromote(fileUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 1_500);
    try {
      chrome.runtime.sendMessage({ type: 'VOCAB_T_PDF_EMBED_PROMOTE', url: fileUrl, width: window.innerWidth, height: window.innerHeight }, (response?: { promoted?: boolean }) => {
        clearTimeout(timer);
        void chrome.runtime.lastError;
        resolve(response?.promoted === true);
      });
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

boot();
