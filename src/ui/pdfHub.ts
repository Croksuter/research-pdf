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
  fileIdentity,
  findOpenDoc,
  homeFilterChoices,
  homePositionKey,
  hubDocKey,
  moveInOrder,
  parseClosedTabs,
  parseLocalTabs,
  pickTabsToSleep,
  progressBucket,
  pushClosedTab,
  sameSource,
  visibleSelection,
  type HubClosedTab,
  type HubLocalTab,
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
  relativeTime,
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
import { S as SHARED } from '../shared/shared.strings';
import { GATHER_MESSAGE, GATHER_RESULT_MESSAGE, SETTINGS_SHOWN_MESSAGE, findOpenPdfTabs, zoomHash, type OpenPdfTab } from './openPdfTabs';
import { LANGUAGE_STORAGE_KEY, currentLanguage, localizeDocument, parseLanguagePref, resolveLanguage } from '../shared/i18n';
import { S } from './pdfHub.strings';

localizeDocument(S);

initDebugLogging();

interface HubTab {
  key: number;
  /** Source URL, or null for a local file opened from disk (kept for this hub tab's session, see "Local files"). */
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
  /** Pin as soon as the document's identity is known: when that was asked (0: not asked). */
  pendingPin: number;
  /** Move to another project as soon as the document's identity is known. */
  pendingMove: { to: string; keep: boolean; since: number } | null;
  frame: HTMLIFrameElement | null;
  /** The frame reported its document (the viewer says `doc` once the PDF opened). */
  loaded: boolean;
  /** The fragment a frame nobody has looked at was opened with (a gathered tab's zoom): given back if it sleeps unseen. */
  unseenHash: string;
  /** Prefetch into the local file cache was attempted. */
  prefetched: boolean;
  lastShownAt: number;
  /** The frame asked to stay loaded (presenting, printing) until then. */
  busyUntil: number;
  /** The tab in the strip: the tab itself and, beside it (not inside), its close or unpin button. */
  root: HTMLDivElement;
  button: HTMLButtonElement;
  iconEl: HTMLSpanElement;
  titleEl: HTMLSpanElement;
  paperEl: HTMLSpanElement;
  verEl: HTMLSpanElement;
  closeEl: HTMLButtonElement;
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
const SEARCH_PAGE_SIZE = 100;
// A pin or move waiting for a document that never reports itself gives up.
const PENDING_TIMEOUT_MS = 60_000;
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

interface RowSpec {
  icon: Node;
  title: string;
  sub?: string | null;
  onClick?: () => void;
  /** Buttons after the row's main button. */
  actions?: HTMLElement[];
  /** 'li': a popover's row; 'item': a row on home. */
  variant?: 'li' | 'item';
  disabled?: boolean;
  tooltip?: string;
}

/** An icon, a title and a line under it, as one button; actions beside it. */
function listRow(spec: RowSpec): HTMLElement {
  const item = spec.variant === 'item';
  const row = el(item ? 'li' : 'div', { className: item ? 'rpdf-item' : 'rpdf-li' });
  const main = el('button', { type: 'button', className: item ? 'rpdf-item-main' : 'rpdf-li-main' });
  const text = el('span', { className: item ? 'rpdf-item-text' : 'rpdf-li-text' });
  text.append(el('span', { className: item ? 'rpdf-item-title' : 'rpdf-li-title', textContent: spec.title }));
  if (spec.sub) text.append(el('span', { className: item ? 'rpdf-item-meta' : 'rpdf-li-sub', textContent: spec.sub }));
  main.append(spec.icon, text);
  if (spec.tooltip) main.title = spec.tooltip;
  if (spec.disabled) main.disabled = true;
  else if (spec.onClick) main.addEventListener('click', spec.onClick);
  row.append(main, ...(spec.actions ?? []));
  return row;
}

/** A small round icon button for a popover row. */
function iconButton(name: string, label: string, aria: string, run: () => void): HTMLButtonElement {
  const button = el('button', { type: 'button', className: 'rpdf-li-action', title: label });
  button.setAttribute('aria-label', aria);
  button.append(icon(name));
  button.addEventListener('click', (e) => { e.stopPropagation(); run(); });
  return button;
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
  // The default project's stored name is Korean data; never renamed, it is shown in this page's language.
  const root = projects[DEFAULT_PROJECT_ID];
  if (root && root.renamedAt === 0) projects = { ...projects, [DEFAULT_PROJECT_ID]: { ...root, name: SHARED.defaultProjectName } };
  const stored = new Set(projectPinnedDocIds(projects, projectId));
  for (const [docId, pinned] of pendingPins) {
    if (stored.has(docId) === pinned) pendingPins.delete(docId);
  }
}

function currentProject(): PdfProject {
  return projects[projectId] ?? projects[DEFAULT_PROJECT_ID];
}

function projectName(id: string): string {
  return projects[id]?.name ?? S.projectFallback;
}

/** Pinned documents of this project, with pin changes still in flight. */
function pinnedDocIds(): string[] {
  const ids = projectPinnedDocIds(projects, projectId).filter((id) => pendingPins.get(id) !== false);
  for (const [id, pinned] of pendingPins) if (pinned && !ids.includes(id)) ids.push(id);
  return ids;
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

type Reply = { success?: boolean; error?: string; code?: string } | undefined;

function succeeded(response: unknown): boolean {
  return !!(response as Reply)?.success;
}

/** What to say when an update was not stored: the background's limits by name, else `fallback`. */
function updateError(response: unknown, fallback: string): string {
  const code = (response as Reply)?.code;
  if (code === 'project-limit') return S.projectLimit;
  if (code === 'folder-limit') return S.folderLimit;
  return fallback;
}

/** Reads projects and folders back from storage (after an optimistic change that was not stored). */
async function reloadProjects(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get([PDF_PROJECTS_STORAGE_KEY, PDF_PROJECT_FOLDERS_STORAGE_KEY]);
    setProjects(stored[PDF_PROJECTS_STORAGE_KEY]);
    folders = parsePdfProjectFolders(stored[PDF_PROJECT_FOLDERS_STORAGE_KEY]);
  } catch {
    return;
  }
  reconcilePinned();
  updateProjectLabel();
  refreshPanels();
  scheduleHomeRender();
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
  // Any viewer in any window saving where it is: only what home shows of it matters.
  if (changes[PDF_DOC_STATE_STORAGE_KEY]) {
    docRecords = parsePdfDocRecords(changes[PDF_DOC_STATE_STORAGE_KEY].newValue);
    onPositionsChanged();
  }
  // A new language: reload in it (the viewers store everything first; the URL
  // keeps the web tabs, the session the local files).
  if (changes[LANGUAGE_STORAGE_KEY] && resolveLanguage(parseLanguagePref(changes[LANGUAGE_STORAGE_KEY].newValue)) !== currentLanguage()) {
    if (isHub) saveLocalTabs();
    void Promise.all([storeFrames(), flushLocalFiles()]).then(() => location.reload());
    return;
  }
  if (changes[DISPLAY_PREFS_STORAGE_KEY]) {
    display = parseDisplayPrefs(changes[DISPLAY_PREFS_STORAGE_KEY].newValue);
    tabs.forEach(updateTabLabel);
    updateFavicon();
    scheduleHomeRender();
  }
});

// ─── Tab strip ───

type NewDoc = { url: string | null; hash: string; file: File | null; fileId?: number };

function createTab(doc: NewDoc): HubTab {
  const key = nextKey++;
  const initialTitle = doc.file ? doc.file.name : doc.url ? pdfDisplayName(doc.url) : 'PDF';
  const root = el('div', { className: 'rpdf-tab' });
  root.dataset.key = String(key);
  const button = el('button', { type: 'button', className: 'rpdf-tab-main', tabIndex: -1 });
  button.setAttribute('role', 'tab');
  const iconEl = el('span', { className: 'rpdf-tab-icon' });
  const titleEl = el('span', { className: 'rpdf-tab-title', textContent: initialTitle });
  const paperEl = el('span', { className: 'rpdf-tab-paper', hidden: true });
  const text = el('span', { className: 'rpdf-tab-text' });
  text.append(titleEl, paperEl);
  const verEl = el('span', { className: 'rpdf-tab-ver', hidden: true });
  button.append(iconEl, text, verEl);
  // A sibling of the tab, not inside it: a button in a button is neither focusable nor announced.
  const closeEl = el('button', { type: 'button', className: 'rpdf-tab-close', tabIndex: -1 });
  root.append(button, closeEl);
  const tab: HubTab = {
    key, url: doc.url, hash: doc.hash, file: doc.file, fileId: doc.file ? doc.fileId ?? localFileId(doc.file) : null,
    title: initialTitle, paperTitle: null, docId: null, libraryId: doc.url ? libraryIdForUrl(doc.url) : null,
    pinned: false, keepOnUnpin: false, pendingPin: 0, pendingMove: null,
    frame: null, loaded: false, unseenHash: '', prefetched: false, lastShownAt: 0, busyUntil: 0,
    root, button, iconEl, titleEl, paperEl, verEl, closeEl,
  };
  // Names the library already knows, until the viewer reports its own.
  const known = tab.libraryId ? library[tab.libraryId] : undefined;
  if (known?.docTitle) tab.title = known.docTitle;
  if (known?.title && !sameTitle(known.title, tab.title)) tab.paperTitle = known.title;
  updateTabLabel(tab);
  button.addEventListener('click', () => activate(key));
  // A pinned tab's button unpins it (it has no close).
  closeEl.addEventListener('click', () => { if (tab.pinned) setPinned(tab, false); else closeTab(key); });
  root.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(key); } });
  root.addEventListener('contextmenu', (e) => { e.preventDefault(); showTabMenu(tab, e.clientX, e.clientY); });
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
  tab.root.classList.toggle('has-paper', !tab.pinned && !!subtitle);
  tab.root.classList.toggle('is-pinned', tab.pinned);
  tab.root.classList.toggle('is-unloaded', !tab.frame);
  tab.root.draggable = true;
  const kind = docKind(tab.docId ?? tab.libraryId);
  tab.iconEl.replaceChildren(icon(tab.pinned ? 'i-pin' : kindIcon(display.kindIcons === 'off' ? 'document' : kind, isLocal(tab))));
  tab.iconEl.dataset.kind = tab.pinned || display.kindIcons !== 'color' ? '' : kind;
  tab.button.title = [tab.paperTitle, tab.title, tab.url, kind !== 'document' ? KIND_LABEL[kind] : null, tab.pinned ? S.pinnedTip : null]
    .filter(Boolean).filter((v, i, all) => all.indexOf(v) === i).join('\n');
  const name = tabName(tab);
  tab.closeEl.title = tab.pinned ? S.unpin : S.closeShortcut;
  tab.closeEl.setAttribute('aria-label', tab.pinned ? S.unpinAria(name) : S.closeAria(name));
  tab.closeEl.replaceChildren(icon(tab.pinned ? 'i-unpin' : 'i-close'));
  if (tab.frame) tab.frame.title = tab.paperTitle ?? tab.title;
}

function pinnedCount(): number {
  return tabs.filter((t) => t.pinned).length;
}

function insertTab(tab: HubTab, index: number): void {
  const at = Math.min(Math.max(index, tab.pinned ? 0 : pinnedCount()), tabs.length);
  tabs.splice(at, 0, tab);
  tabList.insertBefore(tab.root, tabs[at + 1]?.root ?? null);
}

/**
 * Opens the documents here (or finds the tab already showing one). Returns,
 * per document, its tab — or null when the project was full.
 */
function addDocs(docs: NewDoc[], activateLast: boolean, autoActivate = true, at?: number): Array<HubTab | null> {
  let last: HubTab | null = null;
  let insertAt = at;
  const placed: Array<HubTab | null> = [];
  let full = false;
  for (const doc of docs) {
    const index = doc.url ? findOpenDoc(doc.url, tabs.map((t) => ({ url: t.url, docId: t.docId ?? t.libraryId })), libraryIdForUrl) : -1;
    if (index >= 0) {
      const existing = tabs[index];
      if (doc.hash) {
        if (existing.frame) postToFrame(existing, { tag: HUB_MESSAGE_TAG, kind: 'hash', hash: doc.hash });
        else existing.hash = doc.hash;
      }
      last = existing;
      placed.push(existing);
      continue;
    }
    if (full || tabs.length - pinnedCount() >= PDF_HUB_MAX_DOCS) {
      if (!full) showToast(S.tooManyDocs(PDF_HUB_MAX_DOCS));
      full = true;
      placed.push(null);
      continue;
    }
    const tab = createTab(doc);
    insertTab(tab, insertAt ?? tabs.length);
    if (insertAt !== undefined) insertAt += 1;
    registerDoc(tab.libraryId);
    last = tab;
    placed.push(tab);
  }
  if (last && (activateLast || (autoActivate && activeKey === null))) activate(last.key);
  render();
  void queuePrefetch();
  return placed;
}

/**
 * Takes the tab out of the strip at once; its frame first stores drawings
 * and position (the sleep handshake), then goes.
 */
function removeTab(tab: HubTab): void {
  const index = tabs.indexOf(tab);
  if (index < 0) return;
  tabs.splice(index, 1);
  void retireFrame(tab);
  tab.root.remove();
  if (activeKey === tab.key) {
    activeKey = null;
    const neighbor = tabs[index] ?? tabs[index - 1];
    if (neighbor) activate(neighbor.key);
    else showHome(false);
  }
  scheduleLocalFilePrune();
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
  // Loaded behind the others (gathered, pinned): its fragment comes back if it sleeps before anyone looks.
  tab.unseenHash = tab.key !== activeKey && tab.lastShownAt === 0 ? tab.hash : '';
  tab.hash = '';
  tab.loaded = false;
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

/** Shows the tab's document. `focusFrame`: false when the keyboard moves along the strip (focus stays there). */
function activate(key: number, focusFrame = true): void {
  if (key === HOME) { showHome(true); return; }
  if (key === SETTINGS) { showSettings(); return; }
  const tab = tabs.find((t) => t.key === key);
  if (!tab) return;
  const now = Date.now();
  const previous = activeTab();
  if (previous) previous.lastShownAt = now;
  activeKey = key;
  tab.lastShownAt = now;
  tab.unseenHash = '';
  const frame = ensureFrame(tab);
  for (const t of tabs) if (t.frame) t.frame.hidden = t !== tab;
  home.hidden = true;
  homeBtn.setAttribute('aria-pressed', 'false');
  settingsView.hidden = true;
  settingsBtn.setAttribute('aria-pressed', 'false');
  tab.root.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (focusFrame) frame.focus();
  render();
  void enforceSleep();
}

/** Leaves the tab in front for a page (home, settings): its frame hides, the strip stays reachable. */
function leaveTabs(next: number): void {
  const previous = activeTab();
  if (previous) {
    previous.lastShownAt = Date.now();
    lastTabKey = previous.key;
  }
  activeKey = next;
  for (const t of tabs) if (t.frame) t.frame.hidden = true;
}

function showHome(focusSearch: boolean): void {
  leaveTabs(HOME);
  home.hidden = false;
  homeBtn.setAttribute('aria-pressed', 'true');
  settingsView.hidden = true;
  settingsBtn.setAttribute('aria-pressed', 'false');
  resetHomeLimits();
  renderHome();
  void loadAnnotated().then(() => scheduleHomeRender());
  void refreshOpenPdfs();
  if (focusSearch) homeSearch.focus();
  render();
}

/**
 * The settings page in place of the documents. Its frame (settings.html,
 * which styles itself for the hub when framed) is made on first use and
 * kept; each later showing tells it to refresh what may have gone stale.
 */
function showSettings(): void {
  leaveTabs(SETTINGS);
  home.hidden = true;
  homeBtn.setAttribute('aria-pressed', 'false');
  settingsView.hidden = false;
  settingsBtn.setAttribute('aria-pressed', 'true');
  let frame = settingsFrame();
  if (!frame) {
    frame = el('iframe', { src: 'settings.html', title: S.settings });
    // Shown once it has styled itself for the hub, without a light flash.
    frame.style.visibility = 'hidden';
    frame.addEventListener('load', () => { frame?.style.removeProperty('visibility'); frame?.focus(); }, { once: true });
    settingsView.append(frame);
  } else {
    frame.contentWindow?.postMessage({ type: SETTINGS_SHOWN_MESSAGE }, location.origin);
    frame.focus();
  }
  render();
}

function settingsFrame(): HTMLIFrameElement | null {
  return settingsView.querySelector('iframe');
}

function closedEntry(tab: HubTab, index: number): HubClosedTab | null {
  if (!tab.url && tab.fileId === null) return null;
  return { url: tab.url, fileId: tab.url ? null : tab.fileId, title: tab.title, paperTitle: tab.paperTitle, index, closedAt: Date.now() };
}

function closeTab(key: number, remember = true): void {
  const tab = tabs.find((t) => t.key === key);
  if (!tab) return;
  if (tab.pinned) {
    showToast(S.pinnedCantClose);
    return;
  }
  const entry = closedEntry(tab, tabs.indexOf(tab));
  removeTab(tab);
  if (remember && entry) {
    setClosed(pushClosedTab(closed, entry));
    showToast(S.tabClosed, { label: S.undoShortcut, run: () => reopenClosed(entry) });
  }
  render();
}

/** Closes several tabs as one action: one toast, and its undo reopens them all where they were. */
function closeTabs(keys: number[]): void {
  const closing = tabs.filter((t) => keys.includes(t.key) && !t.pinned);
  if (closing.length === 0) return;
  if (closing.length === 1) { closeTab(closing[0].key); return; }
  const entries = closing.map((t) => closedEntry(t, tabs.indexOf(t))).filter((e): e is HubClosedTab => !!e);
  for (const tab of closing) removeTab(tab);
  let stack = closed;
  for (const entry of [...entries].reverse()) stack = pushClosedTab(stack, entry);
  setClosed(stack);
  showToast(S.tabsClosed(closing.length), { label: S.undo, run: () => reopenEntries(entries) });
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

// Keyboard along the strip: one tab is in the Tab order (the one in front,
// or the last one shown while home or settings is); arrows move along the
// tabs and show each, Home / End go to the ends, Delete closes.
let lastTabKey: number | null = null;

function rovingTab(): HubTab | undefined {
  return activeTab() ?? tabs.find((t) => t.key === lastTabKey) ?? tabs[0];
}

function onStripKey(e: KeyboardEvent, tab: HubTab): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey) return false;
  const index = tabs.indexOf(tab);
  let next: HubTab | undefined;
  if (e.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
  else if (e.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
  else if (e.key === 'Home') next = tabs[0];
  else if (e.key === 'End') next = tabs[tabs.length - 1];
  else if (e.key === 'Delete') {
    if (tab.pinned) { showToast(S.pinnedCantClose); return true; }
    const neighbor = tabs[index + 1] ?? tabs[index - 1];
    closeTab(tab.key);
    (neighbor && tabs.includes(neighbor) ? neighbor.button : homeBtn).focus();
    return true;
  } else return false;
  if (next && next !== tab) {
    activate(next.key, false);
    next.button.focus();
  }
  return true;
}

// Drag to reorder within the strip (unpinned tabs; pins keep pin order).
// The pointer's side of the tab's middle says before or after; past the
// last tab is the end.
let dragKey: number | null = null;

function clearStripDropMarks(): void {
  for (const t of tabs) t.root.classList.remove('is-drop-before', 'is-drop-after');
}

function dropAfter(tab: HubTab, e: DragEvent): boolean {
  const rect = tab.root.getBoundingClientRect();
  return e.clientX > rect.left + rect.width / 2;
}

/** Puts the dragged tab before or after `target` (null: last of its kind). */
function dropTab(moved: HubTab, target: HubTab | null, after: boolean): void {
  if (moved.pinned) {
    const docOf = (t: HubTab) => t.libraryId ?? t.docId;
    const movedDoc = docOf(moved);
    if (!movedDoc) return;
    // Every pin of the project, with or without a tab here.
    setPinOrder(moveInOrder(pinnedDocIds(), movedDoc, target ? docOf(target) : null, after));
    return;
  }
  const loose = moveInOrder(tabs.filter((t) => !t.pinned), moved, target, after);
  tabs.splice(0, tabs.length, ...tabs.filter((t) => t.pinned), ...loose);
  for (const t of loose) tabList.append(t.root);
  render();
}

function wireDrag(tab: HubTab): void {
  const { root } = tab;
  const dragged = () => tabs.find((t) => t.key === dragKey);
  root.addEventListener('dragstart', (e) => {
    dragKey = tab.key;
    root.classList.add('is-dragging');
    e.dataTransfer?.setData('text/plain', tab.url ?? tab.title);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  root.addEventListener('dragend', () => {
    dragKey = null;
    root.classList.remove('is-dragging');
    clearStripDropMarks();
  });
  // Pinned tabs reorder among pins (the project's pin order), the rest among the rest.
  root.addEventListener('dragover', (e) => {
    const moved = dragged();
    if (!moved || moved === tab || moved.pinned !== tab.pinned) return;
    e.preventDefault();
    e.stopPropagation();
    const after = dropAfter(tab, e);
    clearStripDropMarks();
    root.classList.add(after ? 'is-drop-after' : 'is-drop-before');
  });
  root.addEventListener('drop', (e) => {
    const moved = dragged();
    if (!moved || moved === tab || moved.pinned !== tab.pinned) return;
    e.preventDefault();
    e.stopPropagation();
    clearStripDropMarks();
    dropTab(moved, tab, dropAfter(tab, e));
  });
}

// The strip past the last tab: drop there to put a tab last.
tabList.addEventListener('dragover', (e) => {
  const moved = tabs.find((t) => t.key === dragKey);
  if (!moved || moved.pinned || e.target !== tabList) return;
  e.preventDefault();
  clearStripDropMarks();
  tabs[tabs.length - 1]?.root.classList.add('is-drop-after');
});
tabList.addEventListener('drop', (e) => {
  const moved = tabs.find((t) => t.key === dragKey);
  if (!moved || moved.pinned || e.target !== tabList) return;
  e.preventDefault();
  clearStripDropMarks();
  dropTab(moved, null, true);
});

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
    for (const t of ordered) tabList.append(t.root);
  }
  render();
}

function setPinnedById(docId: string, pinned: boolean): void {
  if (!library[docId]) return;
  if (pinned && !isDocInProject(projects, projectId, docId)) {
    if (projectId === DEFAULT_PROJECT_ID) {
      const elsewhere = projectsOfDoc(projects, docId).map(projectName).join(', ');
      showToast(S.inOtherProject(elsewhere));
      return;
    }
    registered.add(docId); // pinning registers it
  }
  pendingPins.set(docId, pinned);
  const project = projectId;
  void sendProjectUpdate({ kind: 'pin', id: project, docId, pinned }).then((response) => {
    if (succeeded(response) || project !== projectId || pendingPins.get(docId) !== pinned) return;
    // Not stored: back to what storage says.
    pendingPins.delete(docId);
    reconcilePinned();
    scheduleHomeRender();
    showToast(updateError(response, pinned ? S.pinFailed : S.unpinFailed));
  });
  reconcilePinned();
  scheduleHomeRender();
}

function setPinned(tab: HubTab, pinned: boolean): void {
  const docId = tab.docId ?? tab.libraryId ?? (tab.url ? libraryIdForUrl(tab.url) : null);
  if (pinned && !tab.url) {
    // A file opened from disk has no address to reopen it from in another hub.
    if (docId && library[docId]) setPinnedById(docId, true);
    showToast(S.localPinNote);
    return;
  }
  if (!docId || !library[docId]) {
    if (!pinned) return;
    // Not opened yet: load it (in the background) and pin once it is known.
    const since = Date.now();
    tab.pendingPin = since;
    ensureFrame(tab);
    showToast(S.pinAfterLoad);
    setTimeout(() => {
      if (tab.pendingPin !== since) return;
      tab.pendingPin = 0;
      if (tabs.includes(tab)) showToast(S.pinGaveUp(tabName(tab)));
    }, PENDING_TIMEOUT_MS);
    return;
  }
  tab.libraryId = docId;
  if (!pinned) tab.keepOnUnpin = true;
  setPinnedById(docId, pinned);
}

function completePendingPins(): void {
  for (const tab of tabs) {
    if (!tab.pendingPin || !tab.docId || !library[tab.docId]) continue;
    tab.pendingPin = 0;
    setPinned(tab, true);
  }
}

// ─── Recently closed (this hub's project; survives a reload) ───

let closed: HubClosedTab[] = [];

function closedStorageKey(id = projectId): string {
  return `${CLOSED_STORAGE_KEY}:${id}`;
}

function loadClosed(): HubClosedTab[] {
  try {
    // Before projects, one list per hub tab (now the default project's).
    const raw = sessionStorage.getItem(closedStorageKey())
      ?? (projectId === DEFAULT_PROJECT_ID ? sessionStorage.getItem(CLOSED_STORAGE_KEY) : null);
    return parseClosedTabs(JSON.parse(raw ?? '[]'));
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
  scheduleLocalFilePrune();
}

function docOfClosed(entry: HubClosedTab): NewDoc | null {
  if (entry.url) return { url: entry.url, hash: '', file: null };
  const file = entry.fileId !== null ? localFiles.get(entry.fileId) : undefined;
  return file ? { url: null, hash: '', file, fileId: entry.fileId ?? undefined } : null;
}

function reopenClosed(entry: HubClosedTab | undefined = closed[0]): void {
  if (!entry) { showToast(S.nothingToReopen); return; }
  setClosed(closed.filter((e) => e !== entry));
  hideToast();
  const doc = docOfClosed(entry);
  if (doc) addDocs([doc], true, true, entry.index);
  else reopenClosed(closed[0]); // a local file whose copy is gone
}

/** Reopens tabs closed together, each where it was. */
function reopenEntries(entries: HubClosedTab[]): void {
  setClosed(closed.filter((e) => !entries.includes(e)));
  hideToast();
  const ordered = [...entries].sort((a, b) => a.index - b.index);
  let last: HubTab | null = null;
  for (const entry of ordered) {
    const doc = docOfClosed(entry);
    if (!doc) continue;
    last = addDocs([doc], false, false, entry.index)[0] ?? last;
  }
  if (last) activate(last.key);
}

// ─── Local files ───
//
// A PDF opened from disk has no address to reopen it from, so its bytes are
// kept (IndexedDB, per hub tab session: sessionStorage names the session)
// while a tab or a recently-closed entry of this hub tab refers to it, in
// any of the projects it showed. A reload (a new language), a project switch
// in place and a browser restart that restores the tab bring them back.

const LOCAL_TABS_KEY = 'rpdfLocalTabs';
const SESSION_KEY = 'rpdfHubSession';
const NEXT_FILE_ID_KEY = 'rpdfNextFileId';
const FILES_DB = 'rpdf-hub-files';
const FILES_STORE = 'files';
// Copies no hub tab has claimed for this long are dropped (tabs gone with their session).
const LOCAL_FILE_MAX_AGE_MS = 30 * 86_400_000;

const localFiles = new Map<number, File>();
const localFileIds = new Map<string, number>();

function sessionValue(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

function setSessionValue(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* kept in memory for this page */
  }
}

const hubSession = (() => {
  const known = sessionValue(SESSION_KEY);
  if (known) return known;
  const fresh = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  setSessionValue(SESSION_KEY, fresh);
  return fresh;
})();

let fileIdFloor = 1;
function nextFileId(): number {
  const next = Math.max(fileIdFloor, Number(sessionValue(NEXT_FILE_ID_KEY)) || 1);
  fileIdFloor = next + 1;
  setSessionValue(NEXT_FILE_ID_KEY, String(next + 1));
  return next;
}

let filesDb: Promise<IDBDatabase> | null = null;
function openFilesDb(): Promise<IDBDatabase> {
  filesDb ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(FILES_DB, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(FILES_STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return filesDb;
}

interface StoredLocalFile { session: string; file: File; touchedAt: number }

async function withFiles<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openFilesDb();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(FILES_STORE, mode);
    const request = run(tx.objectStore(FILES_STORE));
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const fileKey = (id: number) => `${hubSession}:${id}`;
const pendingFileWrites = new Set<Promise<unknown>>();

function track(write: Promise<unknown>): void {
  const done = write.catch(() => undefined).finally(() => pendingFileWrites.delete(done));
  pendingFileWrites.add(done);
}

/** The handle for `file`: the one it already has here (the same file opened again), or a new one, stored. */
function localFileId(file: File): number {
  const identity = fileIdentity(file);
  const known = localFileIds.get(identity);
  if (known !== undefined && localFiles.has(known)) return known;
  const id = nextFileId();
  localFiles.set(id, file);
  localFileIds.set(identity, id);
  const record: StoredLocalFile = { session: hubSession, file, touchedAt: Date.now() };
  track(withFiles('readwrite', (store) => store.put(record, fileKey(id))));
  return id;
}

/** Waits for local files still being written (before a reload or a switch). */
function flushLocalFiles(): Promise<unknown> {
  return Promise.all([...pendingFileWrites]);
}

function localTabsKey(id = projectId): string {
  return `${LOCAL_TABS_KEY}:${id}`;
}

// Nothing is recorded before the boot put the recorded ones back.
let localTabsRestored = false;

/** Records this project's local-file tabs (where they stand, which is in front) in the session. */
function saveLocalTabs(): void {
  if (!localTabsRestored) return;
  const list: HubLocalTab[] = [];
  tabs.forEach((t, index) => {
    if (t.url || t.fileId === null) return;
    list.push({ fileId: t.fileId, index, title: t.title, paperTitle: t.paperTitle, active: t.key === activeKey });
  });
  const value = list.length ? JSON.stringify(list) : null;
  if (sessionValue(localTabsKey()) !== value) setSessionValue(localTabsKey(), value);
}

/** Every file handle this hub tab's session still refers to: open or recently closed, in any project. */
function referencedFileIds(): Set<number> {
  const ids = new Set<number>();
  for (const t of tabs) if (t.fileId !== null) ids.add(t.fileId);
  for (const e of closed) if (e.fileId !== null) ids.add(e.fileId);
  try {
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i) ?? '';
      const raw = JSON.parse(sessionStorage.getItem(key) ?? 'null') as unknown;
      if (key.startsWith(`${LOCAL_TABS_KEY}:`)) for (const t of parseLocalTabs(raw)) ids.add(t.fileId);
      else if (key.startsWith(`${CLOSED_STORAGE_KEY}:`)) for (const e of parseClosedTabs(raw)) if (e.fileId !== null) ids.add(e.fileId);
    }
  } catch {
    /* keep what is in memory */
  }
  return ids;
}

let pruneTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleLocalFilePrune(): void {
  if (pruneTimer || !isHub) return;
  pruneTimer = setTimeout(() => { pruneTimer = null; void pruneLocalFiles(); }, 1_000);
}

/** Drops the copies nothing refers to any more. */
async function pruneLocalFiles(): Promise<void> {
  const keep = referencedFileIds();
  for (const [id, file] of [...localFiles]) {
    if (keep.has(id)) continue;
    localFiles.delete(id);
    if (localFileIds.get(fileIdentity(file)) === id) localFileIds.delete(fileIdentity(file));
  }
  const prefix = `${hubSession}:`;
  await withFiles('readwrite', (store) => {
    const cursor = store.openKeyCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      const key = String(c.key);
      if (key.startsWith(prefix) && !keep.has(Number(key.slice(prefix.length)))) store.delete(c.key);
      c.continue();
    };
  }).catch(() => undefined);
}

/**
 * Loads the copies this session refers to into memory, marks them as still
 * wanted, and drops copies of sessions long gone. Returns the files by handle.
 */
async function restoreLocalFiles(): Promise<void> {
  const wanted = referencedFileIds();
  const now = Date.now();
  await withFiles('readwrite', (store) => {
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      const record = c.value as StoredLocalFile;
      const key = String(c.key);
      if (record?.session === hubSession) {
        const id = Number(key.slice(hubSession.length + 1));
        if (wanted.has(id) && record.file instanceof Blob) {
          localFiles.set(id, record.file);
          localFileIds.set(fileIdentity(record.file), id);
          c.update({ ...record, touchedAt: now });
        } else {
          c.delete();
        }
      } else if (!record || now - (record.touchedAt ?? 0) > LOCAL_FILE_MAX_AGE_MS) {
        c.delete();
      }
      c.continue();
    };
  }).catch(() => undefined);
}

/** Puts this project's local-file tabs back where they were; the one in front, if one was. */
function restoreLocalTabs(): HubTab | null {
  let front: HubTab | null = null;
  let missing = 0;
  let records: HubLocalTab[] = [];
  try { records = parseLocalTabs(JSON.parse(sessionValue(localTabsKey()) ?? 'null')); } catch { /* none */ }
  for (const record of records) {
    const file = localFiles.get(record.fileId);
    if (!file) { missing += 1; continue; }
    const tab = createTab({ url: null, hash: '', file, fileId: record.fileId });
    tab.title = record.title;
    tab.paperTitle = record.paperTitle;
    updateTabLabel(tab);
    insertTab(tab, record.index);
    if (record.active) front = tab;
  }
  localTabsRestored = true;
  if (missing) showToast(S.localFilesLost(missing));
  return front;
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
  const name = activeKey === HOME ? S.home : activeKey === SETTINGS ? S.settings : current?.paperTitle ?? current?.title ?? 'PDF';
  const appName = projectId === DEFAULT_PROJECT_ID ? APP_NAME : `${currentProject().name} · ${APP_NAME}`;
  document.title = hubDocumentTitle(name, tabs.length, appName);
  moveBtn.disabled = !current;
  listCount.textContent = tabs.length ? String(tabs.length) : '';
  listBtn.setAttribute('aria-label', S.allTabsCount(tabs.length));
  const badges = arxivVersionBadges(tabs.map((t) => t.url));
  const roving = rovingTab();
  tabs.forEach((t, i) => {
    t.verEl.textContent = badges[i] ?? '';
    t.verEl.hidden = !badges[i];
    const on = t.key === activeKey;
    t.button.setAttribute('aria-selected', String(on));
    t.root.classList.toggle('is-active', on);
    t.button.tabIndex = t === roving ? 0 : -1;
    t.closeEl.tabIndex = t === roving ? 0 : -1;
  });
  updateOverflow();
  if (!isHub) return;
  saveLocalTabs();
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
  const sample = tabs.find((t) => !t.pinned)?.root;
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
    const row = listRow({
      icon: icon(tab.pinned ? 'i-pin' : isLocal(tab) ? 'i-file-local' : 'i-file'),
      title: tabName(tab),
      sub: tab.paperTitle && tab.title !== tab.paperTitle ? tab.title : null,
      onClick: () => { hideList(); activate(tab.key); },
      actions: tab.pinned ? [] : [iconButton('i-close', S.close, S.closeAria(tabName(tab)), () => { closeTab(tab.key); renderList(); })],
    });
    row.classList.toggle('is-active', tab.key === activeKey);
    listItems.append(row);
  }
  if (open.length === 0) listItems.append(el('p', { className: 'rpdf-li-empty', textContent: words.length ? S.noMatchingTab : S.noOpenTabs }));
  // The project's documents that are not open: one click away.
  const index = membershipIndex();
  const openIds = new Set(tabs.map((t) => t.docId ?? t.libraryId));
  const members = Object.values(library)
    .filter((e) => e.urls.length > 0 && !openIds.has(e.docId) && inThisProject(e.docId, index) && matches(entryName(e), e.fileName, ...e.urls))
    .sort((a, b) => b.openedAt - a.openedAt);
  if (members.length) {
    listItems.append(el('h3', { className: 'rpdf-li-head', textContent: S.closedDocsOf(currentProject().name) }));
    for (const entry of members.slice(0, 10)) {
      listItems.append(listRow({
        icon: icon(entry.urls[0].startsWith('file:') ? 'i-file-local' : 'i-file'),
        title: entryName(entry),
        sub: S.openedAgo(relativeTime(entry.openedAt)),
        onClick: () => { hideList(); openEntry(entry); },
      }));
    }
  }
  const recent = closed.filter((e) => matches(e.title, e.paperTitle, e.url));
  if (recent.length) {
    listItems.append(el('h3', { className: 'rpdf-li-head', textContent: S.recentlyClosed }));
    for (const entry of recent.slice(0, 10)) {
      listItems.append(listRow({
        icon: icon('i-restore'),
        title: entry.paperTitle ?? entry.title,
        sub: S.closedAgo(relativeTime(entry.closedAt)),
        onClick: () => { hideList(); reopenClosed(entry); },
      }));
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
  const entries: MenuEntry[] = [
    { label: tab.pinned ? S.unpin : S.pin, run: () => setPinned(tab, !tab.pinned) },
    { label: S.moveToProjectDots, run: () => showMove(tab) },
  ];
  const docId = tab.docId ?? tab.libraryId;
  if (docId && library[docId]) {
    const rect = tab.root.getBoundingClientRect();
    entries.push({ label: S.kindMenuItem(KIND_LABEL[docKind(docId)]), run: () => showKindMenu(docId, Math.max(x, rect.left), y) });
  }
  if (projectId !== DEFAULT_PROJECT_ID && docId && isDocInProject(projects, projectId, docId)) {
    entries.push({ label: S.removeFromProject, run: () => removeDocsFromProject([docId]) });
  }
  if (tab.url) {
    const url = tab.url;
    entries.push({ label: S.copyUrl, run: () => copyUrl(url) });
  }
  const others = tabs.filter((t) => t !== tab && !t.pinned);
  entries.push(
    'sep',
    { label: S.close, run: () => closeTab(tab.key), disabled: tab.pinned },
    { label: S.closeOthers, run: () => closeTabs(others.map((t) => t.key)), disabled: others.length === 0 },
  );
  showMenu(entries, x, y);
}

function copyUrl(url: string): void {
  void navigator.clipboard.writeText(url).then(() => showToast(S.urlCopied), () => showToast(S.urlCopyFailed));
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

type HomeList = 'docs' | 'others' | 'search';
const homeLimits: Record<HomeList, number> = { docs: HOME_PAGE_SIZE, others: HOME_PAGE_SIZE, search: SEARCH_PAGE_SIZE };
let homeRenderQueued = false;
// What the last render showed: the rows (by document) and the reading positions it depended on.
let homeShownDocs = new Set<string>();
let homePositions = '';

function resetHomeLimits(): void {
  homeLimits.docs = HOME_PAGE_SIZE;
  homeLimits.others = HOME_PAGE_SIZE;
  homeLimits.search = SEARCH_PAGE_SIZE;
}

function scheduleHomeRender(): void {
  if (activeKey !== HOME || homeRenderQueued) return;
  homeRenderQueued = true;
  requestAnimationFrame(() => {
    homeRenderQueued = false;
    if (activeKey === HOME) renderHome();
  });
}

function positionKey(): string {
  return homePositionKey(Object.values(library), (docId) => docRecords[docId]?.page ?? null, homeShownDocs, homeView.sort === 'progress');
}

/** A reading position was saved (any viewer, any window): home re-renders only if it shows what changed. */
function onPositionsChanged(): void {
  if (activeKey === HOME && positionKey() !== homePositions) scheduleHomeRender();
}

function entryName(entry: PdfLibraryEntry): string {
  return libraryEntryName(entry, pdfDisplayName);
}

function entrySource(entry: PdfLibraryEntry): string {
  const url = entry.urls[0];
  if (!url || url.startsWith('file:')) return S.localFile;
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
    showToast(S.localReselect);
    fileInput.click();
    return;
  }
  addDocs([{ url, hash: '', file: null }], true);
}

interface HomeRowOptions {
  /** Pinned in this project (worked out once per render). */
  pinned: boolean;
  /** "+": register to this project without opening it. */
  add?: boolean;
  /** "−": take it out of this project (undo in the toast). */
  remove?: boolean;
  /** Names of the other projects it is in, shown in the meta line. */
  elsewhere?: string[];
  /** A row of the pinned list: dragged to reorder. */
  pinnedList?: boolean;
}

// ─── Home: filters, sort, selection (this page; filter and sort remembered per device) ───

type HomeFilter = 'all' | PdfDocKind | 'annotated' | 'reading' | 'unread';
type HomeSort = 'recent' | 'title' | 'year' | 'progress';
const HOME_VIEW_KEY = 'rpdfHomeView';
// Getters: the language is read when a label is shown, not when this module loads.
const HOME_FILTER_LABEL: Record<Exclude<HomeFilter, PdfDocKind>, string> = {
  get all() { return S.filterAll; },
  get annotated() { return S.filterAnnotated; },
  get reading() { return S.filterReading; },
  get unread() { return S.filterUnread; },
};
const HOME_SORT_LABEL: Record<HomeSort, string> = {
  get recent() { return S.sortRecent; },
  get title() { return S.sortTitle; },
  get year() { return S.sortYear; },
  get progress() { return S.sortProgress; },
};

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
  resetHomeLimits();
  renderHome();
}

// Selected rows; always a subset of the rows on screen (see renderHome).
let selected = new Set<string>();

/** Reading progress 0–1, or null when never opened past the first page. */
function progressOf(entry: PdfLibraryEntry): number | null {
  const page = docRecords[entry.docId]?.page ?? null;
  return page && page > 1 ? Math.min(1, page / Math.max(1, entry.numPages)) : null;
}

function matchesFilter(entry: PdfLibraryEntry, filter: HomeFilter): boolean {
  switch (filter) {
    case 'all': return true;
    case 'annotated': return annotated.has(entry.docId);
    case 'reading': return progressBucket(docRecords[entry.docId]?.page ?? null, entry.numPages) === 'reading';
    case 'unread': return progressOf(entry) === null;
    default: return libraryEntryKind(entry) === filter;
  }
}

function sortEntries(entries: PdfLibraryEntry[], sort: HomeSort): PdfLibraryEntry[] {
  const list = [...entries];
  switch (sort) {
    case 'title': return list.sort((a, b) => entryName(a).localeCompare(entryName(b), currentLanguage()));
    case 'year': return list.sort((a, b) => (b.year ?? -1) - (a.year ?? -1) || b.openedAt - a.openedAt);
    case 'progress': return list.sort((a, b) => (progressOf(b) ?? -1) - (progressOf(a) ?? -1) || b.openedAt - a.openedAt);
    default: return list.sort((a, b) => b.openedAt - a.openedAt);
  }
}

/** A round button on a home row (+, −). */
function rowButton(name: string, title: string, aria: string, run: () => void, className = 'rpdf-item-act'): HTMLButtonElement {
  const button = el('button', { type: 'button', className, title });
  button.setAttribute('aria-label', aria);
  button.append(icon(name));
  button.addEventListener('click', run);
  return button;
}

function homeRow(entry: PdfLibraryEntry, options: HomeRowOptions): HTMLElement {
  const { pinned } = options;
  const name = entryName(entry);
  const record = docRecords[entry.docId];
  const page = record?.page ?? null;
  const meta = [
    options.elsewhere?.length ? options.elsewhere.join(', ') : null,
    [entry.venue, entry.year].filter(Boolean).join(' '),
    entrySource(entry),
    relativeTime(entry.openedAt),
    page ? S.pageOf(page, entry.numPages) : S.pages(entry.numPages),
  ].filter(Boolean).join(' · ');
  const kind = libraryEntryKind(entry);
  const kindMark = icon(kindIcon(display.kindIcons === 'off' ? 'document' : kind, !(entry.urls[0] && !entry.urls[0].startsWith('file:'))));
  kindMark.dataset.kind = display.kindIcons === 'color' ? kind : '';
  const tooltip = [kind !== 'document' ? KIND_LABEL[kind] : null, entry.title, entry.docTitle, entry.fileName, ...entry.urls]
    .filter(Boolean).filter((v, i, all) => all.indexOf(v) === i).join('\n');
  const actions: HTMLElement[] = [];
  if (options.add) {
    actions.push(rowButton('i-plus', S.addToProjectTitle(currentProject().name), S.addToProjectAria(name, currentProject().name), () => {
      registered.add(entry.docId);
      void sendProjectUpdate({ kind: 'member', id: projectId, docId: entry.docId, member: true }).then((response) => {
        showToast(succeeded(response) ? S.addedTo(currentProject().name) : updateError(response, S.addFailed));
      });
    }));
  }
  if (options.remove) {
    actions.push(rowButton('i-minus', S.removeFromThisProject, S.removeFromProjectAria(name), () => removeDocsFromProject([entry.docId])));
  }
  const pin = rowButton('i-pin', pinned ? S.unpin : S.pinTitle, pinned ? S.unpinAria(name) : S.pinAria(name), () => setPinnedById(entry.docId, !pinned), 'rpdf-item-pin');
  pin.setAttribute('aria-pressed', String(pinned));
  const more = rowButton('i-more', S.more, S.moreFor(name), () => { const r = more.getBoundingClientRect(); showDocMenu([entry.docId], r.left - 160, r.bottom + 4); }, 'rpdf-item-act rpdf-item-more');
  actions.push(pin, more);
  const row = listRow({ variant: 'item', icon: kindMark, title: name, sub: meta, tooltip, onClick: () => openEntry(entry), actions });
  row.dataset.docId = entry.docId;
  const main = row.querySelector<HTMLButtonElement>('.rpdf-item-main');
  const badges = el('span', { className: 'rpdf-item-badges' });
  if (annotated.has(entry.docId)) {
    const pen = el('span', { className: 'rpdf-badge', title: S.hasAnnotations });
    pen.append(icon('i-pen'));
    badges.append(pen);
  }
  if (openTabFor(entry.docId)) badges.append(el('span', { className: 'rpdf-badge rpdf-badge-open', textContent: S.badgeOpen }));
  main?.append(badges);
  const isSelected = selected.has(entry.docId);
  row.classList.toggle('is-selected', isSelected);
  // Pinned rows are ordered by dragging, not selected.
  if (!options.pinnedList) {
    const check = el('input', { type: 'checkbox', className: 'rpdf-item-check', checked: isSelected });
    check.setAttribute('aria-label', S.selectAria(name));
    check.addEventListener('change', () => {
      if (check.checked) selected.add(entry.docId); else selected.delete(entry.docId);
      row.classList.toggle('is-selected', check.checked);
      renderSelectionBar();
    });
    row.prepend(check);
  }
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

/** Writes `docIds` (this project's pins) in this order; applied here at once, read back if not stored. */
function setPinOrder(docIds: string[]): void {
  const keys = orderKeysBetween(null, null, docIds.length);
  const update: PdfProjectUpdate = { kind: 'pin-order', id: projectId, order: docIds.map((docId, i) => ({ docId, order: keys[i] })) };
  projects = applyPdfProjectUpdate(projects, update);
  void sendProjectUpdate(update).then((response) => {
    if (succeeded(response)) return;
    showToast(updateError(response, S.orderFailed));
    void reloadProjects();
  });
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
    setPinOrder(moveInOrder(pinnedDocIds(), moving, docId, after(e)));
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
  return docIds.length === 1 && library[docIds[0]] ? S.docsOne(entryName(library[docIds[0]])) : S.docsMany(docIds.length);
}

/** Registers the documents to `to` too (they stay where they are). */
function addDocsToProject(docIds: string[], to: string): void {
  void Promise.all(docIds.map((docId) => sendProjectUpdate({ kind: 'member', id: to, docId, member: true }))).then((responses) => {
    const failed = responses.find((r) => !succeeded(r));
    if (failed) { showToast(updateError(failed, S.addFailed)); return; }
    showToast(S.addedDocsTo(docsLabel(docIds), projectName(to)), { label: S.open, run: () => { void openProject(to); } });
  });
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
  showToast(moved ? S.movedDocs(moved, projectName(to)) : S.nothingToMove, moved ? { label: S.open, run: () => { void openProject(to); } } : undefined);
}

/** What taking a document out of this project changed, so undo can put all of it back. */
interface RemovedDoc { docId: string; pinned: boolean; pinOrder: string | null; tab: HubClosedTab | null }

/** Takes the documents out of this project: membership, pin (and its place), open tab — all back with undo. */
function removeDocsFromProject(docIds: string[]): void {
  const project = projectId;
  const inside = docIds.filter((id) => project !== DEFAULT_PROJECT_ID && isDocInProject(projects, project, id));
  if (inside.length === 0) { showToast(S.nothingToRemove); return; }
  const pinnedNow = new Set(pinnedDocIds());
  const removed: RemovedDoc[] = inside.map((docId) => {
    const tab = openTabFor(docId);
    return {
      docId,
      pinned: pinnedNow.has(docId),
      pinOrder: projects[project]?.members.find((m) => m.docId === docId)?.pinOrder ?? null,
      tab: tab ? closedEntry(tab, tabs.indexOf(tab)) : null,
    };
  });
  for (const r of removed) {
    void sendProjectUpdate({ kind: 'member', id: project, docId: r.docId, member: false });
    registered.add(r.docId); // closing it must not register it again
    pendingPins.delete(r.docId);
    const tab = openTabFor(r.docId);
    if (tab) { tab.pinned = false; tab.keepOnUnpin = false; closeTab(tab.key, false); }
  }
  selected = new Set([...selected].filter((id) => !inside.includes(id)));
  scheduleHomeRender();
  showToast(S.removedDocs(docsLabel(inside)), { label: S.undo, run: () => { void restoreRemoved(project, removed); } });
}

async function restoreRemoved(project: string, removed: RemovedDoc[]): Promise<void> {
  if (project !== projectId) return;
  for (const r of removed) {
    await sendProjectUpdate({ kind: 'member', id: project, docId: r.docId, member: true });
    if (!r.pinned) continue;
    await sendProjectUpdate({ kind: 'pin', id: project, docId: r.docId, pinned: true });
    if (r.pinOrder) await sendProjectUpdate({ kind: 'pin-order', id: project, order: [{ docId: r.docId, order: r.pinOrder }] });
  }
  // Pinned ones come back as pins (storage → reconcilePinned); the others where they were.
  const reopen = removed.filter((r) => !r.pinned && r.tab).map((r) => r.tab as HubClosedTab);
  if (reopen.length) reopenEntries(reopen);
}

function showProjectPicker(docIds: string[], mode: 'add' | 'move', x: number, y: number): void {
  const choices = projectChoices(docIds).filter((c) => mode === 'move' || c.project.id !== DEFAULT_PROJECT_ID);
  showMenu([
    { heading: mode === 'add' ? S.addToAnother : S.moveToAnother },
    ...choices.map(({ project, holds }) => ({
      label: holds ? S.alreadyHas(project.name) : project.name,
      disabled: holds,
      run: () => {
        if (mode === 'add') addDocsToProject(docIds, project.id);
        else void moveDocsToProject(docIds, project.id);
        selected.clear();
        scheduleHomeRender();
      },
    })),
    ...(choices.length === 0 ? [{ label: S.noOtherProjects, disabled: true, run: () => undefined }] : []),
  ], x, y);
}

function showDocMenu(docIds: string[], x: number, y: number): void {
  const one = docIds.length === 1 ? library[docIds[0]] : undefined;
  const pinnedNow = new Set(pinnedDocIds());
  const allPinned = docIds.every((id) => pinnedNow.has(id));
  const inHere = projectId !== DEFAULT_PROJECT_ID && docIds.some((id) => isDocInProject(projects, projectId, id));
  const entries: MenuEntry[] = [];
  if (one) entries.push({ label: S.open, run: () => openEntry(one) });
  entries.push(
    { label: allPinned ? S.unpin : S.pin, run: () => { for (const id of docIds) setPinnedById(id, !allPinned); } },
    'sep',
    { label: `${S.addToAnother}…`, run: () => showProjectPicker(docIds, 'add', x, y) },
    { label: `${S.moveToAnother}…`, run: () => showProjectPicker(docIds, 'move', x, y) },
  );
  if (inHere) entries.push({ label: S.removeFromThisProject, run: () => { removeDocsFromProject(docIds); selected.clear(); scheduleHomeRender(); } });
  if (one) {
    entries.push('sep', { label: S.kindMenuItem(KIND_LABEL[libraryEntryKind(one)]), run: () => showKindMenu(one.docId, x, y) });
    const url = one.urls[0];
    if (url) entries.push({ label: S.copyUrl, run: () => copyUrl(url) });
  }
  showMenu(entries, x, y);
}

// The bar at the bottom of home while documents are selected.
const selectionBar = el('div', { className: 'rpdf-selbar', hidden: true });
selectionBar.setAttribute('role', 'toolbar');
selectionBar.setAttribute('aria-label', S.selectionAria);
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
  const pinnedNow = new Set(pinnedDocIds());
  const allPinned = ids.every((id) => pinnedNow.has(id));
  const inHere = projectId !== DEFAULT_PROJECT_ID && ids.some((id) => isDocInProject(projects, projectId, id));
  const done = () => { selected.clear(); renderSelectionBar(); scheduleHomeRender(); };
  selectionBar.replaceChildren(
    el('span', { className: 'rpdf-selbar-count', textContent: S.selectedCount(selected.size) }),
    el('span', { className: 'rpdf-selbar-gap' }),
    button(S.addToAnother, (b) => { const p = at(b); showProjectPicker(ids, 'add', p.x, p.y); }),
    button(S.moveShort, (b) => { const p = at(b); showProjectPicker(ids, 'move', p.x, p.y); }),
    button(allPinned ? S.unpin : S.pin, () => { for (const id of ids) setPinnedById(id, !allPinned); done(); }),
    ...(inHere ? [button(S.removeFromThisProject, () => { removeDocsFromProject(ids); done(); })] : []),
    button(S.clearSelection, done),
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

/** "Show more" under a list cut at its page size. */
function moreButton(list: HomeList, total: number, step = HOME_PAGE_SIZE): HTMLElement | undefined {
  if (total <= homeLimits[list]) return undefined;
  const more = el('button', { type: 'button', className: 'rpdf-more', textContent: S.showMore(total - homeLimits[list]) });
  more.dataset.list = list;
  more.addEventListener('click', () => { homeLimits[list] += step; renderHome(); });
  return more;
}

/** Filter chips (with counts over `entries`) and the sort menu. */
function homeTools(entries: PdfLibraryEntry[]): HTMLElement {
  const bar = el('div', { className: 'rpdf-home-tools' });
  const chips = el('div', { className: 'rpdf-chips', role: 'group' });
  chips.setAttribute('aria-label', S.filterAria);
  // Kind chips only when there is more than one kind to tell apart; the active filter always.
  const kinds = KIND_ORDER.filter((k) => entries.some((e) => libraryEntryKind(e) === k));
  const filters = homeFilterChoices<HomeFilter>('all', kinds, ['annotated', 'reading', 'unread'], homeView.filter);
  for (const filter of filters) {
    const count = entries.filter((e) => matchesFilter(e, filter)).length;
    if (count === 0 && filter !== 'all' && filter !== homeView.filter) continue;
    const label = filter in HOME_FILTER_LABEL ? HOME_FILTER_LABEL[filter as keyof typeof HOME_FILTER_LABEL] : KIND_LABEL[filter as PdfDocKind];
    const chip = el('button', { type: 'button', className: 'rpdf-chip', textContent: `${label} ${count}` });
    chip.dataset.filter = filter;
    chip.setAttribute('aria-pressed', String(homeView.filter === filter));
    chip.addEventListener('click', () => setHomeView({ filter: homeView.filter === filter ? 'all' : filter }));
    chips.append(chip);
  }
  const sort = el('select', { className: 'rpdf-sort' });
  sort.setAttribute('aria-label', S.sortAria);
  for (const [value, label] of Object.entries(HOME_SORT_LABEL)) sort.append(el('option', { value, textContent: label, selected: homeView.sort === value }));
  sort.addEventListener('change', () => setHomeView({ sort: sort.value as HomeSort }));
  bar.append(chips, sort);
  return bar;
}

// ─── PDFs open in Chrome's own viewer: offered on home, gathered here ───
//
// A gathered document's original tab closes only once the document has
// loaded here (in the background if it is not shown), and only if that tab
// still shows it: a signed link that expired, a page behind a login or a
// POST result would otherwise lose its only copy. What did not load, and
// what did not fit, stays open where it was.

let openPdfs: OpenPdfTab[] = [];
const GATHER_DISMISSED_KEY = 'rpdfGatherDismissed';
const GATHER_LOAD_TIMEOUT_MS = 45_000;
const GATHER_PARALLEL = 3;
// Source tabs being gathered now: not offered again, not taken twice.
const gathering = new Set<number>();
// Tabs waiting for their frame's first `doc`.
const loadWaiters = new Map<HubTab, Array<() => void>>();

async function refreshOpenPdfs(): Promise<void> {
  const { tabs: found } = await findOpenPdfTabs();
  const before = openPdfs.map((t) => `${t.id} ${t.url}`).join();
  openPdfs = found.filter((t) => !gathering.has(t.id));
  if (openPdfs.map((t) => `${t.id} ${t.url}`).join() !== before) scheduleHomeRender();
}

/** True once the tab's frame has its document (loaded in the background if need be); false if it never does. */
function whenLoaded(tab: HubTab): Promise<boolean> {
  if (tab.loaded) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish(false), GATHER_LOAD_TIMEOUT_MS);
    function finish(ok: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    }
    loadWaiters.set(tab, [...(loadWaiters.get(tab) ?? []), () => finish(true)]);
    // Kept loaded meanwhile: the sleep policy would unload a frame nobody looks at.
    tab.busyUntil = Math.max(tab.busyUntil, Date.now() + GATHER_LOAD_TIMEOUT_MS);
    ensureFrame(tab);
  });
}

function markLoaded(tab: HubTab): void {
  tab.loaded = true;
  const waiters = loadWaiters.get(tab);
  loadWaiters.delete(tab);
  for (const resolve of waiters ?? []) resolve();
}

/** Closes the tab a gathered document came from, if it still shows that document. */
async function closeSourceTab(source: OpenPdfTab): Promise<void> {
  const now = await chrome.tabs.get(source.id).catch(() => null);
  if (now?.url && sameSource(now.url, source.url)) await chrome.tabs.remove(source.id).catch(() => undefined);
}

interface GatherResult { gathered: number; kept: number }

/** Adds the documents to this tab (not shown) and closes the tabs they came from once each has loaded here. */
async function gatherHere(found: OpenPdfTab[]): Promise<GatherResult> {
  const sources = found.filter((t) => !gathering.has(t.id));
  if (sources.length === 0) return { gathered: 0, kept: 0 };
  for (const t of sources) gathering.add(t.id);
  openPdfs = openPdfs.filter((t) => !gathering.has(t.id));
  scheduleHomeRender();
  const before = new Set(tabs);
  const placed = addDocs(sources.map((t) => ({ url: t.url, hash: zoomHash(t), file: null })), false, false);
  showToast(S.gathering(sources.length));
  let gathered = 0;
  let failed = 0;
  let full = 0;
  const queue = sources.map((source, i) => ({ source, tab: placed[i] ?? null }));
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const { source, tab } = job;
      if (!tab) { full += 1; continue; }
      const ok = tabs.includes(tab) && await whenLoaded(tab);
      tab.busyUntil = 0;
      if (!ok) {
        failed += 1;
        // The original stays; a copy that never loaded (and nobody opened) goes.
        if (!before.has(tab) && tab.lastShownAt === 0 && tabs.includes(tab)) removeTab(tab);
        continue;
      }
      gathered += 1;
      await closeSourceTab(source);
    }
  };
  await Promise.all(Array.from({ length: Math.min(GATHER_PARALLEL, queue.length) }, worker));
  for (const t of sources) gathering.delete(t.id);
  render();
  void enforceSleep();
  showToast(S.gatherResult(gathered, failed, full));
  void refreshOpenPdfs();
  return { gathered, kept: failed + full };
}

function gatherBanner(): HTMLElement | null {
  let dismissed = '';
  try { dismissed = sessionStorage.getItem(GATHER_DISMISSED_KEY) ?? ''; } catch { /* none */ }
  const offered = openPdfs;
  if (offered.length === 0 || dismissed === offered.map((t) => t.id).join()) return null;
  const banner = el('div', { className: 'rpdf-gather' });
  const text = el('div', { className: 'rpdf-gather-text' });
  text.append(el('strong', { textContent: S.gatherBanner(offered.length) }));
  const names = offered.slice(0, 3).map((t) => t.title).join(' · ');
  text.append(el('span', { textContent: offered.length > 3 ? `${names} ${S.gatherMore(offered.length - 3)}` : names }));
  const go = el('button', { type: 'button', className: 'rpdf-primary', textContent: S.gatherHere });
  go.addEventListener('click', () => {
    go.disabled = true;
    void (async () => {
      // What those tabs show now, not when the banner was drawn.
      const { tabs: fresh } = await findOpenPdfTabs();
      await gatherHere(fresh.filter((t) => offered.some((o) => o.id === t.id)));
    })();
  });
  const dismiss = el('button', { type: 'button', className: 'rpdf-item-act', title: S.gatherDismiss });
  dismiss.setAttribute('aria-label', S.gatherDismiss);
  dismiss.append(icon('i-close'));
  dismiss.addEventListener('click', () => {
    try { sessionStorage.setItem(GATHER_DISMISSED_KEY, offered.map((t) => t.id).join()); } catch { /* a nicety */ }
    scheduleHomeRender();
  });
  banner.append(icon('i-file'), text, go, dismiss);
  return banner;
}

// The settings page (framed in this hub) asks to gather; it hears back how it went.
window.addEventListener('message', (event) => {
  const frame = settingsFrame();
  if (event.origin !== location.origin || !frame || event.source !== frame.contentWindow) return;
  const data = event.data as { tag?: unknown; tabs?: unknown };
  if (data?.tag !== GATHER_MESSAGE || !Array.isArray(data.tabs)) return;
  const found = (data.tabs as unknown[])
    .filter((t): t is OpenPdfTab => !!t && typeof (t as OpenPdfTab).id === 'number' && typeof (t as OpenPdfTab).url === 'string')
    .map((t) => ({ ...t, title: typeof t.title === 'string' ? t.title : t.url, zoom: typeof t.zoom === 'number' ? t.zoom : null }));
  void gatherHere(found).then(({ gathered, kept }) => {
    settingsFrame()?.contentWindow?.postMessage({ type: GATHER_RESULT_MESSAGE, gathered, kept }, location.origin);
  });
});

window.addEventListener('focus', () => { if (activeKey === HOME) void refreshOpenPdfs(); });

// Controls of a row that keep focus across a re-render (by document and kind of control).
const ROW_CONTROLS = ['rpdf-item-check', 'rpdf-item-main', 'rpdf-item-act', 'rpdf-item-pin', 'rpdf-item-more'];

/** Where focus is on home, to put it back after a render. */
function homeFocus(): (() => void) | null {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !homeSections.contains(active)) return null;
  const docId = active.closest<HTMLElement>('[data-doc-id]')?.dataset.docId;
  if (docId) {
    // The most specific class (⋯ is also an action button).
    const control = [...ROW_CONTROLS].reverse().find((c) => active.classList.contains(c));
    if (!control) return null;
    return () => {
      const row = Array.from(homeSections.querySelectorAll<HTMLElement>('[data-doc-id]')).find((r) => r.dataset.docId === docId);
      row?.querySelector<HTMLElement>(`.${control}`)?.focus({ preventScroll: true });
    };
  }
  const chip = active.dataset.filter;
  if (chip) return () => homeSections.querySelector<HTMLElement>(`.rpdf-chip[data-filter="${chip}"]`)?.focus({ preventScroll: true });
  if (active.classList.contains('rpdf-sort')) return () => homeSections.querySelector<HTMLElement>('.rpdf-sort')?.focus({ preventScroll: true });
  const list = active.dataset.list;
  if (list) return () => homeSections.querySelector<HTMLElement>(`.rpdf-more[data-list="${list}"]`)?.focus({ preventScroll: true });
  return null;
}

function renderHome(): void {
  const refocus = homeFocus();
  const scroll = home.scrollTop;
  buildHome();
  // Selection follows what is on screen: a hidden row is never acted on.
  const shown = Array.from(homeSections.querySelectorAll<HTMLElement>('[data-doc-id]'));
  homeShownDocs = new Set(shown.map((r) => r.dataset.docId ?? ''));
  const selectable = shown.filter((r) => r.querySelector('.rpdf-item-check')).map((r) => r.dataset.docId ?? '');
  selected = visibleSelection(selected, selectable);
  renderSelectionBar();
  homePositions = positionKey();
  home.scrollTop = scroll;
  refocus?.();
}

function buildHome(): void {
  const project = currentProject();
  homeTitle.replaceChildren(projectBadge(project), document.createTextNode(project.name));
  const entries = Object.values(library);
  const index = membershipIndex();
  const isDefault = projectId === DEFAULT_PROJECT_ID;
  const otherNames = (docId: string) => (index.get(docId) ?? []).filter((id) => id !== projectId).map(projectName);
  const pinnedIds = pinnedDocIds();
  const pinnedSet = new Set(pinnedIds);
  const query = homeSearch.value.trim();
  const sections: HTMLElement[] = [];
  if (query) {
    const found = searchPdfLibrary(entries, query);
    sections.push(found.length
      ? homeSection(
        S.searchResults(found.length),
        found.slice(0, homeLimits.search).map((e) => homeRow(e, { pinned: pinnedSet.has(e.docId), elsewhere: otherNames(e.docId) })),
        moreButton('search', found.length, SEARCH_PAGE_SIZE),
      )
      : el('p', { className: 'rpdf-home-empty', textContent: S.noMatchingPdf }));
    homeSections.replaceChildren(...sections);
    return;
  }
  const banner = gatherBanner();
  if (banner) sections.push(banner);
  const pinned = pinnedIds.map((id) => library[id]).filter((e): e is PdfLibraryEntry => !!e);
  if (pinned.length) {
    const hint = el('span', { className: 'rpdf-home-hint-inline', textContent: pinned.length > 1 ? S.dragToReorder : '' });
    sections.push(homeSection(S.pinnedHeading, pinned.map((e) => homeRow(e, { pinned: true, pinnedList: true })), undefined, hint));
  }
  if (closed.length) {
    const rows = closed.slice(0, 6).map((entry) => listRow({
      variant: 'item',
      icon: icon('i-restore'),
      title: entry.paperTitle ?? entry.title,
      sub: S.closedAgo(relativeTime(entry.closedAt)),
      onClick: () => reopenClosed(entry),
    }));
    sections.push(homeSection(S.recentlyClosed, rows));
  }
  const mine = entries.filter((e) => !pinnedSet.has(e.docId) && inThisProject(e.docId, index));
  const others = isDefault ? [] : entries.filter((e) => !pinnedSet.has(e.docId) && !inThisProject(e.docId, index));
  const tools = homeTools([...mine, ...others]);
  const shown = (list: PdfLibraryEntry[]) => sortEntries(list.filter((e) => matchesFilter(e, homeView.filter)), homeView.sort);
  const mineShown = shown(mine);
  if (isDefault) {
    if (mine.length) {
      sections.push(homeSection(S.documents, mineShown.slice(0, homeLimits.docs).map((e) => homeRow(e, { pinned: false })), moreButton('docs', mineShown.length), tools));
      if (mineShown.length === 0) sections[sections.length - 1].append(el('p', { className: 'rpdf-home-hint', textContent: S.noMatchFilter }));
    }
    if (sections.length === 0) sections.push(el('p', { className: 'rpdf-home-empty', textContent: S.emptyDefault }));
    homeSections.replaceChildren(...sections);
    return;
  }
  const own = homeSection(S.projectDocs, mineShown.slice(0, homeLimits.docs).map((e) => homeRow(e, { pinned: false, remove: true })), moreButton('docs', mineShown.length), tools);
  if (mine.length === 0) own.append(el('p', { className: 'rpdf-home-hint', textContent: S.emptyProject }));
  else if (mineShown.length === 0) own.append(el('p', { className: 'rpdf-home-hint', textContent: S.noMatchFilter }));
  sections.push(own);
  const othersShown = shown(others);
  if (othersShown.length) {
    sections.push(homeSection(
      S.otherPdfs,
      othersShown.slice(0, homeLimits.others).map((e) => homeRow(e, { pinned: false, add: true, elsewhere: otherNames(e.docId) })),
      moreButton('others', othersShown.length),
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
  homeSearchTimer = setTimeout(() => { resetHomeLimits(); renderHome(); }, 80);
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
// file cache. A closed tab's frame does the same before it goes.

let sleepSeq = 0;
const sleepWaiters = new Map<number, (reply: { ok: boolean; hash: string }) => void>();
let sleeping = false;
// Frames of closed tabs, still storing their last drawings.
const retiring = new Set<Promise<void>>();

/** Asks `frame` to store its drawings and position now; a frame that does not answer (loading, hung) counts as done. */
function askToStore(frame: HTMLIFrameElement): Promise<{ ok: boolean; hash: string }> {
  const id = ++sleepSeq;
  return new Promise((resolve) => {
    const done = (reply: { ok: boolean; hash: string }) => { sleepWaiters.delete(id); resolve(reply); };
    sleepWaiters.set(id, done);
    frame.contentWindow?.postMessage({ tag: HUB_MESSAGE_TAG, kind: 'sleep', id } satisfies HubToViewerMessage, location.origin);
    setTimeout(() => done({ ok: true, hash: '' }), SLEEP_REPLY_TIMEOUT_MS);
  });
}

/** Asks every loaded viewer to store its drawings and position now (and waits for closed tabs' frames). */
function storeFrames(): Promise<unknown> {
  return Promise.all([
    ...tabs.filter((t) => t.frame).map((t) => askToStore(t.frame as HTMLIFrameElement)),
    ...retiring,
  ]);
}

/** A closed tab's frame: hidden at once, removed once it stored everything. */
function retireFrame(tab: HubTab): Promise<void> {
  const frame = tab.frame;
  tab.frame = null;
  tab.loaded = false;
  if (!frame) return Promise.resolve();
  frame.hidden = true;
  const done = askToStore(frame).then(() => { frame.remove(); retiring.delete(done); });
  retiring.add(done);
  return done;
}

async function sleepTab(tab: HubTab): Promise<void> {
  if (!tab.frame || tab.key === activeKey) return;
  const reply = await askToStore(tab.frame);
  if (!tab.frame || tab.key === activeKey || !tabs.includes(tab)) return;
  if (!reply.ok) { tab.busyUntil = Date.now() + BUSY_RETRY_MS; return; }
  tab.frame.remove();
  tab.frame = null;
  tab.loaded = false;
  // Never looked at: it reopens the way it came (a gathered tab at its zoom).
  tab.hash = reply.hash || (tab.lastShownAt === 0 ? tab.unseenHash : '');
  tab.unseenHash = '';
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

/** Two tabs turned out to show one document: one goes, and what was waiting on it (a pin, a move) carries over. */
function mergeTwins(reporter: HubTab, twin: HubTab): void {
  const keep = reporter.pinned && !twin.pinned ? reporter : twin;
  const drop = keep === reporter ? twin : reporter;
  if (drop.pendingPin && !keep.pendingPin) keep.pendingPin = drop.pendingPin;
  if (drop.pendingMove && !keep.pendingMove) keep.pendingMove = drop.pendingMove;
  const wasShown = activeKey === drop.key || activeKey === keep.key;
  if (activeKey === drop.key) activeKey = null;
  // The waiters of the dropped tab (a gather) are answered by the kept one.
  const waiting = loadWaiters.get(drop);
  loadWaiters.delete(drop);
  if (waiting) {
    if (keep.loaded) for (const resolve of waiting) resolve();
    else loadWaiters.set(keep, [...(loadWaiters.get(keep) ?? []), ...waiting]);
  }
  removeTab(drop);
  if (wasShown) activate(keep.key);
  showToast(S.mergedIntoTab);
  completePendingPins();
  runPendingMove(keep);
  render();
}

function runPendingMove(tab: HubTab): void {
  if (!tab.pendingMove || !(tab.docId ?? tab.libraryId)) return;
  const { to, keep } = tab.pendingMove;
  tab.pendingMove = null;
  void moveTab(tab, to, keep);
}

window.addEventListener('message', (event) => {
  if (event.origin !== location.origin) return;
  const message = parseViewerToHubMessage(event.data);
  if (!message) return;
  // A closed tab's frame answers too, while it stores its last drawings.
  if (message.kind === 'sleep-reply') {
    if (Array.from(frames.querySelectorAll('iframe')).some((f) => f.contentWindow === event.source)) sleepWaiters.get(message.id)?.(message);
    return;
  }
  const tab = tabs.find((t) => t.frame?.contentWindow === event.source);
  if (!tab) return;
  if (message.kind === 'doc') {
    tab.title = message.title;
    tab.paperTitle = message.paperTitle;
    markLoaded(tab);
    if (message.docId && message.docId !== tab.docId) {
      tab.docId = message.docId;
      if (!tab.pinned) tab.libraryId = message.docId;
      const twin = tabs.find((t) => t !== tab && (t.docId ?? t.libraryId) === message.docId);
      if (twin) { mergeTwins(tab, twin); return; }
      completePendingPins();
      registerDoc(message.docId);
      runPendingMove(tab);
    }
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
  if (e.key === 'Escape') {
    if (!menu.hidden) { hideMenu(); return; }
    if (!listPanel.hidden) { hideList(); listBtn.focus(); return; }
    if (!projectsPanel.hidden) { hideProjects(); projectBtn.focus(); return; }
    if (!stylePanel.hidden) { hideStyle(); projectBtn.focus(); return; }
    if (!movePanel.hidden) { hideMove(); moveBtn.focus(); return; }
  }
  const focused = (document.activeElement as Element | null)?.closest<HTMLElement>('.rpdf-tab');
  const tab = focused ? tabs.find((t) => t.root === focused) : undefined;
  if (tab && onStripKey(e, tab)) e.preventDefault();
});

// ─── Looks: document kinds, project badges, the tab's icon ───

const KIND_LABEL: Record<PdfDocKind, string> = {
  get journal() { return S.kindJournal; },
  get conference() { return S.kindConference; },
  get preprint() { return S.kindPreprint; },
  get survey() { return S.kindSurvey; },
  get technical() { return S.kindTechnical; },
  get document() { return S.kindDocument; },
};
const KIND_ORDER: PdfDocKind[] = ['journal', 'conference', 'preprint', 'survey', 'technical', 'document'];

/** The document's kind: automatic (what the paper strip found), or one the user picks. */
function showKindMenu(docId: string, x: number, y: number): void {
  const entry = library[docId];
  if (!entry) return;
  const set = (userKind: PdfDocKind | null) => { void sendLibraryUpdate({ kind: 'user-kind', docId, userKind }); };
  showMenu([
    { heading: S.kindMenuHeading },
    { label: S.kindAuto(KIND_LABEL[entry.paperKind ?? 'document']), checked: entry.userKind === null, run: () => set(null) },
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

/** Applies the look here at once; storage confirms it a moment later (or it is read back). */
function setStyle(project: PdfProject, iconValue: string | null, color: string | null): void {
  void sendProjectUpdate({ kind: 'style', id: project.id, icon: iconValue, color }).then((response) => {
    if (succeeded(response)) return;
    showToast(updateError(response, S.styleFailed));
    void reloadProjects();
  });
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
  if (!value) { showToast(S.enterEmoji); return; }
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
  projectBtn.title = S.projectBtnTitle(name);
  projectBtn.setAttribute('aria-label', S.projectBtnAria(name));
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
  const response = await sendProjectUpdate({ kind: 'create', id, name });
  if (!succeeded(response)) { showToast(updateError(response, S.projectCreateFailed)); return null; }
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
  if (!response?.success) { showToast(response?.error ?? S.projectOpenFailed); return; }
  if (response.url) await switchHere(response.url);
}

/** Leaves this project (its tabs saved, as when its tab closes) and loads `url` here. */
let switching = false;
async function switchHere(url: string): Promise<void> {
  if (switching || !isHub) return;
  switching = true;
  hidePanels();
  if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
  // Local files stay with this project in this tab's session (see "Local files").
  saveLocalTabs();
  await Promise.all([storeFrames(), flushLocalFiles()]);
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
  const button = iconButton(name, label, S.rowActionAria(subject, label), () => run(button));
  row.append(button);
  return button;
}

function menuAt(button: HTMLElement): { x: number; y: number } {
  const rect = button.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom + 4 };
}

function projectRow(project: PdfProject, index: Map<string, string[]>, folder: string | null): HTMLElement {
  const current = project.id === projectId;
  const open = current || openProjectIds.has(project.id);
  const row = listRow({
    icon: projectBadge(project),
    title: project.name,
    sub: [current ? S.viewingNow : open ? S.stateOpen : null, S.docCount(projectDocCount(project, index))].filter(Boolean).join(' · '),
    onClick: () => { hideProjects(); void openProject(project.id); },
  });
  row.classList.toggle('is-current', current);
  row.classList.toggle('is-nested', folder !== null);
  row.dataset.kind = project.id === DEFAULT_PROJECT_ID ? 'root' : 'project';
  row.dataset.id = project.id;
  row.dataset.parent = folder ?? '';
  if (current) row.querySelector('.rpdf-li-main')?.setAttribute('aria-current', 'true');
  if (!current) rowAction(row, 'i-open-new', S.openInNewTab, () => { hideProjects(); void openProject(project.id, 'new-tab'); }, project.name);
  rowAction(row, 'i-more', S.more, (button) => { const at = menuAt(button); showProjectMenu(project, at.x, at.y); }, project.name);
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); showProjectMenu(project, e.clientX, e.clientY); });
  wireListDrag(row);
  return row;
}

function folderRow(folder: PdfProjectFolder, count: number, shut: boolean): HTMLElement {
  const chevron = icon('i-chevron');
  chevron.classList.add('rpdf-folder-chevron');
  const icons = document.createDocumentFragment();
  icons.append(chevron, icon('i-folder'));
  const row = listRow({
    icon: icons,
    title: folder.name,
    sub: count ? S.folderProjectCount(count) : S.folderEmpty,
    tooltip: shut ? S.expand : S.collapse,
    onClick: () => { setFolderCollapsed(folder.id, !shut); focusAfterRender = folder.id; renderProjects(); },
  });
  row.classList.add('rpdf-folder');
  row.classList.toggle('is-shut', shut);
  row.dataset.kind = 'folder';
  row.dataset.id = folder.id;
  row.dataset.parent = '';
  row.querySelector('.rpdf-li-main')?.setAttribute('aria-expanded', String(!shut));
  rowAction(row, 'i-more', S.more, (button) => { const at = menuAt(button); showFolderMenu(folder, at.x, at.y); }, folder.name);
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); showFolderMenu(folder, e.clientX, e.clientY); });
  wireListDrag(row);
  return row;
}

// A row being renamed or asking for confirmation is left alone by renders
// (a storage change from anywhere would otherwise wipe what is being typed);
// the list catches up when it is done.

function rowBusy(): boolean {
  return !!projectsItems.querySelector('.rpdf-li-rename, .rpdf-li-confirm');
}

/** Turns a row into a name field; `save` gets the cleaned new name (an empty `name` asks for a new one). */
function startRename(row: HTMLElement, name: string, label: string, save: (name: string) => void): void {
  const input = el('input', { type: 'text', className: 'rpdf-li-rename', value: name, maxLength: 60, placeholder: label });
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
    input.remove();
    renderProjects();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

/** Asks in the row itself (no browser dialog): `message`, then a confirm and a cancel button. */
function confirmInRow(row: HTMLElement, message: string, confirmLabel: string, run: () => void): void {
  const box = el('div', { className: 'rpdf-li-confirm', role: 'alertdialog' });
  const text = el('p', { textContent: message });
  text.id = `rpdf-confirm-${Date.now()}`;
  box.setAttribute('aria-describedby', text.id);
  const yes = el('button', { type: 'button', className: 'rpdf-danger', textContent: confirmLabel });
  const no = el('button', { type: 'button', className: 'rpdf-style-text-btn', textContent: S.cancel });
  const buttons = el('div', { className: 'rpdf-li-confirm-buttons' });
  buttons.append(no, yes);
  box.append(text, buttons);
  row.replaceChildren(box);
  row.draggable = false;
  let done = false;
  const finish = (ok: boolean) => {
    if (done) return;
    done = true;
    focusAfterRender = row.dataset.id ?? null;
    box.remove();
    if (ok) run();
    renderProjects();
  };
  yes.addEventListener('click', () => finish(true));
  no.addEventListener('click', () => finish(false));
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); } });
  box.addEventListener('focusout', (e) => { if (!box.contains(e.relatedTarget as Node | null)) finish(false); });
  no.focus();
}

function projectListRow(id: string): HTMLElement | null {
  return Array.from(projectsItems.querySelectorAll<HTMLElement>('.rpdf-li')).find((row) => row.dataset.id === id) ?? null;
}

function renderProjects(): void {
  if (rowBusy()) return;
  const index = membershipIndex();
  const { root, items } = pdfProjectTree(projects, folders);
  const collapsed = collapsedFolders();
  const rows: HTMLElement[] = [el('h3', { className: 'rpdf-li-head', textContent: S.projects }), projectRow(root, index, null)];
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
    projectListRow(focusAfterRender)?.querySelector<HTMLButtonElement>('.rpdf-li-main')?.focus();
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
  const inRow = (run: (row: HTMLElement) => void) => () => { const row = projectListRow(project.id); if (row) run(row); };
  const entries: MenuEntry[] = [
    { label: S.changeStyle, run: () => showStyle(project.id) },
    { label: S.rename, run: inRow((row) => startRename(row, project.name, S.projectNameLabel, (name) => { void sendRename({ kind: 'rename', id: project.id, name }); })) },
  ];
  if (project.id !== DEFAULT_PROJECT_ID) {
    const { items } = pdfProjectTree(projects, folders);
    const list = items.filter((item): item is Extract<typeof item, { kind: 'folder' }> => item.kind === 'folder');
    entries.push('sep', { heading: S.moveToFolderHeading });
    for (const item of list) {
      entries.push({ label: item.folder.name, disabled: project.folder === item.folder.id, run: () => placeItem({ kind: 'project', id: project.id }, item.folder.id, Infinity) });
    }
    if (project.folder && folders[project.folder]?.deletedAt === 0) {
      entries.push({ label: S.outOfFolder, run: () => placeAfterFolder(project.id, project.folder as string) });
    }
    entries.push({ label: S.newFolderWithProject, run: inRow((row) => startRename(row, '', S.newFolderPrompt, (name) => { void newFolderWith(project.id, name); })) });
    entries.push('sep', {
      label: S.delete,
      run: inRow((row) => confirmInRow(row, S.confirmDeleteProject(project.name), S.delete, () => {
        void sendProjectUpdate({ kind: 'delete', id: project.id }).then((response) => {
          if (!succeeded(response)) showToast(updateError(response, S.deleteFailed));
        });
      })),
    });
  }
  showMenu(entries, x, y);
}

function sendRename(update: PdfProjectUpdate | PdfFolderUpdate): Promise<void> {
  return sendProjectUpdate(update).then((response) => {
    if (!succeeded(response)) showToast(updateError(response, S.renameFailed));
  });
}

function showFolderMenu(folder: PdfProjectFolder, x: number, y: number): void {
  showMenu([
    {
      label: S.rename,
      run: () => {
        const row = projectListRow(folder.id);
        if (row) startRename(row, folder.name, S.folderNameLabel, (name) => { void sendRename({ kind: 'folder-rename', id: folder.id, name }); });
      },
    },
    { label: S.deleteFolder, run: () => { void deleteFolder(folder); } },
  ], x, y);
}

/** Deletes the folder (its projects stay, where it stood); undo makes it again with its projects in it. */
async function deleteFolder(folder: PdfProjectFolder): Promise<void> {
  const inside = Object.values(projects)
    .filter((p) => p.deletedAt === 0 && p.folder === folder.id)
    .map((p) => ({ id: p.id, order: p.order }));
  const response = await sendProjectUpdate({ kind: 'folder-delete', id: folder.id });
  if (!succeeded(response)) { showToast(updateError(response, S.deleteFailed)); return; }
  showToast(S.folderDeleted(folder.name), {
    label: S.undo,
    run: () => {
      void (async () => {
        // A deleted folder stays a tombstone: the same name and place under a new id.
        const id = newPdfProjectFolderId();
        const created = await sendProjectUpdate({ kind: 'folder-create', id, name: folder.name, order: folder.order });
        if (!succeeded(created)) { showToast(updateError(created, S.folderCreateFailed)); return; }
        const keys = orderKeysBetween(null, null, inside.length);
        const placements = inside.map((p, i) => ({ id: p.id, folder: id, order: p.order ?? keys[i] }));
        if (placements.length) await sendProjectUpdate({ kind: 'arrange', projects: placements, folders: [] });
      })();
    },
  });
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
  const response = await sendProjectUpdate({ kind: 'folder-create', id, name, order: topEndKey() });
  if (!succeeded(response)) { showToast(updateError(response, S.folderCreateFailed)); return null; }
  return id;
}

async function newFolderWith(id: string, name: string): Promise<void> {
  const folder = await createFolder(name);
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
  if (!cleanPdfProjectName(name)) { projectNewName.focus(); showToast(S.folderNameNeeded); return; }
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
  moveTitle.textContent = S.moveTitle(tabName(tab));
  // Every project is listed, grouped as in the project list; the ones already
  // holding the document are shown disabled rather than left out, so none
  // seems to have vanished.
  const holds = (id: string) => id === from || (!!docId && isDocInProject(projects, id, docId));
  const projectRowFor = (project: PdfProject, nested: boolean) => {
    const inside = holds(project.id);
    const where = project.id === projectId ? S.thisProject : S.alreadyIn;
    const actions = !inside && project.id !== DEFAULT_PROJECT_ID
      ? [iconButton('i-plus', S.alsoAddTitle, S.alsoAddAria(project.name), () => { hideMove(); void moveTab(tab, project.id, true); })]
      : [];
    const row = listRow({
      icon: projectBadge(project),
      title: project.name,
      sub: [openProjectIds.has(project.id) ? S.stateOpen : S.stateClosed, inside ? where : null].filter(Boolean).join(' · '),
      tooltip: inside ? S.alreadyInTitle : S.moveToThisProject,
      disabled: inside,
      onClick: () => { hideMove(); void moveTab(tab, project.id, false); },
      actions,
    });
    row.classList.toggle('is-disabled', inside);
    row.classList.toggle('is-nested', nested);
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
  if (!every.some((p) => !holds(p.id))) rows.push(el('p', { className: 'rpdf-li-empty', textContent: S.noProjectsToMove }));
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
    const since = Date.now();
    tab.pendingMove = { to, keep, since };
    ensureFrame(tab);
    showToast(S.loadThenMove);
    setTimeout(() => {
      if (tab.pendingMove?.since !== since) return;
      tab.pendingMove = null;
      if (tabs.includes(tab)) showToast(S.moveGaveUp(tabName(tab)));
    }, PENDING_TIMEOUT_MS);
    return;
  }
  const from = moveSource(docId);
  const response = await ask<{ success?: boolean; open?: boolean; error?: string }>({
    type: 'VOCAB_T_PDF_PROJECT_MOVE', docId, url: tab.url, from, to, keep,
  });
  if (!response?.success) { showToast(response?.error ?? S.moveFailed); return; }
  const name = projectName(to);
  if (keep) { showToast(S.alsoAddedTo(name)); return; }
  pendingPins.delete(docId);
  if (tabs.includes(tab)) removeTab(tab);
  render();
  showToast(tab.url ? S.movedTo(name) : S.movedToLocal(name), {
    label: S.open,
    run: () => { void openProject(to); },
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
  showToast(S.projectDeleted);
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
    emptyText.textContent = S.movedToPdfTab;
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
  await restoreLocalFiles();
  const localFront = restoreLocalTabs();
  let front: HubTab | undefined;
  const identities = () => tabs.map((t) => ({ url: t.url, docId: t.docId ?? t.libraryId }));
  if (initial.show && initial.show !== PDF_HUB_SHOW_HOME && initial.show !== PDF_HUB_SHOW_SETTINGS) {
    front = tabs[findOpenDoc(initial.show, identities())];
  } else if (!initial.show && docs[initial.active]) {
    front = tabs[findOpenDoc(docs[initial.active].url, identities(), libraryIdForUrl)];
  }
  if (localFront && !initial.show) front = localFront;
  if (front) activate(front.key);
  else if (initial.show === PDF_HUB_SHOW_SETTINGS) showSettings();
  else showHome(false);
  const handedOver = response?.docs ?? [];
  if (handedOver.length) addDocs(handedOver.map((doc) => ({ ...doc, file: null })), true);
  render();
  scheduleUpkeep();
}

void boot();
