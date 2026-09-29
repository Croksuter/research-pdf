// ─── Runtime message contracts (popup / viewer → background) ───
//
// Every message crossing the extension boundary is parsed by shape before a
// handler sees it. Type names keep the historical VOCAB_T_ prefix: they are
// an internal protocol, and renaming would only churn the viewer and tests.

import { PDF_HUB_MAX_DOCS, isPdfViewerSourceUrl, type PdfHubDoc } from './localPdf';
import { parsePdfLibraryUpdate, type PdfLibraryUpdate } from './pdfLibrary';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseEmptyRequest<T extends string>(value: unknown, type: T): { type: T } | null {
  return isRecord(value) && value.type === type && Object.keys(value).length === 1 ? { type } : null;
}

// ─── PDF viewer ───
// Sent by the bundled PDF.js page when the user asks to reopen the current
// document in Chrome's native viewer. The background records a one-shot bypass
// for the sender tab (and pauses the web-PDF redirect rule) before navigating
// so its own routing stays quiet.
export interface OpenNativePdfRequest {
  type: 'VOCAB_T_OPEN_NATIVE_PDF';
  url: string;
}

export function parseOpenNativePdfRequest(value: unknown): OpenNativePdfRequest | null {
  if (!isRecord(value) || value.type !== 'VOCAB_T_OPEN_NATIVE_PDF') return null;
  if (typeof value.url !== 'string' || !isPdfViewerSourceUrl(value.url)) return null;
  return { type: 'VOCAB_T_OPEN_NATIVE_PDF', url: value.url };
}

// Sent by the popup after the web-PDF setting or its host permission changed;
// the background re-derives the declarativeNetRequest rule from durable state.
export interface SyncWebPdfRoutingRequest {
  type: 'VOCAB_T_SYNC_WEB_PDF_ROUTING';
}

export function parseSyncWebPdfRoutingRequest(value: unknown): SyncWebPdfRoutingRequest | null {
  return parseEmptyRequest(value, 'VOCAB_T_SYNC_WEB_PDF_ROUTING');
}

// ─── PDF hub (one tab per window collecting every top-level PDF) ───

function parseHubDocs(value: unknown): PdfHubDoc[] | null {
  if (!Array.isArray(value) || value.length > PDF_HUB_MAX_DOCS) return null;
  const docs: PdfHubDoc[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.url !== 'string' || !isPdfViewerSourceUrl(item.url)) return null;
    const hash = typeof item.hash === 'string' && /^(?:#[^\s]{0,512})?$/u.test(item.hash) ? item.hash : '';
    docs.push({ url: item.url, hash });
  }
  return docs;
}

// A hub page that just loaded asks whether it is its window's hub or should
// hand its documents to the existing one and get out of the way.
export interface PdfHubClaimRequest {
  type: 'VOCAB_T_PDF_HUB_CLAIM';
  docs: PdfHubDoc[];
  canGoBack: boolean;
}

export function parsePdfHubClaimRequest(value: unknown): PdfHubClaimRequest | null {
  if (!isRecord(value) || value.type !== 'VOCAB_T_PDF_HUB_CLAIM' || typeof value.canGoBack !== 'boolean') return null;
  const docs = parseHubDocs(value.docs);
  return docs ? { type: 'VOCAB_T_PDF_HUB_CLAIM', docs, canGoBack: value.canGoBack } : null;
}

// The hub reports its URL-backed documents so the background can recreate it
// after an extension reload (Chrome closes every page of a reloaded
// extension). Reading positions come back from the per-document records.
export interface PdfHubStateRequest {
  type: 'VOCAB_T_PDF_HUB_STATE';
  urls: string[];
  active: number;
}

export function parsePdfHubStateRequest(value: unknown): PdfHubStateRequest | null {
  if (!isRecord(value) || value.type !== 'VOCAB_T_PDF_HUB_STATE') return null;
  if (!Array.isArray(value.urls) || value.urls.length > PDF_HUB_MAX_DOCS) return null;
  if (!value.urls.every((url) => typeof url === 'string' && isPdfViewerSourceUrl(url))) return null;
  const active = typeof value.active === 'number' && Number.isInteger(value.active) && value.active >= 0 ? value.active : 0;
  return { type: 'VOCAB_T_PDF_HUB_STATE', urls: value.urls as string[], active };
}

// Background → hub page broadcast: add these documents to the hub in tab `tabId`.
export interface PdfHubOpenMessage {
  type: 'VOCAB_T_PDF_HUB_OPEN';
  tabId: number;
  docs: PdfHubDoc[];
  activate: boolean;
}

export function parsePdfHubOpenMessage(value: unknown): PdfHubOpenMessage | null {
  if (!isRecord(value) || value.type !== 'VOCAB_T_PDF_HUB_OPEN') return null;
  if (typeof value.tabId !== 'number' || !Number.isInteger(value.tabId) || typeof value.activate !== 'boolean') return null;
  const docs = parseHubDocs(value.docs);
  return docs ? { type: 'VOCAB_T_PDF_HUB_OPEN', tabId: value.tabId, docs, activate: value.activate } : null;
}

// Popup button: recreate PDF viewer tabs whose records survived a reload.
export interface RestoreViewerTabsRequest {
  type: 'VOCAB_T_RESTORE_VIEWER_TABS';
}

export function parseRestoreViewerTabsRequest(value: unknown): RestoreViewerTabsRequest | null {
  return parseEmptyRequest(value, 'VOCAB_T_RESTORE_VIEWER_TABS');
}

// ─── Google Drive sync ───

export interface GetCloudSyncStatusRequest {
  type: 'VOCAB_T_GET_CLOUD_SYNC_STATUS';
}

export function parseGetCloudSyncStatusRequest(value: unknown): GetCloudSyncStatusRequest | null {
  return parseEmptyRequest(value, 'VOCAB_T_GET_CLOUD_SYNC_STATUS');
}

export interface SyncCloudNowRequest {
  type: 'VOCAB_T_SYNC_CLOUD_NOW';
}

export function parseSyncCloudNowRequest(value: unknown): SyncCloudNowRequest | null {
  return parseEmptyRequest(value, 'VOCAB_T_SYNC_CLOUD_NOW');
}

export interface ConnectGoogleSyncRequest {
  type: 'VOCAB_T_CONNECT_GOOGLE_SYNC';
}

export function parseConnectGoogleSyncRequest(value: unknown): ConnectGoogleSyncRequest | null {
  return parseEmptyRequest(value, 'VOCAB_T_CONNECT_GOOGLE_SYNC');
}

export interface DisconnectGoogleSyncRequest {
  type: 'VOCAB_T_DISCONNECT_GOOGLE_SYNC';
}

export function parseDisconnectGoogleSyncRequest(value: unknown): DisconnectGoogleSyncRequest | null {
  return parseEmptyRequest(value, 'VOCAB_T_DISCONNECT_GOOGLE_SYNC');
}

export interface SetPdfSyncEnabledRequest {
  type: 'VOCAB_T_SET_PDF_SYNC_ENABLED';
  enabled: boolean;
}

export function parseSetPdfSyncEnabledRequest(value: unknown): SetPdfSyncEnabledRequest | null {
  if (!isRecord(value) || value.type !== 'VOCAB_T_SET_PDF_SYNC_ENABLED' || Object.keys(value).length !== 2) return null;
  return typeof value.enabled === 'boolean' ? { type: 'VOCAB_T_SET_PDF_SYNC_ENABLED', enabled: value.enabled } : null;
}

export interface PdfSyncHintRequest {
  type: 'VOCAB_T_PDF_SYNC_HINT';
  reason: 'open' | 'edit';
}

/** Viewer → background: pull before a document opens, push after an edit. */
export function parsePdfSyncHintRequest(value: unknown): PdfSyncHintRequest | null {
  if (!isRecord(value) || value.type !== 'VOCAB_T_PDF_SYNC_HINT' || Object.keys(value).length !== 2) return null;
  return value.reason === 'open' || value.reason === 'edit' ? { type: 'VOCAB_T_PDF_SYNC_HINT', reason: value.reason } : null;
}

export interface PdfLibraryUpdateRequest {
  type: 'VOCAB_T_PDF_LIBRARY_UPDATE';
  update: PdfLibraryUpdate;
}

export function parsePdfLibraryUpdateRequest(value: unknown): PdfLibraryUpdateRequest | null {
  if (!isRecord(value) || value.type !== 'VOCAB_T_PDF_LIBRARY_UPDATE' || Object.keys(value).length !== 2) return null;
  const update = parsePdfLibraryUpdate(value.update);
  return update ? { type: 'VOCAB_T_PDF_LIBRARY_UPDATE', update } : null;
}
