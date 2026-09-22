// ─── PDF viewer routing + viewer tab persistence ───
//
// Importing this module registers its listeners once; `pdfMessageHandlers`
// plugs into the background's message dispatcher.

import {
  LOCAL_PDF_VIEWER_ENABLED_SETTING_KEY,
  DEFAULT_LOCAL_PDF_VIEWER_ENABLED,
  WEB_PDF_VIEWER_ENABLED_SETTING_KEY,
  DEFAULT_WEB_PDF_VIEWER_ENABLED,
} from '../shared/constants';
import {
  PDF_VIEWER_PAGE,
  WEB_PDF_HOST_ORIGINS,
  WEB_PDF_REDIRECT_RULE_IDS,
  buildPdfViewerUrl,
  buildWebPdfRedirectRules,
  isLocalPdfUrl,
  isWebPdfSourceUrl,
  isWebPdfSuffixUrl,
  parsePdfViewerFile,
} from '../shared/localPdf';
import {
  parseOpenNativePdfRequest,
  parseRestoreViewerTabsRequest,
  parseSyncWebPdfRoutingRequest,
  parseViewerStateRequest,
} from '../shared/messages';
import { getSetting } from '../db/settingsRepository';
import { debugError, debugLog } from '../shared/debugLog';

// ─── PDF viewer routing ───
//
// Chrome's built-in PDF viewer is a privileged guest frame; content scripts
// never run inside it, even with file-URL access granted. PDF navigations are
// therefore re-pointed at the bundled PDF.js page, whose DOM text layer the
// ordinary content bundle can work on.
//
//   • file:///…pdf — webNavigation.onBeforeNavigate + tabs.update. Requires the
//     user setting AND "Allow access to file URLs" (otherwise the viewer page
//     could not read the file either, so the native viewer is strictly better).
//   • http(s) served as application/pdf — one dynamic declarativeNetRequest
//     redirect rule (Chrome ≥ 128 response-header matching). Requires the
//     opt-in web-PDF setting AND granted optional host access; Chrome itself
//     limits the rule to origins the user granted.
//
// `nativePdfBypassTabs` holds one-shot exemptions for tabs that asked to reopen
// the document in the native viewer. It is in-memory on purpose: the bypass is
// consumed by the very next navigation the same handler triggers, and a
// service-worker restart in between simply falls back to the viewer.
const nativePdfBypassTabs = new Set<number>();

async function hasWebPdfHostAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [...WEB_PDF_HOST_ORIGINS] });
  } catch {
    return false;
  }
}

// Re-derives the web-PDF redirect rule from durable state. Idempotent: always
// removes the rule id first, then adds it back only when both gates hold.
async function syncWebPdfRouting(): Promise<{ enabled: boolean }> {
  let enabled = false;
  try {
    enabled = await getSetting(WEB_PDF_VIEWER_ENABLED_SETTING_KEY, DEFAULT_WEB_PDF_VIEWER_ENABLED)
      && await hasWebPdfHostAccess();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [...WEB_PDF_REDIRECT_RULE_IDS],
      addRules: enabled
        ? buildWebPdfRedirectRules(chrome.runtime.getURL(PDF_VIEWER_PAGE)) as unknown as chrome.declarativeNetRequest.Rule[]
        : [],
    });
    debugLog('bg:pdf', `web PDF routing ${enabled ? 'enabled' : 'disabled'}`);
  } catch (error) {
    debugError('bg:pdf', 'failed to sync web PDF routing', () => ({
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  return { enabled };
}

void syncWebPdfRouting();
chrome.permissions.onRemoved.addListener(() => { void syncWebPdfRouting(); });
chrome.permissions.onAdded.addListener(() => { void syncWebPdfRouting(); });

// Web-PDF "open natively": the DNR rule is not per-tab, so it is dropped for
// the duration of that one navigation and restored once the tab commits (or
// after a safety timeout if the navigation never commits).
const WEB_PDF_NATIVE_REOPEN_TIMEOUT_MS = 10_000;
const webPdfNativeReopenTabs = new Map<number, ReturnType<typeof setTimeout>>();

function finishWebPdfNativeReopen(tabId: number) {
  const timer = webPdfNativeReopenTabs.get(tabId);
  if (timer === undefined) return;
  clearTimeout(timer);
  webPdfNativeReopenTabs.delete(tabId);
  if (webPdfNativeReopenTabs.size === 0) void syncWebPdfRouting();
}

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  finishWebPdfNativeReopen(details.tabId);
  // A viewer tab that navigated somewhere else is no longer restorable.
  if (!details.url.startsWith(chrome.runtime.getURL(PDF_VIEWER_PAGE))) void forgetViewerTab(details.tabId);
});

async function isFileSchemeAccessAllowed(): Promise<boolean> {
  try {
    return await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    return false;
  }
}

// Per-navigation gate for the two URL-suffix routes. Web `.pdf` URLs are also
// handled here (not only by the DNR rule) because Chrome starts honoring
// response-header *value* conditions only ~20 s after browser startup; the
// suffix route is immediate. The DNR rule remains the only path for
// extension-less PDF URLs.
async function shouldRouteByUrl(url: string): Promise<boolean> {
  if (isLocalPdfUrl(url)) {
    return await getSetting(LOCAL_PDF_VIEWER_ENABLED_SETTING_KEY, DEFAULT_LOCAL_PDF_VIEWER_ENABLED)
      && await isFileSchemeAccessAllowed();
  }
  if (isWebPdfSuffixUrl(url)) {
    if (!(await getSetting(WEB_PDF_VIEWER_ENABLED_SETTING_KEY, DEFAULT_WEB_PDF_VIEWER_ENABLED))) return false;
    // The viewer must be able to fetch this exact origin.
    const origin = `${new URL(url).origin}/*`;
    return chrome.permissions.contains({ origins: [origin] }).catch(() => false);
  }
  return false;
}

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  if (!isLocalPdfUrl(details.url) && !isWebPdfSuffixUrl(details.url)) return;
  if (nativePdfBypassTabs.delete(details.tabId)) return;
  void (async () => {
    const route = await shouldRouteByUrl(details.url);
    debugLog('bg:pdf', `PDF URL navigation ${route ? 'routing' : 'left to Chrome'}`, () => ({ tabId: details.tabId, url: details.url }));
    if (!route) return;
    const viewerUrl = buildPdfViewerUrl(details.url, chrome.runtime.getURL(PDF_VIEWER_PAGE));
    try {
      await chrome.tabs.update(details.tabId, { url: viewerUrl });
      debugLog('bg:pdf', 'PDF URL routed to bundled viewer', () => ({ tabId: details.tabId, url: details.url }));
    } catch (error) {
      // The tab may have closed or navigated away in the meantime.
      debugError('bg:pdf', 'failed to route PDF URL', () => ({
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  })();
  // UrlFilter ignores `schemes` for this event; the prefixes do the coarse cut
  // and the exact suffix checks above the fine one.
}, { url: [{ urlPrefix: 'file://' }, { urlPrefix: 'http://' }, { urlPrefix: 'https://' }] });

async function openNativePdf(url: string, sender: chrome.runtime.MessageSender): Promise<Record<string, unknown>> {
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number') return { success: false, error: '탭 정보를 찾을 수 없습니다.' };
  const isWeb = isWebPdfSourceUrl(url);
  if (!isWeb && !(await isFileSchemeAccessAllowed())) {
    return { success: false, error: '파일 URL 액세스가 꺼져 있어 로컬 파일로 이동할 수 없습니다.' };
  }
  nativePdfBypassTabs.add(tabId);
  if (isWeb) {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [...WEB_PDF_REDIRECT_RULE_IDS] });
    } catch {
      // Rule may already be absent; the navigation proceeds either way.
    }
    finishWebPdfNativeReopen(tabId);
    webPdfNativeReopenTabs.set(tabId, setTimeout(() => finishWebPdfNativeReopen(tabId), WEB_PDF_NATIVE_REOPEN_TIMEOUT_MS));
  }
  try {
    await chrome.tabs.update(tabId, { url });
    return { success: true };
  } catch (error) {
    nativePdfBypassTabs.delete(tabId);
    if (isWeb) finishWebPdfNativeReopen(tabId);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ─── PDF viewer tab persistence ───
//
// Chrome closes every page of an extension when the extension is reloaded or
// updated, taking open PDF viewer tabs with it. The viewer page reports its
// source URL + page + zoom (VOCAB_T_VIEWER_STATE); entries are dropped when
// the tab closes or navigates elsewhere. Whatever is still recorded when
// onInstalled fires belonged to a tab Chrome killed, so it is recreated in
// the same window at the same index with `#page=…&zoom=…`.
interface ViewerTabRecord {
  sourceUrl: string;
  page: number | null;
  zoom: string | null;
  windowId: number;
  index: number;
  updatedAt: number;
}
const VIEWER_TABS_STORAGE_KEY = 'vtViewerTabs';
const VIEWER_TAB_RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function readViewerTabs(): Promise<Record<string, ViewerTabRecord>> {
  try {
    const stored = await chrome.storage.local.get(VIEWER_TABS_STORAGE_KEY);
    const value = stored[VIEWER_TABS_STORAGE_KEY];
    return value && typeof value === 'object' ? value as Record<string, ViewerTabRecord> : {};
  } catch {
    return {};
  }
}

async function writeViewerTabs(records: Record<string, ViewerTabRecord>): Promise<void> {
  try {
    await chrome.storage.local.set({ [VIEWER_TABS_STORAGE_KEY]: records });
  } catch {
    /* best effort */
  }
}

async function recordViewerState(
  request: { sourceUrl: string; page: number | null; zoom: string | null },
  sender: chrome.runtime.MessageSender,
): Promise<Record<string, unknown>> {
  const tab = sender.tab;
  if (!tab || typeof tab.id !== 'number') return { success: false, error: '탭 정보를 찾을 수 없습니다.' };
  // Only top-level viewer tabs are restorable; a viewer inside an iframe/embed
  // belongs to its host page.
  if (sender.frameId !== undefined && sender.frameId !== 0) return { success: true, ignored: true };
  const records = await readViewerTabs();
  records[String(tab.id)] = {
    sourceUrl: request.sourceUrl,
    page: request.page,
    zoom: request.zoom,
    windowId: tab.windowId,
    index: tab.index,
    updatedAt: Date.now(),
  };
  await writeViewerTabs(records);
  return { success: true };
}

async function forgetViewerTab(tabId: number): Promise<void> {
  const records = await readViewerTabs();
  if (!(String(tabId) in records)) return;
  delete records[String(tabId)];
  await writeViewerTabs(records);
}

// When the extension itself is reloaded Chrome closes its pages and the dying
// service worker may still see their onRemoved. Deferring the delete lets that
// worker be torn down first, so the record survives for the new worker's
// restore; a tab the user closes is forgotten a moment later as usual.
const VIEWER_TAB_FORGET_DELAY_MS = 2_500;
chrome.tabs.onRemoved.addListener((tabId) => {
  setTimeout(() => { void forgetViewerTab(tabId); }, VIEWER_TAB_FORGET_DELAY_MS);
});

function viewerRestoreUrl(record: ViewerTabRecord): string {
  const base = buildPdfViewerUrl(record.sourceUrl, chrome.runtime.getURL(PDF_VIEWER_PAGE));
  const hash: string[] = [];
  if (record.page) hash.push(`page=${record.page}`);
  if (record.zoom) hash.push(`zoom=${record.zoom}`);
  return hash.length ? `${base}#${hash.join('&')}` : base;
}

async function restoreViewerTabs(): Promise<{ restored: number; open: number }> {
  const records = await readViewerTabs();
  const entries = Object.entries(records);
  let restored = 0;
  let open = 0;
  if (entries.length === 0) return { restored, open };
  const viewerBase = chrome.runtime.getURL(PDF_VIEWER_PAGE);
  // Our own open viewer pages, via the extension's context list: tabs.query
  // cannot match URLs without the `tabs` permission, but getContexts always
  // sees the extension's own documents.
  let openTabs: Array<{ id: number; url: string }> = [];
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    openTabs = contexts
      .filter((c) => c.documentUrl?.startsWith(viewerBase) && typeof c.tabId === 'number' && c.frameId === 0)
      .map((c) => ({ id: c.tabId, url: c.documentUrl ?? '' }));
  } catch {
    openTabs = [];
  }
  const alreadyOpen = new Set(openTabs.map((t) => parsePdfViewerFile(new URL(t.url).search)).filter(Boolean));
  const now = Date.now();
  const next: Record<string, ViewerTabRecord> = {};
  for (const [tabId, record] of entries) {
    if (now - record.updatedAt > VIEWER_TAB_RECORD_MAX_AGE_MS) continue;
    const stillThere = openTabs.some((t) => t.id === Number(tabId));
    if (stillThere) { next[tabId] = record; open += 1; continue; }
    if (alreadyOpen.has(record.sourceUrl)) continue; // e.g. Chrome's own session restore brought it back
    try {
      let windowId: number | undefined = record.windowId;
      try { await chrome.windows.get(windowId); } catch { windowId = undefined; }
      const tab = await chrome.tabs.create({ url: viewerRestoreUrl(record), active: false, ...(windowId !== undefined ? { windowId, index: record.index } : {}) });
      if (typeof tab.id === 'number') next[String(tab.id)] = { ...record, windowId: tab.windowId, index: tab.index, updatedAt: now };
      restored += 1;
      debugLog('bg:pdf', 'restored viewer tab after reload', () => ({ sourceUrl: record.sourceUrl, page: record.page }));
    } catch (error) {
      debugError('bg:pdf', 'failed to restore viewer tab', () => ({ error: error instanceof Error ? error.message : String(error) }));
    }
  }
  await writeViewerTabs(next);
  return { restored, open };
}

chrome.runtime.onInstalled.addListener(() => {
  void restoreViewerTabs();
  void syncWebPdfRouting();
});

type PdfMessageHandler = (
  message: { type: string; [key: string]: unknown },
  sender: chrome.runtime.MessageSender,
) => unknown | Promise<unknown>;

export const pdfMessageHandlers: Record<string, PdfMessageHandler> = {
  VOCAB_T_OPEN_NATIVE_PDF: (m, sender) => {
    const request = parseOpenNativePdfRequest(m);
    return request
      ? openNativePdf(request.url, sender)
      : { success: false, error: '기본 PDF 뷰어 열기 요청 형식이 올바르지 않습니다.' };
  },
  VOCAB_T_VIEWER_STATE: (m, sender) => {
    const request = parseViewerStateRequest(m);
    return request ? recordViewerState(request, sender) : { success: false, error: '뷰어 상태 형식이 올바르지 않습니다.' };
  },
  VOCAB_T_RESTORE_VIEWER_TABS: async (m) => {
    if (!parseRestoreViewerTabsRequest(m)) return { success: false, error: '뷰어 탭 복구 요청 형식이 올바르지 않습니다.' };
    return { success: true, ...(await restoreViewerTabs()) };
  },
  VOCAB_T_SYNC_WEB_PDF_ROUTING: async (m) => {
    if (!parseSyncWebPdfRoutingRequest(m)) return { success: false, error: '웹 PDF 라우팅 동기화 요청 형식이 올바르지 않습니다.' };
    return { success: true, ...(await syncWebPdfRouting()) };
  },
};
