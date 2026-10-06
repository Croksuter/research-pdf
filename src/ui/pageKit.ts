// ─── What the extension's own pages share (settings, welcome, popup) ───
//
// Element lookup, a message to the background that never throws, Chrome's
// access state, the shortcut keys as <kbd>, and gathering PDFs from Chrome's
// own viewer without losing any: a source tab closes only once its document
// is safely in a PDF tab.

import { PDF_HUB_PAGE, WEB_PDF_HOST_ORIGINS, buildPdfHubEntryUrl, parsePdfHubUrl } from '../shared/localPdf';
import { PDF_LIBRARY_STORAGE_KEY, librarySourceUrl, parsePdfLibrary, type PdfLibrary } from '../shared/pdfLibrary';
import { comboText, keyLabel, type Shortcut } from '../shared/shortcuts';
import { hasCachedPdf } from '../db/pdfFileCache';
import { zoomHash, type OpenPdfTab } from './openPdfTabs';

export const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as T;
};

/** A message to the background; null when it could not answer. */
export function send<T>(message: Record<string, unknown>): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(response as T);
      });
    } catch {
      resolve(null);
    }
  });
}

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/u.test(navigator.platform);

/** Site access for web PDFs (the optional http/https host permission). */
export async function hasWebAccess(): Promise<boolean> {
  try { return await chrome.permissions.contains({ origins: [...WEB_PDF_HOST_ORIGINS] }); } catch { return false; }
}

/** Chrome's "Allow access to file URLs" for this extension. */
export async function hasFileAccess(): Promise<boolean> {
  try { return await chrome.extension.isAllowedFileSchemeAccess(); } catch { return false; }
}

/** Chrome's details page for this extension (where file-URL access is turned on). */
export function openExtensionDetails(): void {
  void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
}

/** A shortcut's keys as <kbd>s on this platform, alternatives separated by " / ". */
export function shortcutKeys(shortcut: Shortcut, host: HTMLElement): HTMLElement {
  shortcut.combos.forEach((keys, i) => {
    if (i > 0) host.append(document.createTextNode(' / '));
    for (const key of keys) {
      const kbd = document.createElement('kbd');
      kbd.textContent = keyLabel(key, IS_MAC);
      host.append(kbd);
    }
  });
  host.title = comboText(shortcut, IS_MAC);
  return host;
}

// ─── Messages from the hub to its settings frame ───

/** The hub's answer to a gather request: { type: GATHER_RESULT_MESSAGE, gathered, kept } (counts or lists). */
export function parseGatherResult(data: unknown, type: string): { gathered: number; kept: number } | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  if ((record.type ?? record.tag) !== type) return null;
  const count = (value: unknown) => Array.isArray(value) ? value.length : typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
  return { gathered: count(record.gathered), kept: count(record.kept) };
}

/** A hub message of this type (`type`, or the older `tag`). */
export function isHubMessage(data: unknown, type: string): boolean {
  if (typeof data !== 'object' || data === null) return false;
  const record = data as Record<string, unknown>;
  return (record.type ?? record.tag) === type;
}

// ─── Gathering from Chrome's viewer (welcome page, settings on its own) ───
//
// Each PDF opens like one from the web, with its zoom: the first becomes the
// PDF tab or hands itself to the one already open, and so do the rest. Its
// original tab closes only once the document is safely there: a viewer in a
// PDF tab recorded opening it (a library row stamped since the gather
// began), or a PDF tab lists it and its bytes are in the local file cache
// (documents behind other tabs are downloaded there while idle). Anything
// not there in time stays open.

export const GATHER_CLOSE_TIMEOUT_MS = 45_000;

/** Source URLs (fragment dropped) of library rows opened at or after `since`. */
export function openedSinceUrls(library: PdfLibrary, since: number): Set<string> {
  const urls = new Set<string>();
  for (const entry of Object.values(library)) {
    if (entry.openedAt >= since) for (const url of entry.urls) urls.add(url);
  }
  return urls;
}

export interface GatherProgress {
  /** Documents the open PDF tabs list (their URLs). */
  hubDocs: ReadonlySet<string>;
  /** Documents a viewer in a PDF tab opened since the gather began. */
  openedSince: ReadonlySet<string>;
  /** Documents whose bytes are in the local file cache. */
  cached: ReadonlySet<string>;
}

/** Whether a gathered document is safely in a PDF tab, so its source tab may close. */
export function gatherLanded(url: string, progress: GatherProgress): boolean {
  const key = librarySourceUrl(url);
  if (!key) return false;
  return progress.openedSince.has(key) || (progress.hubDocs.has(key) && progress.cached.has(key));
}

/** Opens each PDF in a PDF tab (in the background). */
export async function openInHub(tabs: readonly OpenPdfTab[]): Promise<void> {
  const hubBase = chrome.runtime.getURL(PDF_HUB_PAGE);
  for (const tab of tabs) await chrome.tabs.create({ url: buildPdfHubEntryUrl(tab.url + zoomHash(tab), hubBase), active: false });
}

async function hubDocUrls(): Promise<Set<string>> {
  const hubBase = chrome.runtime.getURL(PDF_HUB_PAGE);
  const urls = new Set<string>();
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    for (const context of contexts) {
      if (!context.documentUrl?.startsWith(hubBase)) continue;
      const parsed = new URL(context.documentUrl);
      for (const doc of parsePdfHubUrl(parsed.search, parsed.hash).docs) urls.add(doc.url);
    }
  } catch { /* none known */ }
  return urls;
}

async function progressOf(tabs: readonly OpenPdfTab[], since: number): Promise<GatherProgress> {
  const [hubDocs, stored] = await Promise.all([
    hubDocUrls(),
    chrome.storage.local.get(PDF_LIBRARY_STORAGE_KEY).catch(() => ({} as Record<string, unknown>)),
  ]);
  const cached = new Set<string>();
  await Promise.all(tabs.map(async (tab) => {
    const key = librarySourceUrl(tab.url);
    if (key && hubDocs.has(key) && await hasCachedPdf(key).catch(() => false)) cached.add(key);
  }));
  return { hubDocs, openedSince: openedSinceUrls(parsePdfLibrary(stored[PDF_LIBRARY_STORAGE_KEY]), since), cached };
}

/** Closes a source tab if it still shows that document (the user may have moved on in it). */
async function closeIfUnchanged(tab: OpenPdfTab): Promise<boolean> {
  try {
    const now = await chrome.tabs.get(tab.id);
    if (!now.url || librarySourceUrl(now.url) !== librarySourceUrl(tab.url)) return false;
    await chrome.tabs.remove(tab.id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Closes each source tab once its document landed in a PDF tab (see above);
 * `onProgress` hears how many closed so far. Resolves with what closed and
 * what was left open when the time ran out.
 */
export async function closeWhenGathered(
  tabs: readonly OpenPdfTab[],
  since: number,
  onProgress: (closed: number) => void = () => undefined,
  timeoutMs = GATHER_CLOSE_TIMEOUT_MS,
): Promise<{ closed: OpenPdfTab[]; kept: OpenPdfTab[] }> {
  let waiting = [...tabs];
  const closed: OpenPdfTab[] = [];
  const deadline = Date.now() + timeoutMs;
  while (waiting.length) {
    const progress = await progressOf(waiting, since);
    const landed = waiting.filter((t) => gatherLanded(t.url, progress));
    for (const tab of landed) if (await closeIfUnchanged(tab)) closed.push(tab);
    // A tab that landed but changed meanwhile is the user's now: leave it.
    waiting = waiting.filter((t) => !landed.includes(t));
    if (landed.length) onProgress(closed.length);
    if (!waiting.length || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return { closed, kept: tabs.filter((t) => !closed.includes(t)) };
}
