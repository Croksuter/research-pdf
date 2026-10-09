// ─── This hub as a page: its URL and saved layout, recently closed tabs,
// switching projects in place, documents handed over, boot ───

import { findOpenDoc, parseClosedTabs, type HubClosedTab } from '../../shared/hubTabs';
import { PDF_HUB_SHOW_HOME, PDF_HUB_SHOW_SETTINGS, buildPdfViewerUrl, parsePdfHubUrl, type PdfHubDoc, buildPdfHubUrl } from '../../shared/localPdf';
import { parsePdfHubOpenMessage } from '../../shared/messages';
import { DEFAULT_PROJECT_ID } from '../../shared/pdfProjects';
import { S } from '../pdfHub.strings';
import { type HubTab, type NewDoc, activeKey, activeTab, ask, isHub, isPage, libraryIdForUrl, loadLibraryState, myTabId, pendingPins, projectId, projects, registered, tabs, SETTINGS, setProjectId, setIsHub, setMyTabId } from './store';
import { addBtn, empty, emptyText, fileInput, listPanel, strip, viewerBase, hubBase } from './dom';
import { hidePanels, hideToast, showToast } from './uiKit';
import { activate, addDocs, reconcilePinned, render, showSettings } from './tabStrip';
import { scheduleUpkeep, storeFrames } from './frames';
import { flushLocalFiles, localFiles, restoreLocalFiles, restoreLocalTabs, saveLocalTabs, scheduleLocalFilePrune } from './localFiles';
import { renderList } from './tabList';
import { scheduleHomeRender, showHome, initHomeView } from './home/home';
import { updateProjectLabel } from './projectsPanel';
import { restoreSplit, saveSplit } from './split';

export const CLOSED_STORAGE_KEY = 'rpdfClosed';

// ─── Recently closed (this hub's project; survives a reload) ───

export let closed: HubClosedTab[] = [];

export function closedStorageKey(id = projectId): string {
  return `${CLOSED_STORAGE_KEY}:${id}`;
}

export function loadClosed(): HubClosedTab[] {
  try {
    // Before projects, one list per hub tab (now the default project's).
    const raw = sessionStorage.getItem(closedStorageKey())
      ?? (projectId === DEFAULT_PROJECT_ID ? sessionStorage.getItem(CLOSED_STORAGE_KEY) : null);
    return parseClosedTabs(JSON.parse(raw ?? '[]'));
  } catch {
    return [];
  }
}

export function setClosed(next: HubClosedTab[]): void {
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

export function docOfClosed(entry: HubClosedTab): NewDoc | null {
  if (entry.url) return { url: entry.url, hash: '', file: null };
  const file = entry.fileId !== null ? localFiles.get(entry.fileId) : undefined;
  return file ? { url: null, hash: '', file, fileId: entry.fileId ?? undefined } : null;
}

export function reopenClosed(entry: HubClosedTab | undefined = closed[0]): void {
  if (!entry) { showToast(S.nothingToReopen); return; }
  setClosed(closed.filter((e) => e !== entry));
  hideToast();
  const doc = docOfClosed(entry);
  if (doc) addDocs([doc], true, true, entry.index);
  else reopenClosed(closed[0]); // a local file whose copy is gone
}

/** Reopens tabs closed together, each where it was. */
export function reopenEntries(entries: HubClosedTab[]): void {
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

// ─── Title, URL, restore record ───

export let stateTimer: ReturnType<typeof setTimeout> | null = null;

/** The URL-backed tabs, which one is in front, and what (home, a pin) is shown instead. */
export function hubState(): { urls: string[]; active: number; show: string | null } {
  const current = activeTab();
  const urlTabs = tabs.filter((t): t is HubTab & { url: string } => t.url !== null && !t.pinned);
  return {
    urls: urlTabs.map((t) => t.url),
    active: Math.max(0, urlTabs.findIndex((t) => t.key === activeKey)),
    // The project reopens on home rather than on settings.
    show: isPage(activeKey) ? PDF_HUB_SHOW_HOME : current?.pinned ? current.url : null,
  };
}

/** Writes where this hub is to its URL (reload, session restore) and, a moment later, to the project's saved layout. */
export function persistState(): void {
  if (!isHub) return;
  saveLocalTabs();
  saveSplit();
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

export function setProject(id: string): void {
  if (id === projectId) return;
  setProjectId(id);
  closed = loadClosed();
  registered.clear();
  pendingPins.clear();
  reconcilePinned();
  updateProjectLabel();
  render();
  scheduleHomeRender();
}
export async function openProject(id: string, where: 'here' | 'new-tab' = 'here'): Promise<void> {
  if (id === projectId) return;
  const response = await ask<{ success?: boolean; url?: string; error?: string }>({
    type: 'VOCAB_T_PDF_PROJECT_OPEN', project: id, inPlace: where === 'here',
  });
  if (!response?.success) { showToast(response?.error ?? S.projectOpenFailed); return; }
  if (response.url) await switchHere(response.url);
}

/** Leaves this project (its tabs saved, as when its tab closes) and loads `url` here. */
export let switching = false;
/** A new language: reload in it (the viewers store everything first; the URL keeps the web tabs, the session the local files). */
export function reloadInNewLanguage(): void {
  if (isHub) saveLocalTabs();
  void Promise.all([storeFrames(), flushLocalFiles()]).then(() => location.reload());
}

export async function switchHere(url: string): Promise<void> {
  if (switching || !isHub) return;
  switching = true;
  hidePanels();
  if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
  // Local files stay with this project in this tab's session (see "Local files").
  saveLocalTabs();
  await Promise.all([storeFrames(), flushLocalFiles()]);
  await ask({ type: 'VOCAB_T_PDF_HUB_STATE', ...hubState(), project: projectId });
  setIsHub(false); // nothing more is recorded for this project from here
  location.replace(url);
}
export let rehoming = false;
export async function rehome(): Promise<void> {
  if (rehoming || !isHub) return;
  rehoming = true;
  // Pinned ones too: the pins went with the project.
  const docs = tabs.filter((t) => t.url).map((t) => ({ url: t.url as string, hash: '' }));
  const response = await ask<{ success?: boolean; role?: 'hub' | 'forwarded'; project?: string }>({
    type: 'VOCAB_T_PDF_HUB_CLAIM', docs, canGoBack: false, project: DEFAULT_PROJECT_ID,
  });
  rehoming = false;
  if (response?.success && response.role === 'forwarded') {
    setIsHub(false);
    if (myTabId !== null) void chrome.tabs.remove(myTabId).catch(() => undefined);
    return;
  }
  setProject(DEFAULT_PROJECT_ID);
  showToast(S.projectDeleted);
}

// ─── Local files ───

export function openFiles(files: ArrayLike<File>): void {
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

// ─── Boot ───

// Whether this tab has a page to go back to. `navigation.canGoBack` only sees
// same-origin entries, so a web page behind us is invisible to it; but a fresh
// navigation truncates forward history, so after one any other entry is
// behind us. On reload / back-forward only the same-origin answer is safe.
export function canGoBack(): boolean {
  const nav = (window as unknown as { navigation?: { canGoBack?: boolean } }).navigation;
  if (nav?.canGoBack) return true;
  const [entry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
  return entry?.type === 'navigate' && history.length > 1;
}

export async function boot(): Promise<void> {
  const initial = parsePdfHubUrl(location.search, location.hash);
  // Framed by some page (the page is web-accessible): act as the plain viewer.
  if (window.top !== window.self) {
    const first = initial.docs[0];
    location.replace(first ? buildPdfViewerUrl(first.url + first.hash, viewerBase) : viewerBase);
    return;
  }
  strip.hidden = true;
  const current = await chrome.tabs.getCurrent().catch(() => undefined);
  setMyTabId(typeof current?.id === 'number' ? current.id : null);
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
  setProjectId(response?.project ?? initial.project ?? DEFAULT_PROJECT_ID);
  setIsHub(true);
  strip.hidden = false;
  await loadLibraryState();
  if (projects[projectId]?.deletedAt !== 0) setProjectId(DEFAULT_PROJECT_ID);
  closed = loadClosed();
  initHomeView();
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
  restoreSplit();
  const handedOver = response?.docs ?? [];
  if (handedOver.length) addDocs(handedOver.map((doc) => ({ ...doc, file: null })), true);
  render();
  scheduleUpkeep();
}
