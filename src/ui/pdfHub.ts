// ─── ResearchPDF hub page ───
//
// One browser tab per window that collects every PDF the window opens, so
// papers stop scattering across tabs that look like (and mix with) web
// pages. Each document is a viewer iframe (pdf-viewer.html) behind an
// in-page tab strip; iframes are created the first time a document is
// shown, so a restored hub with twenty papers loads only the one in front.
//
// On load the page claims with the background (background/pdfHub.ts): it is
// either its window's hub, or it hands its documents to the existing hub and
// goes back to the page it came from (or closes). The document list lives in
// this page's own URL (history.replaceState, see shared/localPdf.ts), so a
// reload or Chrome's session restore brings every document back.

import { APP_NAME } from '../shared/brand';
import { initDebugLogging } from '../shared/debugLog';
import {
  PDF_HUB_MAX_DOCS,
  PDF_HUB_PAGE,
  PDF_VIEWER_PAGE,
  buildPdfHubUrl,
  buildPdfViewerUrl,
  isWebPdfSourceUrl,
  parsePdfHubUrl,
  pdfDisplayName,
  type PdfHubDoc,
} from '../shared/localPdf';
import { parsePdfHubOpenMessage } from '../shared/messages';
import {
  HUB_MESSAGE_TAG,
  hubDocumentTitle,
  hubKeyAction,
  parseViewerToHubMessage,
  type HubKeyAction,
  type HubToViewerMessage,
} from '../shared/pdfHubProtocol';
import { byId } from './pdfViewer/dom';
import { prefetchPdf } from './pdfFileFetch';

initDebugLogging();

interface HubTab {
  key: number;
  /** Source URL, or null for a local file opened from disk (not restorable). */
  url: string | null;
  /** Fragment to open at (`#page=3`), consumed by the first load. */
  hash: string;
  file: File | null;
  title: string;
  /** Detected paper title, shown under `title`. */
  paperTitle: string | null;
  frame: HTMLIFrameElement | null;
  /** Prefetch into the local file cache was attempted. */
  prefetched: boolean;
  button: HTMLButtonElement;
  titleEl: HTMLSpanElement;
  paperEl: HTMLSpanElement;
}

const tabList = byId<HTMLDivElement>('rpdf-tabs');
const frames = byId<HTMLElement>('rpdf-frames');
const addBtn = byId<HTMLButtonElement>('rpdf-add');
const fileInput = byId<HTMLInputElement>('rpdf-file-input');
const empty = byId<HTMLDivElement>('rpdf-empty');
const emptyText = byId<HTMLParagraphElement>('rpdf-empty-text');
const emptyOpen = byId<HTMLButtonElement>('rpdf-empty-open');

const viewerBase = chrome.runtime.getURL(PDF_VIEWER_PAGE);
const hubBase = chrome.runtime.getURL(PDF_HUB_PAGE);

const tabs: HubTab[] = [];
let activeKey: number | null = null;
let nextKey = 1;
let myTabId: number | null = null;
// False until the claim settled: nothing is persisted and an emptied hub
// is not closed while the page might still hand its documents away.
let isHub = false;

function activeTab(): HubTab | null {
  return tabs.find((t) => t.key === activeKey) ?? null;
}

// ─── Tab strip ───

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

function createTab(doc: { url: string | null; hash: string; file: File | null }): HubTab {
  const key = nextKey++;
  const initialTitle = doc.file ? doc.file.name : doc.url ? pdfDisplayName(doc.url) : 'PDF';
  const button = el('button', { type: 'button', className: 'rpdf-tab', tabIndex: -1 });
  button.setAttribute('role', 'tab');
  button.draggable = true;
  button.dataset.key = String(key);
  const local = !!doc.file || !!doc.url?.startsWith('file:');
  const icon = el('span', { className: 'rpdf-tab-icon' });
  icon.innerHTML = `<svg aria-hidden="true"><use href="#${local ? 'i-file-local' : 'i-file'}"/></svg>`;
  const titleEl = el('span', { className: 'rpdf-tab-title', textContent: initialTitle });
  const paperEl = el('span', { className: 'rpdf-tab-paper', hidden: true });
  const text = el('span', { className: 'rpdf-tab-text' });
  text.append(titleEl, paperEl);
  const close = el('span', { className: 'rpdf-tab-close', title: '닫기 (Alt+W)' });
  close.setAttribute('role', 'button');
  close.setAttribute('aria-label', '이 PDF 닫기');
  close.innerHTML = '<svg><use href="#i-close"/></svg>';
  button.append(icon, text, close);
  const tab: HubTab = { key, url: doc.url, hash: doc.hash, file: doc.file, title: initialTitle, paperTitle: null, frame: null, prefetched: false, button, titleEl, paperEl };
  updateTabLabel(tab);
  button.addEventListener('click', (e) => {
    if ((e.target as Element).closest('.rpdf-tab-close')) closeTab(key);
    else activate(key);
  });
  button.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(key); } });
  wireDrag(tab);
  return tab;
}

function updateTabLabel(tab: HubTab): void {
  tab.titleEl.textContent = tab.title;
  tab.paperEl.textContent = tab.paperTitle ?? '';
  tab.paperEl.hidden = !tab.paperTitle;
  tab.button.classList.toggle('has-paper', !!tab.paperTitle);
  tab.button.title = [tab.title, tab.paperTitle, tab.url].filter(Boolean).join('\n');
  if (tab.frame) tab.frame.title = tab.paperTitle ?? tab.title;
}

function addDocs(docs: Array<{ url: string | null; hash: string; file: File | null }>, activateLast: boolean, autoActivate = true): void {
  let last: HubTab | null = null;
  for (const doc of docs) {
    const existing = doc.url ? tabs.find((t) => t.url === doc.url) : undefined;
    if (existing) {
      if (doc.hash) {
        if (existing.frame) postToFrame(existing, { tag: HUB_MESSAGE_TAG, kind: 'hash', hash: doc.hash });
        else existing.hash = doc.hash;
      }
      last = existing;
      continue;
    }
    if (tabs.length >= PDF_HUB_MAX_DOCS) break;
    const tab = createTab(doc);
    tabs.push(tab);
    tabList.append(tab.button);
    last = tab;
  }
  if (last && (activateLast || (autoActivate && activeKey === null))) activate(last.key);
  render();
  void queuePrefetch();
}

// ─── Prefetch ───
//
// Documents behind other tabs (restored with the hub, opened in the
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

function frameUrl(tab: HubTab): string {
  if (!tab.url) return `${viewerBase}?hub=file`;
  return buildPdfViewerUrl(tab.url + tab.hash, viewerBase);
}

function ensureFrame(tab: HubTab): HTMLIFrameElement {
  if (tab.frame) return tab.frame;
  const frame = el('iframe', { title: tab.title });
  // Presentation mode and BibTeX copy run inside the frame.
  frame.allow = 'fullscreen; clipboard-write';
  frame.src = frameUrl(tab);
  tab.hash = '';
  if (tab.file) {
    const file = tab.file;
    frame.addEventListener('load', () => postToFrame(tab, { tag: HUB_MESSAGE_TAG, kind: 'open-file', file }), { once: true });
  }
  frames.append(frame);
  tab.frame = frame;
  return frame;
}

function postToFrame(tab: HubTab, message: HubToViewerMessage): void {
  tab.frame?.contentWindow?.postMessage(message, location.origin);
}

function activate(key: number): void {
  const tab = tabs.find((t) => t.key === key);
  if (!tab) return;
  activeKey = key;
  const frame = ensureFrame(tab);
  for (const t of tabs) {
    const on = t.key === key;
    t.button.setAttribute('aria-selected', String(on));
    t.button.tabIndex = on ? 0 : -1;
    if (t.frame) t.frame.hidden = !on;
  }
  tab.button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  frame.focus();
  render();
}

function closeTab(key: number): void {
  const index = tabs.findIndex((t) => t.key === key);
  if (index < 0) return;
  const [tab] = tabs.splice(index, 1);
  tab.frame?.remove();
  tab.button.remove();
  if (activeKey === key) {
    activeKey = null;
    const neighbor = tabs[index] ?? tabs[index - 1];
    if (neighbor) activate(neighbor.key);
  }
  if (tabs.length === 0 && isHub && myTabId !== null) {
    // Closing the last document closes the hub, like closing a tab.
    void chrome.tabs.remove(myTabId).catch(() => undefined);
    return;
  }
  render();
}

function step(action: HubKeyAction): void {
  if (action === 'close') { if (activeKey !== null) closeTab(activeKey); return; }
  if (tabs.length < 2) return;
  const index = tabs.findIndex((t) => t.key === activeKey);
  const next = tabs[(index + (action === 'next' ? 1 : -1) + tabs.length) % tabs.length];
  activate(next.key);
}

// Drag to reorder within the strip.
let dragKey: number | null = null;
function wireDrag(tab: HubTab): void {
  const { button } = tab;
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
    if (dragKey === null || dragKey === tab.key) return;
    e.preventDefault();
    for (const t of tabs) t.button.classList.toggle('is-drop-before', t === tab);
  });
  button.addEventListener('drop', (e) => {
    if (dragKey === null || dragKey === tab.key) return;
    e.preventDefault();
    const from = tabs.findIndex((t) => t.key === dragKey);
    const [moved] = tabs.splice(from, 1);
    const to = tabs.findIndex((t) => t.key === tab.key);
    tabs.splice(to, 0, moved);
    tabList.insertBefore(moved.button, tab.button);
    tab.button.classList.remove('is-drop-before');
    render();
  });
}

// ─── Title, URL, restore record ───

let stateTimer: ReturnType<typeof setTimeout> | null = null;

function render(): void {
  const current = activeTab();
  document.title = tabs.length ? hubDocumentTitle(current?.paperTitle ?? current?.title ?? 'PDF', tabs.length, APP_NAME) : `PDF · ${APP_NAME}`;
  empty.hidden = tabs.length > 0;
  if (!isHub) return;
  const urlTabs = tabs.filter((t): t is HubTab & { url: string } => t.url !== null);
  const urls = urlTabs.map((t) => t.url);
  const active = Math.max(0, urlTabs.findIndex((t) => t.key === activeKey));
  const canonical = buildPdfHubUrl(urls, active, hubBase);
  if (location.href !== canonical) history.replaceState(null, '', canonical);
  if (stateTimer) clearTimeout(stateTimer);
  stateTimer = setTimeout(() => {
    stateTimer = null;
    chrome.runtime.sendMessage({ type: 'VOCAB_T_PDF_HUB_STATE', urls, active }, () => { void chrome.runtime.lastError; });
  }, 400);
}

// ─── Messages from viewer frames ───

window.addEventListener('message', (event) => {
  if (event.origin !== location.origin) return;
  const tab = tabs.find((t) => t.frame?.contentWindow === event.source);
  if (!tab) return;
  const message = parseViewerToHubMessage(event.data);
  if (!message) return;
  if (message.kind === 'doc') {
    tab.title = message.title;
    tab.paperTitle = message.paperTitle;
    updateTabLabel(tab);
    render();
  } else if (message.kind === 'key') {
    step(message.action);
  } else {
    openFiles(message.files);
  }
});

document.addEventListener('keydown', (e) => {
  const action = hubKeyAction(e);
  if (action) { e.preventDefault(); step(action); return; }
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
emptyOpen.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files) openFiles(fileInput.files);
  fileInput.value = '';
});
// Files dropped on the strip or the empty hub (the viewer frames handle drops
// on a document themselves and forward them here).
document.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); empty.classList.add('is-dropping'); }
});
document.addEventListener('dragleave', () => empty.classList.remove('is-dropping'));
document.addEventListener('drop', (e) => {
  empty.classList.remove('is-dropping');
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
  addDocs(request.docs.map((doc) => ({ ...doc, file: null })), request.activate);
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
  const current = await chrome.tabs.getCurrent().catch(() => undefined);
  myTabId = typeof current?.id === 'number' ? current.id : null;
  const docs: PdfHubDoc[] = initial.docs;
  let response: { success?: boolean; role?: 'hub' | 'forwarded'; docs?: PdfHubDoc[]; dispose?: 'back' | 'close' } | undefined;
  if (myTabId !== null) {
    response = await chrome.runtime.sendMessage({ type: 'VOCAB_T_PDF_HUB_CLAIM', docs, canGoBack: canGoBack() }).catch(() => undefined);
  }
  if (response?.success && response.role === 'forwarded') {
    emptyText.textContent = 'PDF 탭으로 옮겼습니다.';
    emptyOpen.hidden = true;
    empty.hidden = false;
    if (response.dispose === 'back') history.back();
    else if (myTabId !== null) void chrome.tabs.remove(myTabId).catch(() => undefined);
    return;
  }
  // The hub (or, if the background could not be reached, a standalone page).
  isHub = true;
  const handedOver = response?.docs ?? [];
  addDocs(docs.map((doc) => ({ ...doc, file: null })), false, false);
  const initialUrl = docs[initial.active]?.url;
  const initialActive = tabs.find((t) => t.url === initialUrl) ?? tabs[0];
  if (initialActive) activate(initialActive.key);
  if (handedOver.length) addDocs(handedOver.map((doc) => ({ ...doc, file: null })), true);
  render();
}

void boot();
