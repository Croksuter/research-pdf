// ─── PDF hub: one tab per window that collects every top-level PDF ───
//
// Routing (./pdfRouting.ts and the declarativeNetRequest rule) sends every
// top-level PDF navigation to `pdf-hub.html` in the tab it happened in. That
// page then *claims* here:
//
//   • the window has no hub and the tab has no history → the tab becomes the
//     hub (a PDF opened in a new tab);
//   • the window has no hub but the tab came from a web page → a clean hub tab
//     is created next to it and the tab goes back to its page, so web tabs
//     stay web tabs and the hub never has a Back entry that would unload it;
//   • the window already has a hub → the documents are handed to it and the
//     tab goes back (or closes when it has nowhere to go back to).
//
// Claims are serialized: opening five PDFs at once must elect one hub, not
// five that each see the others. The registry (windowId → hub tab) lives in
// chrome.storage.session so a service-worker restart keeps it.

import { PDF_HUB_PAGE, buildPdfHubEntryUrl, buildPdfHubUrl, type PdfHubDoc } from '../shared/localPdf';
import type { PdfHubOpenMessage } from '../shared/messages';
import { debugError, debugLog } from '../shared/debugLog';

export interface HubRegistryEntry {
  tabId: number;
  /** False until the hub page itself claimed; forwarded docs queue meanwhile. */
  ready: boolean;
  pending: PdfHubDoc[];
}

export type HubClaimDecision =
  | { kind: 'become-hub'; pending: PdfHubDoc[] }
  | { kind: 'forward-live'; hubTabId: number }
  | { kind: 'forward-pending'; hubTabId: number }
  | { kind: 'spawn-hub' };

/** Pure claim policy; the caller has already checked whether `entry` is alive. */
export function decideHubClaim(input: {
  entry: HubRegistryEntry | null;
  claimerTabId: number;
  canGoBack: boolean;
  hasDocs: boolean;
}): HubClaimDecision {
  const { entry, claimerTabId, canGoBack, hasDocs } = input;
  if (entry && entry.tabId === claimerTabId) return { kind: 'become-hub', pending: entry.pending };
  if (entry) return entry.ready ? { kind: 'forward-live', hubTabId: entry.tabId } : { kind: 'forward-pending', hubTabId: entry.tabId };
  if (canGoBack && hasDocs) return { kind: 'spawn-hub' };
  return { kind: 'become-hub', pending: [] };
}

/** Adds docs to a list without duplicating a URL; later hashes win. */
export function mergeHubDocs(into: readonly PdfHubDoc[], docs: readonly PdfHubDoc[]): PdfHubDoc[] {
  const merged = into.map((doc) => ({ ...doc }));
  for (const doc of docs) {
    const existing = merged.find((d) => d.url === doc.url);
    if (existing) existing.hash = doc.hash || existing.hash;
    else merged.push({ ...doc });
  }
  return merged;
}

// ─── Registry (chrome.storage.session) ───

const HUB_REGISTRY_KEY = 'rpdfHubs';
type HubRegistry = Record<string, HubRegistryEntry>;

async function readRegistry(): Promise<HubRegistry> {
  try {
    const stored = await chrome.storage.session.get(HUB_REGISTRY_KEY);
    const value = stored[HUB_REGISTRY_KEY];
    return value && typeof value === 'object' ? value as HubRegistry : {};
  } catch {
    return {};
  }
}

async function writeRegistry(registry: HubRegistry): Promise<void> {
  try {
    await chrome.storage.session.set({ [HUB_REGISTRY_KEY]: registry });
  } catch {
    /* best effort: a lost registry only means the next PDF elects a new hub */
  }
}

let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function liveEntry(registry: HubRegistry, windowId: number): Promise<HubRegistryEntry | null> {
  const entry = registry[String(windowId)];
  if (!entry) return null;
  try {
    const tab = await chrome.tabs.get(entry.tabId);
    if (tab.windowId === windowId) return entry;
  } catch {
    /* closed */
  }
  delete registry[String(windowId)];
  return null;
}

async function forwardToLiveHub(hubTabId: number, docs: PdfHubDoc[], activate: boolean): Promise<boolean> {
  const message: PdfHubOpenMessage = { type: 'VOCAB_T_PDF_HUB_OPEN', tabId: hubTabId, docs, activate };
  try {
    const response = await chrome.runtime.sendMessage(message) as { ok?: boolean } | undefined;
    return response?.ok === true;
  } catch {
    return false;
  }
}

async function activateTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    /* the tab may be gone; nothing else to do */
  }
}

export type HubClaimResult =
  | { success: true; role: 'hub'; docs: PdfHubDoc[] }
  | { success: true; role: 'forwarded'; dispose: 'back' | 'close' }
  | { success: false; error: string };

export function claimPdfHub(
  request: { docs: PdfHubDoc[]; canGoBack: boolean },
  sender: chrome.runtime.MessageSender,
): Promise<HubClaimResult> {
  const tab = sender.tab;
  if (!tab || typeof tab.id !== 'number' || sender.frameId !== 0) {
    return Promise.resolve({ success: false, error: '탭 정보를 찾을 수 없습니다.' });
  }
  const claimer = { id: tab.id, windowId: tab.windowId, index: tab.index, active: tab.active };
  const dispose = request.canGoBack ? 'back' as const : 'close' as const;
  return serialized(async (): Promise<HubClaimResult> => {
    const registry = await readRegistry();
    const key = String(claimer.windowId);
    let entry = await liveEntry(registry, claimer.windowId);
    for (;;) {
      const decision = decideHubClaim({ entry, claimerTabId: claimer.id, canGoBack: request.canGoBack, hasDocs: request.docs.length > 0 });
      debugLog('bg:hub', `claim → ${decision.kind}`, () => ({ tabId: claimer.id, windowId: claimer.windowId, docs: request.docs.length }));
      switch (decision.kind) {
        case 'become-hub': {
          registry[key] = { tabId: claimer.id, ready: true, pending: [] };
          await writeRegistry(registry);
          return { success: true, role: 'hub', docs: decision.pending };
        }
        case 'forward-pending': {
          const pendingEntry = registry[key];
          pendingEntry.pending = mergeHubDocs(pendingEntry.pending, request.docs);
          await writeRegistry(registry);
          if (claimer.active) await activateTab(decision.hubTabId);
          return { success: true, role: 'forwarded', dispose };
        }
        case 'forward-live': {
          if (await forwardToLiveHub(decision.hubTabId, request.docs, claimer.active)) {
            if (claimer.active) await activateTab(decision.hubTabId);
            return { success: true, role: 'forwarded', dispose };
          }
          // The hub did not answer (navigated away, crashed): elect anew.
          delete registry[key];
          entry = null;
          continue;
        }
        case 'spawn-hub': {
          const base = chrome.runtime.getURL(PDF_HUB_PAGE);
          const url = request.docs.length === 1
            ? buildPdfHubEntryUrl(request.docs[0].url + request.docs[0].hash, base)
            : buildPdfHubUrl(request.docs.map((d) => d.url), 0, base);
          try {
            const created = await chrome.tabs.create({ windowId: claimer.windowId, index: claimer.index + 1, active: claimer.active, url });
            if (typeof created.id !== 'number') throw new Error('no tab id');
            registry[key] = { tabId: created.id, ready: false, pending: [] };
            await writeRegistry(registry);
            return { success: true, role: 'forwarded', dispose };
          } catch (error) {
            debugError('bg:hub', 'failed to create hub tab', () => ({ error: error instanceof Error ? error.message : String(error) }));
            // Fall back to keeping the document right here.
            registry[key] = { tabId: claimer.id, ready: true, pending: [] };
            await writeRegistry(registry);
            return { success: true, role: 'hub', docs: [] };
          }
        }
        default:
          return { success: false, error: 'unreachable' };
      }
    }
  });
}

// ─── Registry upkeep ───

function forgetHubTab(tabId: number): Promise<void> {
  return serialized(async () => {
    const registry = await readRegistry();
    let changed = false;
    for (const [windowId, entry] of Object.entries(registry)) {
      if (entry.tabId === tabId) { delete registry[windowId]; changed = true; }
    }
    if (changed) await writeRegistry(registry);
  });
}

/** A hub tab that navigated to anything but the hub page is no longer a hub. */
export function noteTopLevelCommit(tabId: number, url: string): void {
  if (url.startsWith(chrome.runtime.getURL(PDF_HUB_PAGE))) return;
  void forgetHubTab(tabId);
}

chrome.tabs.onRemoved.addListener((tabId) => { void forgetHubTab(tabId); });

// Dragging the hub into another window makes it that window's hub when the
// window has none (a tab torn off into its own window, typically).
const movingHubs = new Set<number>();
chrome.tabs.onDetached.addListener((tabId, info) => {
  void serialized(async () => {
    const registry = await readRegistry();
    const key = String(info.oldWindowId);
    if (registry[key]?.tabId !== tabId) return;
    movingHubs.add(tabId);
    delete registry[key];
    await writeRegistry(registry);
  });
});
chrome.tabs.onAttached.addListener((tabId, info) => {
  void serialized(async () => {
    if (!movingHubs.delete(tabId)) return;
    const registry = await readRegistry();
    const key = String(info.newWindowId);
    if (await liveEntry(registry, info.newWindowId)) return;
    registry[key] = { tabId, ready: true, pending: [] };
    await writeRegistry(registry);
  });
});
