// ─── Runtime message contracts (popup / viewer → background) ───
//
// Every message crossing the extension boundary is parsed by shape before a
// handler sees it. Type names keep the historical VOCAB_T_ prefix: they are
// an internal protocol, and renaming would only churn the viewer and tests.

import { isPdfViewerSourceUrl } from './localPdf';
import { PDF_VIEWER_ZOOM_PATTERN } from './pdfIdentity';

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

// The PDF viewer page reports its document and view state so the background
// can recreate the tab after an extension reload (Chrome closes every page of
// a reloaded extension). `page`/`zoom` feed PDF.js's `#page=…&zoom=…` hash.
export interface ViewerStateRequest {
  type: 'VOCAB_T_VIEWER_STATE';
  sourceUrl: string;
  page: number | null;
  zoom: string | null;
}

export function parseViewerStateRequest(value: unknown): ViewerStateRequest | null {
  if (!isRecord(value) || value.type !== 'VOCAB_T_VIEWER_STATE') return null;
  if (typeof value.sourceUrl !== 'string' || !isPdfViewerSourceUrl(value.sourceUrl)) return null;
  const page = typeof value.page === 'number' && Number.isInteger(value.page) && value.page >= 1 && value.page <= 100_000 ? value.page : null;
  const zoom = typeof value.zoom === 'string' && PDF_VIEWER_ZOOM_PATTERN.test(value.zoom) ? value.zoom : null;
  return { type: 'VOCAB_T_VIEWER_STATE', sourceUrl: value.sourceUrl, page, zoom };
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
