// ─── Hub state: the tabs, the library and projects as read from storage ───
//
// The hub page's shared state and its links to the background. The library,
// projects, folders, positions and display settings are written by the
// background (or the settings page) and read here; this module owns the
// storage listener and tells the rest what changed (`on`), so no renderer
// is called from here. Module-level `let`s are live bindings for readers;
// writers use the setters.

import { STORE_PDF_ANNOTATIONS } from '../../shared/constants';
import { hubDocKey } from '../../shared/hubTabs';
import { pdfDisplayName } from '../../shared/localPdf';
import { DEFAULT_PROJECT_ID, PDF_PROJECTS_STORAGE_KEY, PDF_PROJECT_FOLDERS_STORAGE_KEY, isDocInProject, livePdfProjects, parsePdfProjectFolders, parsePdfProjects, projectPinnedDocIds, seedPdfProjects, type PdfFolderUpdate, type PdfProject, type PdfProjectFolders, type PdfProjects, type PdfProjectUpdate } from '../../shared/pdfProjects';
import { DEFAULT_DISPLAY_PREFS, DISPLAY_PREFS_STORAGE_KEY, parseDisplayPrefs, type DisplayPrefs } from '../../shared/displayPrefs';
import { PDF_DOC_STATE_STORAGE_KEY, parsePdfDocRecords, type PdfDocRecords } from '../../shared/pdfIdentity';
import { PDF_LIBRARY_STORAGE_KEY, libraryEntryName, parsePdfLibrary, type PdfLibrary, type PdfLibraryEntry, type PdfLibraryUpdate } from '../../shared/pdfLibrary';
import { openDB } from '../../db/database';
import { S as SHARED } from '../../shared/shared.strings';
import { LANGUAGE_STORAGE_KEY, currentLanguage, parseLanguagePref, resolveLanguage } from '../../shared/i18n';
import { S } from '../pdfHub.strings';

/** A half of the page in split view (hub/split.ts). */
export type Side = 'left' | 'right';

export interface HubTab {
  key: number;
  /** The half whose tabs it is among while split (the left one otherwise). */
  side: Side;
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
  /** A second view of the document while split view shows it in both halves (hub/split.ts). */
  mirror: HTMLIFrameElement | null;
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

export const HOME = 0;
// The settings page, shown like home in place of a document.
export const SETTINGS = -1;
export const isPage = (key: number | null) => key === HOME || key === SETTINGS;

export const tabs: HubTab[] = [];
export let activeKey: number | null = null;
export let myTabId: number | null = null;
// False until the claim settled: nothing is persisted while the page might
// still hand its documents away.
export let isHub = false;

export function setActiveKey(key: number | null): void { activeKey = key; }
export function setMyTabId(id: number | null): void { myTabId = id; }
export function setIsHub(value: boolean): void { isHub = value; }

export function activeTab(): HubTab | null {
  return tabs.find((t) => t.key === activeKey) ?? null;
}

export function isLocal(tab: { url: string | null; file: File | null }): boolean {
  return !!tab.file || !!tab.url?.startsWith('file:');
}

// ─── Library (read here, written by the background) ───

export let library: PdfLibrary = {};
export let urlToLibraryId = new Map<string, string>();
export let docRecords: PdfDocRecords = {};
export let annotated = new Set<string>();

// ─── Projects (read here, written by the background) ───

export let projectId = DEFAULT_PROJECT_ID;
// Before a device's first project write there is no record: it reads as the
// default project seeded with the library's old pins, like the background.
export let storedProjects: unknown;
export let projects: PdfProjects = parsePdfProjects(undefined);
export let folders: PdfProjectFolders = {};
// How tabs are named and icons drawn on this device (settings page).
export let display: DisplayPrefs = DEFAULT_DISPLAY_PREFS;
// Projects with a hub right now (the background's registry; may be stale).
export let openProjectIds = new Set<string>();
// Pin changes sent but not yet seen in storage: they win over a stale read.
export const pendingPins = new Map<string, boolean>();
// Documents this hub already registered to its project (one message each).
export const registered = new Set<string>();
export const PROJECT_HUBS_SESSION_KEY = 'rpdfProjectHubs';

export function setProjectId(id: string): void { projectId = id; }
/** An optimistic local change, before storage confirms it (or is read back). */
export function setProjectsLocally(next: PdfProjects): void { projects = next; }
export function setFoldersLocally(next: PdfProjectFolders): void { folders = next; }

export function setLibrary(next: PdfLibrary): void {
  library = next;
  urlToLibraryId = new Map();
  for (const entry of Object.values(library).sort((a, b) => a.openedAt - b.openedAt)) {
    for (const url of entry.urls) urlToLibraryId.set(hubDocKey(url).url, entry.docId);
  }
  if (storedProjects === undefined) setProjects(undefined);
}

export function setProjects(raw: unknown): void {
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

export function currentProject(): PdfProject {
  return projects[projectId] ?? projects[DEFAULT_PROJECT_ID];
}

export function projectName(id: string): string {
  return projects[id]?.name ?? S.projectFallback;
}

/** Pinned documents of this project, with pin changes still in flight. */
export function pinnedDocIds(): string[] {
  const ids = projectPinnedDocIds(projects, projectId).filter((id) => pendingPins.get(id) !== false);
  for (const [id, pinned] of pendingPins) if (pinned && !ids.includes(id)) ids.push(id);
  return ids;
}

/** docId → the non-default projects it is registered to. */
export function membershipIndex(): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const project of livePdfProjects(projects)) {
    if (project.id === DEFAULT_PROJECT_ID) continue;
    for (const m of project.members) {
      if (m.member) index.set(m.docId, [...(index.get(m.docId) ?? []), project.id]);
    }
  }
  return index;
}

export function inThisProject(docId: string, index: Map<string, string[]>): boolean {
  return projectId === DEFAULT_PROJECT_ID ? !index.has(docId) : (index.get(docId) ?? []).includes(projectId);
}

export function sendProjectUpdate(update: PdfProjectUpdate | PdfFolderUpdate): Promise<unknown> {
  return ask({ type: 'VOCAB_T_PDF_PROJECT_UPDATE', update });
}

export function sendLibraryUpdate(update: PdfLibraryUpdate): Promise<unknown> {
  return ask({ type: 'VOCAB_T_PDF_LIBRARY_UPDATE', update });
}

export function ask<T = { success?: boolean; error?: string }>(message: Record<string, unknown>): Promise<T | undefined> {
  return (chrome.runtime.sendMessage(message) as Promise<T>).catch(() => undefined);
}

export type Reply = { success?: boolean; error?: string; code?: string } | undefined;

export function succeeded(response: unknown): boolean {
  return !!(response as Reply)?.success;
}

/** What to say when an update was not stored: a limit as the background words it, else `fallback`. */
export function updateError(response: unknown, fallback: string): string {
  const reply = response as Reply;
  if (reply?.code === 'project-limit' || reply?.code === 'folder-limit') {
    if (typeof reply.error === 'string' && reply.error) return reply.error;
    return reply.code === 'project-limit' ? S.projectLimit : S.folderLimit;
  }
  return fallback;
}

// ─── What changed (storage, from anywhere) ───

export interface HubEvents {
  /** The library, projects or folders. */
  data: { library: boolean; projects: boolean; folders: boolean };
  /** Reading positions (any viewer, any window). */
  positions: void;
  /** How tabs are named and icons drawn. */
  display: void;
  /** The page's language changed. */
  language: void;
  /** Which projects have a hub open. */
  registry: void;
}

const listeners = new Map<keyof HubEvents, Array<(detail: never) => void>>();

export function on<K extends keyof HubEvents>(event: K, run: (detail: HubEvents[K]) => void): void {
  listeners.set(event, [...(listeners.get(event) ?? []), run as (detail: never) => void]);
}

function emit<K extends keyof HubEvents>(event: K, detail: HubEvents[K]): void {
  for (const run of listeners.get(event) ?? []) (run as (detail: HubEvents[K]) => void)(detail);
}

/** Reads projects and folders back from storage (after an optimistic change that was not stored). */
export async function reloadProjects(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get([PDF_PROJECTS_STORAGE_KEY, PDF_PROJECT_FOLDERS_STORAGE_KEY]);
    setProjects(stored[PDF_PROJECTS_STORAGE_KEY]);
    folders = parsePdfProjectFolders(stored[PDF_PROJECT_FOLDERS_STORAGE_KEY]);
  } catch {
    return;
  }
  emit('data', { library: false, projects: true, folders: true });
}

export async function loadOpenProjects(): Promise<void> {
  try {
    const stored = await chrome.storage.session.get(PROJECT_HUBS_SESSION_KEY);
    const value = stored[PROJECT_HUBS_SESSION_KEY];
    openProjectIds = new Set(value && typeof value === 'object' ? Object.keys(value) : []);
  } catch {
    openProjectIds = new Set();
  }
}

/** A project opened in another hub registers the documents shown in it. */
export function registerDoc(docId: string | null): void {
  if (!isHub || !docId || projectId === DEFAULT_PROJECT_ID || registered.has(docId)) return;
  registered.add(docId);
  if (isDocInProject(projects, projectId, docId)) return;
  void sendProjectUpdate({ kind: 'member', id: projectId, docId, member: true });
}

export function libraryIdForUrl(url: string): string | null {
  return urlToLibraryId.get(hubDocKey(url).url) ?? null;
}

export async function loadLibraryState(): Promise<void> {
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

export async function loadAnnotated(): Promise<void> {
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
      emit('registry', undefined);
    }
    return;
  }
  if (area !== 'local') return;
  const data = { library: !!changes[PDF_LIBRARY_STORAGE_KEY], projects: !!changes[PDF_PROJECTS_STORAGE_KEY], folders: !!changes[PDF_PROJECT_FOLDERS_STORAGE_KEY] };
  if (data.library) setLibrary(parsePdfLibrary(changes[PDF_LIBRARY_STORAGE_KEY].newValue));
  if (data.projects) setProjects(changes[PDF_PROJECTS_STORAGE_KEY].newValue);
  if (data.folders) folders = parsePdfProjectFolders(changes[PDF_PROJECT_FOLDERS_STORAGE_KEY].newValue);
  if (data.library || data.projects || data.folders) emit('data', data);
  if (changes[PDF_DOC_STATE_STORAGE_KEY]) {
    docRecords = parsePdfDocRecords(changes[PDF_DOC_STATE_STORAGE_KEY].newValue);
    emit('positions', undefined);
  }
  if (changes[LANGUAGE_STORAGE_KEY] && resolveLanguage(parseLanguagePref(changes[LANGUAGE_STORAGE_KEY].newValue)) !== currentLanguage()) {
    emit('language', undefined);
    return;
  }
  if (changes[DISPLAY_PREFS_STORAGE_KEY]) {
    display = parseDisplayPrefs(changes[DISPLAY_PREFS_STORAGE_KEY].newValue);
    emit('display', undefined);
  }
});

// ─── Names ───

export type NewDoc = { url: string | null; hash: string; file: File | null; fileId?: number };

/** What a tab is called: the user's name for it, else the paper, else the document's own name. */
export function tabName(tab: HubTab): string {
  return library[tab.docId ?? tab.libraryId ?? '']?.userTitle ?? tab.paperTitle ?? tab.title;
}

export function entryName(entry: PdfLibraryEntry): string {
  return libraryEntryName(entry, pdfDisplayName);
}

export function entrySource(entry: PdfLibraryEntry): string {
  const url = entry.urls[0];
  if (!url || url.startsWith('file:')) return S.localFile;
  try {
    return new URL(url).hostname.replace(/^www\./u, '');
  } catch {
    return '';
  }
}

export function openTabFor(docId: string): HubTab | undefined {
  return tabs.find((t) => (t.docId ?? t.libraryId) === docId);
}
