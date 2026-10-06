// ─── ResearchPDF settings page ───
//
// Every setting on one page of cards, with section chips and a search that
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
import { PDF_CACHE_MAX_BYTES } from '../shared/pdfCachePolicy';
import { PDF_LIBRARY_STORAGE_KEY, parsePdfLibrary } from '../shared/pdfLibrary';
import { PDF_PROJECTS_STORAGE_KEY, parsePdfProjects } from '../shared/pdfProjects';
import { isEmptyAnnotationCache, parsePdfAnnotationCache } from '../shared/pdfAnnotations';
import { openAlexCheck, semanticScholarCheck, type ApiCheck } from '../shared/apiStatus';

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
  syncAccount.textContent = status.googleConnected ? email || 'Google 계정' : '연결된 Google 계정이 없습니다.';
  syncEnabledInput.checked = status.enabled;
  syncEnabledInput.disabled = !status.googleConnected;
  syncConnectButton.textContent = status.googleConnected ? '다른 계정으로 연결' : 'Google 계정 연결';
  syncConnectButton.classList.toggle('st-btn-primary', !status.googleConnected);
  syncConnectButton.disabled = !status.googleConfigured;
  syncNowButton.hidden = !status.googleConnected;
  syncNowButton.disabled = !status.enabled || status.syncing;
  syncDisconnectButton.hidden = !status.googleConnected;
  syncSetup.textContent = status.googleConfigured
    ? `로그인 창에 redirect_uri_mismatch가 뜨면 이 설치의 리디렉션 URI가 OAuth 클라이언트에 등록되지 않은 것입니다: ${redirectUri()}`
    : `이 빌드에는 Google OAuth 클라이언트 ID가 없습니다. docs/google-drive-sync.md를 따라 설정하세요. 등록할 리디렉션 URI: ${redirectUri()}`;
  if (status.syncing) syncStatus.textContent = '동기화 중…';
  else if (status.error) syncStatus.textContent = `동기화 오류: ${status.error}`;
  else if (status.lastSyncAt) {
    syncStatus.textContent = `마지막 동기화 ${new Date(status.lastSyncAt).toLocaleString('ko-KR')}${status.pendingLocalChanges ? ' · 보낼 변경 있음' : ''}`;
  } else if (status.googleConnected) syncStatus.textContent = status.enabled ? '첫 동기화를 기다리는 중입니다.' : '동기화가 꺼져 있습니다.';
  else syncStatus.textContent = '연결하면 약 15분마다, 그리고 문서를 열고 필기할 때 동기화합니다.';
}

async function loadSync(): Promise<void> {
  const status = await send<SyncStatus | { success: false; error: string }>({ type: 'VOCAB_T_GET_CLOUD_SYNC_STATUS' });
  if (!status || 'success' in status) {
    syncStatus.textContent = status?.error ?? '동기화 상태를 불러오지 못했습니다.';
    return;
  }
  renderSync(status);
}

syncConnectButton.addEventListener('click', () => {
  syncConnectButton.disabled = true;
  syncStatus.textContent = 'Google 로그인 창을 여는 중…';
  void send<{ success: boolean; error?: string }>({ type: 'VOCAB_T_CONNECT_GOOGLE_SYNC' }).then(async (response) => {
    await loadSync();
    if (response && !response.success) syncStatus.textContent = response.error ?? 'Google 계정을 연결하지 못했습니다.';
  });
});

syncDisconnectButton.addEventListener('click', () => {
  syncDisconnectButton.disabled = true;
  void send<{ success: boolean; error?: string }>({ type: 'VOCAB_T_DISCONNECT_GOOGLE_SYNC' }).then(async (response) => {
    await loadSync();
    syncStatus.textContent = response?.success
      ? '연결을 해제했습니다. Drive에 저장된 데이터는 그대로 남아 있습니다.'
      : response?.error ?? '연결을 해제하지 못했습니다.';
  });
});

syncEnabledInput.addEventListener('change', () => {
  void send<{ success: boolean; status?: SyncStatus }>({ type: 'VOCAB_T_SET_PDF_SYNC_ENABLED', enabled: syncEnabledInput.checked })
    .then((response) => { if (response?.status) renderSync(response.status); });
});

syncNowButton.addEventListener('click', () => {
  syncNowButton.disabled = true;
  syncStatus.textContent = '동기화 중…';
  void send<{ success: boolean; error?: string }>({ type: 'VOCAB_T_SYNC_CLOUD_NOW' }).then(async (response) => {
    await loadSync();
    if (!response?.success) syncStatus.textContent = response?.error ?? '동기화에 실패했습니다.';
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
  badge(webAccess, web ? '사이트 접근 허용됨' : '사이트 접근 필요', web ? 'ok' : 'muted');
  badge(fileAccess, file ? '파일 URL 접근 켜짐' : '파일 URL 접근 꺼짐', file ? 'ok' : localOn ? 'warn' : 'muted');
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
        openStatus.textContent = '사이트 접근 권한이 허용되지 않아 켜지 못했습니다.';
        void renderAccess();
        return;
      }
    }
    await setSetting(WEB_PDF_VIEWER_ENABLED_SETTING_KEY, enable);
    const response = await send<{ success: boolean }>({ type: 'VOCAB_T_SYNC_WEB_PDF_ROUTING' });
    openStatus.textContent = !response?.success
      ? '저장했지만 적용하지 못했습니다. 확장 프로그램을 다시 로드하세요.'
      : enable ? '웹 PDF를 ResearchPDF로 엽니다. 이미 열린 PDF 탭은 새로고침하세요.' : '웹 PDF는 Chrome 기본 뷰어로 엽니다.';
    void renderAccess();
  })();
});

localPdfInput.addEventListener('change', () => {
  void setSetting(LOCAL_PDF_VIEWER_ENABLED_SETTING_KEY, localPdfInput.checked).then(async () => {
    const file = await hasFileAccess();
    openStatus.textContent = !localPdfInput.checked
      ? '컴퓨터의 PDF는 Chrome 기본 뷰어로 엽니다.'
      : file ? '컴퓨터의 PDF를 ResearchPDF로 엽니다.' : '켰습니다. Chrome에서 "파일 URL에 대한 액세스 허용"도 켜야 열립니다.';
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
    if (!response?.success) { openStatus.textContent = 'PDF 탭을 복구하지 못했습니다.'; return; }
    const restored = Number(response.restored ?? 0);
    const open = Number(response.open ?? 0);
    openStatus.textContent = restored > 0
      ? `PDF 탭 ${restored}개를 다시 열었습니다.`
      : open > 0 ? `복구할 탭이 없습니다 (열려 있는 PDF 탭 ${open}개).` : '복구할 PDF 탭 기록이 없습니다.';
  });
});

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

const offline: ApiCheck = { state: 'error', message: '연결하지 못했습니다. 네트워크를 확인하세요.' };

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
  badge(field.state, key ? '키 저장됨' : '키 없음', key ? 'ok' : 'muted');
  field.input.placeholder = key ? '저장됨 — 바꾸려면 새 키 입력, 지우려면 비우고 저장' : '키 붙여넣기';
  return key;
}

for (const field of keyFields) {
  field.save.addEventListener('click', () => {
    const key = field.input.value.trim();
    void setSetting(field.setting, key).then(async () => {
      field.input.value = '';
      await renderKey(field);
      field.result.dataset.state = '';
      field.result.textContent = key ? '저장했습니다. "확인"으로 동작하는지 볼 수 있습니다.' : '키를 지웠습니다.';
    });
  });
  field.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') field.save.click(); });
  field.check.addEventListener('click', () => {
    field.check.disabled = true;
    field.result.dataset.state = '';
    field.result.textContent = '확인 중…';
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
    cacheUsage.textContent = files ? `보관한 PDF ${files}개 · ${megabytes(bytes)} / ${megabytes(PDF_CACHE_MAX_BYTES)}` : '보관한 PDF가 없습니다.';
    cacheBar.style.width = `${Math.max(files ? 1 : 0, Math.round(share * 100))}%`;
    cacheBar.parentElement?.setAttribute('aria-valuenow', String(Math.round(share * 100)));
    cacheClearButton.disabled = files === 0;
  } catch {
    cacheUsage.textContent = '보관 용량을 읽지 못했습니다.';
  }
  try {
    const stored = await chrome.storage.local.get([PDF_LIBRARY_STORAGE_KEY, PDF_PROJECTS_STORAGE_KEY]);
    byId('stat-library').textContent = `${Object.keys(parsePdfLibrary(stored[PDF_LIBRARY_STORAGE_KEY])).length}편`;
    byId('stat-projects').textContent = `${Object.values(parsePdfProjects(stored[PDF_PROJECTS_STORAGE_KEY])).filter((p) => p.deletedAt === 0).length}개`;
  } catch { /* stays – */ }
  try {
    const rows = await dbGetAll<unknown>(STORE_PDF_ANNOTATIONS);
    const annotated = rows.map(parsePdfAnnotationCache).filter((c) => c && !isEmptyAnnotationCache(c)).length;
    byId('stat-annotated').textContent = `${annotated}편`;
  } catch { /* stays – */ }
}

fileCacheInput.addEventListener('change', () => {
  void setSetting(PDF_FILE_CACHE_ENABLED_SETTING_KEY, fileCacheInput.checked).then(() => {
    storageStatus.textContent = fileCacheInput.checked
      ? '연 웹 PDF를 이 기기에 보관합니다.'
      : '더 이상 보관하지 않습니다. 이미 보관한 PDF는 비우기로 지울 수 있습니다.';
  });
});

cacheClearButton.addEventListener('click', () => {
  void clearPdfFileCache().then(() => {
    storageStatus.textContent = '보관한 PDF를 모두 지웠습니다. 필기와 읽던 위치는 그대로입니다.';
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

const SHORTCUTS: Array<{ group: string; keys: Array<[string, string]> }> = [
  {
    group: 'PDF 탭',
    keys: [
      ['Alt+Shift+← / Alt+Shift+→', '이전·다음 PDF 탭'],
      ['Alt+W', '지금 PDF 탭 닫기'],
      ['Alt+Shift+T', '닫은 탭 다시 열기'],
      ['Alt+↑ / Alt+↓', '프로젝트 목록에서 순서 옮기기'],
    ],
  },
  {
    group: '보기',
    keys: [
      ['Ctrl+F', '문서에서 찾기'],
      ['Ctrl+G / Ctrl+Shift+G', '다음·이전 찾은 곳'],
      ['Ctrl++ / Ctrl+-', '확대·축소'],
      ['Ctrl+0', '자동 맞춤'],
      ['Ctrl+[ / Ctrl+]', '왼쪽·오른쪽으로 회전'],
      ['Home / End', '첫·마지막 페이지'],
      ['Ctrl+P', '인쇄'],
      ['Ctrl+S', '다운로드 (필기 포함)'],
    ],
  },
  {
    group: '필기·캡처',
    keys: [
      ['Ctrl+Z / Ctrl+Y', '실행 취소·다시 실행'],
      ['S / Ctrl+Shift+X', '영역 캡처 → 한 번 더: 그림·표 자동 인식 → 한 번 더: 끄기'],
      ['Esc', '캡처·찾기·필기 도구 닫기'],
    ],
  },
];

function renderShortcuts(): void {
  const host = byId<HTMLDivElement>('shortcuts');
  for (const { group, keys } of SHORTCUTS) {
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
  await Promise.all([renderAccess(), ...keyFields.map(renderKey), renderStorage()]);
}

renderShortcuts();
void Promise.all([loadSettings(), loadSync()]);
