// ─── Split view: two halves of one hub tab ───
//
// The page can show two panes side by side. The pane in front holds
// `activeKey` — what the strip, the title, the keys and "move" act on — and
// the other pane keeps showing what it showed. Choosing a tab shows it in
// the pane in front, or, when the other pane shows it, brings that pane in
// front; so does pressing anywhere in a pane. Home and settings fill a pane
// like a document.
//
// The same document can be in both panes (the references beside the text):
// the second one is a mirror frame next to the tab's own. Like any two views
// of a document, the one in front (or used) last remembers the reading
// position, and drawings show in both as they are made (the annotation
// cache's channel). Closing the split keeps the pane in front, a mirror
// becoming the tab's own view.
//
// Each half has its own tabs while split: the strip divides where the panes
// do (project and home stay at its left end). A tab shows in its own half;
// dragged to the other half's tabs (or onto that half of the page) it joins
// them and shows there, its old half showing its next tab — or, with none
// left, the halves join, and so do their tabs. A document shown twice has a
// stand-in tab among the second half's tabs.
//
// In: the tab menu, the strip's split button or Alt+Shift+S, or a tab
// dragged onto either half of the page. Out: the same button or key, or
// closing the tab of one half. The divider drags (double-click: even
// halves); its place is per device, and the panes are kept per project for
// this tab's session, so a reload brings them back.

import { HUB_MESSAGE_TAG } from '../../shared/pdfHubProtocol';
import { S } from '../pdfHub.strings';
import { HOME, SETTINGS, type HubTab, type Side, activeKey, activeTab, isPage, isHub, projectId, setActiveKey, tabs } from './store';
import { frames, home, homeBtn, settingsBtn, settingsView, splitBtn, splitDivider, splitDrop, splitFront } from './dom';
import { showToast } from './uiKit';
import { askToStore, ensureFrame, frameUrl, retiring } from './frames';
import { activate, dragKey, render } from './tabStrip';

export type { Side };
export interface Pane {
  key: number;
  /** Shown in the tab's mirror frame (the same document is in the other pane in its own). */
  mirror: boolean;
}
export interface SplitView {
  left: Pane;
  right: Pane;
  focus: Side;
}

export let split: SplitView | null = null;

export const otherSide = (side: Side): Side => (side === 'left' ? 'right' : 'left');

const tabOf = (key: number): HubTab | undefined => tabs.find((t) => t.key === key);

/** Keys on screen: the pane in front and, while split, the other one. */
export function onScreen(key: number): boolean {
  return key === activeKey || (!!split && (split.left.key === key || split.right.key === key));
}

/** The tab shown in the pane behind, if a document is there (not home or settings, not the one in front). */
export function behindKey(): number | null {
  if (!split) return null;
  const pane = split[otherSide(split.focus)];
  return isPage(pane.key) || pane.key === activeKey ? null : pane.key;
}

/** The tabs of half `side` (all of them unless split), in strip order. */
export function groupOf(side: Side): HubTab[] {
  return tabs.filter((t) => (split ? t.side : 'left') === side);
}

/**
 * The tab half `side` shows once `tab` no longer is there: the next of that
 * half's tabs (the one before at the end), or — `tab` being of the other
 * half — the one of this half seen last.
 */
function nextInGroup(side: Side, tab: HubTab | undefined): HubTab | undefined {
  if (tab && tab.side === side) {
    const group = tabs.filter((t) => t.side === side);
    const i = group.indexOf(tab);
    return group[i + 1] ?? group[i - 1];
  }
  return tabs.filter((t) => t.side === side && t !== tab).sort((a, b) => b.lastShownAt - a.lastShownAt)[0];
}

/** The split begins: every tab joins the half keeping what was in front, `key` (not a mirror) the half `side`. */
function beginGroups(side: Side, key: number, mirror: boolean): void {
  for (const t of tabs) t.side = otherSide(side);
  const tab = tabOf(key);
  if (tab && !mirror) tab.side = side;
}

// ─── Mirror frames ───

const loadedMirrors = new WeakSet<HTMLIFrameElement>();

export function noteMirrorLoaded(frame: HTMLIFrameElement): void {
  loadedMirrors.add(frame);
}

/** The tab's second view, opened where its own view is (it is asked first, as before sleeping). */
function ensureMirror(tab: HubTab): HTMLIFrameElement {
  if (tab.mirror) return tab.mirror;
  const frame = document.createElement('iframe');
  frame.title = tab.paperTitle ?? tab.title;
  frame.allow = 'fullscreen; clipboard-write';
  frame.hidden = true;
  tab.mirror = frame;
  const start = (hash: string) => {
    if (tab.mirror !== frame) return;
    frame.src = tab.url ? frameUrl({ ...tab, hash }) : frameUrl(tab);
    if (tab.file) {
      const file = tab.file;
      frame.addEventListener('load', () => frame.contentWindow?.postMessage({ tag: HUB_MESSAGE_TAG, kind: 'open-file', file }, location.origin), { once: true });
    }
    frames.append(frame);
    layoutPanes();
  };
  // Where the reader is: stored as a position, or (never moved in) a `#page=` to open at.
  if (tab.frame && tab.loaded) void askToStore(tab.frame).then((reply) => start(reply.hash));
  else start('');
  return frame;
}

function retire(frame: HTMLIFrameElement): void {
  frame.hidden = true;
  const done = askToStore(frame).then(() => { frame.remove(); retiring.delete(done); });
  retiring.add(done);
}

/** The tab's mirror goes (its drawings stored first). */
export function dropMirror(tab: HubTab): void {
  const frame = tab.mirror;
  tab.mirror = null;
  if (frame) retire(frame);
}

/** The mirror becomes the tab's own view; the view it had goes. */
function promoteMirror(tab: HubTab): void {
  const mirror = tab.mirror;
  if (!mirror) return;
  const own = tab.frame;
  tab.frame = mirror;
  tab.mirror = null;
  tab.loaded = loadedMirrors.has(mirror);
  if (own) retire(own);
}

// ─── Panes ───

function elementFor(pane: Pane): HTMLElement | null {
  if (pane.key === HOME) return home;
  if (pane.key === SETTINGS) return settingsView;
  const tab = tabOf(pane.key);
  if (!tab) return null;
  return pane.mirror ? ensureMirror(tab) : ensureFrame(tab);
}

/** What the pane in front shows (a frame, home or settings). */
export function frontElement(): HTMLElement | null {
  if (activeKey === null) return null;
  return split ? elementFor(split[split.focus]) : activeKey === HOME ? home : activeKey === SETTINGS ? settingsView : tabOf(activeKey)?.frame ?? null;
}

function place(element: HTMLElement, side: Side | null): void {
  element.classList.toggle('rpdf-pane-left', side === 'left');
  element.classList.toggle('rpdf-pane-right', side === 'right');
}

/** Shows what each pane holds and hides the rest; the strip marks the tab behind. */
export function layoutPanes(): void {
  const shown = new Map<HTMLElement, Side | null>();
  if (split) {
    for (const side of ['left', 'right'] as const) {
      const element = elementFor(split[side]);
      if (element) shown.set(element, side);
    }
  } else if (activeKey !== null) {
    const element = frontElement();
    if (element) shown.set(element, null);
  }
  const all: HTMLElement[] = [home, settingsView];
  for (const t of tabs) {
    if (t.frame) all.push(t.frame);
    if (t.mirror) all.push(t.mirror);
  }
  for (const element of all) {
    element.hidden = !shown.has(element);
    place(element, shown.get(element) ?? null);
  }
  homeBtn.setAttribute('aria-pressed', String(activeKey === HOME));
  settingsBtn.setAttribute('aria-pressed', String(activeKey === SETTINGS));
  frames.classList.toggle('is-split', !!split);
  splitDivider.hidden = !split;
  splitFront.hidden = !split;
  if (split) splitFront.dataset.side = split.focus;
  splitBtn.setAttribute('aria-pressed', String(!!split));
  const behind = behindKey();
  for (const t of tabs) t.root.classList.toggle('is-behind', t.key === behind);
  announceFront();
}

// ─── The view in front remembers the reading position ───

let announced: HTMLElement | null = null;

/**
 * Tells the viewer in front that it is: of all views of a document (halves,
 * other hubs), the one brought in front last saves where the reader is.
 * `force`: again (it just loaded, or this hub came back into view).
 */
export function announceFront(force = false): void {
  const front = frontElement();
  if (!(front instanceof HTMLIFrameElement) || (front === announced && !force)) return;
  announced = front;
  front.contentWindow?.postMessage({ tag: HUB_MESSAGE_TAG, kind: 'active' }, location.origin);
}

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') announceFront(true); });
window.addEventListener('focus', () => announceFront(true));

/** Brings pane `side` in front: its tab becomes the active one. */
export function focusSide(side: Side, focusFrame = true): void {
  if (!split || split.focus === side) return;
  const now = Date.now();
  const previous = activeTab();
  if (previous) previous.lastShownAt = now;
  split.focus = side;
  setActiveKey(split[side].key);
  const tab = activeTab();
  if (tab) {
    tab.lastShownAt = now;
    tab.unseenHash = '';
    tab.root.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  layoutPanes();
  if (focusFrame) frontElement()?.focus();
  render();
}

/**
 * Before `key` is shown in front (a tab, home, settings): when the pane
 * behind shows it, that pane comes in front instead — answers true, and
 * nothing else is to change.
 */
export function focusIfBehind(key: number): boolean {
  if (!split) return false;
  const side = otherSide(split.focus);
  if (split[side].key !== key || split[split.focus].key === key) return false;
  focusSide(side);
  return true;
}

/** Pane `side` shows `key` in its own view (a mirror there goes); which pane is in front stays. */
export function showInPane(side: Side, key: number): void {
  if (!split) return;
  const pane = split[side];
  if (pane.key === key && !pane.mirror) return;
  if (pane.mirror) {
    const shown = tabOf(pane.key);
    if (shown) dropMirror(shown);
  }
  split[side] = { key, mirror: false };
}

/**
 * `tab` joins the tabs of half `side` and shows there, in front when
 * `focus`. The half it left shows its next tab, or the halves join when it
 * has none.
 */
export function moveToSide(tab: HubTab, side: Side, focus = true): void {
  if (!split) { tab.side = side; return; }
  const from = otherSide(side);
  const wasShown = split[from].key === tab.key && !split[from].mirror;
  tab.side = side;
  showInPane(side, tab.key);
  if (wasShown) {
    const next = nextInGroup(from, tab);
    if (!next) { closeSplit(side); return; }
    split[from] = { key: next.key, mirror: false };
  }
  if (focus && split.focus !== side) { focusSide(side); return; }
  setActiveKey(split[split.focus].key);
  layoutPanes();
  if (focus) frontElement()?.focus();
  render();
}

/** The stand-in tab of a document shown twice closes: its half shows one of its own tabs, or the halves join. */
export function closeMirrorPane(side: Side): void {
  if (!split || !split[side].mirror) return;
  const next = nextInGroup(side, tabOf(split[side].key));
  if (!next) { closeSplit(otherSide(side)); return; }
  showInPane(side, next.key);
  if (split.focus === side) setActiveKey(next.key);
  layoutPanes();
  render();
}

/** The pane in front now shows `key` (a mirror there goes). Call before `setActiveKey`. */
export function showInFront(key: number): void {
  if (!split) return;
  const pane = split[split.focus];
  if (pane.key === key) return;
  if (pane.mirror) {
    const tab = tabOf(pane.key);
    if (tab) dropMirror(tab);
  }
  split[split.focus] = { key, mirror: false };
}

/**
 * Shows `key` in pane `side` and brings it in front (`focusNew`, or else
 * keeps the pane in front); the other pane keeps (or, when not split yet,
 * takes) what is in front now. `mirror`: the same document as the other
 * pane, in a second view.
 */
export function splitWith(key: number, side: Side = 'right', mirror = false, focusNew = true): void {
  if (activeKey === null) { activate(key); return; }
  const tab = tabOf(key);
  if (!tab && !isPage(key)) return;
  if (!split) {
    if (key === activeKey && !mirror) return;
    split = { left: { key: activeKey, mirror: false }, right: { key: activeKey, mirror: false }, focus: otherSide(side) };
    beginGroups(side, key, mirror);
  } else if (tab && !mirror) {
    // A tab, from either half: it joins this half's tabs.
    moveToSide(tab, side, focusNew);
    return;
  } else {
    const there = split[side];
    if (there.key === key && there.mirror === mirror) { focusSide(side); return; }
    if (there.mirror) {
      const shown = tabOf(there.key);
      if (shown) dropMirror(shown);
    }
  }
  split[side] = { key, mirror };
  if (split.focus === side) {
    setActiveKey(key);
    layoutPanes();
    frontElement()?.focus();
    render();
  } else if (focusNew) {
    focusSide(side);
  } else {
    layoutPanes();
    render();
  }
}

/** Joins the halves: pane `keep` (the one in front by default) fills the page. */
export function closeSplit(keep?: Side): void {
  if (!split) return;
  const side = keep ?? split.focus;
  const kept = split[side];
  const gone = split[otherSide(side)];
  const goneTab = tabOf(gone.key);
  const keptTab = tabOf(kept.key);
  if (gone.mirror && goneTab) dropMirror(goneTab);
  if (kept.mirror && keptTab) promoteMirror(keptTab);
  if (goneTab) goneTab.lastShownAt = Date.now();
  split = null;
  // One strip again: the left half's tabs, then the right half's.
  const merged = [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned && t.side === 'left'), ...tabs.filter((t) => !t.pinned && t.side === 'right')];
  tabs.splice(0, tabs.length, ...merged);
  for (const t of tabs) t.side = 'left';
  setActiveKey(kept.key);
  layoutPanes();
  frontElement()?.focus();
  render();
}

/**
 * A tab leaves the strip: the half showing it shows that half's next tab,
 * or, with none, the split ends with the other half (a document in both
 * halves keeps its own view).
 */
export function releaseTab(key: number): void {
  if (!split) return;
  const left = split.left.key === key;
  const right = split.right.key === key;
  if (left && right) { closeSplit(split.left.mirror ? 'right' : 'left'); return; }
  const side: Side | null = left ? 'left' : right ? 'right' : null;
  if (!side) return;
  const tab = tabOf(key);
  const next = nextInGroup(side, tab);
  if (!next) { closeSplit(otherSide(side)); return; }
  if (split[side].mirror && tab) dropMirror(tab);
  split[side] = { key: next.key, mirror: false };
  if (split.focus === side) setActiveKey(next.key);
  layoutPanes();
}

/** Two tabs turned out to be one document: the halves show the one kept. */
export function replaceInSplit(dropKey: number, keepKey: number): void {
  if (!split) return;
  for (const side of ['left', 'right'] as const) {
    if (split[side].key !== dropKey) continue;
    split[side] = { key: keepKey, mirror: false };
    const kept = tabOf(keepKey);
    if (kept) kept.side = side;
  }
  if (activeKey === dropKey) setActiveKey(keepKey);
  if (split.left.key === split.right.key && !split.left.mirror && !split.right.mirror) closeSplit();
}

/** The tab shown most recently besides `key` (home's documents first by when they were seen). */
function lastShownOther(key: number | null): HubTab | undefined {
  return tabs
    .filter((t) => t.key !== key)
    .sort((a, b) => b.lastShownAt - a.lastShownAt)[0];
}

/** The split button and Alt+Shift+S: halves on (the last other document beside this one, or this one twice), or joined. */
export function toggleSplit(): void {
  if (split) { closeSplit(); return; }
  const front = activeTab();
  const partner = lastShownOther(front?.key ?? null);
  // The reader stays where they were; the other half fills beside it.
  if (front && partner) splitWith(partner.key, 'right', false, false);
  else if (front) splitWith(front.key, 'right', true, false);
  else if (partner && activeKey !== null) splitWith(partner.key, 'right', false, false);
  else showToast(S.splitNothing);
}

/** Alt+Shift+O: the other half comes in front. */
export function focusOtherPane(): void {
  if (split) focusSide(otherSide(split.focus));
}

/** A tab dropped on half `side` of the page. */
export function dropOnSide(key: number, side: Side): void {
  if (!split && key === activeKey) {
    // The tab in front dragged to one half: beside it the one shown before, or itself again.
    const partner = lastShownOther(key);
    if (partner) {
      split = { left: { key: partner.key, mirror: false }, right: { key: partner.key, mirror: false }, focus: otherSide(side) };
      split[side] = { key, mirror: false };
      beginGroups(side, key, false);
      focusSide(side);
    } else {
      splitWith(key, otherSide(side), true);
      if (split) focusSide(side);
    }
    return;
  }
  splitWith(key, side);
}

/** Which pane holds the frame a viewer message came from. */
export function sideOfWindow(source: MessageEventSource | null): Side | null {
  if (!split || !source) return null;
  for (const side of ['left', 'right'] as const) {
    const pane = split[side];
    const tab = tabOf(pane.key);
    const frame = tab ? (pane.mirror ? tab.mirror : tab.frame) : pane.key === SETTINGS ? settingsView.querySelector('iframe') : null;
    if (frame?.contentWindow === source) return side;
  }
  return null;
}

// ─── Divider ───

const RATIO_STORAGE_KEY = 'rpdfSplitRatio';
const MIN_PANE_PX = 240;

function readRatio(): number {
  try {
    const value = Number.parseFloat(localStorage.getItem(RATIO_STORAGE_KEY) ?? '');
    return Number.isFinite(value) && value > 0 && value < 1 ? value : 0.5;
  } catch {
    return 0.5;
  }
}

let ratio = readRatio();

function applyRatio(): void {
  const width = frames.clientWidth;
  const min = width > 0 ? Math.min(0.5, MIN_PANE_PX / width) : 0.2;
  const shown = Math.min(1 - min, Math.max(min, ratio));
  frames.style.setProperty('--split-at', `${(shown * 100).toFixed(2)}%`);
  // The strip's two groups divide where the panes do (a length: a % there is of the strip's own box).
  document.documentElement.style.setProperty('--split-px', `${Math.round(shown * width)}px`);
}

function setRatio(next: number, save: boolean): void {
  ratio = next;
  applyRatio();
  if (!save) return;
  try {
    localStorage.setItem(RATIO_STORAGE_KEY, String(Math.round(ratio * 1000) / 1000));
  } catch {
    /* this session only */
  }
}

applyRatio();
new ResizeObserver(applyRatio).observe(frames);

splitDivider.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  splitDivider.setPointerCapture(e.pointerId);
  // Frames under the pointer would take the moves.
  document.body.classList.add('is-resizing');
  const rect = frames.getBoundingClientRect();
  const move = (ev: PointerEvent) => setRatio((ev.clientX - rect.left) / rect.width, false);
  const up = () => {
    document.body.classList.remove('is-resizing');
    splitDivider.removeEventListener('pointermove', move);
    setRatio(ratio, true);
  };
  splitDivider.addEventListener('pointermove', move);
  splitDivider.addEventListener('pointerup', up, { once: true });
  splitDivider.addEventListener('pointercancel', up, { once: true });
});
splitDivider.addEventListener('dblclick', () => setRatio(0.5, true));
splitDivider.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  setRatio(ratio + (e.key === 'ArrowLeft' ? -0.05 : 0.05), true);
});

// Pressing home or the settings pane brings its half in front (viewers say so themselves).
for (const element of [home, settingsView]) {
  element.addEventListener('pointerdown', () => {
    if (split && element.classList.contains(`rpdf-pane-${otherSide(split.focus)}`)) focusSide(otherSide(split.focus), false);
  }, { capture: true });
}
// The settings frame is a page of its own: focus moving into it is the sign.
window.addEventListener('blur', () => {
  setTimeout(() => {
    const frame = settingsView.querySelector('iframe');
    if (split && frame && document.activeElement === frame && split[otherSide(split.focus)].key === SETTINGS) focusSide(otherSide(split.focus), false);
  }, 0);
});

splitBtn.addEventListener('click', toggleSplit);

// ─── Dropping a tab on a half ───

for (const half of Array.from(splitDrop.querySelectorAll<HTMLElement>('[data-side]'))) {
  half.addEventListener('dragover', (e) => {
    if (dragKey === null) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    splitDrop.classList.add('is-armed');
    half.classList.add('is-over');
  });
  half.addEventListener('dragleave', () => half.classList.remove('is-over'));
  half.addEventListener('drop', (e) => {
    half.classList.remove('is-over');
    const key = dragKey;
    if (key === null) return;
    e.preventDefault();
    dropOnSide(key, half.dataset.side === 'left' ? 'left' : 'right');
  });
}

// ─── Kept for the session (a reload, a project switched back to) ───

const SPLIT_STORAGE_KEY = 'rpdfSplit';

interface SavedPane {
  url: string | null;
  fileId: number | null;
  page: 'home' | 'settings' | null;
  mirror: boolean;
}

let restored = false;

function savedPane(pane: Pane): SavedPane | null {
  if (pane.key === HOME || pane.key === SETTINGS) return { url: null, fileId: null, page: pane.key === HOME ? 'home' : 'settings', mirror: false };
  const tab = tabOf(pane.key);
  if (!tab || (!tab.url && tab.fileId === null)) return null;
  return { url: tab.url, fileId: tab.url ? null : tab.fileId, page: null, mirror: pane.mirror };
}

/** Records the halves of this project for the tab's session (called with every saved state). */
export function saveSplit(): void {
  if (!restored || !isHub) return;
  const key = `${SPLIT_STORAGE_KEY}:${projectId}`;
  try {
    const left = split ? savedPane(split.left) : null;
    const right = split ? savedPane(split.right) : null;
    // The right half's tabs (the rest are the left half's).
    const rightTabs = split ? tabs.filter((t) => t.side === 'right' && (t.url || t.fileId !== null)).map((t) => ({ url: t.url, fileId: t.url ? null : t.fileId })) : [];
    if (split && left && right) sessionStorage.setItem(key, JSON.stringify({ left, right, focus: split.focus, rightTabs }));
    else sessionStorage.removeItem(key);
  } catch {
    /* not kept */
  }
}

function savedTab(saved: unknown): HubTab | undefined {
  if (!saved || typeof saved !== 'object') return undefined;
  const s = saved as Partial<SavedPane>;
  return typeof s.url === 'string'
    ? tabs.find((t) => t.url === s.url)
    : typeof s.fileId === 'number' ? tabs.find((t) => t.fileId === s.fileId) : undefined;
}

function paneFor(saved: unknown): Pane | null {
  if (!saved || typeof saved !== 'object') return null;
  const s = saved as Partial<SavedPane>;
  if (s.page === 'home') return { key: HOME, mirror: false };
  if (s.page === 'settings') return { key: SETTINGS, mirror: false };
  const tab = savedTab(saved);
  return tab ? { key: tab.key, mirror: s.mirror === true } : null;
}

/** Brings back this project's halves once the tabs are restored (boot). */
export function restoreSplit(): void {
  restored = true;
  try {
    const raw = JSON.parse(sessionStorage.getItem(`${SPLIT_STORAGE_KEY}:${projectId}`) ?? 'null') as { left?: unknown; right?: unknown; focus?: unknown; rightTabs?: unknown } | null;
    if (!raw) return;
    const left = paneFor(raw.left);
    const right = paneFor(raw.right);
    if (!left || !right || (left.key === right.key && left.mirror === right.mirror)) return;
    const focus: Side = raw.focus === 'left' ? 'left' : 'right';
    for (const t of tabs) t.side = 'left';
    if (Array.isArray(raw.rightTabs)) for (const saved of raw.rightTabs) { const t = savedTab(saved); if (t) t.side = 'right'; }
    for (const side of ['left', 'right'] as const) {
      const pane = side === 'left' ? left : right;
      const t = tabOf(pane.key);
      if (t && !pane.mirror) t.side = side;
    }
    split = { left, right, focus: otherSide(focus) };
    focusSide(focus);
  } catch {
    /* none */
  }
}
