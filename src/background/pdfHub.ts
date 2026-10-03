// ─── PDF hub: one tab per project that collects its PDFs ───
//
// Routing (./pdfRouting.ts and the declarativeNetRequest rule) sends every
// top-level PDF navigation to `pdf-hub.html` in the tab it happened in. That
// page then *claims* here, for the project its URL names or, for a PDF
// entering from the web, the project the document goes to: an open project
// it is registered to, otherwise the default one (shared/pdfProjects.ts).
//
//   • the project has no hub and the tab has no history → the tab becomes the
//     hub (a PDF opened in a new tab);
//   • the project has no hub but the tab came from a web page → a clean hub
//     tab is created next to it and the tab goes back to its page, so web
//     tabs stay web tabs and the hub never has a Back entry that would unload
//     it;
//   • the project already has a hub (in any window) → the documents are
//     handed to it and the tab goes back (or closes when it has nowhere to go
//     back to).
//
// A project is open in at most one hub, so a hub tab can be dragged to any
// window and stays that project's hub. Claims are serialized: opening five
// PDFs at once must elect one hub, not five that each see the others. The
// registry (project → hub tab) lives in chrome.storage.session so a
// service-worker restart keeps it.

import { PDF_HUB_PAGE, buildPdfHubEntryUrl, buildPdfHubUrl, type PdfHubDoc } from '../shared/localPdf';
import type { PdfHubOpenMessage } from '../shared/messages';
import { hubDocKey } from '../shared/hubTabs';
import { DEFAULT_PROJECT_ID, appendToPdfProjectLayout, applyPdfProjectUpdate, targetProjectForDoc, type PdfProjects } from '../shared/pdfProjects';
import type { PdfLibrary } from '../shared/pdfLibrary';
import { debugError, debugLog } from '../shared/debugLog';
import { readPdfLibrary } from './pdfLibraryStore';
import { mutatePdfProjects, readPdfProjects } from './pdfProjectStore';

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

/** The library row last opened from `url` (fragment ignored), if any. */
export function libraryIdForUrl(library: PdfLibrary, url: string): string | null {
  const key = hubDocKey(url).url;
  let best: { docId: string; openedAt: number } | null = null;
  for (const entry of Object.values(library)) {
    if (!entry.urls.some((u) => hubDocKey(u).url === key)) continue;
    if (!best || entry.openedAt > best.openedAt) best = { docId: entry.docId, openedAt: entry.openedAt };
  }
  return best?.docId ?? null;
}

// ─── Registry (chrome.storage.session) ───

const HUB_REGISTRY_KEY = 'rpdfProjectHubs';
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

async function liveEntry(registry: HubRegistry, project: string): Promise<HubRegistryEntry | null> {
  const entry = registry[project];
  if (!entry) return null;
  try {
    await chrome.tabs.get(entry.tabId);
    return entry;
  } catch {
    /* closed */
  }
  delete registry[project];
  return null;
}

/** Projects with a hub right now (entries are checked lazily, on claim). */
async function liveProjects(registry: HubRegistry): Promise<Set<string>> {
  const live = new Set<string>();
  for (const project of Object.keys(registry)) {
    if (await liveEntry(registry, project)) live.add(project);
  }
  return live;
}

/** `tabId` holds `project` and nothing else. */
function register(registry: HubRegistry, project: string, entry: HubRegistryEntry): void {
  for (const [key, other] of Object.entries(registry)) {
    if (other.tabId === entry.tabId && key !== project) delete registry[key];
  }
  registry[project] = entry;
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

/** Brings a tab forward, and its window when that is another one. */
async function activateTab(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab && typeof tab.windowId === 'number') await chrome.windows?.update(tab.windowId, { focused: true });
  } catch {
    /* the tab may be gone; nothing else to do */
  }
}

/** Which project a claim is for: the one named, or where entering documents go. */
async function claimTarget(request: { docs: PdfHubDoc[]; project: string | null }, registry: HubRegistry): Promise<{ project: string; projects: PdfProjects }> {
  const projects = await readPdfProjects();
  const named = request.project;
  if (named) {
    // A project deleted meanwhile (another device, another hub) hands its
    // documents to the default project.
    return { project: projects[named]?.deletedAt === 0 ? named : DEFAULT_PROJECT_ID, projects };
  }
  if (request.docs.length !== 1) return { project: DEFAULT_PROJECT_ID, projects };
  const library = await readPdfLibrary();
  const docId = libraryIdForUrl(library, request.docs[0].url);
  const live = await liveProjects(registry);
  return { project: targetProjectForDoc(projects, docId, (id) => live.has(id)), projects };
}

export type HubClaimResult =
  | { success: true; role: 'hub'; project: string; docs: PdfHubDoc[] }
  | { success: true; role: 'forwarded'; dispose: 'back' | 'close' }
  | { success: false; error: string };

export function claimPdfHub(
  request: { docs: PdfHubDoc[]; canGoBack: boolean; project: string | null },
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
    const { project } = await claimTarget(request, registry);
    let entry = await liveEntry(registry, project);
    for (;;) {
      // A page naming its project is a hub by intent (opened, restored or
      // switched to it): it never hands its tab back to a web page.
      const decision = decideHubClaim({ entry, claimerTabId: claimer.id, canGoBack: request.canGoBack && !request.project, hasDocs: request.docs.length > 0 });
      debugLog('bg:hub', `claim → ${decision.kind}`, () => ({ tabId: claimer.id, project, docs: request.docs.length }));
      switch (decision.kind) {
        case 'become-hub': {
          register(registry, project, { tabId: claimer.id, ready: true, pending: [] });
          await writeRegistry(registry);
          return { success: true, role: 'hub', project, docs: decision.pending };
        }
        case 'forward-pending': {
          const pendingEntry = registry[project];
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
          delete registry[project];
          entry = null;
          continue;
        }
        case 'spawn-hub': {
          const base = chrome.runtime.getURL(PDF_HUB_PAGE);
          const url = request.docs.length === 1 && project === DEFAULT_PROJECT_ID
            ? buildPdfHubEntryUrl(request.docs[0].url + request.docs[0].hash, base)
            : buildPdfHubUrl(request.docs.map((d) => d.url), 0, base, null, project);
          try {
            const created = await chrome.tabs.create({ windowId: claimer.windowId, index: claimer.index + 1, active: claimer.active, url });
            if (typeof created.id !== 'number') throw new Error('no tab id');
            register(registry, project, { tabId: created.id, ready: false, pending: [] });
            await writeRegistry(registry);
            return { success: true, role: 'forwarded', dispose };
          } catch (error) {
            debugError('bg:hub', 'failed to create hub tab', () => ({ error: error instanceof Error ? error.message : String(error) }));
            // Fall back to keeping the document right here.
            register(registry, project, { tabId: claimer.id, ready: true, pending: [] });
            await writeRegistry(registry);
            return { success: true, role: 'hub', project, docs: [] };
          }
        }
        default:
          return { success: false, error: 'unreachable' };
      }
    }
  });
}

// ─── Opening a project, moving a document ───

/**
 * Shows the project's hub if it is open anywhere. Closed: with `inPlace` the
 * answer is the hub URL with its saved tabs, for the sender to switch to;
 * otherwise a new hub tab opens next to the sender.
 */
export function openPdfProject(project: string, sender: chrome.runtime.MessageSender, inPlace = false): Promise<{ success: boolean; url?: string; error?: string }> {
  return serialized(async () => {
    const projects = await readPdfProjects();
    const target = projects[project];
    if (!target || target.deletedAt !== 0) return { success: false, error: '없는 프로젝트입니다.' };
    const registry = await readRegistry();
    const entry = await liveEntry(registry, project);
    if (entry) {
      if (entry.tabId !== sender.tab?.id) await activateTab(entry.tabId);
      return { success: true };
    }
    const base = chrome.runtime.getURL(PDF_HUB_PAGE);
    const { urls, active, show } = target.layout;
    const url = buildPdfHubUrl(urls, active, base, show, project);
    if (inPlace) return { success: true, url };
    try {
      const at = sender.tab;
      const created = await chrome.tabs.create({
        url,
        active: true,
        ...(at && typeof at.windowId === 'number' ? { windowId: at.windowId, index: at.index + 1 } : {}),
      });
      if (typeof created.id !== 'number') throw new Error('no tab id');
      register(registry, project, { tabId: created.id, ready: false, pending: [] });
      await writeRegistry(registry);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

/**
 * Moves (or, with `keep`, also registers) a document to project `to`; its tab
 * goes to that project's hub when it is open, otherwise into the tabs it
 * opens with. Answers whether the target hub is open.
 */
export function movePdfToProject(request: { docId: string; url: string | null; from: string; to: string; keep: boolean }): Promise<{ success: boolean; open?: boolean; error?: string }> {
  return serialized(async () => {
    const projects = await readPdfProjects();
    if (projects[request.to]?.deletedAt !== 0) return { success: false, error: '없는 프로젝트입니다.' };
    const registry = await readRegistry();
    const entry = await liveEntry(registry, request.to);
    await mutatePdfProjects((current) => {
      let next = request.keep
        ? request.to === DEFAULT_PROJECT_ID ? current : applyPdfProjectUpdate(current, { kind: 'member', id: request.to, docId: request.docId, member: true })
        : applyPdfProjectUpdate(current, { kind: 'move', docId: request.docId, from: request.from, to: request.to });
      if (!request.keep && !entry && request.url) next = appendToPdfProjectLayout(next, request.to, request.url);
      return next;
    });
    if (!request.keep && entry && request.url) {
      const doc = { url: request.url, hash: '' };
      if (entry.ready && await forwardToLiveHub(entry.tabId, [doc], false)) return { success: true, open: true };
      entry.pending = mergeHubDocs(entry.pending, [doc]);
      await writeRegistry(registry);
    }
    return { success: true, open: !!entry };
  });
}

// ─── Registry upkeep ───

function forgetHubTab(tabId: number): Promise<void> {
  return serialized(async () => {
    const registry = await readRegistry();
    let changed = false;
    for (const [project, entry] of Object.entries(registry)) {
      if (entry.tabId === tabId) { delete registry[project]; changed = true; }
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
