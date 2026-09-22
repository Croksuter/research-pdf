// ─── ResearchPDF service worker ───
//
// The PDF viewer's background, and nothing else: viewer routing (file:// and
// opt-in web PDFs), viewer-tab restore after a reload, and Google Drive sync
// of drawings + reading positions. No vocabulary, no content script, no
// model calls. The sync engine lives in ./background/pdfSyncService.ts.

import { pdfMessageHandlers } from './background/pdfRouting';
import { isExtensionPageSender, registerMessageDispatcher, type MessageHandler } from './background/messageDispatcher';
import { initDebugLogging } from './shared/debugLog';
import {
  parseConnectGoogleSyncRequest,
  parseDisconnectGoogleSyncRequest,
  parseGetCloudSyncStatusRequest,
  parsePdfSyncHintRequest,
  parseSetPdfSyncEnabledRequest,
  parseSyncCloudNowRequest,
} from './shared/messages';
import {
  PDF_SYNC_ALARM_NAME,
  PDF_SYNC_ALARM_PERIOD_MINUTES,
  PDF_SYNC_SOON_ALARM_NAME,
  autoSyncPdfIfConnected,
  connectPdfSyncGoogle,
  disconnectPdfSyncGoogle,
  getPdfSyncStatus,
  requestPdfSyncSoon,
  setPdfSyncEnabled,
  syncPdfNow,
} from './background/pdfSyncService';

initDebugLogging();

const messageHandlers: Record<string, MessageHandler> = {
  ...pdfMessageHandlers,
  VOCAB_T_GET_CLOUD_SYNC_STATUS: (m) => parseGetCloudSyncStatusRequest(m)
    ? getPdfSyncStatus()
    : { success: false, error: '동기화 상태 요청 형식이 올바르지 않습니다.' },
  VOCAB_T_SYNC_CLOUD_NOW: (m) => parseSyncCloudNowRequest(m)
    ? syncPdfNow()
    : { success: false, error: '동기화 요청 형식이 올바르지 않습니다.' },
  // Account changes come from this extension's own pages only.
  VOCAB_T_CONNECT_GOOGLE_SYNC: (m, sender) => parseConnectGoogleSyncRequest(m) && isExtensionPageSender(sender)
    ? connectPdfSyncGoogle()
    : { success: false, error: 'Google 연결 요청 형식이 올바르지 않습니다.' },
  VOCAB_T_DISCONNECT_GOOGLE_SYNC: (m, sender) => parseDisconnectGoogleSyncRequest(m) && isExtensionPageSender(sender)
    ? disconnectPdfSyncGoogle()
    : { success: false, error: 'Google 연결 해제 요청 형식이 올바르지 않습니다.' },
  VOCAB_T_SET_PDF_SYNC_ENABLED: async (m, sender) => {
    const request = parseSetPdfSyncEnabledRequest(m);
    if (!request || !isExtensionPageSender(sender)) return { success: false, error: '동기화 설정 요청 형식이 올바르지 않습니다.' };
    return { success: true, status: await setPdfSyncEnabled(request.enabled) };
  },
  // The viewer waits for an `open` pull (bounded on its side); an `edit`
  // schedules one coalesced push a little later.
  VOCAB_T_PDF_SYNC_HINT: async (m, sender) => {
    const request = parsePdfSyncHintRequest(m);
    if (!request || !isExtensionPageSender(sender)) return { success: false, error: '동기화 힌트 형식이 올바르지 않습니다.' };
    if (request.reason === 'open') {
      await autoSyncPdfIfConnected();
    } else {
      requestPdfSyncSoon();
    }
    return { success: true };
  },
};

registerMessageDispatcher(messageHandlers);

// Periodic sync. Created only when missing so a busy worker that restarts
// often cannot keep pushing the first tick out.
void chrome.alarms.get(PDF_SYNC_ALARM_NAME).then((existing) => {
  if (!existing) {
    chrome.alarms.create(PDF_SYNC_ALARM_NAME, { delayInMinutes: 1, periodInMinutes: PDF_SYNC_ALARM_PERIOD_MINUTES });
  }
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PDF_SYNC_ALARM_NAME || alarm.name === PDF_SYNC_SOON_ALARM_NAME) void autoSyncPdfIfConnected();
});
chrome.runtime.onStartup.addListener(() => { void autoSyncPdfIfConnected(); });
