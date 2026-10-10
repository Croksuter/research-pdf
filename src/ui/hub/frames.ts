// ─── Viewer frames ───
//
// One iframe per document (pdf-viewer.html), created the first time it is
// shown or loaded in the background (prefetch, a gather that must see it
// load); frames unseen for a while sleep after storing everything. The
// viewers' messages arrive here, and the hidden upkeep frame lives here too.

import { HUB_IDLE_SLEEP_MS, pickTabsToSleep } from '../../shared/hubTabs';
import { buildPdfViewerUrl, isWebPdfSourceUrl } from '../../shared/localPdf';
import { PDF_UPKEEP_DONE_MESSAGE, PDF_UPKEEP_PAGE, PDF_UPKEEP_STORAGE_KEY, parsePdfUpkeepState, rowsNeedingUpkeep } from '../../shared/pdfUpkeep';
import { HUB_MESSAGE_TAG, parseViewerToHubMessage, type HubToViewerMessage } from '../../shared/pdfHubProtocol';
import { prefetchPdf } from '../pdfFileFetch';
import { type HubTab, activeKey, isHub, library, registerDoc, tabs } from './store';
import { frames, viewerBase } from './dom';
import { el } from './uiKit';
import { completePendingPins, mergeTwins, render, runPendingMove, step, updateTabLabel } from './tabStrip';
import { openFiles } from './session';
import { announceFront, dropMirror, focusSide, noteMirrorLoaded, onScreen, sideOfWindow, split } from './split';
import { armForeignDrop } from './transfer';

export const SLEEP_CHECK_MS = 60_000;
export const SLEEP_REPLY_TIMEOUT_MS = 2_000;
export const BUSY_RETRY_MS = 5 * 60_000;

// ─── Prefetch ───
//
// Documents behind other tabs (restored with the hub, pinned, opened in the
// background) are downloaded into the local file cache while idle, one at a
// time, so switching to them renders from disk.
export let prefetching = false;
export async function queuePrefetch(): Promise<void> {
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

export function frameUrl(tab: HubTab): string {
  if (!tab.url) return `${viewerBase}?hub=file`;
  return buildPdfViewerUrl(tab.url + tab.hash, viewerBase);
}

export function ensureFrame(tab: HubTab): HTMLIFrameElement {
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

export function postToFrame(tab: HubTab, message: HubToViewerMessage): void {
  tab.frame?.contentWindow?.postMessage(message, location.origin);
}
export const GATHER_LOAD_TIMEOUT_MS = 30_000;
// Tabs waiting for their frame's first `doc`.
export const loadWaiters = new Map<HubTab, Array<() => void>>();

/** True once the tab's frame has its document (loaded in the background if need be); false if it never does. */
export function whenLoaded(tab: HubTab, deadline = Date.now() + GATHER_LOAD_TIMEOUT_MS): Promise<boolean> {
  if (tab.loaded) return Promise.resolve(true);
  const wait = Math.min(GATHER_LOAD_TIMEOUT_MS, deadline - Date.now());
  if (wait <= 0) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish(false), wait);
    function finish(ok: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    }
    loadWaiters.set(tab, [...(loadWaiters.get(tab) ?? []), () => finish(true)]);
    // Kept loaded meanwhile: the sleep policy would unload a frame nobody looks at.
    tab.busyUntil = Math.max(tab.busyUntil, Date.now() + wait);
    ensureFrame(tab);
  });
}

export function markLoaded(tab: HubTab): void {
  tab.loaded = true;
  const waiters = loadWaiters.get(tab);
  loadWaiters.delete(tab);
  for (const resolve of waiters ?? []) resolve();
}

// ─── Sleeping frames ───
//
// Every loaded viewer holds its rendered pages and PDF.js worker. Frames not
// shown for a while (or beyond a handful) are unloaded after they stored
// everything; the tab stays, and switching back reloads it from the local
// file cache. A closed tab's frame does the same before it goes.

export let sleepSeq = 0;
export const sleepWaiters = new Map<number, (reply: { ok: boolean; hash: string }) => void>();
export let sleeping = false;
// Frames of closed tabs, still storing their last drawings.
export const retiring = new Set<Promise<void>>();

/** Asks `frame` to store its drawings and position now; a frame that does not answer (loading, hung) counts as done. */
export function askToStore(frame: HTMLIFrameElement): Promise<{ ok: boolean; hash: string }> {
  const id = ++sleepSeq;
  return new Promise((resolve) => {
    const done = (reply: { ok: boolean; hash: string }) => { sleepWaiters.delete(id); resolve(reply); };
    sleepWaiters.set(id, done);
    frame.contentWindow?.postMessage({ tag: HUB_MESSAGE_TAG, kind: 'sleep', id } satisfies HubToViewerMessage, location.origin);
    setTimeout(() => done({ ok: true, hash: '' }), SLEEP_REPLY_TIMEOUT_MS);
  });
}

/** Asks every loaded viewer to store its drawings and position now (and waits for closed tabs' frames). */
export function storeFrames(): Promise<unknown> {
  return Promise.all([
    ...tabs.filter((t) => t.frame).map((t) => askToStore(t.frame as HTMLIFrameElement)),
    ...tabs.filter((t) => t.mirror).map((t) => askToStore(t.mirror as HTMLIFrameElement)),
    ...retiring,
  ]);
}

/** A closed tab's frame: hidden at once, removed once it stored everything. */
export function retireFrame(tab: HubTab): Promise<void> {
  if (tab.mirror) dropMirror(tab);
  const frame = tab.frame;
  tab.frame = null;
  tab.loaded = false;
  if (!frame) return Promise.resolve();
  frame.hidden = true;
  const done = askToStore(frame).then(() => { frame.remove(); retiring.delete(done); });
  retiring.add(done);
  return done;
}

export async function sleepTab(tab: HubTab): Promise<void> {
  if (!tab.frame || onScreen(tab.key)) return;
  const reply = await askToStore(tab.frame);
  if (!tab.frame || onScreen(tab.key) || !tabs.includes(tab)) return;
  if (!reply.ok) { tab.busyUntil = Date.now() + BUSY_RETRY_MS; return; }
  tab.frame.remove();
  tab.frame = null;
  tab.loaded = false;
  // Never looked at: it reopens the way it came (a gathered tab at its zoom).
  tab.hash = reply.hash || (tab.lastShownAt === 0 ? tab.unseenHash : '');
  tab.unseenHash = '';
  updateTabLabel(tab);
}

export async function enforceSleep(): Promise<void> {
  if (sleeping) return;
  sleeping = true;
  try {
    const now = Date.now();
    const keys = pickTabsToSleep(tabs.map((t) => ({
      key: t.key,
      loaded: !!t.frame,
      active: onScreen(t.key),
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

window.addEventListener('message', (event) => {
  if (event.origin !== location.origin) return;
  const message = parseViewerToHubMessage(event.data);
  if (!message) return;
  // A closed tab's frame answers too, while it stores its last drawings.
  if (message.kind === 'sleep-reply') {
    if (Array.from(frames.querySelectorAll('iframe')).some((f) => f.contentWindow === event.source)) sleepWaiters.get(message.id)?.(message);
    return;
  }
  // Another hub's tab dragged over a viewer: the drop zones come up over it.
  if (message.kind === 'drag') { armForeignDrop(); return; }
  // Split view: pressing in a viewer brings its half in front.
  if (message.kind === 'focus') {
    const side = sideOfWindow(event.source);
    if (side && split && side !== split.focus) focusSide(side, false);
    return;
  }
  const tab = tabs.find((t) => t.frame?.contentWindow === event.source);
  if (!tab) {
    // A second view of a document (split view): only its keys and files count.
    const mirrored = tabs.find((t) => t.mirror?.contentWindow === event.source);
    if (!mirrored?.mirror) return;
    if (message.kind === 'doc') { noteMirrorLoaded(mirrored.mirror); announceFront(true); }
    else if (message.kind === 'key') step(message.action);
    else if (message.kind === 'open-files') openFiles(message.files);
    return;
  }
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
    // A viewer that just loaded in front is the one that remembers the position.
    announceFront(true);
  } else if (message.kind === 'key') {
    step(message.action);
  } else if (message.kind === 'open-files') {
    openFiles(message.files);
  }
});

// ─── Upkeep: library rows an older build left incomplete ───
//
// Once the hub has settled, and only if some rows need it, a hidden frame
// (ui/pdfUpkeep.ts) brings them up to date one at a time; it says when it is
// done and goes away. Another hub already running it makes this one's a no-op.

export const UPKEEP_DELAY_MS = 20_000;
export const UPKEEP_MAX_MS = 15 * 60_000;
export let upkeepFrame: HTMLIFrameElement | null = null;

export function endUpkeep(): void {
  upkeepFrame?.remove();
  upkeepFrame = null;
}

export async function startUpkeep(): Promise<void> {
  if (upkeepFrame || !isHub) return;
  const stored = await chrome.storage.local.get(PDF_UPKEEP_STORAGE_KEY).catch(() => ({} as Record<string, unknown>));
  if (rowsNeedingUpkeep(library, parsePdfUpkeepState(stored[PDF_UPKEEP_STORAGE_KEY])).length === 0) return;
  upkeepFrame = el('iframe', { src: PDF_UPKEEP_PAGE, hidden: true, tabIndex: -1 });
  upkeepFrame.setAttribute('aria-hidden', 'true');
  document.body.append(upkeepFrame);
  setTimeout(endUpkeep, UPKEEP_MAX_MS);
}

export function scheduleUpkeep(): void {
  setTimeout(() => {
    const idle = (window as unknown as { requestIdleCallback?: (run: () => void, options?: { timeout: number }) => void }).requestIdleCallback;
    if (idle) idle(() => { void startUpkeep(); }, { timeout: 10_000 });
    else void startUpkeep();
  }, UPKEEP_DELAY_MS);
}

window.addEventListener('message', (e) => {
  if (upkeepFrame && e.source === upkeepFrame.contentWindow && e.data === PDF_UPKEEP_DONE_MESSAGE) endUpkeep();
});
