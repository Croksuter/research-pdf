// ─── The tab strip ───
//
// Tabs (a tab button and, beside it, its close or unpin button), what is in
// front, closing and reopening, keyboard, drag, overflow, pins and their
// order, the tab menu. `render()` brings the strip, the title and the saved
// state up to date after any change. Split, each half has its own tabs
// (hub/split.ts): `side` says among which a tab is.

import { APP_NAME } from '../../shared/brand';
import { arxivVersionBadges, findOpenDoc, hubDocKey, moveInOrder, pushClosedTab, tabsThatLeft, type HubClosedTab } from '../../shared/hubTabs';
import { PDF_HUB_MAX_DOCS, pdfDisplayName } from '../../shared/localPdf';
import { DEFAULT_PROJECT_ID, applyPdfProjectUpdate, isDocInProject, projectsOfDoc, type PdfProjectUpdate } from '../../shared/pdfProjects';
import { orderKeysBetween } from '../../shared/orderKey';
import { tabLabels } from '../../shared/displayPrefs';
import { type PdfLibraryEntry } from '../../shared/pdfLibrary';
import { HUB_MESSAGE_TAG, hubDocumentTitle, sameTitle, type HubKeyAction } from '../../shared/pdfHubProtocol';
import type { PdfTearOffRequest } from '../../shared/messages';
import { SETTINGS_SHOWN_MESSAGE } from '../openPdfTabs';
import { S } from '../pdfHub.strings';
import { HOME, type HubTab, type NewDoc, SETTINGS, type Side, activeKey, activeTab, ask, currentProject, display, isLocal, isPage, library, libraryIdForUrl, pendingPins, pinnedDocIds, projectId, projectName, projects, registerDoc, registered, reloadProjects, sendProjectUpdate, succeeded, tabName, tabs, updateError, setActiveKey, setProjectsLocally } from './store';
import { addBtn, homeBtn, listBtn, listCount, moveBtn, settingsView, splitDrop, strip, tabList, tabListRight } from './dom';
import { type MenuEntry, copyUrl, el, hidePanels, icon, showMenu, showToast } from './uiKit';
import { enforceSleep, ensureFrame, loadWaiters, postToFrame, queuePrefetch, retireFrame } from './frames';
import { dragPrefs, sendToWindow, showWindowMenu, startDrag } from './transfer';
import { closeMirrorPane, closeSplit, focusIfBehind, focusOtherPane, focusSide, frontElement, groupOf, layoutPanes, moveToSide, onScreen, otherSide, releaseTab, replaceInSplit, showInFront, showInPane, split, splitWith, toggleSplit } from './split';
import { closed, reopenClosed, reopenEntries, setClosed, persistState } from './session';
import { localFileId, scheduleLocalFilePrune } from './localFiles';
import { scheduleHomeRender, showHome } from './home/home';
import { removeDocsFromProject } from './home/selection';
import { KIND_LABEL, docKind, kindIcon, showKindMenu } from './looks';
import { moveTab, showMove } from './movePanel';

// A pin or move waiting for a document that never reports itself gives up.
export const PENDING_TIMEOUT_MS = 60_000;
let nextKey = 1;

/** `side`: among which half's tabs while split (default: the half in front). */
export function createTab(doc: NewDoc, side: Side = split?.focus ?? 'left'): HubTab {
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
    key, side, url: doc.url, hash: doc.hash, file: doc.file, fileId: doc.file ? doc.fileId ?? localFileId(doc.file) : null,
    title: initialTitle, paperTitle: null, docId: null, libraryId: doc.url ? libraryIdForUrl(doc.url) : null,
    pinned: false, keepOnUnpin: false, pendingPin: 0, pendingMove: null,
    frame: null, mirror: null, loaded: false, unseenHash: '', prefetched: false, lastShownAt: 0, busyUntil: 0,
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

export function updateTabLabel(tab: HubTab): void {
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

export function pinnedCount(): number {
  return tabs.filter((t) => t.pinned).length;
}

export function insertTab(tab: HubTab, index: number): void {
  const at = Math.min(Math.max(index, tab.pinned ? 0 : pinnedCount()), tabs.length);
  tabs.splice(at, 0, tab);
  placeRoots();
}

const tabLists = [[tabList, 'left'], [tabListRight, 'right']] as const;

/** The list a tab's element belongs in: its half's while split. */
export function listOf(side: Side): HTMLDivElement {
  return split && side === 'right' ? tabListRight : tabList;
}

/**
 * Each tab's element in its half's list, in strip order, and the stand-in
 * of a document shown twice last in its half. Lists already in order are
 * left alone (moving an element would drop its focus).
 */
function placeRoots(): void {
  for (const [list, side] of tabLists) {
    const wanted: Element[] = groupOf(side).map((t) => t.root);
    const ghost = mirrorTab(side);
    if (ghost) wanted.push(ghost);
    const current = Array.from(list.children);
    if (wanted.length === current.length && wanted.every((e, i) => current[i] === e)) continue;
    list.replaceChildren(...wanted);
  }
}

// ─── The stand-in tab of a document shown in both halves ───

let ghost: { root: HTMLDivElement; button: HTMLButtonElement; iconEl: HTMLSpanElement; titleEl: HTMLSpanElement; closeEl: HTMLButtonElement; side: Side } | null = null;

function mirrorTab(side: Side): HTMLDivElement | null {
  const pane = split?.[side];
  const tab = pane?.mirror ? tabs.find((t) => t.key === pane.key) : undefined;
  if (!split || !tab) return null;
  if (!ghost) {
    const root = el('div', { className: 'rpdf-tab is-mirror' });
    const button = el('button', { type: 'button', className: 'rpdf-tab-main', tabIndex: -1 });
    button.setAttribute('role', 'tab');
    const iconEl = el('span', { className: 'rpdf-tab-icon' });
    const titleEl = el('span', { className: 'rpdf-tab-title' });
    const text = el('span', { className: 'rpdf-tab-text' });
    text.append(titleEl);
    button.append(iconEl, text);
    const closeEl = el('button', { type: 'button', className: 'rpdf-tab-close', tabIndex: -1, title: S.closeShortcut });
    closeEl.append(icon('i-close'));
    root.append(button, closeEl);
    const made = { root, button, iconEl, titleEl, closeEl, side };
    button.addEventListener('click', () => focusSide(made.side));
    closeEl.addEventListener('click', () => closeMirrorPane(made.side));
    root.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeMirrorPane(made.side); } });
    ghost = made;
  }
  ghost.side = side;
  const name = tabName(tab);
  ghost.titleEl.textContent = tab.titleEl.textContent;
  ghost.iconEl.replaceChildren(icon('i-split'));
  ghost.button.title = S.splitMirrorTip(name);
  ghost.closeEl.setAttribute('aria-label', S.closeAria(name));
  const on = split.focus === side;
  ghost.root.classList.toggle('is-active', on);
  ghost.button.setAttribute('aria-selected', String(on));
  return ghost.root;
}

/**
 * Opens the documents here (or finds the tab already showing one). Returns,
 * per document, its tab — or null when the project was full.
 */
export function addDocs(docs: NewDoc[], activateLast: boolean, autoActivate = true, at?: number, side?: Side): Array<HubTab | null> {
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
    const tab = createTab(doc, side);
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
export function removeTab(tab: HubTab): void {
  const index = tabs.indexOf(tab);
  if (index < 0) return;
  releaseTab(tab.key);
  tabs.splice(index, 1);
  void retireFrame(tab);
  tab.root.remove();
  if (activeKey === tab.key) {
    setActiveKey(null);
    const neighbor = tabs[index] ?? tabs[index - 1];
    if (neighbor) activate(neighbor.key);
    else showHome(false);
  }
  scheduleLocalFilePrune();
}

/** Shows the tab's document. `focusFrame`: false when the keyboard moves along the strip (focus stays there). */
export function activate(key: number, focusFrame = true): void {
  if (key === HOME) { showHome(true); return; }
  if (key === SETTINGS) { showSettings(); return; }
  const tab = tabs.find((t) => t.key === key);
  if (!tab) return;
  // Split: shown in its own half, which comes in front.
  if (split) {
    showInPane(tab.side, key);
    if (split.focus !== tab.side) {
      focusSide(tab.side, focusFrame);
      void enforceSleep();
      return;
    }
  }
  const now = Date.now();
  const previous = activeTab();
  if (previous) previous.lastShownAt = now;
  showInFront(key);
  setActiveKey(key);
  tab.lastShownAt = now;
  tab.unseenHash = '';
  ensureFrame(tab);
  layoutPanes();
  tab.root.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (focusFrame) frontElement()?.focus();
  render();
  void enforceSleep();
}

/**
 * Leaves the tab in front for a page (home, settings): its frame hides, the
 * strip stays reachable. False when the page was already in the half behind,
 * which came in front instead.
 */
export function leaveTabs(next: number): boolean {
  if (focusIfBehind(next)) return false;
  const previous = activeTab();
  if (previous) {
    previous.lastShownAt = Date.now();
    lastTabKey = previous.key;
  }
  showInFront(next);
  setActiveKey(next);
  layoutPanes();
  return true;
}
export function showSettings(): void {
  if (!leaveTabs(SETTINGS)) return;
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

export function settingsFrame(): HTMLIFrameElement | null {
  return settingsView.querySelector('iframe');
}

export function closedEntry(tab: HubTab, index: number): HubClosedTab | null {
  if (!tab.url && tab.fileId === null) return null;
  return { url: tab.url, fileId: tab.url ? null : tab.fileId, title: tab.title, paperTitle: tab.paperTitle, index, closedAt: Date.now() };
}

export function closeTab(key: number, remember = true): void {
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
export function closeTabs(keys: number[]): void {
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

export function step(action: HubKeyAction): void {
  if (action === 'close') {
    if (activeKey !== null && !isPage(activeKey)) closeTab(activeKey);
    return;
  }
  if (action === 'reopen') { reopenClosed(); return; }
  if (action === 'split') { toggleSplit(); return; }
  if (action === 'pane') { focusOtherPane(); return; }
  // Split: along the tabs of the half in front.
  const group = groupOf(split?.focus ?? 'left');
  if (group.length === 0) return;
  if (isPage(activeKey) || activeKey === null) {
    activate((action === 'next' ? group[0] : group[group.length - 1]).key);
    return;
  }
  if (group.length < 2) return;
  const index = group.findIndex((t) => t.key === activeKey);
  const next = group[(index + (action === 'next' ? 1 : -1) + group.length) % group.length];
  activate(next.key);
}

// Keyboard along the strip: one tab is in the Tab order (the one in front,
// or the last one shown while home or settings is); arrows move along the
// tabs and show each, Home / End go to the ends, Delete closes.
export let lastTabKey: number | null = null;

export function rovingTab(): HubTab | undefined {
  return activeTab() ?? tabs.find((t) => t.key === lastTabKey) ?? tabs[0];
}

export function onStripKey(e: KeyboardEvent, tab: HubTab): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey) return false;
  // Split: along this half's tabs.
  const group = groupOf(split ? tab.side : 'left');
  const index = group.indexOf(tab);
  let next: HubTab | undefined;
  if (e.key === 'ArrowRight') next = group[(index + 1) % group.length];
  else if (e.key === 'ArrowLeft') next = group[(index - 1 + group.length) % group.length];
  else if (e.key === 'Home') next = group[0];
  else if (e.key === 'End') next = group[group.length - 1];
  else if (e.key === 'Delete') {
    if (tab.pinned) { showToast(S.pinnedCantClose); return true; }
    const neighbor = group[index + 1] ?? group[index - 1];
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
export let dragKey: number | null = null;

export function clearStripDropMarks(): void {
  for (const t of tabs) t.root.classList.remove('is-drop-before', 'is-drop-after');
}

export function dropAfter(tab: HubTab, e: DragEvent): boolean {
  const rect = tab.root.getBoundingClientRect();
  return e.clientX > rect.left + rect.width / 2;
}

/**
 * Puts the dragged tab before or after `target` (null: last of its kind, in
 * half `side`'s tabs). From the other half's tabs, it joins this half's.
 */
export function dropTab(moved: HubTab, target: HubTab | null, after: boolean, side: Side = target?.side ?? moved.side): void {
  if (split && moved.side !== side) moveToSide(moved, side);
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
  render();
}

export function wireDrag(tab: HubTab): void {
  const { root } = tab;
  const dragged = () => tabs.find((t) => t.key === dragKey);
  root.addEventListener('dragstart', (e) => {
    dragKey = tab.key;
    root.classList.add('is-dragging');
    // The page below offers its halves (split view).
    document.body.classList.add('is-tab-dragging');
    // Our own types only: another hub page takes it (hub/transfer.ts).
    if (e.dataTransfer) startDrag(tab, e.dataTransfer);
  });
  root.addEventListener('dragend', (e) => {
    dragKey = null;
    root.classList.remove('is-dragging');
    document.body.classList.remove('is-tab-dragging');
    splitDrop.classList.remove('is-armed');
    clearStripDropMarks();
    // Dropped outside this window on nothing that took it: a window of its
    // own there — or (beta) the window it was dropped on, if any.
    if (e.dataTransfer?.dropEffect === 'none' && droppedOutside(e)) {
      void sendToWindow(tab, dragPrefs().windowDrop ? { x: Math.round(e.screenX), y: Math.round(e.screenY) } : null, boundsAt(e));
    }
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

// The strip past the last tab (of a half, while split): drop there to put a
// tab last. The stand-in of a document shown twice counts as past them.
const pastTabs = (e: DragEvent) => !(e.target as Element | null)?.closest('.rpdf-tab:not(.is-mirror)');
for (const [list, side] of tabLists) {
  list.addEventListener('dragover', (e) => {
    const moved = tabs.find((t) => t.key === dragKey);
    if (!moved || moved.pinned || !pastTabs(e)) return;
    e.preventDefault();
    clearStripDropMarks();
    const group = groupOf(side);
    group[group.length - 1]?.root.classList.add('is-drop-after');
  });
  list.addEventListener('drop', (e) => {
    const moved = tabs.find((t) => t.key === dragKey);
    if (!moved || moved.pinned || !pastTabs(e)) return;
    e.preventDefault();
    clearStripDropMarks();
    dropTab(moved, null, true, side);
  });
}

// ─── Pins ───

/** Makes the strip match the project's pinned documents (set here, in another hub, or on another device). */
export function reconcilePinned(): void {
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
    placeRoots();
  }
  render();
}

export function setPinnedById(docId: string, pinned: boolean): void {
  if (!library[docId]) return;
  if (pinned && !isDocInProject(projects, projectId, docId)) {
    if (projectId === DEFAULT_PROJECT_ID) {
      const elsewhere = projectsOfDoc(projects, docId);
      showToast(S.inOtherProject(elsewhere.map(projectName).join(', ')), { label: S.moveHereAndPin, run: () => { void moveHereAndPin(docId, elsewhere); } });
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

/** A document of other projects, pinned in the default one: out of those projects first. */
async function moveHereAndPin(docId: string, from: string[]): Promise<void> {
  for (const project of from) {
    const response = await ask({ type: 'VOCAB_T_PDF_PROJECT_MOVE', docId, url: null, from: project, to: DEFAULT_PROJECT_ID, keep: false });
    if (!succeeded(response)) { showToast(updateError(response, S.moveFailed)); return; }
  }
  await reloadProjects();
  setPinnedById(docId, true);
}

/** Tabs whose documents left this project elsewhere leave its strip. */
export function dropTabsThatLeft(before: Set<string>, now: Set<string>): void {
  const leaving = tabsThatLeft(tabs, before, now);
  for (const tab of leaving) removeTab(tab);
  if (leaving.length) render();
}

export function setPinned(tab: HubTab, pinned: boolean): void {
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

export function completePendingPins(): void {
  for (const tab of tabs) {
    if (!tab.pendingPin || !tab.docId || !library[tab.docId]) continue;
    tab.pendingPin = 0;
    setPinned(tab, true);
  }
}

export function render(): void {
  const current = activeTab();
  const name = activeKey === HOME ? S.home : activeKey === SETTINGS ? S.settings : current?.paperTitle ?? current?.title ?? 'PDF';
  const appName = projectId === DEFAULT_PROJECT_ID ? APP_NAME : `${currentProject().name} · ${APP_NAME}`;
  document.title = hubDocumentTitle(name, tabs.length, appName);
  moveBtn.disabled = !current;
  listCount.textContent = tabs.length ? String(tabs.length) : '';
  listBtn.setAttribute('aria-label', S.allTabsCount(tabs.length));
  const badges = arxivVersionBadges(tabs.map((t) => t.url));
  const roving = rovingTab();
  // Split: two groups of tabs, the boundary on the divider; "+" opens into the half in front.
  strip.classList.toggle('is-split', !!split);
  tabListRight.hidden = !split;
  tabList.classList.toggle('is-focus', !split || split.focus === 'left');
  tabListRight.classList.toggle('is-focus', !!split && split.focus === 'right');
  placeRoots();
  const addAfter = listOf(split?.focus ?? 'left');
  if (addBtn.previousElementSibling !== addAfter) addAfter.after(addBtn);
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
  persistState();
}

// ─── Overflow: scroll fades, wheel scrolling, the tab list ───

export const NARROW_TAB_PX = 150;

export function updateOverflow(): void {
  for (const [list, side] of tabLists) {
    const { scrollLeft, scrollWidth, clientWidth } = list;
    list.classList.toggle('fade-left', scrollLeft > 1);
    list.classList.toggle('fade-right', scrollLeft + clientWidth < scrollWidth - 1);
    // Squeezed tabs drop the paper line (they all share one width).
    const sample = groupOf(side).find((t) => !t.pinned)?.root;
    list.classList.toggle('is-narrow', !!sample && sample.getBoundingClientRect().width < NARROW_TAB_PX);
  }
}
for (const [list] of tabLists) {
  list.addEventListener('scroll', updateOverflow, { passive: true });
  new ResizeObserver(updateOverflow).observe(list);
  list.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || list.scrollWidth <= list.clientWidth) return;
    e.preventDefault();
    list.scrollLeft += e.deltaY;
  }, { passive: false });
}

// ─── Tab context menu ───

export function showTabMenu(tab: HubTab, x: number, y: number): void {
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
  entries.push('sep', ...splitMenu(tab));
  entries.push(
    { label: S.tearOff, run: () => { void sendToWindow(tab, null, null); } },
    { label: S.sendToWindow, run: () => { void showWindowMenu(tab, x, y); } },
  );
  const others = tabs.filter((t) => t !== tab && !t.pinned);
  entries.push(
    'sep',
    { label: S.close, run: () => closeTab(tab.key), disabled: tab.pinned },
    { label: S.closeOthers, run: () => closeTabs(others.map((t) => t.key)), disabled: others.length === 0 },
  );
  showMenu(entries, x, y);
}

// ─── Pin order: drag on home or in the strip ───

/** Writes `docIds` (this project's pins) in this order; applied here at once, read back if not stored. */
export function setPinOrder(docIds: string[]): void {
  const keys = orderKeysBetween(null, null, docIds.length);
  const update: PdfProjectUpdate = { kind: 'pin-order', id: projectId, order: docIds.map((docId, i) => ({ docId, order: keys[i] })) };
  setProjectsLocally(applyPdfProjectUpdate(projects, update));
  void sendProjectUpdate(update).then((response) => {
    if (succeeded(response)) return;
    showToast(updateError(response, S.orderFailed));
    void reloadProjects();
  });
  reconcilePinned();
  scheduleHomeRender();
}

// ─── Messages from viewer frames ───

/** Two tabs turned out to show one document: one goes, and what was waiting on it (a pin, a move) carries over. */
export function mergeTwins(reporter: HubTab, twin: HubTab): void {
  const keep = reporter.pinned && !twin.pinned ? reporter : twin;
  const drop = keep === reporter ? twin : reporter;
  replaceInSplit(drop.key, keep.key);
  if (drop.pendingPin && !keep.pendingPin) keep.pendingPin = drop.pendingPin;
  if (drop.pendingMove && !keep.pendingMove) keep.pendingMove = drop.pendingMove;
  const wasShown = activeKey === drop.key || activeKey === keep.key;
  if (activeKey === drop.key) setActiveKey(null);
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

export function runPendingMove(tab: HubTab): void {
  if (!tab.pendingMove || !(tab.docId ?? tab.libraryId)) return;
  const { to, keep } = tab.pendingMove;
  tab.pendingMove = null;
  void moveTab(tab, to, keep);
}

// ─── Split view and windows, from the tab menu ───

function splitMenu(tab: HubTab): MenuEntry[] {
  const inFront = tab.key === activeKey;
  if (!split) {
    return [inFront
      ? { label: S.splitSame, run: () => splitWith(tab.key, 'right', true) }
      : { label: S.splitOpen, run: () => splitWith(tab.key, 'right') }];
  }
  const behind = otherSide(split.focus);
  const entries: MenuEntry[] = [];
  if (!onScreen(tab.key)) entries.push({ label: S.splitOther, run: () => splitWith(tab.key, behind) });
  else if (inFront && split[behind].key !== tab.key) entries.push({ label: S.splitSameOther, run: () => splitWith(tab.key, behind, true) });
  entries.push({ label: S.splitClose, run: () => closeSplit() });
  return entries;
}

function droppedOutside(e: DragEvent): boolean {
  // Some platforms end a cancelled drag at (0, 0).
  if (e.screenX === 0 && e.screenY === 0) return false;
  return e.screenX < window.screenX || e.screenY < window.screenY
    || e.screenX > window.screenX + window.outerWidth || e.screenY > window.screenY + window.outerHeight;
}

function boundsAt(e: DragEvent): NonNullable<PdfTearOffRequest['bounds']> {
  return { left: Math.round(e.screenX - 80), top: Math.round(e.screenY - 16), width: Math.round(window.outerWidth), height: Math.round(window.outerHeight) };
}
