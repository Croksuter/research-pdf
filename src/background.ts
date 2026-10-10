// ─── ResearchPDF service worker ───
//
// The PDF viewer's background, and nothing else: viewer routing (file:// and
// opt-in web PDFs), hub-tab restore after an extension update, the writers of
// the reading positions, library and projects, and Google Drive sync of all
// of them with the drawings. No content script, no model calls. The sync
// engine lives in ./background/pdfSyncService.ts.

import { pdfMessageHandlers } from './background/pdfRouting';
import { isExtensionPageSender, registerMessageDispatcher, type MessageHandler } from './background/messageDispatcher';
import { initDebugLogging } from './shared/debugLog';
import {
  parseConnectGoogleSyncRequest,
  parseDisconnectGoogleSyncRequest,
  parseGetCloudSyncStatusRequest,
  parsePdfDocStateSaveRequest,
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
import { driveFilesStatus, fetchDriveCopy, keepProjectInDrive, maybeKeepInDrive, removeDocFromDrive, renameDriveCopy, setDriveFilesEnabled, storeDocInDrive } from './background/pdfDriveFiles';
import { CloudSyncError } from './background/cloudSyncError';
import { isRecord } from './shared/guards';
import { savePdfDocRecord } from './background/pdfDocStateStore';
import { followStoredLanguage } from './shared/i18n';
import { watchSyncedSettings } from './background/settingsSync';
import { S } from './background/background.strings';
import './background/onboarding';

initDebugLogging();
followStoredLanguage();
// A preference changed on this device goes to the others with the next push.
watchSyncedSettings(requestPdfSyncSoon);

const messageHandlers: Record<string, MessageHandler> = {
  ...pdfMessageHandlers,
  VOCAB_T_GET_CLOUD_SYNC_STATUS: (m) => parseGetCloudSyncStatusRequest(m)
    ? getPdfSyncStatus()
    : { success: false, error: S.badSyncStatusRequest },
  VOCAB_T_SYNC_CLOUD_NOW: (m) => parseSyncCloudNowRequest(m)
    ? syncPdfNow()
    : { success: false, error: S.badSyncRequest },
  // Account changes come from this extension's own pages only.
  VOCAB_T_CONNECT_GOOGLE_SYNC: (m, sender) => {
    const request = parseConnectGoogleSyncRequest(m);
    return request && isExtensionPageSender(sender)
      ? connectPdfSyncGoogle({ confirmAccountChange: request.confirmAccountChange })
      : { success: false, error: S.badConnectRequest };
  },
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
  // A viewer frame's reading position; the next sync carries it.
  VOCAB_T_PDF_DOC_STATE_SAVE: async (m, sender) => {
    const request = parsePdfDocStateSaveRequest(m);
    if (!request || !isExtensionPageSender(sender)) return { success: false, error: S.badRequest };
    await savePdfDocRecord(request.record);
    return { success: true };
  },
  // Opens and detected titles from viewer frames.
  VOCAB_T_PDF_LIBRARY_UPDATE: async (m, sender) => {
    const request = parsePdfLibraryUpdateRequest(m);
    // A Drive copy is recorded by the background only, once it is there.
    if (!request || !isExtensionPageSender(sender) || request.update.kind === 'drive') return { success: false, error: S.badLibraryRequest };
    const { update } = request;
    if (await updatePdfLibrary(update)) {
      requestPdfSyncSoon();
      if (update.kind === 'rename') void renameDriveCopy(update.docId);
    }
    if (update.kind === 'opened') void maybeKeepInDrive(update.docId, update.url);
    return { success: true };
  },
  // PDF files in the user's Drive folder (background/pdfDriveFiles.ts); extension pages only.
  VOCAB_T_PDF_DRIVE_STATUS: async (_m, sender) => (isExtensionPageSender(sender) ? { success: true, status: await driveFilesStatus() } : { success: false }),
  VOCAB_T_PDF_DRIVE_ENABLE: async (m, sender) => {
    const enabled = isRecord(m) ? m.enabled : undefined;
    if (typeof enabled !== 'boolean' || !isExtensionPageSender(sender)) return { success: false };
    try {
      return { success: true, status: await setDriveFilesEnabled(enabled) };
    } catch (error) {
      return { success: false, errorCode: error instanceof CloudSyncError ? error.code : 'failed' };
    }
  },
  VOCAB_T_PDF_DRIVE_STORE: async (m, sender) => {
    const docIds = isRecord(m) && Array.isArray(m.docIds) ? m.docIds.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128).slice(0, 200) : [];
    if (docIds.length === 0 || !isExtensionPageSender(sender)) return { success: false };
    const results = await Promise.all(docIds.map(storeDocInDrive));
    const failed = results.find((r) => !r.success);
    return failed && !failed.success ? { success: false, errorCode: failed.errorCode, stored: results.filter((r) => r.success).length } : { success: true, stored: results.length };
  },
  VOCAB_T_PDF_DRIVE_REMOVE: async (m, sender) => {
    const docId = isRecord(m) && typeof m.docId === 'string' ? m.docId : '';
    return docId && isExtensionPageSender(sender) ? removeDocFromDrive(docId) : { success: false };
  },
  VOCAB_T_PDF_DRIVE_FETCH: async (m, sender) => {
    if (!isRecord(m) || !isExtensionPageSender(sender)) return { success: false };
    const url = typeof m.url === 'string' ? m.url : null;
    const docId = typeof m.docId === 'string' ? m.docId : null;
    return url || docId ? fetchDriveCopy({ url, docId }) : { success: false };
  },
  VOCAB_T_PDF_DRIVE_KEEP_PROJECT: async (m, sender) => {
    const projectId = isRecord(m) && typeof m.projectId === 'string' ? m.projectId : '';
    return projectId && isExtensionPageSender(sender) ? { success: true, ...(await keepProjectInDrive(projectId)) } : { success: false };
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
