// ─── ResearchPDF popup ───
//
// The quick things: open the PDF tab, see and run the sync, a nudge when web
// PDFs still open in Chrome's viewer. Everything else is on the settings page
// (ui/settings.ts), which this opens.

import { DEFAULT_WEB_PDF_VIEWER_ENABLED, WEB_PDF_VIEWER_ENABLED_SETTING_KEY } from '../shared/constants';
import { getSetting } from '../db/settingsRepository';
import { PDF_HUB_PAGE, WEB_PDF_HOST_ORIGINS } from '../shared/localPdf';

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as T;
};

const syncSummary = byId<HTMLParagraphElement>('sync-summary');
const syncAction = byId<HTMLButtonElement>('sync-action');
const webHint = byId<HTMLParagraphElement>('web-hint');

type SyncStatus = {
  googleConfigured: boolean;
  googleConnected: boolean;
  googleAccountEmail: string;
  enabled: boolean;
  lastSyncAt: string | null;
  error: string | null;
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

function openSettings(): void {
  void chrome.runtime.openOptionsPage();
  window.close();
}

let syncNow = false;

async function loadSync(): Promise<void> {
  const status = await send<SyncStatus | { success: false; error: string }>({ type: 'VOCAB_T_GET_CLOUD_SYNC_STATUS' });
  if (!status || 'success' in status) { syncSummary.textContent = '상태를 불러오지 못했습니다.'; return; }
  syncNow = status.googleConnected && status.enabled;
  syncAction.hidden = false;
  syncAction.disabled = status.syncing;
  syncAction.textContent = syncNow ? '지금 동기화' : status.googleConnected ? '켜기' : '연결';
  if (!status.googleConnected) syncSummary.textContent = '연결하면 필기와 읽던 위치가 모든 기기를 따라옵니다.';
  else if (!status.enabled) syncSummary.textContent = `${status.googleAccountEmail || 'Google 계정'} · 꺼져 있음`;
  else if (status.syncing) syncSummary.textContent = '동기화 중…';
  else if (status.error) syncSummary.textContent = `오류: ${status.error}`;
  else syncSummary.textContent = status.lastSyncAt
    ? `${status.googleAccountEmail || 'Google 계정'} · ${new Date(status.lastSyncAt).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })}`
    : `${status.googleAccountEmail || 'Google 계정'} · 첫 동기화를 기다리는 중`;
}

syncAction.addEventListener('click', () => {
  if (!syncNow) { openSettings(); return; }
  syncAction.disabled = true;
  syncSummary.textContent = '동기화 중…';
  void send<{ success: boolean; error?: string }>({ type: 'VOCAB_T_SYNC_CLOUD_NOW' }).then(async (response) => {
    await loadSync();
    if (!response?.success) syncSummary.textContent = response?.error ?? '동기화에 실패했습니다.';
  });
});

byId('open-viewer').addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL(PDF_HUB_PAGE) });
  window.close();
});
byId('open-settings').addEventListener('click', openSettings);
byId('web-hint-open').addEventListener('click', openSettings);

async function loadWebHint(): Promise<void> {
  const enabled = await getSetting(WEB_PDF_VIEWER_ENABLED_SETTING_KEY, DEFAULT_WEB_PDF_VIEWER_ENABLED);
  const granted = await chrome.permissions.contains({ origins: [...WEB_PDF_HOST_ORIGINS] }).catch(() => false);
  webHint.hidden = enabled && granted;
}

void loadSync();
void loadWebHint();
