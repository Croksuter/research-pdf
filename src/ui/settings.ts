// ─── ResearchPDF settings page ───
//
// Shown inside the PDF tab (the hub's ⚙ button, the popup's "설정"). Every
// setting on one page of cards, with section chips and a search that
// narrows the rows. Besides the switches it shows what the switches depend
// on — Chrome's site and file-URL access, whether an API key works and how
// much of the day's database budget is left — and the keyboard shortcuts.
// Durable actions go through the background, as from the popup.

import {
  DEFAULT_LOCAL_PDF_VIEWER_ENABLED,
  DEFAULT_PAPER_INFO_ENABLED,
  DEFAULT_PDF_FILE_CACHE_ENABLED,
  DEFAULT_WEB_PDF_VIEWER_ENABLED,
  LOCAL_PDF_VIEWER_ENABLED_SETTING_KEY,
  OPENALEX_API_KEY_SETTING_KEY,
  PAPER_INFO_ENABLED_SETTING_KEY,
  PDF_FILE_CACHE_ENABLED_SETTING_KEY,
  SEMANTIC_SCHOLAR_API_KEY_SETTING_KEY,
  STORE_PDF_ANNOTATIONS,
  WEB_PDF_VIEWER_ENABLED_SETTING_KEY,
} from '../shared/constants';
import { getSetting, setSetting } from '../db/settingsRepository';
import { dbGetAll } from '../db/database';
import { clearPdfFileCache, pdfFileCacheUsage } from '../db/pdfFileCache';
import { WEB_PDF_HOST_ORIGINS } from '../shared/localPdf';
import { GATHER_MESSAGE, GATHER_RESULT_MESSAGE, SETTINGS_SHOWN_MESSAGE, findOpenPdfTabs } from './openPdfTabs';
import { PDF_CACHE_MAX_BYTES } from '../shared/pdfCachePolicy';
import { PDF_LIBRARY_STORAGE_KEY, parsePdfLibrary } from '../shared/pdfLibrary';
import { PDF_PROJECTS_STORAGE_KEY, parsePdfProjects } from '../shared/pdfProjects';
import { isEmptyAnnotationCache, parsePdfAnnotationCache } from '../shared/pdfAnnotations';
import { openAlexCheck, semanticScholarCheck, type ApiCheck } from '../shared/apiStatus';
import { DISPLAY_PREFS_STORAGE_KEY, parseDisplayPrefs, type DisplayPrefs } from '../shared/displayPrefs';
import { LANGUAGE_STORAGE_KEY, currentLanguage, localizeDocument, parseLanguagePref, saveLanguagePref } from '../shared/i18n';
import { syncStatusErrorText } from '../shared/syncErrors';
import { SHORTCUTS, SHORTCUT_GROUPS, shortcutLabel } from '../shared/shortcuts';
import type { PdfSyncPublicStatus } from '../background/pdfSyncService';
import {
  byId, closeWhenGathered, hasFileAccess, hasWebAccess, isHubMessage, openExtensionDetails, openInHub, parseGatherResult, send, shortcutKeys,
} from './pageKit';
import { S } from './settings.strings';

localizeDocument(S);
document.title = S.pageTitle;

function badge(element: HTMLElement, text: string, tone: 'ok' | 'warn' | 'muted'): void {
  element.textContent = text;
  element.dataset.tone = tone;
  element.hidden = !text;
}

// The settings live in the PDF tab (the hub frames this page, which then
// takes the hub's colors). Opened on its own — Chrome's extension options —
// it hands over to a hub and closes; if that fails it stays usable here.
const embedded = window.top !== window.self;
document.documentElement.classList.toggle('is-embedded', embedded);
if (!embedded) {
  void send<{ success: boolean }>({ type: 'VOCAB_T_PDF_SHOW_SETTINGS' }).then(async (response) => {
    if (!response?.success) return;
    const tab = await chrome.tabs.getCurrent().catch(() => undefined);
    if (typeof tab?.id === 'number') void chrome.tabs.remove(tab.id).catch(() => undefined);
  });
}

byId('st-version').textContent = `ResearchPDF ${chrome.runtime.getManifest().version}`;
// The policy page carries both languages: link to this page's.
byId<HTMLAnchorElement>('st-privacy').hash = currentLanguage();

// ─── Search and section chips ───

const searchInput = byId<HTMLInputElement>('st-search');
const emptyNote = byId<HTMLParagraphElement>('st-empty');
const cards = Array.from(document.querySelectorAll<HTMLElement>('.st-card'));

searchInput.addEventListener('input', () => {
  const words = searchInput.value.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  let any = false;
  for (const card of cards) {
    const title = card.querySelector('h2')?.textContent?.toLowerCase() ?? '';
    const rows = Array.from(card.querySelectorAll<HTMLElement>('[data-search], .st-keys-group, .st-account, .st-links li'));
    const cardHit = words.length > 0 && words.every((w) => title.includes(w));
    let shown = 0;
    for (const row of rows) {
      const hay = `${row.dataset.search ?? ''} ${row.textContent ?? ''}`.toLowerCase();
      const hit = words.length === 0 || cardHit || words.every((w) => hay.includes(w));
      row.hidden = !hit;
      if (hit) shown += 1;
    }
    card.hidden = words.length > 0 && !cardHit && shown === 0;
    if (!card.hidden) any = true;
  }
  emptyNote.hidden = any;
});

const chips = Array.from(document.querySelectorAll<HTMLAnchorElement>('.st-chips a'));
const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    for (const chip of chips) chip.classList.toggle('is-active', chip.hash === `#${entry.target.id}`);
  }
}, { rootMargin: '-140px 0px -60% 0px' });
for (const card of cards) observer.observe(card);

// ─── Sync ───

type SyncStatus = PdfSyncPublicStatus;

type ConnectResponse = {
  success: boolean;
  error?: string;
  errorCode?: string;
  needsConfirm?: 'account-change';
  previousEmail?: string;
  email?: string;
};

const syncAvatar = byId<HTMLDivElement>('sync-avatar');
const syncAccount = byId<HTMLParagraphElement>('sync-account');
const syncStatus = byId<HTMLParagraphElement>('sync-status');
const syncEnabledInput = byId<HTMLInputElement>('sync-enabled');
const syncConnectButton = byId<HTMLButtonElement>('sync-connect');
const syncNowButton = byId<HTMLButtonElement>('sync-now');
const syncDisconnectButton = byId<HTMLButtonElement>('sync-disconnect');
const syncSetup = byId<HTMLParagraphElement>('sync-setup');
const syncSetupDev = byId<HTMLParagraphElement>('sync-setup-dev');
let lastSync: SyncStatus | null = null;
let syncPoll: ReturnType<typeof setTimeout> | undefined;

function redirectUri(): string {
  try { return chrome.identity.getRedirectURL(); } catch { return ''; }
}

function renderSync(status: SyncStatus): void {
  const email = status.googleAccountEmail;
  syncAvatar.textContent = status.googleConnected ? (email[0] ?? 'G').toUpperCase() : 'G';
  syncAvatar.classList.toggle('is-off', !status.googleConnected);
  syncAccount.textContent = status.googleConnected ? email || S.googleAccount : S.noAccount;
  syncEnabledInput.checked = status.enabled;
  syncEnabledInput.disabled = !status.googleConnected;
  syncConnectButton.textContent = status.googleConnected ? S.connectOther : S.connectGoogle;
  syncConnectButton.classList.toggle('st-btn-primary', !status.googleConnected);
  syncConnectButton.disabled = !status.googleConfigured;
  syncNowButton.hidden = !status.googleConnected;
  syncNowButton.disabled = !status.enabled || status.syncing;
  syncDisconnectButton.hidden = !status.googleConnected;
  // Usable again after a reconnect or a disconnect that failed.
  syncDisconnectButton.disabled = false;
  // What a user can do; the OAuth details are for whoever builds the extension.
  syncSetup.textContent = status.googleConfigured ? S.signInHelp : S.signInUnavailable;
  syncSetupDev.textContent = status.googleConfigured
    ? S.setupConfigured(redirectUri())
    : S.setupMissing(redirectUri());
  const errorText = syncStatusErrorText(status);
  if (status.syncing) syncStatus.textContent = S.syncing;
  else if (errorText) syncStatus.textContent = S.syncError(errorText);
  else if (status.lastSyncAt) {
    syncStatus.textContent = S.lastSync(new Date(status.lastSyncAt).toLocaleString(currentLanguage()), status.pendingLocalChanges);
  } else if (status.googleConnected) syncStatus.textContent = status.enabled ? S.waitingFirst : S.syncOff;
  else syncStatus.textContent = S.syncHint;
  lastSync = status;
  // A sync in progress finishes in the background: look again until it has.
  clearTimeout(syncPoll);
  if (status.syncing) syncPoll = setTimeout(() => { if (document.visibilityState === 'visible') void loadSync(); }, 1_500);
}

async function loadSync(): Promise<void> {
  const status = await send<SyncStatus | { success: false; error: string }>({ type: 'VOCAB_T_GET_CLOUD_SYNC_STATUS' });
  if (!status || 'success' in status) {
    syncStatus.textContent = status?.error ?? S.syncStatusFailed;
    return;
  }
  renderSync(status);
}

syncConnectButton.addEventListener('click', () => {
  syncConnectButton.disabled = true;
  syncStatus.textContent = S.signInOpening;
  void (async () => {
    let response = await send<ConnectResponse>({ type: 'VOCAB_T_CONNECT_GOOGLE_SYNC' });
    // Another account than this device's data last went to: ask before merging into it.
    let declined = false;
    if (response?.needsConfirm === 'account-change') {
      declined = !confirm(S.confirmAccountChange(response.previousEmail || S.googleAccount, response.email || S.googleAccount));
      if (!declined) response = await send<ConnectResponse>({ type: 'VOCAB_T_CONNECT_GOOGLE_SYNC', confirmAccountChange: true });
    }
    await loadSync();
    if (declined) syncStatus.textContent = S.accountChangeDeclined;
    else if (response && !response.success) syncStatus.textContent = syncStatusErrorText(response) ?? S.connectFailed;
  })();
});

syncDisconnectButton.addEventListener('click', () => {
  if (!confirm(S.confirmDisconnect(lastSync?.googleAccountEmail || S.googleAccount))) return;
  syncDisconnectButton.disabled = true;
  void send<{ success: boolean; error?: string }>({ type: 'VOCAB_T_DISCONNECT_GOOGLE_SYNC' }).then(async (response) => {
    await loadSync();
    syncStatus.textContent = response?.success
      ? S.disconnected
      : response?.error ?? S.disconnectFailed;
  });
});

// The switch shows what the background did, not what was asked: a refusal
// or no answer puts it back.
syncEnabledInput.addEventListener('change', () => {
  void send<{ success: boolean; status?: SyncStatus }>({ type: 'VOCAB_T_SET_PDF_SYNC_ENABLED', enabled: syncEnabledInput.checked })
    .then(async (response) => {
      if (response?.success && response.status) { renderSync(response.status); return; }
      await loadSync();
      syncStatus.textContent = S.syncSwitchFailed;
    });
});

syncNowButton.addEventListener('click', () => {
  syncNowButton.disabled = true;
  syncStatus.textContent = S.syncing;
  void send<{ success: boolean; error?: string; errorCode?: string }>({ type: 'VOCAB_T_SYNC_CLOUD_NOW' }).then(async (response) => {
    await loadSync();
    if (!response?.success) syncStatus.textContent = syncStatusErrorText(response) ?? S.syncFailed;
  });
});

// ─── Opening PDFs ───

const webPdfInput = byId<HTMLInputElement>('web-pdf-viewer-enabled');
const localPdfInput = byId<HTMLInputElement>('local-pdf-viewer-enabled');
const webAccess = byId<HTMLSpanElement>('web-access');
const fileAccess = byId<HTMLSpanElement>('file-access');
const fileAccessOpen = byId<HTMLButtonElement>('file-access-open');
const restoreTabsButton = byId<HTMLButtonElement>('restore-viewer-tabs');
const openStatus = byId<HTMLParagraphElement>('open-status');

/** What Chrome actually allows, next to the switches that need it. */
async function renderAccess(): Promise<void> {
  const [web, file, webOn, localOn] = await Promise.all([
    hasWebAccess(),
    hasFileAccess(),
    getSetting(WEB_PDF_VIEWER_ENABLED_SETTING_KEY, DEFAULT_WEB_PDF_VIEWER_ENABLED),
    getSetting(LOCAL_PDF_VIEWER_ENABLED_SETTING_KEY, DEFAULT_LOCAL_PDF_VIEWER_ENABLED),
  ]);
  // The rule only exists while host access is granted; reflect that, not just the stored flag.
  webPdfInput.checked = webOn && web;
  localPdfInput.checked = localOn;
  badge(webAccess, web ? S.siteAccessOn : S.siteAccessNeeded, web ? 'ok' : 'muted');
  badge(fileAccess, file ? S.fileUrlOn : S.fileUrlOff, file ? 'ok' : localOn ? 'warn' : 'muted');
  fileAccessOpen.hidden = file;
}

// The permission prompt must run inside this user-gesture handler. The
// setting is persisted as `true` only after the grant; the background then
// re-derives its redirect rule from both.
webPdfInput.addEventListener('change', () => {
  void (async () => {
    const enable = webPdfInput.checked;
    if (enable) {
      let granted = await hasWebAccess();
      if (!granted) {
        try {
          granted = await chrome.permissions.request({ origins: [...WEB_PDF_HOST_ORIGINS] });
        } catch {
          granted = false;
        }
      }
      if (!granted) {
        webPdfInput.checked = false;
        openStatus.textContent = S.siteDenied;
        void renderAccess();
        return;
      }
    }
    await setSetting(WEB_PDF_VIEWER_ENABLED_SETTING_KEY, enable);
    const response = await send<{ success: boolean }>({ type: 'VOCAB_T_SYNC_WEB_PDF_ROUTING' });
    openStatus.textContent = !response?.success
      ? S.savedNotApplied
      : enable ? S.webOn : S.webOff;
    void renderAccess();
  })();
});

localPdfInput.addEventListener('change', () => {
  void setSetting(LOCAL_PDF_VIEWER_ENABLED_SETTING_KEY, localPdfInput.checked).then(async () => {
    const file = await hasFileAccess();
    openStatus.textContent = !localPdfInput.checked
      ? S.localOff
      : file ? S.localOn : S.localNeedsAccess;
    void renderAccess();
  });
});

fileAccessOpen.addEventListener('click', openExtensionDetails);

// A grant made elsewhere (coming back from Chrome's extension page: refresh() below).
chrome.permissions.onAdded.addListener(() => { void renderAccess(); });
chrome.permissions.onRemoved.addListener(() => { void renderAccess(); });

restoreTabsButton.addEventListener('click', () => {
  restoreTabsButton.disabled = true;
  void send<{ success: boolean; restored?: number; open?: number }>({ type: 'VOCAB_T_RESTORE_VIEWER_TABS' }).then((response) => {
    restoreTabsButton.disabled = false;
    if (!response?.success) { openStatus.textContent = S.restoreFailed; return; }
    const restored = Number(response.restored ?? 0);
    const open = Number(response.open ?? 0);
    openStatus.textContent = restored > 0
      ? S.restoredTabs(restored)
      : open > 0 ? S.nothingToRestore(open) : S.noTabHistory;
  });
});

// Gather the PDFs open in Chrome's own viewer: into the hub this page is
// framed in (which answers with what it gathered and what it left open), or
// (on its own) the way a PDF from the web opens, each original tab closing
// once its document is in a PDF tab (ui/pageKit.ts).
const gatherButton = byId<HTMLButtonElement>('gather-open-pdfs');
let gatherWait: ReturnType<typeof setTimeout> | undefined;

function gatherFinished(gathered: number, kept: number): void {
  clearTimeout(gatherWait);
  gatherWait = undefined;
  gatherButton.disabled = false;
  openStatus.textContent = kept ? `${S.gatherDone(gathered)} ${S.gatherKept(kept)}` : S.gatherDone(gathered);
}

gatherButton.addEventListener('click', () => {
  void (async () => {
    const { tabs, hidden } = await findOpenPdfTabs();
    if (tabs.length === 0) { openStatus.textContent = hidden ? S.gatherNeedsAccess : S.gatherNone; return; }
    gatherButton.disabled = true;
    openStatus.textContent = S.gatherWorking;
    if (embedded) {
      window.parent.postMessage({ tag: GATHER_MESSAGE, tabs }, location.origin);
      gatherWait = setTimeout(() => {
        gatherWait = undefined;
        gatherButton.disabled = false;
        openStatus.textContent = S.gatherNoAnswer;
      }, 60_000);
      return;
    }
    const since = Date.now();
    await openInHub(tabs);
    const { kept } = await closeWhenGathered(tabs, since);
    gatherFinished(tabs.length, kept.length);
  })();
});

// ─── Display (this device; open hubs follow at once) ───

const displayLanguage = byId<HTMLSelectElement>('display-language');
displayLanguage.value = parseLanguagePref(localStorage.getItem(LANGUAGE_STORAGE_KEY));
displayLanguage.addEventListener('change', () => {
  void saveLanguagePref(parseLanguagePref(displayLanguage.value)).then(() => location.reload());
});

const displayTitle = byId<HTMLSelectElement>('display-tab-title');
const displaySubtitle = byId<HTMLSelectElement>('display-tab-subtitle');
const displayKinds = byId<HTMLSelectElement>('display-kind-icons');
const displayFavicon = byId<HTMLInputElement>('display-project-favicon');

async function readDisplay(): Promise<DisplayPrefs> {
  return parseDisplayPrefs((await chrome.storage.local.get(DISPLAY_PREFS_STORAGE_KEY))[DISPLAY_PREFS_STORAGE_KEY]);
}

async function renderDisplay(): Promise<void> {
  const prefs = await readDisplay();
  displayTitle.value = prefs.tabTitle;
  displaySubtitle.value = prefs.tabSubtitle;
  displayKinds.value = prefs.kindIcons;
  displayFavicon.checked = prefs.projectFavicon;
}

function saveDisplay(): void {
  const prefs = parseDisplayPrefs({
    tabTitle: displayTitle.value,
    tabSubtitle: displaySubtitle.value,
    kindIcons: displayKinds.value,
    projectFavicon: displayFavicon.checked,
  });
  void chrome.storage.local.set({ [DISPLAY_PREFS_STORAGE_KEY]: prefs });
}

for (const control of [displayTitle, displaySubtitle, displayKinds, displayFavicon]) control.addEventListener('change', saveDisplay);

// ─── Paper info and database keys ───

const paperInfoInput = byId<HTMLInputElement>('paper-info-enabled');
paperInfoInput.addEventListener('change', () => { void setSetting(PAPER_INFO_ENABLED_SETTING_KEY, paperInfoInput.checked); });

interface KeyField {
  setting: string;
  input: HTMLInputElement;
  save: HTMLButtonElement;
  remove: HTMLButtonElement;
  check: HTMLButtonElement;
  state: HTMLSpanElement;
  result: HTMLParagraphElement;
  run: (key: string) => Promise<ApiCheck>;
}

async function probe(url: string, init?: RequestInit): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const offline: ApiCheck = { state: 'error', message: S.offline };

const keyFields: KeyField[] = [
  {
    setting: OPENALEX_API_KEY_SETTING_KEY,
    input: byId('openalex-api-key-input'),
    save: byId('openalex-api-key-save'),
    remove: byId('openalex-api-key-remove'),
    check: byId('openalex-check'),
    state: byId('openalex-key-state'),
    result: byId('openalex-check-result'),
    // With a key, OpenAlex's own status endpoint (free); without, the
    // smallest request, whose headers carry the shared budget.
    run: async (key) => {
      const response = key
        ? await probe(`https://api.openalex.org/rate-limit?api_key=${encodeURIComponent(key)}`)
        : await probe('https://api.openalex.org/works?per-page=1&select=id');
      return response ? openAlexCheck(response.status, response.headers, !!key) : offline;
    },
  },
  {
    setting: SEMANTIC_SCHOLAR_API_KEY_SETTING_KEY,
    input: byId('s2-api-key-input'),
    save: byId('s2-api-key-save'),
    remove: byId('s2-api-key-remove'),
    check: byId('s2-check'),
    state: byId('s2-key-state'),
    result: byId('s2-check-result'),
    run: async (key) => {
      const response = await probe('https://api.semanticscholar.org/graph/v1/paper/arXiv:1706.03762?fields=title', key ? { headers: { 'x-api-key': key } } : undefined);
      // Its 429s carry no CORS headers, so a rate limit reaches the page as a failed fetch.
      return response ? semanticScholarCheck(response.status, !!key) : semanticScholarCheck(0, !!key);
    },
  },
];

async function renderKey(field: KeyField): Promise<string> {
  const key = (await getSetting<string>(field.setting, '')).trim();
  badge(field.state, key ? S.keySaved : S.keyNone, key ? 'ok' : 'muted');
  field.input.placeholder = key ? S.keyPlaceholderSaved : S.keyPlaceholderEmpty;
  field.remove.hidden = !key;
  return key;
}

for (const field of keyFields) {
  // Saving needs a key: an empty field never removes the saved one ("Remove" does).
  field.save.addEventListener('click', () => {
    const key = field.input.value.trim();
    field.result.dataset.state = '';
    if (!key) { field.result.textContent = S.keyEmpty; return; }
    void setSetting(field.setting, key).then(async () => {
      field.input.value = '';
      await renderKey(field);
      field.result.textContent = S.keySavedNote;
    });
  });
  field.remove.addEventListener('click', () => {
    void setSetting(field.setting, '').then(async () => {
      field.input.value = '';
      await renderKey(field);
      field.result.dataset.state = '';
      field.result.textContent = S.keyRemoved;
    });
  });
  field.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') field.save.click(); });
  field.check.addEventListener('click', () => {
    field.check.disabled = true;
    field.result.dataset.state = '';
    field.result.textContent = S.checking;
    void (async () => {
      // A key typed but not saved yet is what the user wants checked.
      const key = field.input.value.trim() || (await getSetting<string>(field.setting, '')).trim();
      const check = await field.run(key);
      field.result.dataset.state = check.state;
      field.result.textContent = check.message;
      field.check.disabled = false;
    })();
  });
}

// ─── Storage ───

const fileCacheInput = byId<HTMLInputElement>('pdf-file-cache-enabled');
const cacheUsage = byId<HTMLSpanElement>('cache-usage');
const cacheBar = byId<HTMLSpanElement>('cache-bar');
const cacheClearButton = byId<HTMLButtonElement>('pdf-file-cache-clear');
const storageStatus = byId<HTMLParagraphElement>('storage-status');

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)}MB`;

async function renderStorage(): Promise<void> {
  try {
    const { files, bytes } = await pdfFileCacheUsage();
    const share = Math.min(1, bytes / PDF_CACHE_MAX_BYTES);
    cacheUsage.textContent = files ? S.savedPdfsUsage(files, megabytes(bytes), megabytes(PDF_CACHE_MAX_BYTES)) : S.noSavedPdfs;
    cacheBar.style.width = `${Math.max(files ? 1 : 0, Math.round(share * 100))}%`;
    cacheBar.parentElement?.setAttribute('aria-valuenow', String(Math.round(share * 100)));
    cacheClearButton.disabled = files === 0;
  } catch {
    cacheUsage.textContent = S.usageFailed;
  }
  try {
    const stored = await chrome.storage.local.get([PDF_LIBRARY_STORAGE_KEY, PDF_PROJECTS_STORAGE_KEY]);
    byId('stat-library').textContent = S.countPapers(Object.keys(parsePdfLibrary(stored[PDF_LIBRARY_STORAGE_KEY])).length);
    byId('stat-projects').textContent = S.countProjects(Object.values(parsePdfProjects(stored[PDF_PROJECTS_STORAGE_KEY])).filter((p) => p.deletedAt === 0).length);
  } catch { /* stays – */ }
  try {
    const rows = await dbGetAll<unknown>(STORE_PDF_ANNOTATIONS);
    const annotated = rows.map(parsePdfAnnotationCache).filter((c) => c && !isEmptyAnnotationCache(c)).length;
    byId('stat-annotated').textContent = S.countPapers(annotated);
  } catch { /* stays – */ }
}

fileCacheInput.addEventListener('change', () => {
  void setSetting(PDF_FILE_CACHE_ENABLED_SETTING_KEY, fileCacheInput.checked).then(() => {
    storageStatus.textContent = fileCacheInput.checked
      ? S.cacheOn
      : S.cacheOff;
  });
});

// Up to the whole cache in one click: say how much, and what cannot come back.
cacheClearButton.addEventListener('click', () => {
  void (async () => {
    const { files, bytes } = await pdfFileCacheUsage().catch(() => ({ files: 0, bytes: 0 }));
    if (files === 0 || !confirm(S.confirmClearCache(files, megabytes(bytes)))) return;
    await clearPdfFileCache();
    storageStatus.textContent = S.cacheCleared;
    await renderStorage();
  })();
});

// ─── Shortcuts ───

/** The one shortcut table (shared/shortcuts.ts), by group. */
function renderShortcuts(): void {
  const host = byId<HTMLDivElement>('shortcuts');
  for (const { group, label } of SHORTCUT_GROUPS) {
    const section = document.createElement('div');
    section.className = 'st-keys-group';
    const title = document.createElement('h3');
    title.textContent = shortcutLabel(label);
    const list = document.createElement('dl');
    for (const shortcut of SHORTCUTS.filter((s) => s.group === group)) {
      const row = document.createElement('div');
      const dt = document.createElement('dt');
      const combo = document.createElement('span');
      combo.className = 'st-combo';
      dt.append(shortcutKeys(shortcut, combo));
      const dd = document.createElement('dd');
      dd.textContent = shortcutLabel(shortcut.label);
      row.append(dt, dd);
      list.append(row);
    }
    section.append(title, list);
    host.append(section);
  }
}

// ─── Boot ───

async function loadSettings(): Promise<void> {
  const [paperInfo, fileCache] = await Promise.all([
    getSetting(PAPER_INFO_ENABLED_SETTING_KEY, DEFAULT_PAPER_INFO_ENABLED),
    getSetting(PDF_FILE_CACHE_ENABLED_SETTING_KEY, DEFAULT_PDF_FILE_CACHE_ENABLED),
  ]);
  paperInfoInput.checked = paperInfo;
  fileCacheInput.checked = fileCache;
  await Promise.all([renderAccess(), renderDisplay(), ...keyFields.map(renderKey), renderStorage()]);
}

// The hub keeps this frame once made, so what it shows can go stale: look
// again when the hub shows it, when the tab comes back, and when a sync or
// another page changed the library or the projects. (The sync state itself
// lives in IndexedDB, which announces nothing; a running sync is polled.)
let refreshing: Promise<void> | null = null;
let refreshAgain = false;
function refresh(): void {
  if (refreshing) { refreshAgain = true; return; }
  refreshing = Promise.all([loadSettings(), loadSync()]).then(() => undefined, () => undefined).finally(() => {
    refreshing = null;
    if (refreshAgain) { refreshAgain = false; refresh(); }
  });
}

window.addEventListener('message', (event) => {
  if (!embedded || event.origin !== location.origin || event.source !== window.parent) return;
  if (isHubMessage(event.data, SETTINGS_SHOWN_MESSAGE)) { refresh(); return; }
  const result = parseGatherResult(event.data, GATHER_RESULT_MESSAGE);
  if (result && gatherWait !== undefined) gatherFinished(result.gathered, result.kept);
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
window.addEventListener('focus', refresh);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[PDF_LIBRARY_STORAGE_KEY] || changes[PDF_PROJECTS_STORAGE_KEY] || changes[DISPLAY_PREFS_STORAGE_KEY])) refresh();
});

renderShortcuts();
refresh();
