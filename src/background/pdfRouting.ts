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
  PDF_HUB_PAGE,
  PDF_VIEWER_PAGE,
  WEB_PDF_HOST_ORIGINS,
  WEB_PDF_REDIRECT_RULE_IDS,
  buildPdfHubEntryUrl,
  buildPdfHubUrl,
  buildWebPdfRedirectRules,
  isLocalPdfUrl,
  isPdfViewerSourceUrl,
  isWebPdfSourceUrl,
  isWebPdfSuffixUrl,
  parsePdfHubUrl,
} from '../shared/localPdf';
import {
  parseOpenNativePdfRequest,
  parsePdfHubClaimRequest,
  parsePdfHubStateRequest,
  parsePdfProjectMoveRequest,
  parsePdfProjectOpenRequest,
  parsePdfProjectUpdateRequest,
  parseRestoreViewerTabsRequest,
  parseSyncWebPdfRoutingRequest,
} from '../shared/messages';
import { DEFAULT_PROJECT_ID, isPdfProjectId } from '../shared/pdfProjects';
import { getSetting } from '../db/settingsRepository';
import { debugError, debugLog } from '../shared/debugLog';
import { claimPdfHub, movePdfToProject, noteTopLevelCommit, openPdfProject } from './pdfHub';
import { updatePdfProjects } from './pdfProjectStore';
import { isExtensionPageSender } from './messageDispatcher';
import { requestPdfSyncSoon } from './pdfSyncService';

// ─── PDF viewer routing ───
//
// Chrome's built-in PDF viewer is a privileged guest frame; content scripts
// never run inside it, even with file-URL access granted. PDF navigations are
// therefore re-pointed at the bundled PDF.js page. Top-level PDFs land in the
// PDF hub of a project (./pdfHub.ts: one tab collecting its PDFs), embedded ones
// in the viewer page inline.
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
        ? buildWebPdfRedirectRules(chrome.runtime.getURL(PDF_VIEWER_PAGE), chrome.runtime.getURL(PDF_HUB_PAGE)) as unknown as chrome.declarativeNetRequest.Rule[]
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
  noteTopLevelCommit(details.tabId, details.url);
  // A hub tab that navigated somewhere else is no longer restorable.
  if (!details.url.startsWith(chrome.runtime.getURL(PDF_HUB_PAGE))) void forgetViewerTab(details.tabId);
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
    const hubUrl = buildPdfHubEntryUrl(details.url, chrome.runtime.getURL(PDF_HUB_PAGE));
    try {
      await chrome.tabs.update(details.tabId, { url: hubUrl });
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

// The viewer inside the hub is a frame of the hub tab; navigating that tab
// would unload every other document, so the native copy gets its own tab.
async function nativeTargetTab(sender: chrome.runtime.MessageSender): Promise<number | null> {
  const tab = sender.tab;
  if (!tab || typeof tab.id !== 'number') return null;
  if (sender.frameId === 0) return tab.id;
  const created = await chrome.tabs.create({ windowId: tab.windowId, index: tab.index + 1, url: 'about:blank' });
  return typeof created.id === 'number' ? created.id : null;
}

async function openNativePdf(url: string, sender: chrome.runtime.MessageSender): Promise<Record<string, unknown>> {
  const isWeb = isWebPdfSourceUrl(url);
  if (!isWeb && !(await isFileSchemeAccessAllowed())) {
    return { success: false, error: '파일 URL 액세스가 꺼져 있어 로컬 파일로 이동할 수 없습니다.' };
  }
  const tabId = await nativeTargetTab(sender).catch(() => null);
  if (tabId === null) return { success: false, error: '탭 정보를 찾을 수 없습니다.' };
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

// ─── PDF hub persistence ───
//
// Chrome closes every page of an extension when the extension is reloaded or
// updated, taking the hub tabs with it. Each hub reports its URL-backed
// documents (VOCAB_T_PDF_HUB_STATE); entries are dropped when the tab closes
// or navigates elsewhere. Whatever is still recorded when onInstalled fires
// belonged to a tab Chrome killed, so it is recreated in the same window at
// the same index, for the same project. Reading positions come back from the
// per-document records. The same report is the project's saved layout.
interface HubTabRecord {
  urls: string[];
  active: number;
  project: string;
  windowId: number;
  index: number;
  updatedAt: number;
}
const VIEWER_TABS_STORAGE_KEY = 'vtViewerTabs';
const VIEWER_TAB_RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Records written before the hub existed held one `sourceUrl` per viewer tab,
// and before projects existed every hub was the default project's.
function normalizeRecord(value: unknown): HubTabRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<HubTabRecord> & { sourceUrl?: unknown };
  const urls = Array.isArray(record.urls) ? record.urls : typeof record.sourceUrl === 'string' ? [record.sourceUrl] : [];
  const valid = urls.filter((url): url is string => typeof url === 'string' && isPdfViewerSourceUrl(url));
  if (valid.length === 0 || typeof record.windowId !== 'number' || typeof record.index !== 'number' || typeof record.updatedAt !== 'number') return null;
  const project = isPdfProjectId(record.project) ? record.project : DEFAULT_PROJECT_ID;
  return { urls: valid, active: typeof record.active === 'number' ? record.active : 0, project, windowId: record.windowId, index: record.index, updatedAt: record.updatedAt };
}

async function readViewerTabs(): Promise<Record<string, HubTabRecord>> {
  try {
    const stored = await chrome.storage.local.get(VIEWER_TABS_STORAGE_KEY);
    const value = stored[VIEWER_TABS_STORAGE_KEY];
    if (!value || typeof value !== 'object') return {};
    const records: Record<string, HubTabRecord> = {};
    for (const [tabId, raw] of Object.entries(value as Record<string, unknown>)) {
      const record = normalizeRecord(raw);
      if (record) records[tabId] = record;
    }
    return records;
  } catch {
    return {};
  }
}

async function writeViewerTabs(records: Record<string, HubTabRecord>): Promise<void> {
  try {
    await chrome.storage.local.set({ [VIEWER_TABS_STORAGE_KEY]: records });
  } catch {
    /* best effort */
  }
}

async function recordHubState(
  request: { urls: string[]; active: number; project: string; show: string | null },
  sender: chrome.runtime.MessageSender,
): Promise<Record<string, unknown>> {
  const tab = sender.tab;
  if (!tab || typeof tab.id !== 'number' || sender.frameId !== 0) return { success: false, error: '탭 정보를 찾을 수 없습니다.' };
  const records = await readViewerTabs();
  if (request.urls.length === 0) {
    delete records[String(tab.id)];
  } else {
    records[String(tab.id)] = {
      urls: request.urls,
      active: request.active,
      project: request.project,
      windowId: tab.windowId,
      index: tab.index,
      updatedAt: Date.now(),
    };
  }
  await writeViewerTabs(records);
  const { urls, active, project, show } = request;
  if (await updatePdfProjects({ kind: 'layout', id: project, urls, active, show })) requestPdfSyncSoon();
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

async function restoreViewerTabs(): Promise<{ restored: number; open: number }> {
  const records = await readViewerTabs();
  const entries = Object.entries(records);
  let restored = 0;
  let open = 0;
  if (entries.length === 0) return { restored, open };
  const hubBase = chrome.runtime.getURL(PDF_HUB_PAGE);
  // Our own open hub pages, via the extension's context list: tabs.query
  // cannot match URLs without the `tabs` permission, but getContexts always
  // sees the extension's own documents.
  let openTabs: Array<{ id: number; url: string }> = [];
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    openTabs = contexts
      .filter((c) => c.documentUrl?.startsWith(hubBase) && typeof c.tabId === 'number' && c.frameId === 0)
      .map((c) => ({ id: c.tabId, url: c.documentUrl ?? '' }));
  } catch {
    openTabs = [];
  }
  const alreadyOpen = new Set(openTabs.flatMap((t) => {
    const parsed = new URL(t.url);
    return parsePdfHubUrl(parsed.search, parsed.hash).docs.map((doc) => doc.url);
  }));
  const now = Date.now();
  const next: Record<string, HubTabRecord> = {};
  for (const [tabId, record] of entries) {
    if (now - record.updatedAt > VIEWER_TAB_RECORD_MAX_AGE_MS) continue;
    const stillThere = openTabs.some((t) => t.id === Number(tabId));
    if (stillThere) { next[tabId] = record; open += 1; continue; }
    // e.g. Chrome's own session restore brought them back
    const urls = record.urls.filter((url) => !alreadyOpen.has(url));
    if (urls.length === 0) continue;
    const active = Math.max(0, urls.indexOf(record.urls[record.active] ?? ''));
    try {
      let windowId: number | undefined = record.windowId;
      try { await chrome.windows.get(windowId); } catch { windowId = undefined; }
      const tab = await chrome.tabs.create({ url: buildPdfHubUrl(urls, active, hubBase, null, record.project), active: false, ...(windowId !== undefined ? { windowId, index: record.index } : {}) });
      if (typeof tab.id === 'number') next[String(tab.id)] = { urls, active, project: record.project, windowId: tab.windowId, index: tab.index, updatedAt: now };
      restored += 1;
      debugLog('bg:pdf', 'restored PDF hub after reload', () => ({ documents: urls.length }));
    } catch (error) {
      debugError('bg:pdf', 'failed to restore PDF hub', () => ({ error: error instanceof Error ? error.message : String(error) }));
    }
  }
  await writeViewerTabs(next);
  return { restored, open };
}

chrome.runtime.onInstalled.addListener(() => {
  void restoreViewerTabs();
  void syncWebPdfRouting();
});

function isHubPageSender(sender: chrome.runtime.MessageSender): boolean {
  return isExtensionPageSender(sender) && (sender.url ?? '').startsWith(chrome.runtime.getURL(PDF_HUB_PAGE));
}

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
  VOCAB_T_PDF_HUB_CLAIM: (m, sender) => {
    const request = parsePdfHubClaimRequest(m);
    return request && isHubPageSender(sender)
      ? claimPdfHub(request, sender)
      : { success: false, error: 'PDF 탭 요청 형식이 올바르지 않습니다.' };
  },
  VOCAB_T_PDF_HUB_STATE: (m, sender) => {
    const request = parsePdfHubStateRequest(m);
    return request && isHubPageSender(sender)
      ? recordHubState(request, sender)
      : { success: false, error: 'PDF 탭 상태 형식이 올바르지 않습니다.' };
  },
  VOCAB_T_PDF_PROJECT_UPDATE: async (m, sender) => {
    const request = parsePdfProjectUpdateRequest(m);
    if (!request || !isHubPageSender(sender)) return { success: false, error: '프로젝트 요청 형식이 올바르지 않습니다.' };
    if (await updatePdfProjects(request.update)) requestPdfSyncSoon();
    return { success: true };
  },
  VOCAB_T_PDF_PROJECT_OPEN: (m, sender) => {
    const request = parsePdfProjectOpenRequest(m);
    return request && isHubPageSender(sender)
      ? openPdfProject(request.project, sender)
      : { success: false, error: '프로젝트 열기 요청 형식이 올바르지 않습니다.' };
  },
  VOCAB_T_PDF_PROJECT_MOVE: async (m, sender) => {
    const request = parsePdfProjectMoveRequest(m);
    if (!request || !isHubPageSender(sender)) return { success: false, error: '프로젝트 이동 요청 형식이 올바르지 않습니다.' };
    const result = await movePdfToProject(request);
    if (result.success) requestPdfSyncSoon();
    return result;
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
