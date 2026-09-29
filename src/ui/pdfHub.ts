// ─── ResearchPDF hub page ───
//
// One browser tab per window that collects every PDF the window opens, so
// papers stop scattering across tabs that look like (and mix with) web
// pages. Each document is a viewer iframe (pdf-viewer.html) behind an
// in-page tab strip; iframes are created the first time a document is
// shown, so a restored hub with twenty papers loads only the one in front,
// and frames not shown for a while are unloaded again (shared/hubTabs.ts).
//
// Left of the tabs is the home page: the library of every document the hub
// has shown (shared/pdfLibrary.ts), the pinned ones and this hub's recently
// closed tabs. Pinned documents are tabs in every hub, on every device.
//
// On load the page claims with the background (background/pdfHub.ts): it is
// either its window's hub, or it hands its documents to the existing hub and
// goes back to the page it came from (or closes). The document list lives in
// this page's own URL (history.replaceState, see shared/localPdf.ts), so a
// reload or Chrome's session restore brings every document back.

import { APP_NAME } from '../shared/brand';
import { STORE_PDF_ANNOTATIONS } from '../shared/constants';
import { initDebugLogging } from '../shared/debugLog';
import {
  HUB_IDLE_SLEEP_MS,
  arxivVersionBadges,
  findOpenDoc,
  hubDocKey,
  parseClosedTabs,
  pickTabsToSleep,
  pushClosedTab,
  type HubClosedTab,
} from '../shared/hubTabs';
import {
  PDF_HUB_MAX_DOCS,
  PDF_HUB_PAGE,
  PDF_HUB_SHOW_HOME,
  PDF_VIEWER_PAGE,
  buildPdfHubUrl,
  buildPdfViewerUrl,
  isWebPdfSourceUrl,
  parsePdfHubUrl,
  pdfDisplayName,
  type PdfHubDoc,
} from '../shared/localPdf';
import { parsePdfHubOpenMessage } from '../shared/messages';
import { PDF_DOC_STATE_STORAGE_KEY, parsePdfDocRecords, type PdfDocRecords } from '../shared/pdfIdentity';
import {
  PDF_LIBRARY_STORAGE_KEY,
  libraryEntryName,
  parsePdfLibrary,
  pinnedLibraryEntries,
  relativeTimeKo,
  searchPdfLibrary,
  type PdfLibrary,
  type PdfLibraryEntry,
  type PdfLibraryUpdate,
} from '../shared/pdfLibrary';
import {
  HUB_MESSAGE_TAG,
  hubDocumentTitle,
  hubKeyAction,
  parseViewerToHubMessage,
  sameTitle,
  type HubKeyAction,
  type HubToViewerMessage,
} from '../shared/pdfHubProtocol';
import { openDB } from '../db/database';
import { byId } from './pdfViewer/dom';
import { prefetchPdf } from './pdfFileFetch';

initDebugLogging();

interface HubTab {
  key: number;
  /** Source URL, or null for a local file opened from disk (not restorable). */
  url: string | null;
  /** Fragment to open at (`#page=3`), consumed by the next load. */
  hash: string;
  file: File | null;
  /** Handle for `file` in `localFiles`, so a closed local tab can be reopened. */
  fileId: number | null;
  title: string;
  /** Detected paper title, shown under `title`. */
  paperTitle: string | null;
  /** Identity the loaded viewer reported. */
  docId: string | null;
  /** Library row this tab stands for: its pinned row, or the row last opened from its URL. */
  libraryId: string | null;
  pinned: boolean;
  /** Unpinned from this hub: stays open even if it was never loaded. */
  keepOnUnpin: boolean;
  /** Pin as soon as the document's identity is known. */
  pendingPin: boolean;
  frame: HTMLIFrameElement | null;
  /** Prefetch into the local file cache was attempted. */
  prefetched: boolean;
  lastShownAt: number;
  /** The frame asked to stay loaded (presenting, printing) until then. */
  busyUntil: number;
  button: HTMLButtonElement;
  iconEl: HTMLSpanElement;
  titleEl: HTMLSpanElement;
  paperEl: HTMLSpanElement;
  verEl: HTMLSpanElement;
  closeEl: HTMLSpanElement;
}

const HOME = 0;
const SLEEP_CHECK_MS = 60_000;
const SLEEP_REPLY_TIMEOUT_MS = 2_000;
const BUSY_RETRY_MS = 5 * 60_000;
const TOAST_MS = 5_000;
const HOME_PAGE_SIZE = 30;
const CLOSED_STORAGE_KEY = 'rpdfClosed';

const strip = byId<HTMLElement>('rpdf-strip');
const homeBtn = byId<HTMLButtonElement>('rpdf-home-btn');
const tabList = byId<HTMLDivElement>('rpdf-tabs');
const frames = byId<HTMLElement>('rpdf-frames');
const addBtn = byId<HTMLButtonElement>('rpdf-add');
const listBtn = byId<HTMLButtonElement>('rpdf-list-btn');
const listCount = byId<HTMLSpanElement>('rpdf-list-count');
const listPanel = byId<HTMLDivElement>('rpdf-list');
const listSearch = byId<HTMLInputElement>('rpdf-list-search');
const listItems = byId<HTMLDivElement>('rpdf-list-items');
const menu = byId<HTMLDivElement>('rpdf-menu');
const fileInput = byId<HTMLInputElement>('rpdf-file-input');
const home = byId<HTMLElement>('rpdf-home');
const homeSearch = byId<HTMLInputElement>('rpdf-home-search');
const homeOpen = byId<HTMLButtonElement>('rpdf-home-open');
const homeSections = byId<HTMLDivElement>('rpdf-home-sections');
const empty = byId<HTMLDivElement>('rpdf-empty');
const emptyText = byId<HTMLParagraphElement>('rpdf-empty-text');
const toast = byId<HTMLDivElement>('rpdf-toast');
const toastText = byId<HTMLSpanElement>('rpdf-toast-text');
const toastAction = byId<HTMLButtonElement>('rpdf-toast-action');

const viewerBase = chrome.runtime.getURL(PDF_VIEWER_PAGE);
const hubBase = chrome.runtime.getURL(PDF_HUB_PAGE);

const tabs: HubTab[] = [];
let activeKey: number | null = null;
let nextKey = 1;
let myTabId: number | null = null;
// False until the claim settled: nothing is persisted while the page might
// still hand its documents away.
let isHub = false;

let nextFileId = 1;
const localFiles = new Map<number, File>();

function activeTab(): HubTab | null {
  return tabs.find((t) => t.key === activeKey) ?? null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
}

function isLocal(tab: { url: string | null; file: File | null }): boolean {
  return !!tab.file || !!tab.url?.startsWith('file:');
}

// ─── Library (read here, written by the background) ───

let library: PdfLibrary = {};
let urlToLibraryId = new Map<string, string>();
let docRecords: PdfDocRecords = {};
let annotated = new Set<string>();
// Pin changes sent but not yet seen in storage: they win over a stale read.
const pendingPins = new Map<string, boolean>();

function setLibrary(next: PdfLibrary): void {
  library = next;
  for (const [docId, pinned] of pendingPins) {
    if (!library[docId] || library[docId].pinned === pinned) pendingPins.delete(docId);
  }
  urlToLibraryId = new Map();
  for (const entry of Object.values(library).sort((a, b) => a.openedAt - b.openedAt)) {
    for (const url of entry.urls) urlToLibraryId.set(hubDocKey(url).url, entry.docId);
  }
}

function libraryView(): PdfLibrary {
  if (pendingPins.size === 0) return library;
  const view: PdfLibrary = { ...library };
  for (const [docId, pinned] of pendingPins) {
    if (view[docId]) view[docId] = { ...view[docId], pinned, pinChangedAt: Number.MAX_SAFE_INTEGER };
  }
  return view;
}

function libraryIdForUrl(url: string): string | null {
  return urlToLibraryId.get(hubDocKey(url).url) ?? null;
}

function sendLibraryUpdate(update: PdfLibraryUpdate): void {
  chrome.runtime.sendMessage({ type: 'VOCAB_T_PDF_LIBRARY_UPDATE', update }, () => { void chrome.runtime.lastError; });
}

async function loadLibraryState(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get([PDF_LIBRARY_STORAGE_KEY, PDF_DOC_STATE_STORAGE_KEY]);
    setLibrary(parsePdfLibrary(stored[PDF_LIBRARY_STORAGE_KEY]));
    docRecords = parsePdfDocRecords(stored[PDF_DOC_STATE_STORAGE_KEY]);
  } catch {
    /* an empty home page */
  }
}

async function loadAnnotated(): Promise<void> {
  try {
    const db = await openDB();
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const request = db.transaction(STORE_PDF_ANNOTATIONS, 'readonly').objectStore(STORE_PDF_ANNOTATIONS).getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    annotated = new Set(keys.filter((k): k is string => typeof k === 'string'));
  } catch {
    annotated = new Set();
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[PDF_LIBRARY_STORAGE_KEY]) {
    setLibrary(parsePdfLibrary(changes[PDF_LIBRARY_STORAGE_KEY].newValue));
    if (isHub) {
      completePendingPins();
      reconcilePinned();
    }
    scheduleHomeRender();
  }
  if (changes[PDF_DOC_STATE_STORAGE_KEY]) {
    docRecords = parsePdfDocRecords(changes[PDF_DOC_STATE_STORAGE_KEY].newValue);
    scheduleHomeRender();
  }
});

// ─── Tab strip ───

function createTab(doc: { url: string | null; hash: string; file: File | null }): HubTab {
  const key = nextKey++;
  const initialTitle = doc.file ? doc.file.name : doc.url ? pdfDisplayName(doc.url) : 'PDF';
  const button = el('button', { type: 'button', className: 'rpdf-tab', tabIndex: -1 });
  button.setAttribute('role', 'tab');
  button.dataset.key = String(key);
  const iconEl = el('span', { className: 'rpdf-tab-icon' });
  const titleEl = el('span', { className: 'rpdf-tab-title', textContent: initialTitle });
  const paperEl = el('span', { className: 'rpdf-tab-paper', hidden: true });
  const text = el('span', { className: 'rpdf-tab-text' });
  text.append(titleEl, paperEl);
  const verEl = el('span', { className: 'rpdf-tab-ver', hidden: true });
  const closeEl = el('span', { className: 'rpdf-tab-close', title: '닫기 (Alt+W)' });
  closeEl.setAttribute('role', 'button');
  closeEl.setAttribute('aria-label', '이 PDF 닫기');
  closeEl.append(icon('i-close'));
  button.append(iconEl, text, verEl, closeEl);
  let fileId: number | null = null;
  if (doc.file) {
    fileId = nextFileId++;
    localFiles.set(fileId, doc.file);
  }
  const tab: HubTab = {
    key, url: doc.url, hash: doc.hash, file: doc.file, fileId,
    title: initialTitle, paperTitle: null, docId: null, libraryId: doc.url ? libraryIdForUrl(doc.url) : null,
    pinned: false, keepOnUnpin: false, pendingPin: false,
    frame: null, prefetched: false, lastShownAt: 0, busyUntil: 0,
    button, iconEl, titleEl, paperEl, verEl, closeEl,
  };
  // Names the library already knows, until the viewer reports its own.
  const known = tab.libraryId ? library[tab.libraryId] : undefined;
  if (known?.docTitle) tab.title = known.docTitle;
  if (known?.title && !sameTitle(known.title, tab.title)) tab.paperTitle = known.title;
  updateTabLabel(tab);
  button.addEventListener('click', (e) => {
    if ((e.target as Element).closest('.rpdf-tab-close')) closeTab(key);
    else activate(key);
  });
  button.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(key); } });
  button.addEventListener('contextmenu', (e) => { e.preventDefault(); showTabMenu(tab, e.clientX, e.clientY); });
  wireDrag(tab);
  return tab;
}

function updateTabLabel(tab: HubTab): void {
  // A pinned tab is narrow: one line, the best name.
  tab.titleEl.textContent = tab.pinned ? tab.paperTitle ?? tab.title : tab.title;
  tab.paperEl.textContent = tab.paperTitle ?? '';
  tab.paperEl.hidden = tab.pinned || !tab.paperTitle;
  tab.button.classList.toggle('has-paper', !tab.pinned && !!tab.paperTitle);
  tab.button.classList.toggle('is-pinned', tab.pinned);
  tab.button.classList.toggle('is-unloaded', !tab.frame);
  tab.button.draggable = !tab.pinned;
  tab.closeEl.hidden = tab.pinned;
  tab.iconEl.replaceChildren(icon(tab.pinned ? 'i-pin' : isLocal(tab) ? 'i-file-local' : 'i-file'));
  tab.button.title = [tab.paperTitle, tab.title, tab.url, tab.pinned ? '고정됨 · 우클릭해 고정 해제' : null]
    .filter(Boolean).filter((v, i, all) => all.indexOf(v) === i).join('\n');
  if (tab.frame) tab.frame.title = tab.paperTitle ?? tab.title;
}

function pinnedCount(): number {
  return tabs.filter((t) => t.pinned).length;
}

function insertTab(tab: HubTab, index: number): void {
  const at = Math.min(Math.max(index, tab.pinned ? 0 : pinnedCount()), tabs.length);
  tabs.splice(at, 0, tab);
  tabList.insertBefore(tab.button, tabs[at + 1]?.button ?? null);
}

function addDocs(docs: Array<{ url: string | null; hash: string; file: File | null }>, activateLast: boolean, autoActivate = true, at?: number): void {
  let last: HubTab | null = null;
  let insertAt = at;
  for (const doc of docs) {
    const index = doc.url ? findOpenDoc(doc.url, tabs.map((t) => ({ url: t.url, docId: t.docId ?? t.libraryId })), libraryIdForUrl) : -1;
    if (index >= 0) {
      const existing = tabs[index];
      if (doc.hash) {
        if (existing.frame) postToFrame(existing, { tag: HUB_MESSAGE_TAG, kind: 'hash', hash: doc.hash });
        else existing.hash = doc.hash;
      }
      last = existing;
      continue;
    }
    if (tabs.length - pinnedCount() >= PDF_HUB_MAX_DOCS) {
      showToast(`한 창에는 PDF를 ${PDF_HUB_MAX_DOCS}개까지 열 수 있습니다.`);
      break;
    }
    const tab = createTab(doc);
    insertTab(tab, insertAt ?? tabs.length);
    if (insertAt !== undefined) insertAt += 1;
    last = tab;
  }
  if (last && (activateLast || (autoActivate && activeKey === null))) activate(last.key);
  render();
  void queuePrefetch();
}

function removeTab(tab: HubTab): void {
  const index = tabs.indexOf(tab);
  if (index < 0) return;
  tabs.splice(index, 1);
  tab.frame?.remove();
  tab.frame = null;
  tab.button.remove();
  if (activeKey === tab.key) {
    activeKey = null;
    const neighbor = tabs[index] ?? tabs[index - 1];
    if (neighbor) activate(neighbor.key);
    else showHome(false);
  }
}

// ─── Prefetch ───
//
// Documents behind other tabs (restored with the hub, pinned, opened in the
// background) are downloaded into the local file cache while idle, one at a
// time, so switching to them renders from disk.
let prefetching = false;
async function queuePrefetch(): Promise<void> {
  if (prefetching) return;
  prefetching = true;
  try {
    for (;;) {
      const next = tabs.find((t) => t.url && !t.frame && !t.prefetched && isWebPdfSourceUrl(t.url));
      if (!next?.url) break;
      next.prefetched = true;
      await new Promise<void>((resolve) => { requestIdleCallback(() => resolve(), { timeout: 2_000 }); });
      if (!next.frame) await prefetchPdf(next.url).catch(() => false);
    }
  } finally {
    prefetching = false;
  }
}

// ─── Frames ───

function frameUrl(tab: HubTab): string {
  if (!tab.url) return `${viewerBase}?hub=file`;
  return buildPdfViewerUrl(tab.url + tab.hash, viewerBase);
}

function ensureFrame(tab: HubTab): HTMLIFrameElement {
  if (tab.frame) return tab.frame;
  const frame = el('iframe', { title: tab.paperTitle ?? tab.title });
  // Presentation mode and BibTeX copy run inside the frame.
  frame.allow = 'fullscreen; clipboard-write';
  frame.hidden = tab.key !== activeKey;
  frame.src = frameUrl(tab);
  tab.hash = '';
  if (tab.file) {
    const file = tab.file;
    frame.addEventListener('load', () => postToFrame(tab, { tag: HUB_MESSAGE_TAG, kind: 'open-file', file }), { once: true });
  }
  frames.append(frame);
  tab.frame = frame;
  updateTabLabel(tab);
  return frame;
}

function postToFrame(tab: HubTab, message: HubToViewerMessage): void {
  tab.frame?.contentWindow?.postMessage(message, location.origin);
}

function activate(key: number): void {
  if (key === HOME) { showHome(true); return; }
  const tab = tabs.find((t) => t.key === key);
  if (!tab) return;
  const now = Date.now();
  const previous = activeTab();
  if (previous) previous.lastShownAt = now;
  activeKey = key;
  tab.lastShownAt = now;
  const frame = ensureFrame(tab);
  for (const t of tabs) {
    const on = t.key === key;
    t.button.setAttribute('aria-selected', String(on));
    t.button.tabIndex = on ? 0 : -1;
    if (t.frame) t.frame.hidden = !on;
  }
  home.hidden = true;
  homeBtn.setAttribute('aria-pressed', 'false');
  tab.button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  frame.focus();
  render();
  void enforceSleep();
}

function showHome(focusSearch: boolean): void {
  const previous = activeTab();
  if (previous) previous.lastShownAt = Date.now();
  activeKey = HOME;
  for (const t of tabs) {
    t.button.setAttribute('aria-selected', 'false');
    t.button.tabIndex = -1;
    if (t.frame) t.frame.hidden = true;
  }
  home.hidden = false;
  homeBtn.setAttribute('aria-pressed', 'true');
  homeLimit = HOME_PAGE_SIZE;
  renderHome();
  void loadAnnotated().then(() => scheduleHomeRender());
  if (focusSearch) homeSearch.focus();
  render();
}

function closeTab(key: number, remember = true): void {
  const tab = tabs.find((t) => t.key === key);
  if (!tab) return;
  if (tab.pinned) {
    showToast('고정된 탭입니다. 우클릭해 고정을 해제하면 닫을 수 있습니다.');
    return;
  }
  const index = tabs.indexOf(tab);
  removeTab(tab);
  if (remember && (tab.url || tab.fileId !== null)) {
    const entry: HubClosedTab = {
      url: tab.url,
      fileId: tab.url ? null : tab.fileId,
      title: tab.title,
      paperTitle: tab.paperTitle,
      index,
      closedAt: Date.now(),
    };
    setClosed(pushClosedTab(closed, entry));
    showToast('탭을 닫았습니다.', { label: '되돌리기 (Alt+Shift+T)', run: () => reopenClosed(entry) });
  }
  render();
}

function step(action: HubKeyAction): void {
  if (action === 'close') {
    if (activeKey !== null && activeKey !== HOME) closeTab(activeKey);
    return;
  }
  if (action === 'reopen') { reopenClosed(); return; }
  if (tabs.length === 0) return;
  if (activeKey === HOME || activeKey === null) {
    activate((action === 'next' ? tabs[0] : tabs[tabs.length - 1]).key);
    return;
  }
  if (tabs.length < 2) return;
  const index = tabs.findIndex((t) => t.key === activeKey);
  const next = tabs[(index + (action === 'next' ? 1 : -1) + tabs.length) % tabs.length];
  activate(next.key);
}

// Drag to reorder within the strip (unpinned tabs; pins keep pin order).
let dragKey: number | null = null;
function wireDrag(tab: HubTab): void {
  const { button } = tab;
  const dragged = () => tabs.find((t) => t.key === dragKey);
  button.addEventListener('dragstart', (e) => {
    dragKey = tab.key;
    button.classList.add('is-dragging');
    e.dataTransfer?.setData('text/plain', tab.url ?? tab.title);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  button.addEventListener('dragend', () => {
    dragKey = null;
    button.classList.remove('is-dragging');
    for (const t of tabs) t.button.classList.remove('is-drop-before');
  });
  button.addEventListener('dragover', (e) => {
    if (dragKey === null || dragKey === tab.key || tab.pinned) return;
    e.preventDefault();
    for (const t of tabs) t.button.classList.toggle('is-drop-before', t === tab);
  });
  button.addEventListener('drop', (e) => {
    const moved = dragged();
    if (!moved || moved === tab || tab.pinned) return;
    e.preventDefault();
    tabs.splice(tabs.indexOf(moved), 1);
    tabs.splice(tabs.indexOf(tab), 0, moved);
    tabList.insertBefore(moved.button, tab.button);
    tab.button.classList.remove('is-drop-before');
    render();
  });
}

// ─── Pins ───

/** Makes the strip match the library's pinned rows (this and every other hub). */
function reconcilePinned(): void {
  const pinned = pinnedLibraryEntries(libraryView()).filter((e) => e.urls.length > 0);
  const wanted = new Set(pinned.map((e) => e.docId));
  for (const tab of [...tabs]) {
    if (!tab.pinned || (tab.libraryId && wanted.has(tab.libraryId))) continue;
    tab.pinned = false;
    // Unpinned elsewhere, never opened here: it only existed as a pin.
    if (!tab.keepOnUnpin && !tab.frame && tab.key !== activeKey) removeTab(tab);
    else updateTabLabel(tab);
    tab.keepOnUnpin = false;
  }
  for (const entry of pinned) {
    let tab = tabs.find((t) => t.libraryId === entry.docId || t.docId === entry.docId)
      ?? tabs.find((t) => t.url !== null && entry.urls.some((u) => hubDocKey(u).url === hubDocKey(t.url as string).url));
    if (!tab) {
      tab = createTab({ url: entry.urls[0], hash: '', file: null });
      tab.pinned = true;
      insertTab(tab, pinnedCount());
    }
    tab.libraryId = entry.docId;
    tab.pinned = true;
    if (!tab.frame && entry.title && !tab.paperTitle) tab.paperTitle = entry.title;
    updateTabLabel(tab);
  }
  // Pinned tabs first, in pin order; the rest keep their order.
  const pinnedTabs = pinned
    .map((e) => tabs.find((t) => t.pinned && t.libraryId === e.docId))
    .filter((t): t is HubTab => !!t);
  const ordered = [...pinnedTabs, ...tabs.filter((t) => !pinnedTabs.includes(t))];
  if (ordered.some((t, i) => tabs[i] !== t)) {
    tabs.splice(0, tabs.length, ...ordered);
    for (const t of ordered) tabList.append(t.button);
  }
  render();
}

function setPinnedById(docId: string, pinned: boolean): void {
  if (!library[docId]) return;
  pendingPins.set(docId, pinned);
  sendLibraryUpdate({ kind: 'pin', docId, pinned });
  reconcilePinned();
  scheduleHomeRender();
}

function setPinned(tab: HubTab, pinned: boolean): void {
  const docId = tab.docId ?? tab.libraryId ?? (tab.url ? libraryIdForUrl(tab.url) : null);
  if (pinned && !tab.url) {
    // A file opened from disk has no address to reopen it from in another hub.
    if (docId && library[docId]) setPinnedById(docId, true);
    showToast('로컬 파일은 홈의 고정 목록에만 표시됩니다.');
    return;
  }
  if (!docId || !library[docId]) {
    if (!pinned) return;
    // Not opened yet: load it (in the background) and pin once it is known.
    tab.pendingPin = true;
    ensureFrame(tab);
    showToast('문서를 불러온 뒤 고정합니다.');
    return;
  }
  tab.libraryId = docId;
  if (!pinned) tab.keepOnUnpin = true;
  setPinnedById(docId, pinned);
}

function completePendingPins(): void {
  for (const tab of tabs) {
    if (!tab.pendingPin || !tab.docId || !library[tab.docId]) continue;
    tab.pendingPin = false;
    setPinned(tab, true);
  }
}

// ─── Recently closed (this hub; survives a reload) ───

let closed: HubClosedTab[] = (() => {
  try {
    return parseClosedTabs(JSON.parse(sessionStorage.getItem(CLOSED_STORAGE_KEY) ?? '[]'))
      .filter((e) => e.fileId === null); // local files do not survive a reload
  } catch {
    return [];
  }
})();

function setClosed(next: HubClosedTab[]): void {
  closed = next;
  try {
    sessionStorage.setItem(CLOSED_STORAGE_KEY, JSON.stringify(closed));
  } catch {
    /* kept in memory */
  }
  if (!listPanel.hidden) renderList();
  scheduleHomeRender();
}

function reopenClosed(entry: HubClosedTab | undefined = closed[0]): void {
  if (!entry) { showToast('다시 열 탭이 없습니다.'); return; }
  setClosed(closed.filter((e) => e !== entry));
  hideToast();
  if (entry.url) {
    addDocs([{ url: entry.url, hash: '', file: null }], true, true, entry.index);
    return;
  }
  const file = entry.fileId !== null ? localFiles.get(entry.fileId) : undefined;
  if (file) addDocs([{ url: null, hash: '', file }], true, true, entry.index);
  else reopenClosed(closed[0]);
}

// ─── Title, URL, restore record ───

let stateTimer: ReturnType<typeof setTimeout> | null = null;

function render(): void {
  const current = activeTab();
  const name = activeKey === HOME ? '홈' : current?.paperTitle ?? current?.title ?? 'PDF';
  document.title = hubDocumentTitle(name, tabs.length, APP_NAME);
  listCount.textContent = tabs.length ? String(tabs.length) : '';
  const badges = arxivVersionBadges(tabs.map((t) => t.url));
  tabs.forEach((t, i) => {
    t.verEl.textContent = badges[i] ?? '';
    t.verEl.hidden = !badges[i];
  });
  updateOverflow();
  if (!isHub) return;
  const urlTabs = tabs.filter((t): t is HubTab & { url: string } => t.url !== null && !t.pinned);
  const urls = urlTabs.map((t) => t.url);
  const active = Math.max(0, urlTabs.findIndex((t) => t.key === activeKey));
  const show = activeKey === HOME ? PDF_HUB_SHOW_HOME : current?.pinned ? current.url : null;
  const canonical = buildPdfHubUrl(urls, active, hubBase, show);
  if (location.href !== canonical) history.replaceState(null, '', canonical);
  if (stateTimer) clearTimeout(stateTimer);
  stateTimer = setTimeout(() => {
    stateTimer = null;
    chrome.runtime.sendMessage({ type: 'VOCAB_T_PDF_HUB_STATE', urls, active }, () => { void chrome.runtime.lastError; });
  }, 400);
}

// ─── Overflow: scroll fades, wheel scrolling, the tab list ───

const NARROW_TAB_PX = 150;

function updateOverflow(): void {
  const { scrollLeft, scrollWidth, clientWidth } = tabList;
  tabList.classList.toggle('fade-left', scrollLeft > 1);
  tabList.classList.toggle('fade-right', scrollLeft + clientWidth < scrollWidth - 1);
  // Squeezed tabs drop the paper line (they all share one width).
  const sample = tabs.find((t) => !t.pinned)?.button;
  tabList.classList.toggle('is-narrow', !!sample && sample.getBoundingClientRect().width < NARROW_TAB_PX);
}
tabList.addEventListener('scroll', updateOverflow, { passive: true });
new ResizeObserver(updateOverflow).observe(tabList);
tabList.addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || tabList.scrollWidth <= tabList.clientWidth) return;
  e.preventDefault();
  tabList.scrollLeft += e.deltaY;
}, { passive: false });

function tabName(tab: HubTab): string {
  return tab.paperTitle ?? tab.title;
}

function renderList(): void {
  const words = listSearch.value.toLowerCase().split(/\s+/u).filter(Boolean);
  const matches = (...fields: Array<string | null>) => {
    const hay = fields.filter(Boolean).join('\n').toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  listItems.replaceChildren();
  const open = tabs.filter((t) => matches(t.title, t.paperTitle, t.url));
  for (const tab of open) {
    const row = el('div', { className: 'rpdf-li' });
    row.classList.toggle('is-active', tab.key === activeKey);
    const main = el('button', { type: 'button', className: 'rpdf-li-main' });
    const text = el('span', { className: 'rpdf-li-text' });
    text.append(el('span', { className: 'rpdf-li-title', textContent: tabName(tab) }));
    if (tab.paperTitle && tab.title !== tab.paperTitle) text.append(el('span', { className: 'rpdf-li-sub', textContent: tab.title }));
    main.append(icon(tab.pinned ? 'i-pin' : isLocal(tab) ? 'i-file-local' : 'i-file'), text);
    main.addEventListener('click', () => { hideList(); activate(tab.key); });
    row.append(main);
    if (!tab.pinned) {
      const close = el('button', { type: 'button', className: 'rpdf-li-action', title: '닫기' });
      close.setAttribute('aria-label', `${tabName(tab)} 닫기`);
      close.append(icon('i-close'));
      close.addEventListener('click', () => { closeTab(tab.key); renderList(); });
      row.append(close);
    }
    listItems.append(row);
  }
  if (open.length === 0) listItems.append(el('p', { className: 'rpdf-li-empty', textContent: words.length ? '일치하는 탭이 없습니다.' : '열린 탭이 없습니다.' }));
  const recent = closed.filter((e) => matches(e.title, e.paperTitle, e.url));
  if (recent.length) {
    listItems.append(el('h3', { className: 'rpdf-li-head', textContent: '최근 닫은 탭' }));
    for (const entry of recent.slice(0, 10)) {
      const main = el('button', { type: 'button', className: 'rpdf-li-main' });
      const text = el('span', { className: 'rpdf-li-text' });
      text.append(
        el('span', { className: 'rpdf-li-title', textContent: entry.paperTitle ?? entry.title }),
        el('span', { className: 'rpdf-li-sub', textContent: `${relativeTimeKo(entry.closedAt)} 닫음` }),
      );
      main.append(icon('i-restore'), text);
      main.addEventListener('click', () => { hideList(); reopenClosed(entry); });
      const row = el('div', { className: 'rpdf-li' });
      row.append(main);
      listItems.append(row);
    }
  }
}

function showList(): void {
  hideMenu();
  listPanel.hidden = false;
  listBtn.setAttribute('aria-expanded', 'true');
  listSearch.value = '';
  renderList();
  listSearch.focus();
}

function hideList(): void {
  if (listPanel.hidden) return;
  listPanel.hidden = true;
  listBtn.setAttribute('aria-expanded', 'false');
}

listBtn.addEventListener('click', () => { if (listPanel.hidden) showList(); else hideList(); });
listSearch.addEventListener('input', renderList);
listPanel.addEventListener('keydown', (e) => {
  const items = Array.from(listItems.querySelectorAll<HTMLButtonElement>('.rpdf-li-main'));
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? index + 1 : index <= 0 ? -1 : index - 1;
    if (next < 0) listSearch.focus();
    else items[Math.min(next, items.length - 1)]?.focus();
  } else if (e.key === 'Enter' && document.activeElement === listSearch) {
    e.preventDefault();
    items[0]?.click();
  }
});

// ─── Tab context menu ───

function showTabMenu(tab: HubTab, x: number, y: number): void {
  hideList();
  menu.replaceChildren();
  const item = (label: string, run: () => void, disabled = false) => {
    const button = el('button', { type: 'button', className: 'rpdf-menu-item', textContent: label, disabled });
    button.setAttribute('role', 'menuitem');
    button.addEventListener('click', () => { hideMenu(); run(); });
    menu.append(button);
  };
  item(tab.pinned ? '고정 해제' : '고정', () => setPinned(tab, !tab.pinned));
  if (tab.url) {
    const url = tab.url;
    item('주소 복사', () => {
      void navigator.clipboard.writeText(url).then(() => showToast('주소를 복사했습니다.'), () => showToast('주소를 복사하지 못했습니다.'));
    });
  }
  menu.append(el('hr'));
  item('닫기', () => closeTab(tab.key), tab.pinned);
  const others = tabs.filter((t) => t !== tab && !t.pinned);
  item('다른 탭 모두 닫기', () => { for (const t of others) closeTab(t.key); }, others.length === 0);
  menu.hidden = false;
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - height - 8)}px`;
  menu.querySelector<HTMLButtonElement>('.rpdf-menu-item:not(:disabled)')?.focus();
}

function hideMenu(): void {
  menu.hidden = true;
}

menu.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('.rpdf-menu-item:not(:disabled)'));
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  items[(index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
});

// Clicking anywhere else, or into a document (the hub window loses focus).
document.addEventListener('pointerdown', (e) => {
  const target = e.target as Node;
  if (!menu.hidden && !menu.contains(target)) hideMenu();
  if (!listPanel.hidden && !listPanel.contains(target) && !listBtn.contains(target)) hideList();
}, true);
window.addEventListener('blur', () => { hideMenu(); hideList(); });

// ─── Toast ───

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(message: string, action?: { label: string; run: () => void }): void {
  toastText.textContent = message;
  toastAction.hidden = !action;
  toastAction.textContent = action?.label ?? '';
  toastAction.onclick = action ? () => { hideToast(); action.run(); } : null;
  toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, TOAST_MS);
}

function hideToast(): void {
  toast.hidden = true;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
}

// ─── Home: the library ───

let homeLimit = HOME_PAGE_SIZE;
let homeRenderQueued = false;

function scheduleHomeRender(): void {
  if (activeKey !== HOME || homeRenderQueued) return;
  homeRenderQueued = true;
  requestAnimationFrame(() => {
    homeRenderQueued = false;
    if (activeKey === HOME) renderHome();
  });
}

function entryName(entry: PdfLibraryEntry): string {
  return libraryEntryName(entry, pdfDisplayName);
}

function entrySource(entry: PdfLibraryEntry): string {
  const url = entry.urls[0];
  if (!url || url.startsWith('file:')) return '로컬 파일';
  try {
    return new URL(url).hostname.replace(/^www\./u, '');
  } catch {
    return '';
  }
}

function openTabFor(docId: string): HubTab | undefined {
  return tabs.find((t) => (t.docId ?? t.libraryId) === docId);
}

function openEntry(entry: PdfLibraryEntry): void {
  const existing = openTabFor(entry.docId);
  if (existing) { activate(existing.key); return; }
  const url = entry.urls[0];
  if (!url) {
    showToast('컴퓨터의 파일에서 연 PDF입니다. 파일을 다시 선택하세요.');
    fileInput.click();
    return;
  }
  addDocs([{ url, hash: '', file: null }], true);
}

function homeRow(entry: PdfLibraryEntry): HTMLElement {
  const pinned = libraryView()[entry.docId]?.pinned ?? entry.pinned;
  const row = el('li', { className: 'rpdf-item' });
  const main = el('button', { type: 'button', className: 'rpdf-item-main' });
  main.title = [entry.title, entry.docTitle, entry.fileName, ...entry.urls].filter(Boolean).filter((v, i, all) => all.indexOf(v) === i).join('\n');
  const text = el('span', { className: 'rpdf-item-text' });
  text.append(el('span', { className: 'rpdf-item-title', textContent: entryName(entry) }));
  const record = docRecords[entry.docId];
  const page = record?.page ?? null;
  const meta = [
    [entry.venue, entry.year].filter(Boolean).join(' '),
    entrySource(entry),
    relativeTimeKo(entry.openedAt),
    page ? `${page} / ${entry.numPages}쪽` : `${entry.numPages}쪽`,
  ].filter(Boolean).join(' · ');
  text.append(el('span', { className: 'rpdf-item-meta', textContent: meta }));
  main.append(icon(entry.urls[0] && !entry.urls[0].startsWith('file:') ? 'i-file' : 'i-file-local'), text);
  const badges = el('span', { className: 'rpdf-item-badges' });
  if (annotated.has(entry.docId)) {
    const pen = el('span', { className: 'rpdf-badge', title: '필기 있음' });
    pen.append(icon('i-pen'));
    badges.append(pen);
  }
  if (openTabFor(entry.docId)) badges.append(el('span', { className: 'rpdf-badge rpdf-badge-open', textContent: '열림' }));
  main.append(badges);
  main.addEventListener('click', () => openEntry(entry));
  const pin = el('button', { type: 'button', className: 'rpdf-item-pin', title: pinned ? '고정 해제' : '고정 — 모든 PDF 탭 왼쪽에 둡니다' });
  pin.setAttribute('aria-pressed', String(pinned));
  pin.setAttribute('aria-label', pinned ? `${entryName(entry)} 고정 해제` : `${entryName(entry)} 고정`);
  pin.append(icon('i-pin'));
  pin.addEventListener('click', () => setPinnedById(entry.docId, !pinned));
  row.append(main, pin);
  if (page && entry.numPages > 1) {
    const bar = el('span', { className: 'rpdf-item-progress' });
    const fill = el('span');
    fill.style.width = `${Math.round(Math.min(1, page / entry.numPages) * 100)}%`;
    bar.append(fill);
    row.append(bar);
  }
  return row;
}

function homeSection(title: string, rows: HTMLElement[], extra?: HTMLElement): HTMLElement {
  const section = el('section', { className: 'rpdf-home-section' });
  section.append(el('h2', { textContent: title }));
  const list = el('ul', { className: 'rpdf-items' });
  list.append(...rows);
  section.append(list);
  if (extra) section.append(extra);
  return section;
}

function renderHome(): void {
  const view = libraryView();
  const entries = Object.values(view);
  const query = homeSearch.value.trim();
  const sections: HTMLElement[] = [];
  if (query) {
    const found = searchPdfLibrary(entries, query);
    sections.push(found.length
      ? homeSection(`검색 결과 ${found.length}개`, found.slice(0, 100).map(homeRow))
      : el('p', { className: 'rpdf-home-empty', textContent: '일치하는 PDF가 없습니다.' }));
  } else {
    const pinned = pinnedLibraryEntries(view);
    if (pinned.length) sections.push(homeSection('고정됨', pinned.map(homeRow)));
    if (closed.length) {
      const rows = closed.slice(0, 6).map((entry) => {
        const row = el('li', { className: 'rpdf-item' });
        const main = el('button', { type: 'button', className: 'rpdf-item-main' });
        const text = el('span', { className: 'rpdf-item-text' });
        text.append(
          el('span', { className: 'rpdf-item-title', textContent: entry.paperTitle ?? entry.title }),
          el('span', { className: 'rpdf-item-meta', textContent: `${relativeTimeKo(entry.closedAt)} 닫음` }),
        );
        main.append(icon('i-restore'), text);
        main.addEventListener('click', () => reopenClosed(entry));
        row.append(main);
        return row;
      });
      sections.push(homeSection('최근 닫은 탭', rows));
    }
    const recent = searchPdfLibrary(entries.filter((e) => !e.pinned), '');
    if (recent.length) {
      let more: HTMLElement | undefined;
      if (recent.length > homeLimit) {
        more = el('button', { type: 'button', className: 'rpdf-more', textContent: `더 보기 (${recent.length - homeLimit}개 더)` });
        more.addEventListener('click', () => { homeLimit += HOME_PAGE_SIZE; renderHome(); });
      }
      sections.push(homeSection('이어 읽기', recent.slice(0, homeLimit).map(homeRow), more));
    }
    if (sections.length === 0) {
      sections.push(el('p', {
        className: 'rpdf-home-empty',
        textContent: '아직 연 PDF가 없습니다. 웹에서 PDF를 열거나, 파일을 이 창에 끌어다 놓으세요. 연 PDF는 여기에 모이고, 고정한 PDF는 모든 창의 PDF 탭 왼쪽에 놓입니다.',
      }));
    }
  }
  homeSections.replaceChildren(...sections);
}

homeBtn.addEventListener('click', () => showHome(true));
homeOpen.addEventListener('click', () => fileInput.click());
let homeSearchTimer: ReturnType<typeof setTimeout> | null = null;
homeSearch.addEventListener('input', () => {
  if (homeSearchTimer) clearTimeout(homeSearchTimer);
  homeSearchTimer = setTimeout(() => { homeLimit = HOME_PAGE_SIZE; renderHome(); }, 80);
});
homeSearch.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  homeSections.querySelector<HTMLButtonElement>('.rpdf-item-main')?.click();
});

// ─── Sleeping frames ───
//
// Every loaded viewer holds its rendered pages and PDF.js worker. Frames not
// shown for a while (or beyond a handful) are unloaded after they stored
// everything; the tab stays, and switching back reloads it from the local
// file cache.

let sleepSeq = 0;
const sleepWaiters = new Map<number, (reply: { ok: boolean; hash: string }) => void>();
let sleeping = false;

async function sleepTab(tab: HubTab): Promise<void> {
  if (!tab.frame || tab.key === activeKey) return;
  const id = ++sleepSeq;
  const reply = await new Promise<{ ok: boolean; hash: string }>((resolve) => {
    sleepWaiters.set(id, resolve);
    postToFrame(tab, { tag: HUB_MESSAGE_TAG, kind: 'sleep', id });
    // A frame that does not answer (still loading, hung) is unloaded anyway;
    // its drawings are also stored on unload.
    setTimeout(() => resolve({ ok: true, hash: '' }), SLEEP_REPLY_TIMEOUT_MS);
  });
  sleepWaiters.delete(id);
  if (!tab.frame || tab.key === activeKey || !tabs.includes(tab)) return;
  if (!reply.ok) { tab.busyUntil = Date.now() + BUSY_RETRY_MS; return; }
  tab.frame.remove();
  tab.frame = null;
  tab.hash = reply.hash;
  updateTabLabel(tab);
}

async function enforceSleep(): Promise<void> {
  if (sleeping) return;
  sleeping = true;
  try {
    const now = Date.now();
    const keys = pickTabsToSleep(tabs.map((t) => ({
      key: t.key,
      loaded: !!t.frame,
      active: t.key === activeKey,
      lastShownAt: t.lastShownAt,
      busyUntil: t.busyUntil,
    })), now);
    for (const key of keys) {
      const tab = tabs.find((t) => t.key === key);
      if (tab) await sleepTab(tab);
    }
  } finally {
    sleeping = false;
  }
}
setInterval(() => { void enforceSleep(); }, Math.min(SLEEP_CHECK_MS, HUB_IDLE_SLEEP_MS));

// ─── Messages from viewer frames ───

function mergeTwins(reporter: HubTab, twin: HubTab): void {
  const keep = reporter.pinned && !twin.pinned ? reporter : twin;
  const drop = keep === reporter ? twin : reporter;
  const wasShown = activeKey === drop.key || activeKey === keep.key;
  if (activeKey === drop.key) activeKey = null;
  removeTab(drop);
  if (wasShown) activate(keep.key);
  showToast('이미 열려 있는 문서라 그 탭으로 합쳤습니다.');
  render();
}

window.addEventListener('message', (event) => {
  if (event.origin !== location.origin) return;
  const tab = tabs.find((t) => t.frame?.contentWindow === event.source);
  if (!tab) return;
  const message = parseViewerToHubMessage(event.data);
  if (!message) return;
  if (message.kind === 'doc') {
    tab.title = message.title;
    tab.paperTitle = message.paperTitle;
    if (message.docId && message.docId !== tab.docId) {
      tab.docId = message.docId;
      if (!tab.pinned) tab.libraryId = message.docId;
      const twin = tabs.find((t) => t !== tab && (t.docId ?? t.libraryId) === message.docId);
      if (twin) { mergeTwins(tab, twin); return; }
      completePendingPins();
    }
    updateTabLabel(tab);
    render();
  } else if (message.kind === 'key') {
    step(message.action);
  } else if (message.kind === 'sleep-reply') {
    sleepWaiters.get(message.id)?.(message);
  } else {
    openFiles(message.files);
  }
});

document.addEventListener('keydown', (e) => {
  const action = hubKeyAction(e);
  if (action) { e.preventDefault(); step(action); return; }
  if (e.key === 'Escape') {
    if (!menu.hidden) { hideMenu(); return; }
    if (!listPanel.hidden) { hideList(); listBtn.focus(); return; }
  }
  if (document.activeElement?.closest('.rpdf-tab') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    step(e.key === 'ArrowRight' ? 'next' : 'prev');
  }
});

// ─── Local files ───

function openFiles(files: ArrayLike<File>): void {
  const pdfs = Array.from(files).filter((f) => f.type === 'application/pdf' || /\.pdf$/iu.test(f.name));
  if (pdfs.length === 0) return;
  addDocs(pdfs.map((file) => ({ url: null, hash: '', file })), true);
}

addBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files) openFiles(fileInput.files);
  fileInput.value = '';
});
// Files dropped on the strip or the home page (the viewer frames handle drops
// on a document themselves and forward them here).
document.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); document.body.classList.add('is-dropping'); }
});
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('is-dropping');
});
document.addEventListener('drop', (e) => {
  document.body.classList.remove('is-dropping');
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  openFiles(e.dataTransfer.files);
});

// ─── Documents handed over by other tabs (background broadcast) ───

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const request = parsePdfHubOpenMessage(message);
  // Only a registered hub is addressed, possibly before its own claim
  // response has been processed here — accept regardless of `isHub`.
  if (!request || myTabId === null || request.tabId !== myTabId) return false;
  // No documents: the popup's "open the PDF tab", which shows the home page.
  if (request.docs.length === 0) showHome(false);
  else addDocs(request.docs.map((doc) => ({ ...doc, file: null })), request.activate);
  sendResponse({ ok: true });
  return false;
});

// ─── Boot ───

// Whether this tab has a page to go back to. `navigation.canGoBack` only sees
// same-origin entries, so a web page behind us is invisible to it; but a fresh
// navigation truncates forward history, so after one any other entry is
// behind us. On reload / back-forward only the same-origin answer is safe.
function canGoBack(): boolean {
  const nav = (window as unknown as { navigation?: { canGoBack?: boolean } }).navigation;
  if (nav?.canGoBack) return true;
  const [entry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
  return entry?.type === 'navigate' && history.length > 1;
}

async function boot(): Promise<void> {
  const initial = parsePdfHubUrl(location.search, location.hash);
  // Framed by some page (the page is web-accessible): act as the plain viewer.
  if (window.top !== window.self) {
    const first = initial.docs[0];
    location.replace(first ? buildPdfViewerUrl(first.url + first.hash, viewerBase) : viewerBase);
    return;
  }
  strip.hidden = true;
  const current = await chrome.tabs.getCurrent().catch(() => undefined);
  myTabId = typeof current?.id === 'number' ? current.id : null;
  const docs: PdfHubDoc[] = initial.docs;
  let response: { success?: boolean; role?: 'hub' | 'forwarded'; docs?: PdfHubDoc[]; dispose?: 'back' | 'close' } | undefined;
  if (myTabId !== null) {
    response = await chrome.runtime.sendMessage({ type: 'VOCAB_T_PDF_HUB_CLAIM', docs, canGoBack: canGoBack() }).catch(() => undefined);
  }
  if (response?.success && response.role === 'forwarded') {
    emptyText.textContent = 'PDF 탭으로 옮겼습니다.';
    empty.hidden = false;
    if (response.dispose === 'back') history.back();
    else if (myTabId !== null) void chrome.tabs.remove(myTabId).catch(() => undefined);
    return;
  }
  // The hub (or, if the background could not be reached, a standalone page).
  isHub = true;
  strip.hidden = false;
  await loadLibraryState();
  reconcilePinned();
  addDocs(docs.map((doc) => ({ ...doc, file: null })), false, false);
  let front: HubTab | undefined;
  const identities = () => tabs.map((t) => ({ url: t.url, docId: t.docId ?? t.libraryId }));
  if (initial.show && initial.show !== PDF_HUB_SHOW_HOME) {
    front = tabs[findOpenDoc(initial.show, identities())];
  } else if (!initial.show && docs[initial.active]) {
    front = tabs[findOpenDoc(docs[initial.active].url, identities(), libraryIdForUrl)];
  }
  if (front) activate(front.key);
  else showHome(false);
  const handedOver = response?.docs ?? [];
  if (handedOver.length) addDocs(handedOver.map((doc) => ({ ...doc, file: null })), true);
  render();
}

void boot();
