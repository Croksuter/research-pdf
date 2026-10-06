// ─── ResearchPDF popup ───
//
// The quick things: open the PDF tab, see and run the sync, a nudge when web
// PDFs still open in Chrome's viewer. Everything else is on the settings page
// (ui/settings.ts), which this opens.

import { DEFAULT_WEB_PDF_VIEWER_ENABLED, WEB_PDF_VIEWER_ENABLED_SETTING_KEY } from '../shared/constants';
import { getSetting } from '../db/settingsRepository';
import { PDF_HUB_PAGE } from '../shared/localPdf';
import { currentLanguage, localizeDocument } from '../shared/i18n';
import { syncStatusErrorText } from '../shared/syncErrors';
import type { PdfSyncPublicStatus } from '../background/pdfSyncService';
import { byId, hasWebAccess, send } from './pageKit';
import { S } from './popup.strings';

localizeDocument(S);

const syncSummary = byId<HTMLParagraphElement>('sync-summary');
const syncAction = byId<HTMLButtonElement>('sync-action');
const webHint = byId<HTMLParagraphElement>('web-hint');

type SyncStatus = PdfSyncPublicStatus;

/** The settings page lives in the PDF tab: the background brings one forward with it. */
function openSettings(): void {
  void send({ type: 'VOCAB_T_PDF_SHOW_SETTINGS' }).then(() => window.close());
}

let syncNow = false;

async function loadSync(): Promise<void> {
  const status = await send<SyncStatus | { success: false; error: string }>({ type: 'VOCAB_T_GET_CLOUD_SYNC_STATUS' });
  if (!status || 'success' in status) { syncSummary.textContent = S.statusFailed; return; }
  syncNow = status.googleConnected && status.enabled;
  syncAction.hidden = false;
  syncAction.disabled = status.syncing;
  syncAction.textContent = syncNow ? S.syncNow : status.googleConnected ? S.turnOn : S.connect;
  const account = status.googleAccountEmail || S.googleAccount;
  const errorText = syncStatusErrorText(status);
  if (!status.googleConnected) syncSummary.textContent = S.notConnected;
  else if (!status.enabled) syncSummary.textContent = S.off(account);
  else if (status.syncing) syncSummary.textContent = S.syncing;
  else if (errorText) syncSummary.textContent = S.error(errorText);
  else syncSummary.textContent = status.lastSyncAt
    ? S.lastSync(account, new Date(status.lastSyncAt).toLocaleString(currentLanguage(), { dateStyle: 'short', timeStyle: 'short' }))
    : S.waitingFirst(account);
}

syncAction.addEventListener('click', () => {
  if (!syncNow) { openSettings(); return; }
  syncAction.disabled = true;
  syncSummary.textContent = S.syncing;
  void send<{ success: boolean; error?: string; errorCode?: string }>({ type: 'VOCAB_T_SYNC_CLOUD_NOW' }).then(async (response) => {
    await loadSync();
    if (!response?.success) syncSummary.textContent = syncStatusErrorText(response) ?? S.syncFailed;
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
  const granted = await hasWebAccess();
  webHint.hidden = enabled && granted;
}

void loadSync();
void loadWebHint();
