// ─── Moving a document's tab between hubs (shared/tabTransfer.ts) ───
//
// Every way a tab leaves for another hub ends in one place: the receiving
// hub's `receive`. It works out the case (same project, another one, the
// default one), asks what to do unless the device's settings already say,
// then takes the document from the hub it is in over a BroadcastChannel —
// that hub stores where the reader is, lets the tab go on a move, and hands
// over a file picked from disk — and opens it, with a notice that can undo.
//
//   • dropped on this hub page (from another window, or the other half of a
//     browser's split view): `receive` from the drop;
//   • sent from the tab menu or dropped on another window's empty space
//     (beta): the background finds the window; one holding a hub of the
//     project gets an offer (that hub asks as for a drop), any other a new
//     hub tab with just this document and a note of where it came from.
//
// Drawings follow on their own (the annotation channel); the reading
// position is whatever the view last brought in front saved.

import { DEFAULT_PROJECT_ID, isDocInProject, projectsOfDoc } from '../../shared/pdfProjects';
import {
  DEFAULT_DRAG_PREFS, DRAG_PREFS_STORAGE_KEY, TAB_DRAG_TYPE, dropCase, parseDragPrefs, parseTabPayload, sourceOfTypes, sourceType,
  type DragPrefs, type DropAction, type DropCase, type TabPayload,
} from '../../shared/tabTransfer';
import type { PdfTearOffRequest } from '../../shared/messages';
import { S } from '../pdfHub.strings';
import { type HubTab, ask, isHub, myTabId, openTabFor, projectId, projectName, projects, sendProjectUpdate, succeeded, tabName, tabs } from './store';
import { splitDrop, tabList, tabListRight } from './dom';
import { el, showMenu, showToast } from './uiKit';
import { askToStore } from './frames';
import { activate, addDocs, clearStripDropMarks, dragKey, removeTab, render, updateTabLabel } from './tabStrip';
import { dropOnSide, type Side } from './split';
import { handOverToHub } from './localFiles';

// ─── Settings ───

let prefs: DragPrefs = DEFAULT_DRAG_PREFS;
void chrome.storage.local.get(DRAG_PREFS_STORAGE_KEY).then((stored) => { prefs = parseDragPrefs(stored[DRAG_PREFS_STORAGE_KEY]); }, () => undefined);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[DRAG_PREFS_STORAGE_KEY]) prefs = parseDragPrefs(changes[DRAG_PREFS_STORAGE_KEY].newValue);
});

export function dragPrefs(): DragPrefs {
  return prefs;
}

// ─── The channel between hubs ───

type TransferMessage =
  // `by` asks the hub in tab `to` for its tab `key`; `remove`: it leaves there.
  | { t: 'take'; id: string; to: number; by: number; key: number; remove: boolean }
  | { t: 'given'; id: string; to: number; ok: boolean; file: File | null; hash: string }
  // The hub holding a document offers it to the hub in tab `to` (`action` null: that hub decides).
  | { t: 'offer'; to: number; payload: TabPayload; action: DropAction | null };

const channel = new BroadcastChannel('rpdf-tab-transfer');
const TAKE_TIMEOUT_MS = 4_000;
const OFFER_TIMEOUT_MS = 60_000;

const post = (message: TransferMessage) => channel.postMessage(message);
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** What a tab carries when dragged or sent. */
export function payloadFor(tab: HubTab): TabPayload | null {
  if (myTabId === null) return null;
  return {
    from: myTabId, key: tab.key, project: projectId, url: tab.url, docId: tab.docId ?? tab.libraryId,
    title: tab.title, paperTitle: tab.paperTitle, pinned: tab.pinned,
  };
}

/** A tab's drag carries our own types only (never the address as text: Chrome's tab strip would navigate a tab to it). */
export function startDrag(tab: HubTab, data: DataTransfer): void {
  const payload = payloadFor(tab);
  if (!payload || myTabId === null) return;
  data.setData(TAB_DRAG_TYPE, JSON.stringify(payload));
  data.setData(sourceType(myTabId, projectId), '1');
  data.effectAllowed = 'move';
}

// ─── Giving: this hub holds the document ───

// Offers waiting for the other hub to take the tab: key → settle.
const offers = new Map<number, (taken: boolean) => void>();
// A hub made for a document sent here closes when that document is sent back.
let closeWhenEmptied = false;

async function give(message: Extract<TransferMessage, { t: 'take' }>): Promise<void> {
  const tab = tabs.find((t) => t.key === message.key);
  if (!isHub || !tab) {
    post({ t: 'given', id: message.id, to: message.by, ok: false, file: null, hash: '' });
    return;
  }
  offers.get(tab.key)?.(true);
  // Where the reader is, stored before the other hub opens it.
  const stored = tab.frame ? await askToStore(tab.frame) : { ok: true, hash: '' };
  post({ t: 'given', id: message.id, to: message.by, ok: true, file: tab.file, hash: stored.hash });
  // A pinned document stays: pins are the project's, in every hub of it.
  if (!message.remove || tab.pinned || !tabs.includes(tab)) return;
  const name = tabName(tab);
  removeTab(tab);
  render();
  if (closeWhenEmptied && tabs.length === 0 && myTabId !== null) { void chrome.tabs.remove(myTabId).catch(() => undefined); return; }
  showToast(S.tabSentAway(name));
}

/** Offers the tab to the hub in tab `to`; false when nothing took it (that hub is gone). */
function offer(to: number, tab: HubTab, action: DropAction | null): Promise<boolean> {
  const payload = payloadFor(tab);
  if (!payload) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => settle(false), action ? TAKE_TIMEOUT_MS : OFFER_TIMEOUT_MS);
    function settle(taken: boolean): void {
      clearTimeout(timer);
      if (offers.get(tab.key) === settle) offers.delete(tab.key);
      resolve(taken);
    }
    offers.set(tab.key, settle);
    post({ t: 'offer', to, payload, action });
  });
}

// ─── Taking: this hub receives ───

const takes = new Map<string, (message: Extract<TransferMessage, { t: 'given' }> | null) => void>();

function takeFrom(payload: TabPayload, remove: boolean): Promise<{ file: File | null; hash: string } | null> {
  if (myTabId === null) return Promise.resolve(null);
  const id = newId();
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(null), TAKE_TIMEOUT_MS);
    function done(message: Extract<TransferMessage, { t: 'given' }> | null): void {
      clearTimeout(timer);
      takes.delete(id);
      resolve(message?.ok ? { file: message.file, hash: message.hash } : null);
    }
    takes.set(id, done);
    post({ t: 'take', id, to: payload.from, by: myTabId as number, key: payload.key, remove });
  });
}

/** Where the document really is: its hub's project, or (a guest there) the project it belongs to. */
function sourceProject(payload: TabPayload): string {
  if (!payload.docId || isDocInProject(projects, payload.project, payload.docId)) return payload.project;
  return projectsOfDoc(projects, payload.docId)[0] ?? payload.project;
}

export interface DropPlace {
  /** Where in the strip. */
  index?: number;
  /** Among which half's tabs (split view). */
  group?: Side;
  /** Which half of the page. */
  side?: Side;
  /** Where the dialog goes (page coordinates). */
  x?: number;
  y?: number;
}

/** A document arriving from another hub: decide, take it from there, open it here. */
export async function receive(payload: TabPayload, place: DropPlace, decided: DropAction | null): Promise<void> {
  if (!isHub || payload.from === myTabId) return;
  const from = sourceProject(payload);
  const inHere = !!payload.docId && isDocInProject(projects, projectId, payload.docId);
  // A pinned document of this project is here already.
  if (payload.pinned && from === projectId) {
    const there = payload.docId ? openTabFor(payload.docId) : undefined;
    if (there) { activate(there.key); return; }
  }
  const kind = dropCase(from, projectId, inHere);
  const choice = prefs[kind];
  const action = decided ?? (choice !== 'ask' ? choice : await askDrop(kind, payload, from, place));
  if (!action) return;
  const got = await takeFrom(payload, action === 'move');
  if (!got && !payload.url) { showToast(S.transferFailed); return; }
  const [tab] = addDocs([{ url: payload.url, hash: got?.hash ?? '', file: got?.file ?? null }], true, true, place.index, place.group);
  if (!tab) return;
  if (!tab.loaded) {
    tab.title = payload.title;
    tab.paperTitle = tab.paperTitle ?? payload.paperTitle;
    updateTabLabel(tab);
  }
  if (place.side) dropOnSide(tab.key, place.side);
  const name = tabName(tab);
  // The document's projects: moved here, added here, or out of its projects.
  const docId = payload.docId;
  if (docId && kind === 'other') {
    const response = await ask({ type: 'VOCAB_T_PDF_PROJECT_MOVE', docId, url: null, from, to: projectId, keep: action === 'keep' });
    if (!succeeded(response)) { showToast(S.moveFailed); return; }
  } else if (docId && kind === 'default' && action === 'move') {
    const response = await ask({ type: 'VOCAB_T_PDF_PROJECT_MOVE', docId, url: null, from, to: DEFAULT_PROJECT_ID, keep: false });
    if (!succeeded(response)) { showToast(S.moveFailed); return; }
  }
  showToast(arrivedText(kind, action, name, from), { label: S.undo, run: () => { void undoArrival(tab, payload.from, kind, action); } });
}

function arrivedText(kind: DropCase, action: DropAction, name: string, from: string): string {
  if (kind === 'same') return action === 'move' ? S.tabMovedHere(name) : S.tabKeptBoth(name);
  if (kind === 'other') return action === 'move' ? S.movedHere(S.docsOne(name), projectName(from)) : S.alsoAddedHere(name);
  return action === 'move' ? S.tookOutOfProjects(name) : S.openedAsGuest(name);
}

/**
 * Puts back what an arrival did. Kept in both: it just closes here (and is no
 * longer added to this project). Moved: the hub it came from takes it back —
 * a move there like any other, so the projects go back too.
 */
async function undoArrival(tab: HubTab, from: number, kind: DropCase, action: DropAction): Promise<void> {
  if (!tabs.includes(tab)) return;
  if (action === 'move') {
    if (!(await offer(from, tab, 'move'))) showToast(S.sendBackFailed);
    return;
  }
  const docId = tab.docId ?? tab.libraryId;
  if (docId && kind === 'other') await sendProjectUpdate({ kind: 'member', id: projectId, docId, member: false });
  removeTab(tab);
  render();
}

// ─── Asking ───

let askPanel: HTMLDivElement | null = null;
let closeAsk: ((action: DropAction | null) => void) | null = null;

function askDrop(kind: DropCase, payload: TabPayload, from: string, place: DropPlace): Promise<DropAction | null> {
  closeAsk?.(null);
  const panel = askPanel ?? (askPanel = el('div', { className: 'rpdf-popover rpdf-ask' }));
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', S.askTitle);
  if (!panel.isConnected) document.body.append(panel);
  const name = payload.paperTitle ?? payload.title;
  const [primary, secondary] = kind === 'same'
    ? [S.askMoveHere, S.askKeepBoth]
    : kind === 'other' ? [S.askMoveToProject(projectName(projectId)), S.askAddHere] : [S.askTakeOut, S.askGuest];
  const sub = kind === 'same' ? S.askSameSub : S.askFromProject(projectName(from));
  const title = el('p', { className: 'rpdf-ask-title', textContent: S.docsOne(name) });
  const lines = [el('p', { className: 'rpdf-ask-sub', textContent: sub })];
  if (kind !== 'same' && payload.pinned) lines.push(el('p', { className: 'rpdf-ask-note', textContent: S.askPinNote(projectName(from)) }));
  if (kind === 'same') lines.push(el('p', { className: 'rpdf-ask-note', textContent: S.askSameNote }));
  const moveBtn = el('button', { type: 'button', className: 'rpdf-primary', textContent: primary });
  const keepBtn = el('button', { type: 'button', className: 'rpdf-ask-btn', textContent: secondary });
  const cancelBtn = el('button', { type: 'button', className: 'rpdf-ask-btn rpdf-ask-cancel', textContent: S.cancel });
  const actions = el('div', { className: 'rpdf-ask-actions' });
  actions.append(moveBtn, keepBtn, cancelBtn);
  const remember = el('input', { type: 'checkbox' });
  const rememberRow = el('label', { className: 'rpdf-ask-remember' });
  rememberRow.append(remember, el('span', { textContent: S.askRemember }));
  panel.replaceChildren(title, ...lines, actions, rememberRow);
  panel.hidden = false;
  const { width, height } = panel.getBoundingClientRect();
  const x = place.x ?? window.innerWidth / 2;
  const y = place.y ?? window.innerHeight / 3;
  panel.style.left = `${Math.max(8, Math.min(x - width / 2, window.innerWidth - width - 8))}px`;
  panel.style.top = `${Math.max(8, Math.min(y - 20, window.innerHeight - height - 8))}px`;
  panel.style.right = 'auto';
  moveBtn.focus();
  return new Promise((resolve) => {
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
    };
    const outside = (e: PointerEvent) => { if (!panel.contains(e.target as Node)) finish(null); };
    function finish(action: DropAction | null): void {
      closeAsk = null;
      panel.hidden = true;
      document.removeEventListener('keydown', keys, true);
      document.removeEventListener('pointerdown', outside, true);
      if (action && remember.checked) {
        prefs = { ...prefs, [kind]: action };
        void chrome.storage.local.set({ [DRAG_PREFS_STORAGE_KEY]: prefs }).catch(() => undefined);
      }
      resolve(action);
    }
    closeAsk = finish;
    moveBtn.addEventListener('click', () => finish('move'));
    keepBtn.addEventListener('click', () => finish('keep'));
    cancelBtn.addEventListener('click', () => finish(null));
    document.addEventListener('keydown', keys, true);
    document.addEventListener('pointerdown', outside, true);
  });
}

// ─── Sending to another window ───

type SendReply = { success?: boolean; hubTabId?: number; created?: boolean; error?: string } | undefined;

/**
 * Sends the document to window `target` (by id, or the one under a screen
 * point), or to a new window at `bounds` when `target` is null or finds none.
 * A window holding a hub of this project gets an offer (that hub asks);
 * otherwise a hub tab made there holds just this document, and the tab
 * leaves here.
 */
export async function sendToWindow(tab: HubTab, target: PdfTearOffRequest['target'], bounds: PdfTearOffRequest['bounds']): Promise<void> {
  if (!tab.url && !tab.file) { showToast(S.tearOffLocal); return; }
  if (tab.frame) await askToStore(tab.frame);
  const request: PdfTearOffRequest = { type: 'VOCAB_T_PDF_TEAR_OFF', project: projectId, url: tab.url, bounds, target, arrival: { key: tab.key, title: tabName(tab) } };
  const response = await ask<SendReply>(request as unknown as Record<string, unknown>);
  if (!response?.success || typeof response.hubTabId !== 'number') { showToast(S.tearOffFailed); return; }
  if (!response.created) {
    if (!(await offer(response.hubTabId, tab, null))) showToast(S.sendFailed);
    return;
  }
  if (!tab.url && !(await handOverToHub(response.hubTabId, tab))) { showToast(S.tearOffFailed); return; }
  if (!tab.pinned && tabs.includes(tab)) {
    removeTab(tab);
    render();
  }
}

/** "다른 창으로 보내기…": the other windows, numbered as Chrome lists them, and a new one. */
export async function showWindowMenu(tab: HubTab, x: number, y: number): Promise<void> {
  const reply = await ask<{ success?: boolean; windows?: Array<{ windowId: number; number: number; tabs: number; hasHub: boolean }> }>({ type: 'VOCAB_T_PDF_WINDOWS', project: projectId });
  const windows = reply?.windows ?? [];
  showMenu([
    { heading: S.sendToWindowHead },
    ...windows.map((w) => ({ label: S.windowLabel(w.number, w.tabs, w.hasHub), run: () => { void sendToWindow(tab, { windowId: w.windowId }, null); } })),
    ...(windows.length ? ['sep' as const] : []),
    { label: S.newWindow, run: () => { void sendToWindow(tab, null, null); } },
  ], x, y);
}

// ─── A hub made for a document sent here ───

const ARRIVALS_KEY = 'rpdfArrivals';

/** Shows where the document came from, with a way to keep it there too or send it back. */
export async function takeArrival(): Promise<void> {
  if (!isHub || myTabId === null) return;
  const stored = (await chrome.storage.session.get(ARRIVALS_KEY).catch(() => ({} as Record<string, unknown>)))[ARRIVALS_KEY];
  const all = stored && typeof stored === 'object' ? stored as Record<string, { from?: unknown; title?: unknown }> : {};
  const arrival = all[String(myTabId)];
  if (!arrival || !Number.isInteger(arrival.from)) return;
  delete all[String(myTabId)];
  await chrome.storage.session.set({ [ARRIVALS_KEY]: all }).catch(() => undefined);
  const from = arrival.from as number;
  closeWhenEmptied = true;
  const title = typeof arrival.title === 'string' ? arrival.title : '';
  const theTab = () => tabs.find((t) => tabName(t) === title) ?? tabs[tabs.length - 1];
  showToast(
    S.tabMovedHere(title),
    { label: S.keepThereToo, run: () => { const t = theTab(); if (t) void offer(from, t, 'keep').then((ok) => { if (!ok) showToast(S.sendBackFailed); }); } },
    { label: S.undo, run: () => { const t = theTab(); if (t) void offer(from, t, 'move').then((ok) => { if (!ok) showToast(S.sendBackFailed); }); } },
  );
}

// ─── Messages ───

channel.onmessage = (event: MessageEvent<unknown>) => {
  const m = event.data as Partial<TransferMessage> | null;
  if (!m || typeof m !== 'object' || myTabId === null || m.to !== myTabId) return;
  if (m.t === 'take' && typeof m.id === 'string' && Number.isInteger(m.by) && Number.isInteger(m.key)) {
    void give({ t: 'take', id: m.id, to: myTabId, by: m.by as number, key: m.key as number, remove: m.remove === true });
  } else if (m.t === 'given' && typeof m.id === 'string') {
    const file = (m as { file?: unknown }).file;
    takes.get(m.id)?.({ t: 'given', id: m.id, to: myTabId, ok: m.ok === true, file: file instanceof File ? file : null, hash: typeof m.hash === 'string' ? m.hash : '' });
  } else if (m.t === 'offer') {
    const payload = parseTabPayload((m as { payload?: unknown }).payload);
    const action = m.action === 'move' || m.action === 'keep' ? m.action : null;
    if (payload) void receive(payload, {}, action);
  }
};

// ─── Drops from another hub page ───
//
// Another window's tab (or the other half of a browser's split view) dragged
// over this page: the strip marks where it goes, the page offers its halves.
// Over a viewer the frame takes the drag events, so the viewer says so and
// the halves come up above it.

let disarmTimer: ReturnType<typeof setTimeout> | null = null;

function foreignDrag(e: DragEvent): boolean {
  if (dragKey !== null || !e.dataTransfer) return false;
  const types = Array.from(e.dataTransfer.types);
  if (!types.includes(TAB_DRAG_TYPE)) return false;
  return sourceOfTypes(types)?.from !== myTabId;
}

/** Shows the halves for a drag that came from elsewhere (until it leaves or drops). */
export function armForeignDrop(): void {
  if (!isHub) return;
  document.body.classList.add('is-tab-dragging', 'is-foreign-drag');
  if (disarmTimer) clearTimeout(disarmTimer);
  disarmTimer = setTimeout(disarm, 1_200);
}

function disarm(): void {
  if (disarmTimer) clearTimeout(disarmTimer);
  disarmTimer = null;
  document.body.classList.remove('is-foreign-drag');
  if (dragKey === null) document.body.classList.remove('is-tab-dragging');
  splitDrop.classList.remove('is-armed');
  for (const half of Array.from(splitDrop.querySelectorAll('.is-over'))) half.classList.remove('is-over');
  clearStripDropMarks();
}

/** Where in the strip a drop at `e` goes (and, split, among which half's tabs), marking it. */
function stripPlace(e: DragEvent, mark: boolean): Pick<DropPlace, 'index' | 'group'> | undefined {
  const target = (e.target as Element | null)?.closest<HTMLElement>('.rpdf-tab');
  const tab = target ? tabs.find((t) => t.root === target) : undefined;
  if (!tab) {
    const list = (e.target as Element | null)?.closest<HTMLElement>('.rpdf-tabs');
    return list ? { index: tabs.length, group: list.dataset.side === 'right' ? 'right' : 'left' } : undefined;
  }
  const rect = tab.root.getBoundingClientRect();
  const after = e.clientX > rect.left + rect.width / 2;
  if (mark) {
    clearStripDropMarks();
    tab.root.classList.add(after ? 'is-drop-after' : 'is-drop-before');
  }
  return { index: tabs.indexOf(tab) + (after ? 1 : 0), group: tab.side };
}

function halfAt(e: DragEvent): HTMLElement | null {
  return (e.target as Element | null)?.closest<HTMLElement>('.rpdf-split-half') ?? null;
}

document.addEventListener('dragover', (e) => {
  if (!foreignDrag(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  armForeignDrop();
  const half = halfAt(e);
  splitDrop.classList.toggle('is-armed', !!half);
  for (const h of Array.from(splitDrop.querySelectorAll<HTMLElement>('.rpdf-split-half'))) h.classList.toggle('is-over', h === half);
  if (!half) stripPlace(e, true);
});

document.addEventListener('drop', (e) => {
  if (!foreignDrag(e)) return;
  e.preventDefault();
  const payload = parseTabPayload(e.dataTransfer?.getData(TAB_DRAG_TYPE) ?? '');
  const half = halfAt(e);
  const inStrip = half ? undefined : stripPlace(e, false);
  disarm();
  const side = half?.dataset.side === 'left' || half?.dataset.side === 'right' ? half.dataset.side : undefined;
  if (payload) void receive(payload, { ...inStrip, side, x: e.clientX, y: e.clientY }, null);
});

for (const list of [tabList, tabListRight]) list.addEventListener('dragleave', (e) => { if (!e.relatedTarget) clearStripDropMarks(); });
