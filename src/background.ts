// ─── ResearchPDF service worker ───
//
// The PDF viewer's background, and nothing else: viewer routing (file:// and
// opt-in web PDFs), viewer-tab restore after a reload, the library of opened
// documents, and Google Drive sync of drawings, reading positions and the
// library. No vocabulary, no content script, no
// model calls. The sync engine lives in ./background/pdfSyncService.ts.

import { pdfMessageHandlers } from './background/pdfRouting';
import { isExtensionPageSender, registerMessageDispatcher, type MessageHandler } from './background/messageDispatcher';
import { initDebugLogging } from './shared/debugLog';
import {
  parseConnectGoogleSyncRequest,
  parseDisconnectGoogleSyncRequest,
  parseGetCloudSyncStatusRequest,
  parsePdfLibraryUpdateRequest,
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
  pullPdfSyncForOpen,
  requestPdfSyncSoon,
  setPdfSyncEnabled,
  syncPdfNow,
} from './background/pdfSyncService';
import { updatePdfLibrary } from './background/pdfLibraryStore';
import { followStoredLanguage } from './shared/i18n';
import { S } from './background/background.strings';
import './background/onboarding';

initDebugLogging();
followStoredLanguage();

const messageHandlers: Record<string, MessageHandler> = {
  ...pdfMessageHandlers,
  VOCAB_T_GET_CLOUD_SYNC_STATUS: (m) => parseGetCloudSyncStatusRequest(m)
    ? getPdfSyncStatus()
    : { success: false, error: S.badSyncStatusRequest },
  VOCAB_T_SYNC_CLOUD_NOW: (m) => parseSyncCloudNowRequest(m)
    ? syncPdfNow()
    : { success: false, error: S.badSyncRequest },
  // Account changes come from this extension's own pages only.
  VOCAB_T_CONNECT_GOOGLE_SYNC: (m, sender) => parseConnectGoogleSyncRequest(m) && isExtensionPageSender(sender)
    ? connectPdfSyncGoogle()
    : { success: false, error: S.badConnectRequest },
  VOCAB_T_DISCONNECT_GOOGLE_SYNC: (m, sender) => parseDisconnectGoogleSyncRequest(m) && isExtensionPageSender(sender)
    ? disconnectPdfSyncGoogle()
    : { success: false, error: S.badDisconnectRequest },
  VOCAB_T_SET_PDF_SYNC_ENABLED: async (m, sender) => {
    const request = parseSetPdfSyncEnabledRequest(m);
    if (!request || !isExtensionPageSender(sender)) return { success: false, error: S.badSyncSettingRequest };
    return { success: true, status: await setPdfSyncEnabled(request.enabled) };
  },
  // An `open` pull answers with the documents it changed (the viewer has
  // already rendered from local data); an `edit` schedules one coalesced
  // push a little later.
  VOCAB_T_PDF_SYNC_HINT: async (m, sender) => {
    const request = parsePdfSyncHintRequest(m);
    if (!request || !isExtensionPageSender(sender)) return { success: false, error: S.badSyncHint };
    if (request.reason === 'open') return { success: true, ...(await pullPdfSyncForOpen()) };
    requestPdfSyncSoon();
    return { success: true };
  },
  // Opens and detected titles from viewer frames, pins from the hub.
  VOCAB_T_PDF_LIBRARY_UPDATE: async (m, sender) => {
    const request = parsePdfLibraryUpdateRequest(m);
    if (!request || !isExtensionPageSender(sender)) return { success: false, error: S.badLibraryRequest };
    if (await updatePdfLibrary(request.update)) requestPdfSyncSoon();
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
