// ─── ResearchPDF hub page ───
//
// One browser tab per project that collects its PDFs, so papers stop
// scattering across tabs that look like (and mix with) web pages. Each document is a viewer iframe (pdf-viewer.html) behind an
// in-page tab strip; iframes are created the first time a document is
// shown, so a restored hub with twenty papers loads only the one in front,
// and frames not shown for a while are unloaded again (shared/hubTabs.ts).
//
// A project (shared/pdfProjects.ts) is a named set of documents with its own
// pins and the tabs it was last closed with; every PDF first lands in the
// default project and "프로젝트로 이동" moves it. The switcher at the strip's
// left opens, creates, renames and deletes projects; each open project is
// one hub tab.
//
// Left of the tabs is the home page: the project's documents and pins, this
// hub's recently closed tabs, and the library of every document any hub has
// shown (shared/pdfLibrary.ts). Pinned documents are tabs in that project's
// hub, on every device.
//
// On load the page claims with the background (background/pdfHub.ts): it is
// either its project's hub, or it hands its documents to the existing hub
// and goes back to the page it came from (or closes). The document list lives in
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
  PDF_HUB_SHOW_SETTINGS,
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
  DEFAULT_PROJECT_ID,
  PDF_PROJECTS_STORAGE_KEY,
  PDF_PROJECT_COLORS,
  applyPdfProjectUpdate,
  PDF_PROJECT_FOLDERS_STORAGE_KEY,
  PDF_PROJECT_ICONS,
  cleanPdfProjectName,
  isDocInProject,
  livePdfProjects,
  newPdfProjectFolderId,
  newPdfProjectId,
  parsePdfProjectFolders,
  parsePdfProjects,
  pdfProjectEmojiIcon,
  pdfProjectLook,
  pdfProjectTree,
  projectPinnedDocIds,
  projectsOfDoc,
  seedPdfProjects,
  type PdfFolderUpdate,
  type PdfProject,
  type PdfProjectFolder,
  type PdfProjectFolders,
  type PdfProjects,
  type PdfProjectUpdate,
} from '../shared/pdfProjects';
import { compareOrderKeys, orderKeyAtEnd, orderKeyBetween, orderKeysBetween } from '../shared/orderKey';
import { DEFAULT_DISPLAY_PREFS, DISPLAY_PREFS_STORAGE_KEY, parseDisplayPrefs, tabLabels, type DisplayPrefs } from '../shared/displayPrefs';
import { PDF_UPKEEP_DONE_MESSAGE, PDF_UPKEEP_PAGE, PDF_UPKEEP_STORAGE_KEY, parsePdfUpkeepState, rowsNeedingUpkeep } from '../shared/pdfUpkeep';
import { PDF_DOC_STATE_STORAGE_KEY, parsePdfDocRecords, type PdfDocRecords } from '../shared/pdfIdentity';
import {
  PDF_LIBRARY_STORAGE_KEY,
  libraryEntryKind,
  libraryEntryName,
  parsePdfLibrary,
  relativeTimeKo,
  searchPdfLibrary,
  type PdfDocKind,
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
  /** Move to another project as soon as the document's identity is known. */
  pendingMove: { to: string; keep: boolean } | null;
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
// The settings page, shown like home in place of a document.
const SETTINGS = -1;
const isPage = (key: number | null) => key === HOME || key === SETTINGS;
const SLEEP_CHECK_MS = 60_000;
const SLEEP_REPLY_TIMEOUT_MS = 2_000;
const BUSY_RETRY_MS = 5 * 60_000;
const TOAST_MS = 5_000;
const HOME_PAGE_SIZE = 30;
const CLOSED_STORAGE_KEY = 'rpdfClosed';

const strip = byId<HTMLElement>('rpdf-strip');
const homeBtn = byId<HTMLButtonElement>('rpdf-home-btn');
const settingsBtn = byId<HTMLButtonElement>('rpdf-settings-btn');
const settingsView = byId<HTMLElement>('rpdf-settings');
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
const projectBtn = byId<HTMLButtonElement>('rpdf-project-btn');
const projectNameEl = byId<HTMLSpanElement>('rpdf-project-name');
const projectBadgeEl = byId<HTMLSpanElement>('rpdf-project-badge');
const folderNewBtn = byId<HTMLButtonElement>('rpdf-folder-new');
const stylePanel = byId<HTMLDivElement>('rpdf-style');
const styleBack = byId<HTMLButtonElement>('rpdf-style-back');
const stylePreview = byId<HTMLSpanElement>('rpdf-style-preview');
const styleTitle = byId<HTMLParagraphElement>('rpdf-style-title');
const styleIcons = byId<HTMLDivElement>('rpdf-style-icons');
const styleEmojis = byId<HTMLDivElement>('rpdf-style-emojis');
const styleEmojiInput = byId<HTMLInputElement>('rpdf-style-emoji-input');
const styleColors = byId<HTMLDivElement>('rpdf-style-colors');
const styleReset = byId<HTMLButtonElement>('rpdf-style-reset');
const styleDone = byId<HTMLButtonElement>('rpdf-style-done');
const projectsPanel = byId<HTMLDivElement>('rpdf-projects');
const projectsItems = byId<HTMLDivElement>('rpdf-projects-items');
const projectNewForm = byId<HTMLFormElement>('rpdf-project-new');
const projectNewName = byId<HTMLInputElement>('rpdf-project-new-name');
const moveBtn = byId<HTMLButtonElement>('rpdf-move-btn');
const movePanel = byId<HTMLDivElement>('rpdf-move');
const moveTitle = byId<HTMLParagraphElement>('rpdf-move-title');
const moveItems = byId<HTMLDivElement>('rpdf-move-items');
const moveNewForm = byId<HTMLFormElement>('rpdf-move-new');
const moveNewName = byId<HTMLInputElement>('rpdf-move-new-name');
const homeTitle = byId<HTMLHeadingElement>('rpdf-home-title');

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

// ─── Projects (read here, written by the background) ───

let projectId = DEFAULT_PROJECT_ID;
// Before a device's first project write there is no record: it reads as the
// default project seeded with the library's old pins, like the background.
let storedProjects: unknown;
let projects: PdfProjects = parsePdfProjects(undefined);
let folders: PdfProjectFolders = {};
// How tabs are named and icons drawn on this device (settings page).
let display: DisplayPrefs = DEFAULT_DISPLAY_PREFS;
// Projects with a hub right now (the background's registry; may be stale).
let openProjectIds = new Set<string>();
// Pin changes sent but not yet seen in storage: they win over a stale read.
const pendingPins = new Map<string, boolean>();
// Documents this hub already registered to its project (one message each).
const registered = new Set<string>();
const PROJECT_HUBS_SESSION_KEY = 'rpdfProjectHubs';

function setLibrary(next: PdfLibrary): void {
  library = next;
  urlToLibraryId = new Map();
  for (const entry of Object.values(library).sort((a, b) => a.openedAt - b.openedAt)) {
    for (const url of entry.urls) urlToLibraryId.set(hubDocKey(url).url, entry.docId);
  }
  if (storedProjects === undefined) setProjects(undefined);
}

function setProjects(raw: unknown): void {
  storedProjects = raw;
  projects = raw === undefined ? seedPdfProjects(Object.values(library)) : parsePdfProjects(raw);
  const stored = new Set(projectPinnedDocIds(projects, projectId));
  for (const [docId, pinned] of pendingPins) {
    if (stored.has(docId) === pinned) pendingPins.delete(docId);
  }
}

function currentProject(): PdfProject {
  return projects[projectId] ?? projects[DEFAULT_PROJECT_ID];
}

function projectName(id: string): string {
  return projects[id]?.name ?? '프로젝트';
}

/** Pinned documents of this project, with pin changes still in flight. */
function pinnedDocIds(): string[] {
  const ids = projectPinnedDocIds(projects, projectId).filter((id) => pendingPins.get(id) !== false);
  for (const [id, pinned] of pendingPins) if (pinned && !ids.includes(id)) ids.push(id);
  return ids;
}

function isPinnedDoc(docId: string): boolean {
  return pinnedDocIds().includes(docId);
}

/** docId → the non-default projects it is registered to. */
function membershipIndex(): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const project of livePdfProjects(projects)) {
    if (project.id === DEFAULT_PROJECT_ID) continue;
    for (const m of project.members) {
      if (m.member) index.set(m.docId, [...(index.get(m.docId) ?? []), project.id]);
    }
  }
  return index;
}

function inThisProject(docId: string, index: Map<string, string[]>): boolean {
  return projectId === DEFAULT_PROJECT_ID ? !index.has(docId) : (index.get(docId) ?? []).includes(projectId);
}

function sendProjectUpdate(update: PdfProjectUpdate | PdfFolderUpdate): Promise<unknown> {
  return ask({ type: 'VOCAB_T_PDF_PROJECT_UPDATE', update });
}

function sendLibraryUpdate(update: PdfLibraryUpdate): Promise<unknown> {
  return ask({ type: 'VOCAB_T_PDF_LIBRARY_UPDATE', update });
}

function ask<T = { success?: boolean; error?: string }>(message: Record<string, unknown>): Promise<T | undefined> {
  return (chrome.runtime.sendMessage(message) as Promise<T>).catch(() => undefined);
}

async function loadOpenProjects(): Promise<void> {
  try {
    const stored = await chrome.storage.session.get(PROJECT_HUBS_SESSION_KEY);
    const value = stored[PROJECT_HUBS_SESSION_KEY];
    openProjectIds = new Set(value && typeof value === 'object' ? Object.keys(value) : []);
  } catch {
    openProjectIds = new Set();
  }
}

/** A project opened in another hub registers the documents shown in it. */
function registerDoc(docId: string | null): void {
  if (!isHub || !docId || projectId === DEFAULT_PROJECT_ID || registered.has(docId)) return;
  registered.add(docId);
  if (isDocInProject(projects, projectId, docId)) return;
  void sendProjectUpdate({ kind: 'member', id: projectId, docId, member: true });
}

function libraryIdForUrl(url: string): string | null {
  return urlToLibraryId.get(hubDocKey(url).url) ?? null;
}

async function loadLibraryState(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get([PDF_LIBRARY_STORAGE_KEY, PDF_DOC_STATE_STORAGE_KEY, PDF_PROJECTS_STORAGE_KEY, PDF_PROJECT_FOLDERS_STORAGE_KEY, DISPLAY_PREFS_STORAGE_KEY]);
    display = parseDisplayPrefs(stored[DISPLAY_PREFS_STORAGE_KEY]);
    setLibrary(parsePdfLibrary(stored[PDF_LIBRARY_STORAGE_KEY]));
    setProjects(stored[PDF_PROJECTS_STORAGE_KEY]);
    folders = parsePdfProjectFolders(stored[PDF_PROJECT_FOLDERS_STORAGE_KEY]);
    docRecords = parsePdfDocRecords(stored[PDF_DOC_STATE_STORAGE_KEY]);
  } catch {
    /* an empty home page */
  }
  await loadOpenProjects();
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
  if (area === 'session') {
    if (changes[PROJECT_HUBS_SESSION_KEY]) {
      const value = changes[PROJECT_HUBS_SESSION_KEY].newValue;
      openProjectIds = new Set(value && typeof value === 'object' ? Object.keys(value) : []);
      refreshPanels();
    }
    return;
  }
  if (area !== 'local') return;
  if (changes[PDF_LIBRARY_STORAGE_KEY] || changes[PDF_PROJECTS_STORAGE_KEY] || changes[PDF_PROJECT_FOLDERS_STORAGE_KEY]) {
    if (changes[PDF_LIBRARY_STORAGE_KEY]) {
      setLibrary(parsePdfLibrary(changes[PDF_LIBRARY_STORAGE_KEY].newValue));
      tabs.forEach(updateTabLabel); // kinds
    }
    if (changes[PDF_PROJECTS_STORAGE_KEY]) setProjects(changes[PDF_PROJECTS_STORAGE_KEY].newValue);
    if (changes[PDF_PROJECT_FOLDERS_STORAGE_KEY]) folders = parsePdfProjectFolders(changes[PDF_PROJECT_FOLDERS_STORAGE_KEY].newValue);
    if (isHub) {
      // This project was deleted (here, in another hub, on another device).
      if (projects[projectId]?.deletedAt !== 0) { void rehome(); return; }
      completePendingPins();
      reconcilePinned();
      updateProjectLabel();
      refreshPanels();
    }
    scheduleHomeRender();
  }
  if (changes[PDF_DOC_STATE_STORAGE_KEY]) {
    docRecords = parsePdfDocRecords(changes[PDF_DOC_STATE_STORAGE_KEY].newValue);
    scheduleHomeRender();
  }
  if (changes[DISPLAY_PREFS_STORAGE_KEY]) {
    display = parseDisplayPrefs(changes[DISPLAY_PREFS_STORAGE_KEY].newValue);
    tabs.forEach(updateTabLabel);
    updateFavicon();
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
    pinned: false, keepOnUnpin: false, pendingPin: false, pendingMove: null,
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
  const entry = library[tab.docId ?? tab.libraryId ?? ''];
  const { title, subtitle } = tabLabels({ docName: tab.title, paperTitle: tab.paperTitle ?? entry?.title ?? null, venue: entry?.venue ?? null, year: entry?.year ?? null }, display);
  // A pinned tab is narrow: one line.
  tab.titleEl.textContent = title;
  tab.paperEl.textContent = subtitle ?? '';
  tab.paperEl.hidden = tab.pinned || !subtitle;
  tab.button.classList.toggle('has-paper', !tab.pinned && !!subtitle);
  tab.button.classList.toggle('is-pinned', tab.pinned);
  tab.button.classList.toggle('is-unloaded', !tab.frame);
  tab.button.draggable = true;
  tab.closeEl.hidden = tab.pinned;
  const kind = docKind(tab.docId ?? tab.libraryId);
  tab.iconEl.replaceChildren(icon(tab.pinned ? 'i-pin' : kindIcon(display.kindIcons === 'off' ? 'document' : kind, isLocal(tab))));
  tab.iconEl.dataset.kind = tab.pinned || display.kindIcons !== 'color' ? '' : kind;
  tab.button.title = [tab.paperTitle, tab.title, tab.url, kind !== 'document' ? KIND_LABEL[kind] : null, tab.pinned ? '고정됨 · 우클릭해 고정 해제' : null]
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
      showToast(`한 프로젝트에는 PDF를 ${PDF_HUB_MAX_DOCS}개까지 열 수 있습니다.`);
      break;
    }
    const tab = createTab(doc);
    insertTab(tab, insertAt ?? tabs.length);
    if (insertAt !== undefined) insertAt += 1;
    registerDoc(tab.libraryId);
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
  if (key === SETTINGS) { showSettings(); return; }
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
  settingsView.hidden = true;
  settingsBtn.setAttribute('aria-pressed', 'false');
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
  settingsView.hidden = true;
  settingsBtn.setAttribute('aria-pressed', 'false');
  homeLimit = HOME_PAGE_SIZE;
  renderHome();
  void loadAnnotated().then(() => scheduleHomeRender());
  if (focusSearch) homeSearch.focus();
  render();
}

/**
 * The settings page in place of the documents. Its frame (settings.html,
 * which styles itself for the hub when framed) is made on first use and kept.
 */
function showSettings(): void {
  const previous = activeTab();
  if (previous) previous.lastShownAt = Date.now();
  activeKey = SETTINGS;
  for (const t of tabs) {
    t.button.setAttribute('aria-selected', 'false');
    t.button.tabIndex = -1;
    if (t.frame) t.frame.hidden = true;
  }
  home.hidden = true;
  homeBtn.setAttribute('aria-pressed', 'false');
  settingsView.hidden = false;
  settingsBtn.setAttribute('aria-pressed', 'true');
  let frame = settingsView.querySelector('iframe');
  if (!frame) {
    frame = el('iframe', { src: 'settings.html', title: '설정' });
    // Shown once it has styled itself for the hub, without a light flash.
    frame.style.visibility = 'hidden';
    frame.addEventListener('load', () => { frame?.style.removeProperty('visibility'); frame?.focus(); }, { once: true });
    settingsView.append(frame);
  } else {
    frame.focus();
  }
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
    if (activeKey !== null && !isPage(activeKey)) closeTab(activeKey);
    return;
  }
  if (action === 'reopen') { reopenClosed(); return; }
  if (tabs.length === 0) return;
  if (isPage(activeKey) || activeKey === null) {
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
  // Pinned tabs reorder among pins (the project's pin order), the rest among the rest.
  button.addEventListener('dragover', (e) => {
    const moved = dragged();
    if (!moved || moved === tab || moved.pinned !== tab.pinned) return;
    e.preventDefault();
    for (const t of tabs) t.button.classList.toggle('is-drop-before', t === tab);
  });
  button.addEventListener('drop', (e) => {
    const moved = dragged();
    if (!moved || moved === tab || moved.pinned !== tab.pinned) return;
    e.preventDefault();
    tab.button.classList.remove('is-drop-before');
    if (tab.pinned) {
      const order = tabs.filter((t) => t.pinned && t !== moved).map((t) => t.libraryId).filter((id): id is string => !!id);
      if (!moved.libraryId) return;
      order.splice(order.indexOf(tab.libraryId ?? ''), 0, moved.libraryId);
      setPinOrder(order);
      return;
    }
    tabs.splice(tabs.indexOf(moved), 1);
    tabs.splice(tabs.indexOf(tab), 0, moved);
    tabList.insertBefore(moved.button, tab.button);
    render();
  });
}

// ─── Pins ───

/** Makes the strip match the project's pinned documents (set here, in another hub, or on another device). */
function reconcilePinned(): void {
  const pinned = pinnedDocIds()
    .map((id) => library[id])
    .filter((e): e is PdfLibraryEntry => !!e && e.urls.length > 0);
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
  if (pinned && !isDocInProject(projects, projectId, docId)) {
    if (projectId === DEFAULT_PROJECT_ID) {
      const elsewhere = projectsOfDoc(projects, docId).map(projectName).join(', ');
      showToast(`‘${elsewhere}’ 프로젝트의 문서입니다. 기본 프로젝트로 옮긴 뒤 고정하세요.`);
      return;
    }
    registered.add(docId); // pinning registers it
  }
  pendingPins.set(docId, pinned);
  void sendProjectUpdate({ kind: 'pin', id: projectId, docId, pinned });
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

// ─── Recently closed (this hub's project; survives a reload) ───

let closed: HubClosedTab[] = [];

function closedStorageKey(): string {
  return `${CLOSED_STORAGE_KEY}:${projectId}`;
}

function loadClosed(): HubClosedTab[] {
  try {
    // Before projects, one list per hub tab (now the default project's).
    const raw = sessionStorage.getItem(closedStorageKey())
      ?? (projectId === DEFAULT_PROJECT_ID ? sessionStorage.getItem(CLOSED_STORAGE_KEY) : null);
    return parseClosedTabs(JSON.parse(raw ?? '[]'))
      .filter((e) => e.fileId === null); // local files do not survive a reload
  } catch {
    return [];
  }
}

function setClosed(next: HubClosedTab[]): void {
  closed = next;
  try {
    sessionStorage.setItem(closedStorageKey(), JSON.stringify(closed));
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

/** The URL-backed tabs, which one is in front, and what (home, a pin) is shown instead. */
function hubState(): { urls: string[]; active: number; show: string | null } {
  const current = activeTab();
  const urlTabs = tabs.filter((t): t is HubTab & { url: string } => t.url !== null && !t.pinned);
  return {
    urls: urlTabs.map((t) => t.url),
    active: Math.max(0, urlTabs.findIndex((t) => t.key === activeKey)),
    // The project reopens on home rather than on settings.
    show: isPage(activeKey) ? PDF_HUB_SHOW_HOME : current?.pinned ? current.url : null,
  };
}

function render(): void {
  const current = activeTab();
  const name = activeKey === HOME ? '홈' : activeKey === SETTINGS ? '설정' : current?.paperTitle ?? current?.title ?? 'PDF';
  const appName = projectId === DEFAULT_PROJECT_ID ? APP_NAME : `${currentProject().name} · ${APP_NAME}`;
  document.title = hubDocumentTitle(name, tabs.length, appName);
  moveBtn.disabled = !current;
  listCount.textContent = tabs.length ? String(tabs.length) : '';
  const badges = arxivVersionBadges(tabs.map((t) => t.url));
  tabs.forEach((t, i) => {
    t.verEl.textContent = badges[i] ?? '';
    t.verEl.hidden = !badges[i];
  });
  updateOverflow();
  if (!isHub) return;
  const { urls, active, show } = hubState();
  // A reload keeps settings in front; the project's saved state does not.
  const canonical = buildPdfHubUrl(urls, active, hubBase, activeKey === SETTINGS ? PDF_HUB_SHOW_SETTINGS : show, projectId);
  if (location.href !== canonical) history.replaceState(null, '', canonical);
  if (stateTimer) clearTimeout(stateTimer);
  const project = projectId;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    if (project !== projectId || !isHub) return;
    chrome.runtime.sendMessage({ type: 'VOCAB_T_PDF_HUB_STATE', urls, active, project, show }, () => { void chrome.runtime.lastError; });
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
  // The project's documents that are not open: one click away.
  const index = membershipIndex();
  const openIds = new Set(tabs.map((t) => t.docId ?? t.libraryId));
  const members = Object.values(library)
    .filter((e) => e.urls.length > 0 && !openIds.has(e.docId) && inThisProject(e.docId, index) && matches(entryName(e), e.fileName, ...e.urls))
    .sort((a, b) => b.openedAt - a.openedAt);
  if (members.length) {
    listItems.append(el('h3', { className: 'rpdf-li-head', textContent: `${currentProject().name}의 닫힌 문서` }));
    for (const entry of members.slice(0, 10)) {
      const main = el('button', { type: 'button', className: 'rpdf-li-main' });
      const text = el('span', { className: 'rpdf-li-text' });
      text.append(
        el('span', { className: 'rpdf-li-title', textContent: entryName(entry) }),
        el('span', { className: 'rpdf-li-sub', textContent: `${relativeTimeKo(entry.openedAt)} 열어 봄` }),
      );
      main.append(icon(entry.urls[0].startsWith('file:') ? 'i-file-local' : 'i-file'), text);
      main.addEventListener('click', () => { hideList(); openEntry(entry); });
      const row = el('div', { className: 'rpdf-li' });
      row.append(main);
      listItems.append(row);
    }
  }
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
  hidePanels();
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
  hidePanels();
  menu.replaceChildren();
  const item = (label: string, run: () => void, disabled = false) => {
    const button = el('button', { type: 'button', className: 'rpdf-menu-item', textContent: label, disabled });
    button.setAttribute('role', 'menuitem');
    button.addEventListener('click', () => { hideMenu(); run(); });
    menu.append(button);
  };
  item(tab.pinned ? '고정 해제' : '고정', () => setPinned(tab, !tab.pinned));
  item('프로젝트로 이동…', () => showMove(tab));
  const docId = tab.docId ?? tab.libraryId;
  if (docId && library[docId]) {
    const rect = tab.button.getBoundingClientRect();
    item(`문서 종류: ${KIND_LABEL[docKind(docId)]}…`, () => showKindMenu(docId, Math.max(x, rect.left), y));
  }
  if (projectId !== DEFAULT_PROJECT_ID && docId && isDocInProject(projects, projectId, docId)) {
    item('프로젝트에서 빼기', () => removeFromProject(tab, docId));
  }
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
  // The list's own menu (⋯, right click) belongs to it.
  if (!projectsPanel.hidden && !projectsPanel.contains(target) && !projectBtn.contains(target) && !menu.contains(target)) hideProjects();
  if (!stylePanel.hidden && !stylePanel.contains(target) && !projectBtn.contains(target)) hideStyle();
  if (!movePanel.hidden && !movePanel.contains(target) && !moveBtn.contains(target)) hideMove();
}, true);
window.addEventListener('blur', () => hidePanels());

function hidePanels(): void {
  hideMenu();
  hideList();
  hideProjects();
  hideStyle();
  hideMove();
}

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

interface HomeRowOptions {
  /** "+": register to this project without opening it. */
  add?: boolean;
  /** Names of the other projects it is in, shown in the meta line. */
  elsewhere?: string[];
  /** A row of the pinned list: dragged to reorder. */
  pinnedList?: boolean;
}

// ─── Home: filters, sort, selection (this page; filter and sort remembered per device) ───

type HomeFilter = 'all' | PdfDocKind | 'annotated' | 'reading' | 'unread';
type HomeSort = 'recent' | 'title' | 'year' | 'progress';
const HOME_VIEW_KEY = 'rpdfHomeView';
const HOME_FILTER_LABEL: Record<Exclude<HomeFilter, PdfDocKind>, string> = { all: '전체', annotated: '필기 있음', reading: '읽는 중', unread: '안 읽음' };
const HOME_SORT_LABEL: Record<HomeSort, string> = { recent: '최근 연 순', title: '제목 순', year: '최신 연도 순', progress: '많이 읽은 순' };

function loadHomeView(): { filter: HomeFilter; sort: HomeSort } {
  try {
    const raw = JSON.parse(localStorage.getItem(HOME_VIEW_KEY) ?? '{}') as { filter?: string; sort?: string };
    const filter = (['all', 'annotated', 'reading', 'unread', ...KIND_ORDER] as string[]).includes(raw.filter ?? '') ? raw.filter as HomeFilter : 'all';
    const sort = (Object.keys(HOME_SORT_LABEL) as string[]).includes(raw.sort ?? '') ? raw.sort as HomeSort : 'recent';
    return { filter, sort };
  } catch {
    return { filter: 'all', sort: 'recent' };
  }
}
// Read at boot (it needs the kinds declared further down).
let homeView: { filter: HomeFilter; sort: HomeSort } = { filter: 'all', sort: 'recent' };
function setHomeView(next: Partial<typeof homeView>): void {
  homeView = { ...homeView, ...next };
  try { localStorage.setItem(HOME_VIEW_KEY, JSON.stringify(homeView)); } catch { /* a nicety */ }
  homeLimit = HOME_PAGE_SIZE;
  renderHome();
}

const selected = new Set<string>();

/** Reading progress 0–1, or null when never opened past the first page. */
function progressOf(entry: PdfLibraryEntry): number | null {
  const page = docRecords[entry.docId]?.page ?? null;
  return page && page > 1 ? Math.min(1, page / Math.max(1, entry.numPages)) : null;
}

function matchesFilter(entry: PdfLibraryEntry, filter: HomeFilter): boolean {
  switch (filter) {
    case 'all': return true;
    case 'annotated': return annotated.has(entry.docId);
    case 'reading': { const p = progressOf(entry); return p !== null && p < 0.98; }
    case 'unread': return progressOf(entry) === null;
    default: return libraryEntryKind(entry) === filter;
  }
}

function sortEntries(entries: PdfLibraryEntry[], sort: HomeSort): PdfLibraryEntry[] {
  const list = [...entries];
  switch (sort) {
    case 'title': return list.sort((a, b) => entryName(a).localeCompare(entryName(b), 'ko'));
    case 'year': return list.sort((a, b) => (b.year ?? -1) - (a.year ?? -1) || b.openedAt - a.openedAt);
    case 'progress': return list.sort((a, b) => (progressOf(b) ?? -1) - (progressOf(a) ?? -1) || b.openedAt - a.openedAt);
    default: return list.sort((a, b) => b.openedAt - a.openedAt);
  }
}

function homeRow(entry: PdfLibraryEntry, options: HomeRowOptions = {}): HTMLElement {
  const pinned = isPinnedDoc(entry.docId);
  const row = el('li', { className: 'rpdf-item' });
  row.dataset.docId = entry.docId;
  const isSelected = selected.has(entry.docId);
  row.classList.toggle('is-selected', isSelected);
  if (!options.pinnedList) {
    const check = el('input', { type: 'checkbox', className: 'rpdf-item-check', checked: isSelected });
    check.setAttribute('aria-label', `${entryName(entry)} 선택`);
    check.addEventListener('change', () => {
      if (check.checked) selected.add(entry.docId); else selected.delete(entry.docId);
      row.classList.toggle('is-selected', check.checked);
      renderSelectionBar();
    });
    row.append(check);
  }
  const main = el('button', { type: 'button', className: 'rpdf-item-main' });
  main.title = [entry.title, entry.docTitle, entry.fileName, ...entry.urls].filter(Boolean).filter((v, i, all) => all.indexOf(v) === i).join('\n');
  const text = el('span', { className: 'rpdf-item-text' });
  text.append(el('span', { className: 'rpdf-item-title', textContent: entryName(entry) }));
  const record = docRecords[entry.docId];
  const page = record?.page ?? null;
  const meta = [
    options.elsewhere?.length ? options.elsewhere.join(', ') : null,
    [entry.venue, entry.year].filter(Boolean).join(' '),
    entrySource(entry),
    relativeTimeKo(entry.openedAt),
    page ? `${page} / ${entry.numPages}쪽` : `${entry.numPages}쪽`,
  ].filter(Boolean).join(' · ');
  text.append(el('span', { className: 'rpdf-item-meta', textContent: meta }));
  const kind = libraryEntryKind(entry);
  const kindMark = icon(kindIcon(display.kindIcons === 'off' ? 'document' : kind, !(entry.urls[0] && !entry.urls[0].startsWith('file:'))));
  kindMark.dataset.kind = display.kindIcons === 'color' ? kind : '';
  main.append(kindMark, text);
  if (kind !== 'document') main.title = `${KIND_LABEL[kind]}\n${main.title}`;
  const badges = el('span', { className: 'rpdf-item-badges' });
  if (annotated.has(entry.docId)) {
    const pen = el('span', { className: 'rpdf-badge', title: '필기 있음' });
    pen.append(icon('i-pen'));
    badges.append(pen);
  }
  if (openTabFor(entry.docId)) badges.append(el('span', { className: 'rpdf-badge rpdf-badge-open', textContent: '열림' }));
  main.append(badges);
  main.addEventListener('click', () => openEntry(entry));
  row.append(main);
  if (options.add) {
    const add = el('button', { type: 'button', className: 'rpdf-item-act', title: `${currentProject().name}에 추가` });
    add.setAttribute('aria-label', `${entryName(entry)}을(를) ${currentProject().name}에 추가`);
    add.append(icon('i-plus'));
    add.addEventListener('click', () => {
      registered.add(entry.docId);
      void sendProjectUpdate({ kind: 'member', id: projectId, docId: entry.docId, member: true });
      showToast(`${currentProject().name}에 추가했습니다.`);
    });
    row.append(add);
  }
  const pin = el('button', { type: 'button', className: 'rpdf-item-pin', title: pinned ? '고정 해제' : '고정 — 이 프로젝트의 탭 왼쪽에 둡니다' });
  pin.setAttribute('aria-pressed', String(pinned));
  pin.setAttribute('aria-label', pinned ? `${entryName(entry)} 고정 해제` : `${entryName(entry)} 고정`);
  pin.append(icon('i-pin'));
  pin.addEventListener('click', () => setPinnedById(entry.docId, !pinned));
  row.append(pin);
  const more = el('button', { type: 'button', className: 'rpdf-item-act rpdf-item-more', title: '더 보기' });
  more.setAttribute('aria-label', `${entryName(entry)} 더 보기`);
  more.append(icon('i-more'));
  more.addEventListener('click', () => { const r = more.getBoundingClientRect(); showDocMenu([entry.docId], r.left - 160, r.bottom + 4); });
  row.append(more);
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); showDocMenu([entry.docId], e.clientX, e.clientY); });
  if (page && entry.numPages > 1) {
    const bar = el('span', { className: 'rpdf-item-progress' });
    const fill = el('span');
    fill.style.width = `${Math.round(Math.min(1, page / entry.numPages) * 100)}%`;
    bar.append(fill);
    row.append(bar);
  }
  if (options.pinnedList) wirePinDrag(row, entry.docId);
  return row;
}

// ─── Pin order: drag on home or in the strip ───

/** Writes `docIds` (this project's pins) in this order; applied here at once. */
function setPinOrder(docIds: string[]): void {
  const keys = orderKeysBetween(null, null, docIds.length);
  const update: PdfProjectUpdate = { kind: 'pin-order', id: projectId, order: docIds.map((docId, i) => ({ docId, order: keys[i] })) };
  projects = applyPdfProjectUpdate(projects, update);
  void sendProjectUpdate(update);
  reconcilePinned();
  scheduleHomeRender();
}

let pinDragDoc: string | null = null;
function wirePinDrag(row: HTMLElement, docId: string): void {
  row.draggable = true;
  row.classList.add('is-draggable');
  row.addEventListener('dragstart', (e) => {
    pinDragDoc = docId;
    row.classList.add('is-dragging');
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', docId); }
  });
  row.addEventListener('dragend', () => {
    pinDragDoc = null;
    row.classList.remove('is-dragging');
    for (const r of Array.from(homeSections.querySelectorAll('.drop-before, .drop-after'))) r.classList.remove('drop-before', 'drop-after');
  });
  const after = (e: DragEvent) => { const r = row.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
  row.addEventListener('dragover', (e) => {
    if (!pinDragDoc || pinDragDoc === docId) return;
    e.preventDefault();
    row.classList.toggle('drop-after', after(e));
    row.classList.toggle('drop-before', !after(e));
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
  row.addEventListener('drop', (e) => {
    const moving = pinDragDoc;
    row.classList.remove('drop-before', 'drop-after');
    if (!moving || moving === docId) return;
    e.preventDefault();
    const order = pinnedDocIds().filter((id) => id !== moving);
    order.splice(order.indexOf(docId) + (after(e) ? 1 : 0), 0, moving);
    setPinOrder(order);
  });
}

// ─── Actions on documents (a row's ⋯, or the selection) ───

/** Projects to offer for `docIds`: live ones but this one, in list order; `holds` marks where all of them already are. */
function projectChoices(docIds: string[]): Array<{ project: PdfProject; holds: boolean }> {
  const { root, items } = pdfProjectTree(projects, folders);
  const all = [root, ...items.flatMap((item) => (item.kind === 'project' ? [item.project] : item.projects))];
  return all.filter((p) => p.id !== projectId).map((project) => ({ project, holds: docIds.every((id) => isDocInProject(projects, project.id, id)) }));
}

function docsLabel(docIds: string[]): string {
  return docIds.length === 1 ? `‘${entryName(library[docIds[0]])}’` : `${docIds.length}개 문서`;
}

/** Registers the documents to `to` too (they stay where they are). */
function addDocsToProject(docIds: string[], to: string): void {
  for (const docId of docIds) void sendProjectUpdate({ kind: 'member', id: to, docId, member: true });
  showToast(`${docsLabel(docIds)}를 ${projectName(to)}에도 추가했습니다.`, { label: '열기', run: () => { void openProject(to); } });
}

/** Moves the documents to `to`: open tabs here go with them. */
async function moveDocsToProject(docIds: string[], to: string): Promise<void> {
  let moved = 0;
  for (const docId of docIds) {
    if (isDocInProject(projects, to, docId)) continue;
    const tab = openTabFor(docId);
    const from = moveSource(docId);
    if (from === to) continue;
    const response = await ask<{ success?: boolean }>({
      type: 'VOCAB_T_PDF_PROJECT_MOVE', docId, url: tab?.url ?? library[docId]?.urls[0] ?? null, from, to, keep: false,
    });
    if (!response?.success) continue;
    moved += 1;
    pendingPins.delete(docId);
    if (tab && tabs.includes(tab)) removeTab(tab);
  }
  render();
  showToast(moved ? `${moved}개 문서를 ${projectName(to)}(으)로 옮겼습니다.` : '옮길 문서가 없습니다.', moved ? { label: '열기', run: () => { void openProject(to); } } : undefined);
}

function removeDocsFromProject(docIds: string[]): void {
  const inside = docIds.filter((id) => projectId !== DEFAULT_PROJECT_ID && isDocInProject(projects, projectId, id));
  for (const docId of inside) {
    void sendProjectUpdate({ kind: 'member', id: projectId, docId, member: false });
    registered.add(docId);
    const tab = openTabFor(docId);
    if (tab) { if (tab.pinned) { tab.pinned = false; tab.keepOnUnpin = false; } closeTab(tab.key, false); }
  }
  showToast(`${docsLabel(inside)}를 이 프로젝트에서 뺐습니다.`, {
    label: '되돌리기',
    run: () => { for (const docId of inside) void sendProjectUpdate({ kind: 'member', id: projectId, docId, member: true }); },
  });
}

function showProjectPicker(docIds: string[], mode: 'add' | 'move', x: number, y: number): void {
  const choices = projectChoices(docIds).filter((c) => mode === 'move' || c.project.id !== DEFAULT_PROJECT_ID);
  showMenu([
    { heading: mode === 'add' ? '다른 프로젝트에도 추가' : '다른 프로젝트로 옮기기' },
    ...choices.map(({ project, holds }) => ({
      label: holds ? `${project.name} — 이미 있음` : project.name,
      disabled: holds,
      run: () => {
        if (mode === 'add') addDocsToProject(docIds, project.id);
        else void moveDocsToProject(docIds, project.id);
        selected.clear();
        scheduleHomeRender();
      },
    })),
    ...(choices.length === 0 ? [{ label: '다른 프로젝트가 없습니다', disabled: true, run: () => undefined }] : []),
  ], x, y);
}

function showDocMenu(docIds: string[], x: number, y: number): void {
  const one = docIds.length === 1 ? library[docIds[0]] : undefined;
  const allPinned = docIds.every(isPinnedDoc);
  const inHere = projectId !== DEFAULT_PROJECT_ID && docIds.some((id) => isDocInProject(projects, projectId, id));
  const entries: MenuEntry[] = [];
  if (one) entries.push({ label: '열기', run: () => openEntry(one) });
  entries.push(
    { label: allPinned ? '고정 해제' : '고정', run: () => { for (const id of docIds) setPinnedById(id, !allPinned); } },
    'sep',
    { label: '다른 프로젝트에도 추가…', run: () => showProjectPicker(docIds, 'add', x, y) },
    { label: '다른 프로젝트로 옮기기…', run: () => showProjectPicker(docIds, 'move', x, y) },
  );
  if (inHere) entries.push({ label: '이 프로젝트에서 빼기', run: () => { removeDocsFromProject(docIds); selected.clear(); scheduleHomeRender(); } });
  if (one) {
    entries.push('sep', { label: `문서 종류: ${KIND_LABEL[libraryEntryKind(one)]}…`, run: () => showKindMenu(one.docId, x, y) });
    const url = one.urls[0];
    if (url) entries.push({ label: '주소 복사', run: () => { void navigator.clipboard.writeText(url).then(() => showToast('주소를 복사했습니다.'), () => showToast('주소를 복사하지 못했습니다.')); } });
  }
  showMenu(entries, x, y);
}

// The bar at the bottom of home while documents are selected.
const selectionBar = el('div', { className: 'rpdf-selbar', hidden: true });
selectionBar.setAttribute('role', 'toolbar');
selectionBar.setAttribute('aria-label', '선택한 문서');
home.append(selectionBar);

function renderSelectionBar(): void {
  for (const id of [...selected]) if (!library[id]) selected.delete(id);
  selectionBar.hidden = selected.size === 0;
  home.classList.toggle('has-selection', selected.size > 0);
  if (selected.size === 0) { selectionBar.replaceChildren(); return; }
  const ids = [...selected];
  const button = (label: string, run: (b: HTMLButtonElement) => void) => {
    const b = el('button', { type: 'button', className: 'rpdf-selbar-btn', textContent: label });
    b.addEventListener('click', () => run(b));
    return b;
  };
  const at = (b: HTMLButtonElement) => { const r = b.getBoundingClientRect(); return { x: r.left, y: r.top - 8 - Math.min(320, 34 * (projectChoices(ids).length + 1)) }; };
  const allPinned = ids.every(isPinnedDoc);
  const inHere = projectId !== DEFAULT_PROJECT_ID && ids.some((id) => isDocInProject(projects, projectId, id));
  selectionBar.replaceChildren(
    el('span', { className: 'rpdf-selbar-count', textContent: `${selected.size}개 선택` }),
    el('span', { className: 'rpdf-selbar-gap' }),
    button('다른 프로젝트에도 추가', (b) => { const p = at(b); showProjectPicker(ids, 'add', p.x, p.y); }),
    button('옮기기', (b) => { const p = at(b); showProjectPicker(ids, 'move', p.x, p.y); }),
    button(allPinned ? '고정 해제' : '고정', () => { for (const id of ids) setPinnedById(id, !allPinned); selected.clear(); renderSelectionBar(); scheduleHomeRender(); }),
    ...(inHere ? [button('이 프로젝트에서 빼기', () => { removeDocsFromProject(ids); selected.clear(); renderSelectionBar(); scheduleHomeRender(); })] : []),
    button('선택 해제', () => { selected.clear(); renderSelectionBar(); scheduleHomeRender(); }),
  );
}

function homeSection(title: string, rows: HTMLElement[], extra?: HTMLElement, tools?: HTMLElement): HTMLElement {
  const section = el('section', { className: 'rpdf-home-section' });
  const head = el('div', { className: 'rpdf-home-section-head' });
  head.append(el('h2', { textContent: title }));
  if (tools) head.append(tools);
  section.append(head);
  const list = el('ul', { className: 'rpdf-items' });
  list.append(...rows);
  section.append(list);
  if (extra) section.append(extra);
  return section;
}

function moreButton(total: number, onMore: () => void): HTMLElement | undefined {
  if (total <= homeLimit) return undefined;
  const more = el('button', { type: 'button', className: 'rpdf-more', textContent: `더 보기 (${total - homeLimit}개 더)` });
  more.addEventListener('click', onMore);
  return more;
}

/** Filter chips (with counts over `entries`) and the sort menu. */
function homeTools(entries: PdfLibraryEntry[]): HTMLElement {
  const bar = el('div', { className: 'rpdf-home-tools' });
  const chips = el('div', { className: 'rpdf-chips', role: 'group' });
  chips.setAttribute('aria-label', '거르기');
  // Kind chips only when there is more than one kind to tell apart.
  const kinds = KIND_ORDER.filter((k) => entries.some((e) => libraryEntryKind(e) === k));
  const filters: HomeFilter[] = ['all', ...(kinds.length > 1 ? kinds : []), 'annotated', 'reading', 'unread'];
  for (const filter of filters) {
    const count = entries.filter((e) => matchesFilter(e, filter)).length;
    if (count === 0 && filter !== 'all' && filter !== homeView.filter) continue;
    const label = filter in HOME_FILTER_LABEL ? HOME_FILTER_LABEL[filter as keyof typeof HOME_FILTER_LABEL] : KIND_LABEL[filter as PdfDocKind];
    const chip = el('button', { type: 'button', className: 'rpdf-chip', textContent: `${label} ${count}` });
    chip.setAttribute('aria-pressed', String(homeView.filter === filter));
    chip.addEventListener('click', () => setHomeView({ filter: homeView.filter === filter ? 'all' : filter }));
    chips.append(chip);
  }
  const sort = el('select', { className: 'rpdf-sort' });
  sort.setAttribute('aria-label', '정렬');
  for (const [value, label] of Object.entries(HOME_SORT_LABEL)) sort.append(el('option', { value, textContent: label, selected: homeView.sort === value }));
  sort.addEventListener('change', () => setHomeView({ sort: sort.value as HomeSort }));
  bar.append(chips, sort);
  return bar;
}

function renderHome(): void {
  const project = currentProject();
  homeTitle.replaceChildren(projectBadge(project), document.createTextNode(project.name));
  const entries = Object.values(library);
  const index = membershipIndex();
  const isDefault = projectId === DEFAULT_PROJECT_ID;
  const otherNames = (docId: string) => (index.get(docId) ?? []).filter((id) => id !== projectId).map(projectName);
  const query = homeSearch.value.trim();
  const sections: HTMLElement[] = [];
  renderSelectionBar();
  if (query) {
    const found = searchPdfLibrary(entries, query);
    sections.push(found.length
      ? homeSection(`검색 결과 ${found.length}개`, found.slice(0, 100).map((e) => homeRow(e, { elsewhere: otherNames(e.docId) })))
      : el('p', { className: 'rpdf-home-empty', textContent: '일치하는 PDF가 없습니다.' }));
    homeSections.replaceChildren(...sections);
    return;
  }
  const pinnedIds = pinnedDocIds();
  const pinned = pinnedIds.map((id) => library[id]).filter((e): e is PdfLibraryEntry => !!e);
  if (pinned.length) {
    const hint = el('span', { className: 'rpdf-home-hint-inline', textContent: pinned.length > 1 ? '끌어서 순서 변경 · 탭 줄 순서와 같음' : '' });
    sections.push(homeSection('고정', pinned.map((e) => homeRow(e, { pinnedList: true })), undefined, hint));
  }
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
  const pinnedSet = new Set(pinnedIds);
  const mine = entries.filter((e) => !pinnedSet.has(e.docId) && inThisProject(e.docId, index));
  const others = isDefault ? [] : entries.filter((e) => !pinnedSet.has(e.docId) && !inThisProject(e.docId, index));
  const tools = homeTools([...mine, ...others]);
  const shown = (list: PdfLibraryEntry[]) => sortEntries(list.filter((e) => matchesFilter(e, homeView.filter)), homeView.sort);
  const mineShown = shown(mine);
  if (isDefault) {
    if (mine.length) {
      sections.push(homeSection('문서', mineShown.slice(0, homeLimit).map((e) => homeRow(e)), moreButton(mineShown.length, () => { homeLimit += HOME_PAGE_SIZE; renderHome(); }), tools));
      if (mineShown.length === 0) sections[sections.length - 1].append(el('p', { className: 'rpdf-home-hint', textContent: '이 조건에 맞는 문서가 없습니다.' }));
    }
    if (sections.length === 0) {
      sections.push(el('p', {
        className: 'rpdf-home-empty',
        textContent: '아직 연 PDF가 없습니다. 웹에서 PDF를 열거나, 파일을 이 창에 끌어다 놓으세요. 처음 연 PDF는 기본 프로젝트에 모이고, 위의 ‘프로젝트로 이동’으로 다른 프로젝트에 옮길 수 있습니다.',
      }));
    }
    homeSections.replaceChildren(...sections);
    return;
  }
  const own = homeSection('이 프로젝트의 문서', mineShown.map((e) => homeRow(e)), undefined, tools);
  if (mine.length === 0) {
    own.append(el('p', {
      className: 'rpdf-home-hint',
      textContent: '아직 문서가 없습니다. 아래 목록에서 열거나 +로 추가하고, 다른 프로젝트의 탭에서는 ‘프로젝트로 이동’을 쓰세요. 이 프로젝트에서 연 PDF는 자동으로 추가됩니다.',
    }));
  } else if (mineShown.length === 0) {
    own.append(el('p', { className: 'rpdf-home-hint', textContent: '이 조건에 맞는 문서가 없습니다.' }));
  }
  sections.push(own);
  const othersShown = shown(others);
  if (othersShown.length) {
    sections.push(homeSection(
      '다른 PDF',
      othersShown.slice(0, homeLimit).map((e) => homeRow(e, { add: true, elsewhere: otherNames(e.docId) })),
      moreButton(othersShown.length, () => { homeLimit += HOME_PAGE_SIZE; renderHome(); }),
    ));
  }
  homeSections.replaceChildren(...sections);
}

homeBtn.addEventListener('click', () => showHome(true));
settingsBtn.addEventListener('click', () => { if (activeKey === SETTINGS) showHome(false); else showSettings(); });
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

/** Asks every loaded viewer to store its drawings and position now. */
function storeFrames(): Promise<unknown> {
  return Promise.all(tabs.filter((t) => t.frame).map((tab) => new Promise<void>((resolve) => {
    const id = ++sleepSeq;
    const done = () => { sleepWaiters.delete(id); resolve(); };
    sleepWaiters.set(id, done);
    postToFrame(tab, { tag: HUB_MESSAGE_TAG, kind: 'sleep', id });
    setTimeout(done, SLEEP_REPLY_TIMEOUT_MS);
  })));
}

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
      registerDoc(message.docId);
      if (tab.pendingMove) {
        const { to, keep } = tab.pendingMove;
        tab.pendingMove = null;
        void moveTab(tab, to, keep);
      }
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
    if (!projectsPanel.hidden) { hideProjects(); projectBtn.focus(); return; }
    if (!stylePanel.hidden) { hideStyle(); projectBtn.focus(); return; }
    if (!movePanel.hidden) { hideMove(); moveBtn.focus(); return; }
  }
  if (document.activeElement?.closest('.rpdf-tab') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    step(e.key === 'ArrowRight' ? 'next' : 'prev');
  }
});

// ─── Looks: document kinds, project badges, the tab's icon ───

const KIND_LABEL: Record<PdfDocKind, string> = {
  journal: '저널 논문',
  conference: '학회 논문',
  preprint: '프리프린트',
  survey: '서베이·리뷰',
  technical: '보고서·학위논문',
  document: '일반 PDF',
};
const KIND_ORDER: PdfDocKind[] = ['journal', 'conference', 'preprint', 'survey', 'technical', 'document'];

/** The document's kind: automatic (what the paper strip found), or one the user picks. */
function showKindMenu(docId: string, x: number, y: number): void {
  const entry = library[docId];
  if (!entry) return;
  const set = (userKind: PdfDocKind | null) => { void sendLibraryUpdate({ kind: 'user-kind', docId, userKind }); };
  showMenu([
    { heading: '문서 종류' },
    { label: `자동 — ${KIND_LABEL[entry.paperKind ?? 'document']}`, checked: entry.userKind === null, run: () => set(null) },
    'sep',
    ...KIND_ORDER.map((kind) => ({ label: KIND_LABEL[kind], checked: entry.userKind === kind, run: () => set(kind) })),
  ], x, y);
}

function docKind(docId: string | null): PdfDocKind {
  const entry = docId ? library[docId] : undefined;
  return entry ? libraryEntryKind(entry) : 'document';
}

function kindIcon(kind: PdfDocKind, local: boolean): string {
  return kind === 'document' ? (local ? 'i-file-local' : 'i-file') : `i-kind-${kind}`;
}

/** Draws `project`'s icon, emoji or first letter into `badge`. */
function fillBadge(badge: HTMLElement, project: PdfProject): void {
  const look = pdfProjectLook(project);
  badge.dataset.look = look.kind;
  badge.style.setProperty('--badge', look.color);
  badge.replaceChildren(look.kind === 'icon' ? icon(`i-proj-${look.value}`) : document.createTextNode(look.value));
}

function projectBadge(project: PdfProject): HTMLSpanElement {
  const badge = el('span', { className: 'rpdf-pbadge' });
  badge.setAttribute('aria-hidden', 'true');
  fillBadge(badge, project);
  return badge;
}

// The hub tab's icon in Chrome is its project's, so hubs of different
// projects tell apart in the tab strip. The default project, never styled,
// keeps the app icon.
const faviconLink = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
const APP_FAVICON = faviconLink?.getAttribute('href') ?? 'icons/icon-32.png';
let faviconKey = '';

function updateFavicon(): void {
  if (!faviconLink) return;
  const project = currentProject();
  const look = pdfProjectLook(project);
  const plain = !display.projectFavicon || (project.id === DEFAULT_PROJECT_ID && !project.icon && !project.color);
  const key = plain ? 'app' : `${look.kind}|${look.value}|${look.color}`;
  if (key === faviconKey) return;
  faviconKey = key;
  if (plain) { faviconLink.href = APP_FAVICON; return; }
  void drawFavicon(look).then((url) => { if (url && faviconKey === key) faviconLink.href = url; });
}

async function drawFavicon(look: ReturnType<typeof pdfProjectLook>): Promise<string | null> {
  const size = 64;
  const canvas = el('canvas', { width: size, height: size });
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (look.kind === 'emoji') {
    ctx.font = `${Math.round(size * 0.84)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    ctx.fillText(look.value, size / 2, size * 0.55);
    return canvas.toDataURL('image/png');
  }
  ctx.fillStyle = look.color;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, size * 0.22);
  ctx.fill();
  if (look.kind === 'letter') {
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${Math.round(size * 0.6)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.fillText(look.value, size / 2, size * 0.55);
    return canvas.toDataURL('image/png');
  }
  const symbol = document.getElementById(`i-proj-${look.value}`);
  if (symbol) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${symbol.innerHTML}</svg>`;
    const image = new Image(size, size);
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    try {
      await image.decode();
      const inset = size * 0.16;
      ctx.drawImage(image, inset, inset, size - inset * 2, size - inset * 2);
    } catch {
      /* the colored square alone */
    }
  }
  return canvas.toDataURL('image/png');
}

// ─── Project icon picker ───

const SUGGESTED_EMOJI = ['📚', '🧪', '🤖', '🧠', '💡', '🎯', '📈', '🧬', '🔭', '🌱', '⚙️', '📝', '🎓', '🗂️', '🔬', '🚀'];
let styleTarget: string | null = null;

function showStyle(id: string): void {
  hidePanels();
  styleTarget = id;
  stylePanel.hidden = false;
  projectBtn.setAttribute('aria-expanded', 'true');
  styleEmojiInput.value = '';
  renderStyle();
  styleIcons.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
}

function hideStyle(): void {
  if (stylePanel.hidden) return;
  stylePanel.hidden = true;
  styleTarget = null;
  projectBtn.setAttribute('aria-expanded', 'false');
}

function renderStyle(): void {
  const project = styleTarget ? projects[styleTarget] : undefined;
  if (!project || project.deletedAt !== 0) { hideStyle(); return; }
  fillBadge(stylePreview, project);
  styleTitle.textContent = project.name;
  const choice = (label: string, selected: boolean, content: Node | string, run: () => void, className = 'rpdf-style-choice') => {
    const button = el('button', { type: 'button', className, title: label });
    button.setAttribute('role', 'option');
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-selected', String(selected));
    button.append(content);
    button.addEventListener('click', run);
    return button;
  };
  styleIcons.replaceChildren(...PDF_PROJECT_ICONS.map((name) =>
    choice(name, project.icon === `i:${name}`, icon(`i-proj-${name}`), () => setStyle(project, `i:${name}`, project.color))));
  styleEmojis.replaceChildren(...SUGGESTED_EMOJI.map((emoji) =>
    choice(emoji, project.icon === `e:${emoji}`, emoji, () => setStyle(project, `e:${emoji}`, project.color))));
  const color = pdfProjectLook(project).color;
  styleColors.replaceChildren(...Object.entries(PDF_PROJECT_COLORS).map(([id, hex]) => {
    const swatch = choice(id, project.color === id || (!project.color && hex === color), '', () => setStyle(project, project.icon, id), 'rpdf-style-swatch');
    swatch.style.setProperty('--swatch', hex);
    return swatch;
  }));
}

/** Applies the look here at once; storage confirms it a moment later. */
function setStyle(project: PdfProject, iconValue: string | null, color: string | null): void {
  void sendProjectUpdate({ kind: 'style', id: project.id, icon: iconValue, color });
  projects = { ...projects, [project.id]: { ...project, icon: iconValue, color } };
  if (project.id === projectId) updateProjectLabel();
  renderStyle();
}

styleBack.addEventListener('click', () => { hideStyle(); showProjects(); });
styleDone.addEventListener('click', () => { hideStyle(); projectBtn.focus(); });
styleReset.addEventListener('click', () => {
  const project = styleTarget ? projects[styleTarget] : undefined;
  if (project) setStyle(project, null, null);
});
const takeEmoji = () => {
  const project = styleTarget ? projects[styleTarget] : undefined;
  const value = pdfProjectEmojiIcon(styleEmojiInput.value);
  if (!project || !styleEmojiInput.value.trim()) return;
  if (!value) { showToast('이모지 하나를 입력하세요.'); return; }
  styleEmojiInput.value = '';
  setStyle(project, value, project.color);
};
styleEmojiInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); takeEmoji(); } });
styleEmojiInput.addEventListener('change', takeEmoji);

// ─── Projects: switcher, move, rehoming ───

function projectDocCount(project: PdfProject, index: Map<string, string[]>): number {
  if (project.id !== DEFAULT_PROJECT_ID) return project.members.filter((m) => m.member).length;
  return Object.keys(library).filter((docId) => !index.has(docId)).length;
}

function updateProjectLabel(): void {
  const name = currentProject().name;
  projectNameEl.textContent = name;
  fillBadge(projectBadgeEl, currentProject());
  updateFavicon();
  projectBtn.title = `프로젝트: ${name} — 다른 프로젝트 열기, 새로 만들기`;
  projectBtn.setAttribute('aria-label', `프로젝트 ${name}`);
}

function setProject(id: string): void {
  if (id === projectId) return;
  projectId = id;
  closed = loadClosed();
  registered.clear();
  pendingPins.clear();
  reconcilePinned();
  updateProjectLabel();
  render();
  scheduleHomeRender();
}

function refreshPanels(): void {
  if (!projectsPanel.hidden) renderProjects();
  if (!stylePanel.hidden) renderStyle();
  if (!movePanel.hidden && moveTarget) renderMove(moveTarget);
}

async function createProject(rawName: string): Promise<string | null> {
  const name = cleanPdfProjectName(rawName);
  if (!name) return null;
  const id = newPdfProjectId();
  // Awaited: the next request (open, move) must find the project stored.
  const response = await sendProjectUpdate({ kind: 'create', id, name }) as { success?: boolean } | undefined;
  if (!response?.success) { showToast('프로젝트를 만들지 못했습니다.'); return null; }
  return id;
}

/**
 * Shows project `id`: in this tab (the default), or in a new tab next to it.
 * A project already open in another tab is brought forward instead.
 */
async function openProject(id: string, where: 'here' | 'new-tab' = 'here'): Promise<void> {
  if (id === projectId) return;
  const response = await ask<{ success?: boolean; url?: string; error?: string }>({
    type: 'VOCAB_T_PDF_PROJECT_OPEN', project: id, inPlace: where === 'here',
  });
  if (!response?.success) { showToast(response?.error ?? '프로젝트를 열지 못했습니다.'); return; }
  if (response.url) await switchHere(response.url);
}

/** Leaves this project (its tabs saved, as when its tab closes) and loads `url` here. */
let switching = false;
async function switchHere(url: string): Promise<void> {
  if (switching || !isHub) return;
  switching = true;
  hidePanels();
  if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
  await storeFrames();
  await ask({ type: 'VOCAB_T_PDF_HUB_STATE', ...hubState(), project: projectId });
  isHub = false; // nothing more is recorded for this project from here
  location.replace(url);
}

// The list: the default project, then folders (one level) and projects in
// the user's order. Rows drag to reorder or into / out of folders, Alt+↑/↓
// moves the focused one; "⋯" (or a right click) has the rest.

type ListRef = { kind: 'project' | 'folder'; id: string };
const COLLAPSED_KEY = 'rpdfFoldersCollapsed';
let dragging: ListRef | null = null;
let focusAfterRender: string | null = null;

function collapsedFolders(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function setFolderCollapsed(id: string, collapsed: boolean): void {
  const ids = collapsedFolders();
  if (collapsed) ids.add(id); else ids.delete(id);
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids])); } catch { /* per-device nicety */ }
}

function rowAction(row: HTMLElement, name: string, label: string, run: (button: HTMLButtonElement) => void, subject: string): HTMLButtonElement {
  const button = el('button', { type: 'button', className: 'rpdf-li-action', title: label });
  button.setAttribute('aria-label', `${subject} ${label}`);
  button.append(icon(name));
  button.addEventListener('click', (e) => { e.stopPropagation(); run(button); });
  row.append(button);
  return button;
}

function menuAt(button: HTMLElement): { x: number; y: number } {
  const rect = button.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom + 4 };
}

function projectRow(project: PdfProject, index: Map<string, string[]>, folder: string | null): HTMLElement {
  const row = el('div', { className: 'rpdf-li' });
  const current = project.id === projectId;
  row.classList.toggle('is-current', current);
  row.classList.toggle('is-nested', folder !== null);
  row.dataset.kind = project.id === DEFAULT_PROJECT_ID ? 'root' : 'project';
  row.dataset.id = project.id;
  row.dataset.parent = folder ?? '';
  const main = el('button', { type: 'button', className: 'rpdf-li-main' });
  const text = el('span', { className: 'rpdf-li-text' });
  const open = current || openProjectIds.has(project.id);
  text.append(
    el('span', { className: 'rpdf-li-title', textContent: project.name }),
    el('span', { className: 'rpdf-li-sub', textContent: [current ? '지금 보는 중' : open ? '열림' : null, `문서 ${projectDocCount(project, index)}개`].filter(Boolean).join(' · ') }),
  );
  main.append(projectBadge(project), text);
  if (current) main.setAttribute('aria-current', 'true');
  main.addEventListener('click', () => { hideProjects(); void openProject(project.id); });
  row.append(main);
  if (!current) rowAction(row, 'i-open-new', '새 탭에서 열기', () => { hideProjects(); void openProject(project.id, 'new-tab'); }, project.name);
  rowAction(row, 'i-more', '더 보기', (button) => { const at = menuAt(button); showProjectMenu(project, at.x, at.y); }, project.name);
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); showProjectMenu(project, e.clientX, e.clientY); });
  wireListDrag(row);
  return row;
}

function folderRow(folder: PdfProjectFolder, count: number, shut: boolean): HTMLElement {
  const row = el('div', { className: 'rpdf-li rpdf-folder' });
  row.classList.toggle('is-shut', shut);
  row.dataset.kind = 'folder';
  row.dataset.id = folder.id;
  row.dataset.parent = '';
  const main = el('button', { type: 'button', className: 'rpdf-li-main' });
  main.setAttribute('aria-expanded', String(!shut));
  const text = el('span', { className: 'rpdf-li-text' });
  text.append(
    el('span', { className: 'rpdf-li-title', textContent: folder.name }),
    el('span', { className: 'rpdf-li-sub', textContent: count ? `프로젝트 ${count}개` : '비어 있음 — 프로젝트를 끌어다 넣으세요' }),
  );
  const chevron = icon('i-chevron');
  chevron.classList.add('rpdf-folder-chevron');
  main.append(chevron, icon('i-folder'), text);
  main.title = shut ? '펼치기' : '접기';
  main.addEventListener('click', () => { setFolderCollapsed(folder.id, !shut); focusAfterRender = folder.id; renderProjects(); });
  row.append(main);
  rowAction(row, 'i-more', '더 보기', (button) => { const at = menuAt(button); showFolderMenu(folder, at.x, at.y); }, folder.name);
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); showFolderMenu(folder, e.clientX, e.clientY); });
  wireListDrag(row);
  return row;
}

/** Turns a row into a name field; `save` gets the cleaned new name. */
function startRename(row: HTMLElement, name: string, label: string, save: (name: string) => void): void {
  const input = el('input', { type: 'text', className: 'rpdf-li-rename', value: name, maxLength: 60 });
  input.setAttribute('aria-label', label);
  row.replaceChildren(input);
  row.draggable = false;
  input.focus();
  input.select();
  let done = false;
  const finish = (keep: boolean) => {
    if (done) return;
    done = true;
    const next = cleanPdfProjectName(input.value);
    if (keep && next && next !== name) save(next);
    focusAfterRender = row.dataset.id ?? null;
    renderProjects();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

function listRow(id: string): HTMLElement | null {
  return Array.from(projectsItems.querySelectorAll<HTMLElement>('.rpdf-li')).find((row) => row.dataset.id === id) ?? null;
}

function renderProjects(): void {
  const index = membershipIndex();
  const { root, items } = pdfProjectTree(projects, folders);
  const collapsed = collapsedFolders();
  const rows: HTMLElement[] = [el('h3', { className: 'rpdf-li-head', textContent: '프로젝트' }), projectRow(root, index, null)];
  for (const item of items) {
    if (item.kind === 'project') { rows.push(projectRow(item.project, index, null)); continue; }
    const shut = collapsed.has(item.folder.id);
    rows.push(folderRow(item.folder, item.projects.length, shut));
    if (!shut) rows.push(...item.projects.map((project) => projectRow(project, index, item.folder.id)));
  }
  // Dropping here puts a project or folder last, outside every folder.
  const end = el('div', { className: 'rpdf-li-end' });
  end.dataset.kind = 'end';
  wireListDrag(end);
  rows.push(end);
  projectsItems.replaceChildren(...rows);
  if (focusAfterRender) {
    listRow(focusAfterRender)?.querySelector<HTMLButtonElement>('.rpdf-li-main')?.focus();
    focusAfterRender = null;
  }
}

// ─── Menus for the list ───

type MenuEntry = { label: string; run: () => void; disabled?: boolean; checked?: boolean } | 'sep' | { heading: string };

/** A small menu at (x, y); the panel it was opened from stays open. */
function showMenu(entries: MenuEntry[], x: number, y: number): void {
  menu.replaceChildren();
  for (const entry of entries) {
    if (entry === 'sep') { menu.append(el('hr')); continue; }
    if ('heading' in entry) { menu.append(el('p', { className: 'rpdf-menu-head', textContent: entry.heading })); continue; }
    const button = el('button', { type: 'button', className: 'rpdf-menu-item', textContent: entry.label, disabled: !!entry.disabled });
    button.setAttribute('role', entry.checked === undefined ? 'menuitem' : 'menuitemradio');
    if (entry.checked !== undefined) button.setAttribute('aria-checked', String(entry.checked));
    button.addEventListener('click', () => { hideMenu(); entry.run(); });
    menu.append(button);
  }
  menu.hidden = false;
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
  menu.querySelector<HTMLButtonElement>('.rpdf-menu-item:not(:disabled)')?.focus();
}

function showProjectMenu(project: PdfProject, x: number, y: number): void {
  const entries: MenuEntry[] = [
    { label: '아이콘·색 바꾸기…', run: () => showStyle(project.id) },
    { label: '이름 바꾸기', run: () => { const row = listRow(project.id); if (row) startRename(row, project.name, '프로젝트 이름', (name) => { void sendProjectUpdate({ kind: 'rename', id: project.id, name }); }); } },
  ];
  if (project.id !== DEFAULT_PROJECT_ID) {
    const { items } = pdfProjectTree(projects, folders);
    const list = items.filter((item): item is Extract<typeof item, { kind: 'folder' }> => item.kind === 'folder');
    entries.push('sep', { heading: '폴더로 옮기기' });
    for (const item of list) {
      entries.push({ label: item.folder.name, disabled: project.folder === item.folder.id, run: () => placeItem({ kind: 'project', id: project.id }, item.folder.id, Infinity) });
    }
    if (project.folder && folders[project.folder]?.deletedAt === 0) {
      entries.push({ label: '폴더 밖으로', run: () => placeAfterFolder(project.id, project.folder as string) });
    }
    entries.push({ label: '새 폴더 만들어 넣기…', run: () => { void newFolderWith(project.id); } });
    entries.push('sep', {
      label: '삭제',
      run: () => {
        const ok = confirm(`‘${project.name}’ 프로젝트를 삭제할까요?\n\n문서와 필기는 지워지지 않습니다. 다른 프로젝트에 없는 문서는 기본 프로젝트로 돌아갑니다.`);
        if (ok) void sendProjectUpdate({ kind: 'delete', id: project.id });
      },
    });
  }
  showMenu(entries, x, y);
}

function showFolderMenu(folder: PdfProjectFolder, x: number, y: number): void {
  showMenu([
    { label: '이름 바꾸기', run: () => { const row = listRow(folder.id); if (row) startRename(row, folder.name, '폴더 이름', (name) => { void sendProjectUpdate({ kind: 'folder-rename', id: folder.id, name }); }); } },
    {
      label: '폴더 삭제 (프로젝트는 남김)',
      run: () => {
        void sendProjectUpdate({ kind: 'folder-delete', id: folder.id });
        showToast(`‘${folder.name}’ 폴더를 지웠습니다. 안의 프로젝트는 목록에 그대로 있습니다.`);
      },
    },
  ], x, y);
}

// ─── Folders and order ───

/** The items of one level (null: the top), in list order. */
function siblingsOf(parent: string | null): Array<{ ref: ListRef; order: string | null }> {
  const { items } = pdfProjectTree(projects, folders);
  if (parent === null) {
    return items.map((item) => (item.kind === 'folder'
      ? { ref: { kind: 'folder' as const, id: item.folder.id }, order: item.folder.order }
      : { ref: { kind: 'project' as const, id: item.project.id }, order: item.project.order }));
  }
  const folder = items.find((item) => item.kind === 'folder' && item.folder.id === parent);
  return folder?.kind === 'folder' ? folder.projects.map((p) => ({ ref: { kind: 'project' as const, id: p.id }, order: p.order })) : [];
}

const sameRef = (a: ListRef, b: ListRef) => a.kind === b.kind && a.id === b.id;

/**
 * Puts `ref` into `parent` (a folder, or null: the top) at `index` among the
 * items there other than itself. Only its own key changes, unless the level
 * still has unkeyed items: then the whole level gets keys, in the order shown.
 */
function placeItem(ref: ListRef, parent: string | null, index: number): void {
  if (ref.kind === 'folder') parent = null;
  const siblings = siblingsOf(parent).filter((s) => !sameRef(s.ref, ref));
  const at = Math.max(0, Math.min(index, siblings.length));
  const before = at > 0 ? siblings[at - 1].order : null;
  const after = at < siblings.length ? siblings[at].order : null;
  const update: Extract<PdfFolderUpdate, { kind: 'arrange' }> = { kind: 'arrange', projects: [], folders: [] };
  const put = (item: ListRef, order: string) => {
    if (item.kind === 'project') update.projects.push({ id: item.id, folder: parent, order });
    else update.folders.push({ id: item.id, order });
  };
  const keyed = siblings.every((s) => s.order !== null) && (before === null || after === null || compareOrderKeys(before, after) < 0);
  if (keyed) {
    put(ref, orderKeyBetween(before, after));
  } else {
    const list = [...siblings.slice(0, at).map((s) => s.ref), ref, ...siblings.slice(at).map((s) => s.ref)];
    const keys = orderKeysBetween(null, null, list.length);
    list.forEach((item, i) => put(item, keys[i]));
  }
  focusAfterRender = ref.id;
  void sendProjectUpdate(update);
}

/** Out of its folder, right after it. */
function placeAfterFolder(projectIdToMove: string, folderId: string): void {
  const top = siblingsOf(null);
  const at = top.findIndex((s) => s.ref.kind === 'folder' && s.ref.id === folderId);
  placeItem({ kind: 'project', id: projectIdToMove }, null, at + 1);
}

/** A key for a new item at the end of the top level, if the level is keyed. */
function topEndKey(): string | null {
  const top = siblingsOf(null);
  if (top.some((s) => s.order === null)) return null;
  const last = top[top.length - 1]?.order ?? null;
  return orderKeyAtEnd(last);
}

async function createFolder(rawName: string): Promise<string | null> {
  const name = cleanPdfProjectName(rawName);
  if (!name) return null;
  const id = newPdfProjectFolderId();
  const response = await sendProjectUpdate({ kind: 'folder-create', id, name, order: topEndKey() }) as { success?: boolean } | undefined;
  if (!response?.success) { showToast('폴더를 만들지 못했습니다.'); return null; }
  return id;
}

async function newFolderWith(id: string): Promise<void> {
  const name = prompt('새 폴더 이름');
  const folder = name ? await createFolder(name) : null;
  if (!folder) return;
  // The folder must be in storage (and read back here) before placing into it.
  folders = { ...folders, [folder]: { id: folder, name: cleanPdfProjectName(name) ?? '', createdAt: Date.now(), renamedAt: Date.now(), deletedAt: 0, order: null, placedAt: 0 } };
  placeItem({ kind: 'project', id }, folder, Infinity);
}

// Drag and drop: where a drop on `row` would put the dragged item.
function dropPlace(row: HTMLElement, clientY: number): { parent: string | null; index: number; mark: 'before' | 'after' | 'into' } | null {
  const item = dragging;
  if (!item) return null;
  const kind = row.dataset.kind;
  const id = row.dataset.id ?? '';
  const parent = row.dataset.parent ? row.dataset.parent : null;
  const rect = row.getBoundingClientRect();
  const f = rect.height ? (clientY - rect.top) / rect.height : 0.5;
  const indexIn = (level: string | null, target: ListRef) => siblingsOf(level).filter((s) => !sameRef(s.ref, item)).findIndex((s) => sameRef(s.ref, target));
  if (kind === 'end') return { parent: null, index: Infinity, mark: 'before' };
  if (kind === 'root') return { parent: null, index: 0, mark: 'after' };
  if (kind === 'folder') {
    const target: ListRef = { kind: 'folder', id };
    if (sameRef(target, item)) return null;
    const at = indexIn(null, target);
    if (item.kind === 'folder') return f < 0.5 ? { parent: null, index: at, mark: 'before' } : { parent: null, index: at + 1, mark: 'after' };
    if (f < 0.3) return { parent: null, index: at, mark: 'before' };
    if (f > 0.75 && row.classList.contains('is-shut')) return { parent: null, index: at + 1, mark: 'after' };
    return { parent: id, index: Infinity, mark: 'into' };
  }
  if (kind === 'project') {
    const target: ListRef = { kind: 'project', id };
    if (sameRef(target, item)) return null;
    if (item.kind === 'folder' && parent !== null) return null;
    const at = indexIn(parent, target);
    return f < 0.5 ? { parent, index: at, mark: 'before' } : { parent, index: at + 1, mark: 'after' };
  }
  return null;
}

function clearDropMarks(): void {
  for (const row of Array.from(projectsItems.querySelectorAll('.drop-before, .drop-after, .drop-into'))) row.classList.remove('drop-before', 'drop-after', 'drop-into');
}

function wireListDrag(row: HTMLElement): void {
  const kind = row.dataset.kind;
  if (kind === 'project' || kind === 'folder') {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      dragging = { kind, id: row.dataset.id ?? '' };
      row.classList.add('is-dragging');
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', row.dataset.id ?? ''); }
    });
    row.addEventListener('dragend', () => { dragging = null; row.classList.remove('is-dragging'); clearDropMarks(); });
  }
  row.addEventListener('dragover', (e) => {
    const place = dropPlace(row, e.clientY);
    clearDropMarks();
    if (!place) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    row.classList.add(`drop-${place.mark}`);
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after', 'drop-into'));
  row.addEventListener('drop', (e) => {
    const place = dropPlace(row, e.clientY);
    const item = dragging;
    clearDropMarks();
    if (!place || !item) return;
    e.preventDefault();
    dragging = null;
    placeItem(item, place.parent, place.index);
  });
}

// Alt+↑/↓: the focused project or folder one place up or down its level.
projectsItems.addEventListener('keydown', (e) => {
  if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  const row = (e.target as HTMLElement).closest<HTMLElement>('.rpdf-li');
  const kind = row?.dataset.kind;
  if (!row || (kind !== 'project' && kind !== 'folder')) return;
  e.preventDefault();
  const ref: ListRef = { kind, id: row.dataset.id ?? '' };
  const parent = row.dataset.parent ? row.dataset.parent : null;
  const at = siblingsOf(parent).findIndex((s) => sameRef(s.ref, ref));
  const to = e.key === 'ArrowUp' ? at - 1 : at + 1;
  if (at < 0 || to < 0 || to >= siblingsOf(parent).length) return;
  placeItem(ref, parent, to);
});

function showProjects(): void {
  hidePanels();
  projectsPanel.hidden = false;
  projectBtn.setAttribute('aria-expanded', 'true');
  projectNewName.value = '';
  renderProjects();
  void loadOpenProjects().then(() => { if (!projectsPanel.hidden) renderProjects(); });
  projectsItems.querySelector<HTMLButtonElement>('.rpdf-li-main')?.focus();
}

function hideProjects(): void {
  if (projectsPanel.hidden) return;
  projectsPanel.hidden = true;
  projectBtn.setAttribute('aria-expanded', 'false');
}

projectBtn.addEventListener('click', () => {
  if (!stylePanel.hidden) hideStyle();
  else if (projectsPanel.hidden) showProjects();
  else hideProjects();
});
folderNewBtn.addEventListener('click', () => {
  const name = projectNewName.value;
  if (!cleanPdfProjectName(name)) { projectNewName.focus(); showToast('폴더 이름을 입력한 뒤 폴더 버튼을 누르세요.'); return; }
  void createFolder(name).then((id) => {
    if (!id) return;
    projectNewName.value = '';
    focusAfterRender = id;
  });
});
projectNewForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = projectNewName.value;
  void createProject(name).then((id) => {
    if (!id) return;
    hideProjects();
    void openProject(id);
  });
});

// "프로젝트로 이동": the document in front (or the one whose tab menu asked).
let moveTarget: HubTab | null = null;

/** Where the document is now: this project, or (a guest here) the one it belongs to. */
function moveSource(docId: string | null): string {
  if (!docId || isDocInProject(projects, projectId, docId)) return projectId;
  return projectsOfDoc(projects, docId)[0] ?? projectId;
}

function renderMove(tab: HubTab): void {
  const docId = tab.docId ?? tab.libraryId ?? (tab.url ? libraryIdForUrl(tab.url) : null);
  const from = moveSource(docId);
  moveTitle.textContent = `‘${tabName(tab)}’ 옮기기`;
  // Every project is listed, grouped as in the project list; the ones already
  // holding the document are shown disabled rather than left out, so none
  // seems to have vanished.
  const holds = (id: string) => id === from || (!!docId && isDocInProject(projects, id, docId));
  const projectRowFor = (project: PdfProject, nested: boolean) => {
    const inside = holds(project.id);
    const row = el('div', { className: inside ? 'rpdf-li is-disabled' : 'rpdf-li' });
    row.classList.toggle('is-nested', nested);
    const main = el('button', { type: 'button', className: 'rpdf-li-main' });
    const open = openProjectIds.has(project.id);
    const where = project.id === projectId ? '지금 이 프로젝트' : '이미 들어 있음';
    const text = el('span', { className: 'rpdf-li-text' });
    text.append(
      el('span', { className: 'rpdf-li-title', textContent: project.name }),
      el('span', { className: 'rpdf-li-sub', textContent: [open ? '열림' : '닫힘', inside ? where : null].filter(Boolean).join(' · ') }),
    );
    main.append(projectBadge(project), text);
    if (inside) {
      main.disabled = true;
      main.title = '이 문서가 이미 들어 있는 프로젝트입니다';
      row.append(main);
      return row;
    }
    main.title = '이 프로젝트로 옮기기';
    main.addEventListener('click', () => { hideMove(); void moveTab(tab, project.id, false); });
    row.append(main);
    if (project.id !== DEFAULT_PROJECT_ID) {
      const add = el('button', { type: 'button', className: 'rpdf-li-action', title: '여기에도 추가 (지금 프로젝트에도 남김)' });
      add.setAttribute('aria-label', `${project.name}에도 추가`);
      add.append(icon('i-plus'));
      add.addEventListener('click', () => { hideMove(); void moveTab(tab, project.id, true); });
      row.append(add);
    }
    return row;
  };
  const { root, items } = pdfProjectTree(projects, folders);
  const rows: HTMLElement[] = [projectRowFor(root, false)];
  for (const item of items) {
    if (item.kind === 'project') { rows.push(projectRowFor(item.project, false)); continue; }
    if (item.projects.length === 0) continue;
    const head = el('p', { className: 'rpdf-li-folder-head' });
    head.append(icon('i-folder'), el('span', { textContent: item.folder.name }));
    rows.push(head, ...item.projects.map((project) => projectRowFor(project, true)));
  }
  const every = [root, ...items.flatMap((item) => (item.kind === 'project' ? [item.project] : item.projects))];
  if (!every.some((p) => !holds(p.id))) rows.push(el('p', { className: 'rpdf-li-empty', textContent: '옮길 다른 프로젝트가 없습니다. 아래에서 새로 만드세요.' }));
  moveItems.replaceChildren(...rows);
}

function showMove(tab: HubTab | null = activeTab()): void {
  if (!tab) return;
  hidePanels();
  moveTarget = tab;
  movePanel.hidden = false;
  moveBtn.setAttribute('aria-expanded', 'true');
  moveNewName.value = '';
  renderMove(tab);
  void loadOpenProjects().then(() => { if (!movePanel.hidden && moveTarget) renderMove(moveTarget); });
  moveItems.querySelector<HTMLButtonElement>('.rpdf-li-main:not(:disabled)')?.focus();
}

function hideMove(): void {
  if (movePanel.hidden) return;
  movePanel.hidden = true;
  moveTarget = null;
  moveBtn.setAttribute('aria-expanded', 'false');
}

moveBtn.addEventListener('click', () => { if (movePanel.hidden) showMove(); else hideMove(); });
moveNewForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const tab = moveTarget;
  const name = moveNewName.value;
  if (!tab) return;
  void createProject(name).then((id) => {
    if (!id) return;
    hideMove();
    void moveTab(tab, id, false);
  });
});

/**
 * Moves the tab's document to project `to` (`keep`: registers it there and
 * leaves it here). The background puts it in that project's hub, or among
 * the tabs it opens with.
 */
async function moveTab(tab: HubTab, to: string, keep: boolean): Promise<void> {
  const docId = tab.docId ?? tab.libraryId ?? (tab.url ? libraryIdForUrl(tab.url) : null);
  if (!docId) {
    tab.pendingMove = { to, keep };
    ensureFrame(tab);
    showToast('문서를 불러온 뒤 옮깁니다.');
    return;
  }
  const from = moveSource(docId);
  const response = await ask<{ success?: boolean; open?: boolean; error?: string }>({
    type: 'VOCAB_T_PDF_PROJECT_MOVE', docId, url: tab.url, from, to, keep,
  });
  if (!response?.success) { showToast(response?.error ?? '옮기지 못했습니다.'); return; }
  const name = projectName(to);
  if (keep) { showToast(`${name}에도 추가했습니다.`); return; }
  pendingPins.delete(docId);
  if (tabs.includes(tab)) removeTab(tab);
  render();
  showToast(tab.url ? `${name}(으)로 옮겼습니다.` : `${name}(으)로 옮겼습니다. 로컬 파일은 그 프로젝트에서 다시 열어야 합니다.`, {
    label: '열기',
    run: () => { void openProject(to); },
  });
}

function removeFromProject(tab: HubTab, docId: string): void {
  void sendProjectUpdate({ kind: 'member', id: projectId, docId, member: false });
  registered.add(docId); // closing it must not register it again
  if (tab.pinned) { tab.pinned = false; tab.keepOnUnpin = false; }
  closeTab(tab.key, false);
  showToast('이 프로젝트에서 뺐습니다.', {
    label: '되돌리기',
    run: () => {
      void sendProjectUpdate({ kind: 'member', id: projectId, docId, member: true });
      if (tab.url) addDocs([{ url: tab.url, hash: '', file: null }], true);
    },
  });
}

/**
 * This hub's project was deleted: its documents go to the default project —
 * this hub becomes it, or hands them to its open hub and closes.
 */
let rehoming = false;
async function rehome(): Promise<void> {
  if (rehoming || !isHub) return;
  rehoming = true;
  // Pinned ones too: the pins went with the project.
  const docs = tabs.filter((t) => t.url).map((t) => ({ url: t.url as string, hash: '' }));
  const response = await ask<{ success?: boolean; role?: 'hub' | 'forwarded'; project?: string }>({
    type: 'VOCAB_T_PDF_HUB_CLAIM', docs, canGoBack: false, project: DEFAULT_PROJECT_ID,
  });
  rehoming = false;
  if (response?.success && response.role === 'forwarded') {
    isHub = false;
    if (myTabId !== null) void chrome.tabs.remove(myTabId).catch(() => undefined);
    return;
  }
  setProject(DEFAULT_PROJECT_ID);
  showToast('프로젝트가 삭제되어 이 탭은 기본 프로젝트가 되었습니다.');
}

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
  if (request.show === 'settings') showSettings();
  else if (request.docs.length === 0) showHome(false);
  else addDocs(request.docs.map((doc) => ({ ...doc, file: null })), request.activate);
  sendResponse({ ok: true });
  return false;
});

// ─── Upkeep: library rows an older build left incomplete ───
//
// Once the hub has settled, and only if some rows need it, a hidden frame
// (ui/pdfUpkeep.ts) brings them up to date one at a time; it says when it is
// done and goes away. Another hub already running it makes this one's a no-op.

const UPKEEP_DELAY_MS = 20_000;
const UPKEEP_MAX_MS = 15 * 60_000;
let upkeepFrame: HTMLIFrameElement | null = null;

function endUpkeep(): void {
  upkeepFrame?.remove();
  upkeepFrame = null;
}

async function startUpkeep(): Promise<void> {
  if (upkeepFrame || !isHub) return;
  const stored = await chrome.storage.local.get(PDF_UPKEEP_STORAGE_KEY).catch(() => ({} as Record<string, unknown>));
  if (rowsNeedingUpkeep(library, parsePdfUpkeepState(stored[PDF_UPKEEP_STORAGE_KEY])).length === 0) return;
  upkeepFrame = el('iframe', { src: PDF_UPKEEP_PAGE, hidden: true, tabIndex: -1 });
  upkeepFrame.setAttribute('aria-hidden', 'true');
  document.body.append(upkeepFrame);
  setTimeout(endUpkeep, UPKEEP_MAX_MS);
}

function scheduleUpkeep(): void {
  setTimeout(() => {
    const idle = (window as unknown as { requestIdleCallback?: (run: () => void, options?: { timeout: number }) => void }).requestIdleCallback;
    if (idle) idle(() => { void startUpkeep(); }, { timeout: 10_000 });
    else void startUpkeep();
  }, UPKEEP_DELAY_MS);
}

window.addEventListener('message', (e) => {
  if (upkeepFrame && e.source === upkeepFrame.contentWindow && e.data === PDF_UPKEEP_DONE_MESSAGE) endUpkeep();
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
  let response: { success?: boolean; role?: 'hub' | 'forwarded'; project?: string; docs?: PdfHubDoc[]; dispose?: 'back' | 'close' } | undefined;
  if (myTabId !== null) {
    response = await chrome.runtime.sendMessage({ type: 'VOCAB_T_PDF_HUB_CLAIM', docs, canGoBack: canGoBack(), project: initial.project }).catch(() => undefined);
  }
  if (response?.success && response.role === 'forwarded') {
    emptyText.textContent = 'PDF 탭으로 옮겼습니다.';
    empty.hidden = false;
    if (response.dispose === 'back') history.back();
    else if (myTabId !== null) void chrome.tabs.remove(myTabId).catch(() => undefined);
    return;
  }
  // The hub (or, if the background could not be reached, a standalone page).
  projectId = response?.project ?? initial.project ?? DEFAULT_PROJECT_ID;
  isHub = true;
  strip.hidden = false;
  await loadLibraryState();
  if (projects[projectId]?.deletedAt !== 0) projectId = DEFAULT_PROJECT_ID;
  closed = loadClosed();
  homeView = loadHomeView();
  updateProjectLabel();
  reconcilePinned();
  addDocs(docs.map((doc) => ({ ...doc, file: null })), false, false);
  let front: HubTab | undefined;
  const identities = () => tabs.map((t) => ({ url: t.url, docId: t.docId ?? t.libraryId }));
  if (initial.show && initial.show !== PDF_HUB_SHOW_HOME && initial.show !== PDF_HUB_SHOW_SETTINGS) {
    front = tabs[findOpenDoc(initial.show, identities())];
  } else if (!initial.show && docs[initial.active]) {
    front = tabs[findOpenDoc(docs[initial.active].url, identities(), libraryIdForUrl)];
  }
  if (front) activate(front.key);
  else if (initial.show === PDF_HUB_SHOW_SETTINGS) showSettings();
  else showHome(false);
  const handedOver = response?.docs ?? [];
  if (handedOver.length) addDocs(handedOver.map((doc) => ({ ...doc, file: null })), true);
  render();
  scheduleUpkeep();
}

void boot();
