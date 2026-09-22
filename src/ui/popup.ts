// ─── ResearchPDF settings popup ───
//
// Viewer routing, paper strip, tab restore, and Google Drive sync. Every
// durable action goes through the background; this page only reads settings
// and sends one-shot messages.

import {
  DEFAULT_LOCAL_PDF_VIEWER_ENABLED,
  DEFAULT_PAPER_INFO_ENABLED,
  DEFAULT_WEB_PDF_VIEWER_ENABLED,
  LOCAL_PDF_VIEWER_ENABLED_SETTING_KEY,
  PAPER_INFO_ENABLED_SETTING_KEY,
  SEMANTIC_SCHOLAR_API_KEY_SETTING_KEY,
  WEB_PDF_VIEWER_ENABLED_SETTING_KEY,
} from '../shared/constants';
import { getSetting, setSetting } from '../db/settingsRepository';
import { PDF_VIEWER_PAGE, WEB_PDF_HOST_ORIGINS } from '../shared/localPdf';

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as T;
};

const openViewerButton = byId<HTMLButtonElement>('open-viewer');
const syncAccount = byId<HTMLParagraphElement>('sync-account');
const syncEnabledInput = byId<HTMLInputElement>('sync-enabled');
const syncConnectButton = byId<HTMLButtonElement>('sync-connect');
const syncNowButton = byId<HTMLButtonElement>('sync-now');
const syncDisconnectButton = byId<HTMLButtonElement>('sync-disconnect');
const syncStatus = byId<HTMLParagraphElement>('sync-status');
const syncSetup = byId<HTMLParagraphElement>('sync-setup');
const localPdfInput = byId<HTMLInputElement>('local-pdf-viewer-enabled');
const webPdfInput = byId<HTMLInputElement>('web-pdf-viewer-enabled');
const paperInfoInput = byId<HTMLInputElement>('paper-info-enabled');
const s2KeyInput = byId<HTMLInputElement>('s2-api-key-input');
const s2KeySaveButton = byId<HTMLButtonElement>('s2-api-key-save');
const restoreTabsButton = byId<HTMLButtonElement>('restore-viewer-tabs');
const settingsStatus = byId<HTMLParagraphElement>('settings-status');

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

// ─── Sync ───

function redirectUri(): string {
  try { return chrome.identity.getRedirectURL(); } catch { return ''; }
}

function renderSync(status: SyncStatus): void {
  syncAccount.textContent = status.googleConnected
    ? `연결된 계정: ${status.googleAccountEmail || 'Google 계정'}`
    : '연결된 Google 계정이 없습니다.';
  syncEnabledInput.checked = status.enabled;
  syncEnabledInput.disabled = !status.googleConnected;
  syncConnectButton.textContent = status.googleConnected ? '다른 계정으로 연결' : 'Google 계정 연결';
  syncConnectButton.disabled = !status.googleConfigured;
  syncNowButton.disabled = !(status.googleConnected && status.enabled);
  syncDisconnectButton.disabled = !status.googleConnected;
  syncSetup.textContent = status.googleConfigured
    ? ''
    : `이 빌드에는 Google OAuth 클라이언트 ID가 설정되어 있지 않습니다. docs/google-drive-sync.md를 따라 설정하세요. 등록할 리디렉션 URI: ${redirectUri()}`;
  if (status.syncing) syncStatus.textContent = '동기화 중…';
  else if (status.error) syncStatus.textContent = `동기화 오류: ${status.error}`;
  else if (status.lastSyncAt) {
    syncStatus.textContent = `마지막 동기화: ${new Date(status.lastSyncAt).toLocaleString('ko-KR')}`
      + (status.pendingLocalChanges ? ' · 보낼 변경 있음' : '');
  } else syncStatus.textContent = status.googleConnected ? '첫 동기화를 기다리는 중입니다.' : '';
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
  syncStatus.textContent = 'Google 로그인 창을 여는 중… 창이 뜨면 이 팝업은 닫힙니다. 로그인 후 다시 열어 상태를 확인하세요.';
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
      ? 'Google 계정 연결을 해제했습니다. Drive에 저장된 데이터는 그대로 남아 있습니다.'
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
  void send<{ success: boolean; error?: string; lastSyncAt?: string }>({ type: 'VOCAB_T_SYNC_CLOUD_NOW' }).then((response) => {
    syncNowButton.disabled = false;
    syncStatus.textContent = response?.success
      ? `동기화 완료: ${new Date(response.lastSyncAt ?? Date.now()).toLocaleString('ko-KR')}`
      : response?.error ?? '동기화에 실패했습니다.';
  });
});

// ─── Viewer settings ───

openViewerButton.addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL(PDF_VIEWER_PAGE) });
  window.close();
});

localPdfInput.addEventListener('change', () => {
  void setSetting(LOCAL_PDF_VIEWER_ENABLED_SETTING_KEY, localPdfInput.checked).then(() => {
    settingsStatus.textContent = localPdfInput.checked ? '로컬 PDF를 ResearchPDF로 엽니다.' : '로컬 PDF는 Chrome 기본 뷰어로 엽니다.';
  });
});

async function hasWebPdfHostAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [...WEB_PDF_HOST_ORIGINS] });
  } catch {
    return false;
  }
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
        settingsStatus.textContent = '사이트 접근 권한이 허용되지 않아 웹 PDF 뷰어를 켜지 못했습니다.';
        return;
      }
    }
    await setSetting(WEB_PDF_VIEWER_ENABLED_SETTING_KEY, enable);
    const response = await send<{ success: boolean }>({ type: 'VOCAB_T_SYNC_WEB_PDF_ROUTING' });
    settingsStatus.textContent = !response?.success
      ? '웹 PDF 뷰어 설정은 저장됐지만 백그라운드 적용에 실패했습니다. 확장을 다시 로드하세요.'
      : enable ? '웹 PDF를 ResearchPDF로 엽니다. 이미 열린 PDF 탭은 새로고침하세요.' : '웹 PDF는 Chrome 기본 뷰어로 엽니다.';
  })();
});

paperInfoInput.addEventListener('change', () => {
  void setSetting(PAPER_INFO_ENABLED_SETTING_KEY, paperInfoInput.checked).then(() => {
    settingsStatus.textContent = '논문 정보 표시 설정을 저장했습니다.';
  });
});

s2KeySaveButton.addEventListener('click', () => {
  const key = s2KeyInput.value.trim();
  void setSetting(SEMANTIC_SCHOLAR_API_KEY_SETTING_KEY, key).then(() => {
    s2KeyInput.value = '';
    settingsStatus.textContent = key ? 'Semantic Scholar API 키를 저장했습니다.' : 'Semantic Scholar API 키를 삭제했습니다.';
  });
});

restoreTabsButton.addEventListener('click', () => {
  restoreTabsButton.disabled = true;
  void send<{ success: boolean; restored?: number; open?: number }>({ type: 'VOCAB_T_RESTORE_VIEWER_TABS' }).then((response) => {
    restoreTabsButton.disabled = false;
    if (!response?.success) {
      settingsStatus.textContent = 'PDF 뷰어 탭을 복구하지 못했습니다.';
      return;
    }
    const restored = Number(response.restored ?? 0);
    const open = Number(response.open ?? 0);
    settingsStatus.textContent = restored > 0
      ? `PDF 뷰어 탭 ${restored}개를 다시 열었습니다.`
      : (open > 0 ? `복구할 탭이 없습니다 (열려 있는 뷰어 탭 ${open}개).` : '복구할 PDF 뷰어 탭 기록이 없습니다.');
  });
});

// ─── Boot ───

async function loadSettings(): Promise<void> {
  const [localPdf, webPdf, paperInfo, s2Key] = await Promise.all([
    getSetting(LOCAL_PDF_VIEWER_ENABLED_SETTING_KEY, DEFAULT_LOCAL_PDF_VIEWER_ENABLED),
    getSetting(WEB_PDF_VIEWER_ENABLED_SETTING_KEY, DEFAULT_WEB_PDF_VIEWER_ENABLED),
    getSetting(PAPER_INFO_ENABLED_SETTING_KEY, DEFAULT_PAPER_INFO_ENABLED),
    getSetting<string>(SEMANTIC_SCHOLAR_API_KEY_SETTING_KEY, ''),
  ]);
  localPdfInput.checked = localPdf;
  // The rule only exists while host access is granted; reflect that, not just the stored flag.
  webPdfInput.checked = webPdf && await hasWebPdfHostAccess();
  paperInfoInput.checked = paperInfo;
  s2KeyInput.placeholder = s2Key ? '저장됨 (바꾸려면 새 키 입력)' : '없으면 공용 익명 한도 사용';
}

void Promise.all([loadSettings(), loadSync()]).catch(() => {
  settingsStatus.textContent = '설정을 불러오지 못했습니다.';
});
