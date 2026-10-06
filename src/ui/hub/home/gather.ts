// ─── PDFs open in Chrome's own viewer: offered on home, gathered here ───
//
// A gathered document's original tab closes only once the document has
// loaded here (in the background if it is not shown), and only if that tab
// still shows it: a signed link that expired, a page behind a login or a
// POST result would otherwise lose its only copy. What did not load, and
// what did not fit, stays open where it was.

import { sameSource } from '../../../shared/hubTabs';
import { GATHER_MESSAGE, GATHER_RESULT_MESSAGE, findOpenPdfTabs, zoomHash, type OpenPdfTab } from '../../openPdfTabs';
import { S } from '../../pdfHub.strings';
import { HOME, activeKey, tabs } from '../store';
import { el, icon, showToast } from '../uiKit';
import { addDocs, removeTab, render, settingsFrame } from '../tabStrip';
import { enforceSleep, whenLoaded } from '../frames';
import { scheduleHomeRender } from './home';

export let openPdfs: OpenPdfTab[] = [];
export const GATHER_DISMISSED_KEY = 'rpdfGatherDismissed';
export const GATHER_PARALLEL = 4;
// The whole gather answers within this (the settings page waits a minute): what has not loaded by then stays open.
const GATHER_DEADLINE_MS = 50_000;
// Source tabs being gathered now: not offered again, not taken twice.
export const gathering = new Set<number>();

export async function refreshOpenPdfs(): Promise<void> {
  const { tabs: found } = await findOpenPdfTabs();
  const before = openPdfs.map((t) => `${t.id} ${t.url}`).join();
  openPdfs = found.filter((t) => !gathering.has(t.id));
  if (openPdfs.map((t) => `${t.id} ${t.url}`).join() !== before) scheduleHomeRender();
}

/** Closes the tab a gathered document came from, if it still shows that document. */
export async function closeSourceTab(source: OpenPdfTab): Promise<void> {
  const now = await chrome.tabs.get(source.id).catch(() => null);
  if (now?.url && sameSource(now.url, source.url)) await chrome.tabs.remove(source.id).catch(() => undefined);
}

export interface GatherResult { gathered: number; kept: number }

/** Adds the documents to this tab (not shown) and closes the tabs they came from once each has loaded here. */
export async function gatherHere(found: OpenPdfTab[]): Promise<GatherResult> {
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
  const deadline = Date.now() + GATHER_DEADLINE_MS;
  const queue = sources.map((source, i) => ({ source, tab: placed[i] ?? null }));
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const { source, tab } = job;
      if (!tab) { full += 1; continue; }
      const ok = tabs.includes(tab) && await whenLoaded(tab, deadline);
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

export function gatherBanner(): HTMLElement | null {
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
  const asker = event.source as Window;
  void gatherHere(found).then(({ gathered, kept }) => {
    asker.postMessage({ type: GATHER_RESULT_MESSAGE, gathered, kept }, location.origin);
  });
});

window.addEventListener('focus', () => { if (activeKey === HOME) void refreshOpenPdfs(); });
