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
import { PDF_HUB_PAGE, WEB_PDF_HOST_ORIGINS, buildPdfHubEntryUrl } from '../shared/localPdf';
import { GATHER_MESSAGE, closeTabs, findOpenPdfTabs, zoomHash } from './openPdfTabs';
import { PDF_CACHE_MAX_BYTES } from '../shared/pdfCachePolicy';
import { PDF_LIBRARY_STORAGE_KEY, parsePdfLibrary } from '../shared/pdfLibrary';
import { PDF_PROJECTS_STORAGE_KEY, parsePdfProjects } from '../shared/pdfProjects';
import { isEmptyAnnotationCache, parsePdfAnnotationCache } from '../shared/pdfAnnotations';
import { openAlexCheck, semanticScholarCheck, type ApiCheck } from '../shared/apiStatus';
import { DISPLAY_PREFS_STORAGE_KEY, parseDisplayPrefs, type DisplayPrefs } from '../shared/displayPrefs';
import { LANGUAGE_STORAGE_KEY, currentLanguage, localizeDocument, parseLanguagePref, saveLanguagePref } from '../shared/i18n';
import { S } from './settings.strings';

localizeDocument(S);
document.title = S.pageTitle;

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as T;
};

function send<T>(message: Record<string, unknown>): Promise<T | null> {
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

function badge(element: HTMLElement, text: string, tone: 'ok' | 'warn' | 'muted'): void {
  element.textContent = text;
  element.dataset.tone = tone;
  element.hidden = !text;
}

const MAC = /Mac|iPhone|iPad/u.test(navigator.platform);

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

type SyncStatus = {
  googleConfigured: boolean;
  googleConnected: boolean;
  googleAccountEmail: string;
  enabled: boolean;
  lastSyncAt: string | null;
  error: string | null;
  pendingLocalChanges: boolean;
  syncing: boolean;
};

const syncAvatar = byId<HTMLDivElement>('sync-avatar');
const syncAccount = byId<HTMLParagraphElement>('sync-account');
const syncStatus = byId<HTMLParagraphElement>('sync-status');
const syncEnabledInput = byId<HTMLInputElement>('sync-enabled');
const syncConnectButton = byId<HTMLButtonElement>('sync-connect');
const syncNowButton = byId<HTMLButtonElement>('sync-now');
const syncDisconnectButton = byId<HTMLButtonElement>('sync-disconnect');
const syncSetup = byId<HTMLParagraphElement>('sync-setup');

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
  syncSetup.textContent = status.googleConfigured
    ? S.setupConfigured(redirectUri())
    : S.setupMissing(redirectUri());
  if (status.syncing) syncStatus.textContent = S.syncing;
  else if (status.error) syncStatus.textContent = S.syncError(status.error);
  else if (status.lastSyncAt) {
    syncStatus.textContent = S.lastSync(new Date(status.lastSyncAt).toLocaleString(currentLanguage()), status.pendingLocalChanges);
  } else if (status.googleConnected) syncStatus.textContent = status.enabled ? S.waitingFirst : S.syncOff;
  else syncStatus.textContent = S.syncHint;
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
  void send<{ success: boolean; error?: string }>({ type: 'VOCAB_T_CONNECT_GOOGLE_SYNC' }).then(async (response) => {
    await loadSync();
    if (response && !response.success) syncStatus.textContent = response.error ?? S.connectFailed;
  });
});

syncDisconnectButton.addEventListener('click', () => {
  syncDisconnectButton.disabled = true;
  void send<{ success: boolean; error?: string }>({ type: 'VOCAB_T_DISCONNECT_GOOGLE_SYNC' }).then(async (response) => {
    await loadSync();
    syncStatus.textContent = response?.success
      ? S.disconnected
      : response?.error ?? S.disconnectFailed;
  });
});

syncEnabledInput.addEventListener('change', () => {
  void send<{ success: boolean; status?: SyncStatus }>({ type: 'VOCAB_T_SET_PDF_SYNC_ENABLED', enabled: syncEnabledInput.checked })
    .then((response) => { if (response?.status) renderSync(response.status); });
});

syncNowButton.addEventListener('click', () => {
  syncNowButton.disabled = true;
  syncStatus.textContent = S.syncing;
  void send<{ success: boolean; error?: string }>({ type: 'VOCAB_T_SYNC_CLOUD_NOW' }).then(async (response) => {
    await loadSync();
    if (!response?.success) syncStatus.textContent = response?.error ?? S.syncFailed;
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

async function hasWebPdfHostAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [...WEB_PDF_HOST_ORIGINS] });
  } catch {
    return false;
  }
}

async function hasFileAccess(): Promise<boolean> {
  try {
    return await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    return false;
  }
}

/** What Chrome actually allows, next to the switches that need it. */
async function renderAccess(): Promise<void> {
  const [web, file, webOn, localOn] = await Promise.all([
    hasWebPdfHostAccess(),
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
      let granted = await hasWebPdfHostAccess();
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

fileAccessOpen.addEventListener('click', () => {
  void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});

// Coming back from Chrome's extension page, or a grant made elsewhere.
window.addEventListener('focus', () => { void renderAccess(); });
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
// framed in, or (on its own) the way a PDF from the web opens.
byId<HTMLButtonElement>('gather-open-pdfs').addEventListener('click', () => {
  void (async () => {
    const { tabs, hidden } = await findOpenPdfTabs();
    if (tabs.length === 0) { openStatus.textContent = hidden ? S.gatherNeedsAccess : S.gatherNone; return; }
    if (embedded) {
      window.parent.postMessage({ tag: GATHER_MESSAGE, tabs }, location.origin);
    } else {
      for (const tab of tabs) await chrome.tabs.create({ url: buildPdfHubEntryUrl(tab.url + zoomHash(tab), chrome.runtime.getURL(PDF_HUB_PAGE)), active: false });
      await closeTabs(tabs);
    }
    openStatus.textContent = S.gatherDone(tabs.length);
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
  return key;
}

for (const field of keyFields) {
  field.save.addEventListener('click', () => {
    const key = field.input.value.trim();
    void setSetting(field.setting, key).then(async () => {
      field.input.value = '';
      await renderKey(field);
      field.result.dataset.state = '';
      field.result.textContent = key ? S.keySavedNote : S.keyRemoved;
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

cacheClearButton.addEventListener('click', () => {
  void clearPdfFileCache().then(() => {
    storageStatus.textContent = S.cacheCleared;
    return renderStorage();
  });
});

// ─── Shortcuts ───

/** Keys as written on this platform: ⌥ ⇧ ⌘ on a Mac, Alt Shift Ctrl elsewhere. */
function keyCaps(combo: string): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'st-combo';
  combo.split(' / ').forEach((alternative, i) => {
    if (i > 0) wrap.append(document.createTextNode(' / '));
    // "Ctrl++" is Ctrl and the plus key.
    for (const part of alternative.replace(/\+\+$/u, '+PLUS').split('+').map((p) => (p === 'PLUS' ? '+' : p))) {
      const name = MAC ? ({ Alt: '⌥', Shift: '⇧', Ctrl: '⌘' } as Record<string, string>)[part] ?? part : part;
      const kbd = document.createElement('kbd');
      kbd.textContent = name;
      wrap.append(kbd);
    }
  });
  return wrap;
}

function shortcuts(): Array<{ group: string; keys: Array<[string, string]> }> {
  return [
    {
      group: S.groupTabs,
      keys: [
        ['Alt+Shift+← / Alt+Shift+→', S.scPrevNextTab],
        ['Alt+W', S.scCloseTab],
        ['Alt+Shift+T', S.scReopenTab],
        ['Alt+↑ / Alt+↓', S.scMoveInProject],
      ],
    },
    {
      group: S.groupView,
      keys: [
        ['Ctrl+F', S.scFind],
        ['Ctrl+G / Ctrl+Shift+G', S.scFindNext],
        ['Ctrl++ / Ctrl+-', S.scZoom],
        ['Ctrl+0', S.scFit],
        ['Ctrl+[ / Ctrl+]', S.scRotate],
        ['Home / End', S.scFirstLast],
        ['Ctrl+P', S.scPrint],
        ['Ctrl+S', S.scDownload],
      ],
    },
    {
      group: S.groupAnnotate,
      keys: [
        ['Ctrl+Z / Ctrl+Y', S.scUndoRedo],
        ['S / Ctrl+Shift+X', S.scCapture],
        ['Esc', S.scEsc],
      ],
    },
  ];
}

function renderShortcuts(): void {
  const host = byId<HTMLDivElement>('shortcuts');
  for (const { group, keys } of shortcuts()) {
    const section = document.createElement('div');
    section.className = 'st-keys-group';
    const title = document.createElement('h3');
    title.textContent = group;
    const list = document.createElement('dl');
    for (const [combo, what] of keys) {
      const row = document.createElement('div');
      const dt = document.createElement('dt');
      dt.append(keyCaps(combo));
      const dd = document.createElement('dd');
      dd.textContent = what;
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

renderShortcuts();
void Promise.all([loadSettings(), loadSync()]);
