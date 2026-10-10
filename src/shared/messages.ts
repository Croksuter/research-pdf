// ─── Runtime message contracts (popup / viewer → background) ───
//
// Every message crossing the extension boundary is parsed by shape before a
// handler sees it. Type names keep the historical VOCAB_T_ prefix: they are
// an internal protocol, and renaming would only churn the viewer and tests.

import { PDF_HUB_MAX_DOCS, isPdfViewerSourceUrl, type PdfHubDoc } from './localPdf';
import { parsePdfDocRecord, type PdfDocRecord } from './pdfIdentity';
import { parsePdfLibraryUpdate, type PdfLibraryUpdate } from './pdfLibrary';
import { isPdfProjectId, parsePdfFolderUpdate, parsePdfProjectUpdate, type PdfFolderUpdate, type PdfProjectUpdate } from './pdfProjects';
import { isRecord } from './guards';


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

// ─── PDF hub (one tab per project collecting every top-level PDF) ───

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

// A hub page that just loaded asks whether it is a project's hub or should
// hand its documents to the existing one and get out of the way. `project`
// is the one its URL names, or null to let the background route the
// documents (the default project, or an open one they are registered to).
export interface PdfHubClaimRequest {
  type: 'VOCAB_T_PDF_HUB_CLAIM';
  docs: PdfHubDoc[];
  canGoBack: boolean;
  project: string | null;
}

export function parsePdfHubClaimRequest(value: unknown): PdfHubClaimRequest | null {
  if (!isRecord(value) || value.type !== 'VOCAB_T_PDF_HUB_CLAIM' || typeof value.canGoBack !== 'boolean') return null;
  const project = value.project === undefined || value.project === null ? null : isPdfProjectId(value.project) ? value.project : undefined;
  if (project === undefined) return null;
  const docs = parseHubDocs(value.docs);
  return docs ? { type: 'VOCAB_T_PDF_HUB_CLAIM', docs, canGoBack: value.canGoBack, project } : null;
}

// The hub reports its URL-backed documents so the background can recreate it
// after an extension reload (Chrome closes every page of a reloaded
// extension) and keep them as its project's layout, which is what the
// project opens with next time. Reading positions come back from the
// per-document records.
export interface PdfHubStateRequest {
  type: 'VOCAB_T_PDF_HUB_STATE';
  urls: string[];
  active: number;
  project: string;
  /** `home`, a pinned document's URL in front, or null. */
  show: string | null;
}

export function parsePdfHubStateRequest(value: unknown): PdfHubStateRequest | null {
  if (!isRecord(value) || value.type !== 'VOCAB_T_PDF_HUB_STATE' || !isPdfProjectId(value.project)) return null;
  if (!Array.isArray(value.urls) || value.urls.length > PDF_HUB_MAX_DOCS) return null;
  if (!value.urls.every((url) => typeof url === 'string' && isPdfViewerSourceUrl(url))) return null;
  const show = value.show === null || value.show === undefined ? null
    : value.show === 'home' || (typeof value.show === 'string' && isPdfViewerSourceUrl(value.show)) ? value.show as string : undefined;
  if (show === undefined) return null;
  const active = typeof value.active === 'number' && Number.isInteger(value.active) && value.active >= 0 ? value.active : 0;
  return { type: 'VOCAB_T_PDF_HUB_STATE', urls: value.urls as string[], active, project: value.project, show };
}

// ─── Projects (hub → background) ───

export interface PdfProjectUpdateRequest {
  type: 'VOCAB_T_PDF_PROJECT_UPDATE';
  update: PdfProjectUpdate | PdfFolderUpdate;
}

export function parsePdfProjectUpdateRequest(value: unknown): PdfProjectUpdateRequest | null {
  if (!isRecord(value) || value.type !== 'VOCAB_T_PDF_PROJECT_UPDATE' || Object.keys(value).length !== 2) return null;
  const update = parsePdfProjectUpdate(value.update) ?? parsePdfFolderUpdate(value.update);
  return update && update.kind !== 'layout' && update.kind !== 'move' ? { type: 'VOCAB_T_PDF_PROJECT_UPDATE', update } : null;
}

// Show a project: its hub if it is open anywhere. Otherwise, `inPlace`: the
// URL the sender switches itself to; not: a new hub tab next to the sender,
// with the tabs the project was closed with.
export interface PdfProjectOpenRequest {
  type: 'VOCAB_T_PDF_PROJECT_OPEN';
  project: string;
  inPlace: boolean;
}

export function parsePdfProjectOpenRequest(value: unknown): PdfProjectOpenRequest | null {
  if (!isRecord(value) || value.type !== 'VOCAB_T_PDF_PROJECT_OPEN' || Object.keys(value).length !== 3) return null;
  if (!isPdfProjectId(value.project) || typeof value.inPlace !== 'boolean') return null;
  return { type: 'VOCAB_T_PDF_PROJECT_OPEN', project: value.project, inPlace: value.inPlace };
}

// Move a document to another project (`keep`: register it there too and
// leave it where it is). The background updates the membership and puts the
// document's tab in the target: handed to its hub when open, otherwise added
// to the tabs it opens with.
export interface PdfProjectMoveRequest {
  type: 'VOCAB_T_PDF_PROJECT_MOVE';
  docId: string;
  url: string | null;
  from: string;
  to: string;
  keep: boolean;
}

export function parsePdfProjectMoveRequest(value: unknown): PdfProjectMoveRequest | null {
  if (!isRecord(value) || value.type !== 'VOCAB_T_PDF_PROJECT_MOVE') return null;
  const { docId, url, from, to, keep } = value;
  if (typeof docId !== 'string' || !docId || docId.length > 128 || !isPdfProjectId(from) || !isPdfProjectId(to) || from === to) return null;
  if (url !== null && (typeof url !== 'string' || !isPdfViewerSourceUrl(url))) return null;
  if (typeof keep !== 'boolean') return null;
  return { type: 'VOCAB_T_PDF_PROJECT_MOVE', docId, url, from, to, keep };
}

// Send a document from its hub to another window ("새 창으로 분리", "다른 창으로
// 보내기", a tab dropped outside the hub's window). `target`: a window by id,
// the window under a screen point (a drop on another window's empty space),
// or null for a new window — placed at `bounds` (the drop point), or where
// Chrome puts it. `url` null: a file picked from disk, handed over to the hub
// once it exists. `arrival`: what the new hub's notice can send back.
export interface PdfTearOffRequest {
  type: 'VOCAB_T_PDF_TEAR_OFF';
  project: string;
  url: string | null;
  bounds: { left: number; top: number; width: number; height: number } | null;
  target: { windowId: number } | { x: number; y: number } | null;
  arrival: { key: number; title: string } | null;
}

const BOUND_LIMIT = 100_000;
const isCoord = (n: unknown): n is number => Number.isInteger(n) && Math.abs(n as number) <= BOUND_LIMIT;

function parseBounds(value: unknown): PdfTearOffRequest['bounds'] | undefined {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return undefined;
  const { left, top, width, height } = value;
  if (![left, top, width, height].every(isCoord)) return undefined;
  if ((width as number) < 200 || (height as number) < 150) return undefined;
  return { left: left as number, top: top as number, width: width as number, height: height as number };
}

function parseTarget(value: unknown): PdfTearOffRequest['target'] | undefined {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return undefined;
  if ('windowId' in value) return Number.isInteger(value.windowId) ? { windowId: value.windowId as number } : undefined;
  return isCoord(value.x) && isCoord(value.y) ? { x: value.x, y: value.y } : undefined;
}

function parseArrival(value: unknown): PdfTearOffRequest['arrival'] | undefined {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !Number.isInteger(value.key) || typeof value.title !== 'string') return undefined;
  return { key: value.key as number, title: value.title.slice(0, 300) };
}

export function parsePdfTearOffRequest(value: unknown): PdfTearOffRequest | null {
  if (!isRecord(value) || value.type !== 'VOCAB_T_PDF_TEAR_OFF') return null;
  const { project } = value;
  const url = value.url ?? null;
  if (!isPdfProjectId(project) || (url !== null && (typeof url !== 'string' || !isPdfViewerSourceUrl(url)))) return null;
  const bounds = parseBounds(value.bounds);
  const target = parseTarget(value.target);
  const arrival = parseArrival(value.arrival);
  if (bounds === undefined || target === undefined || arrival === undefined) return null;
  return { type: 'VOCAB_T_PDF_TEAR_OFF', project, url, bounds, target, arrival };
}

// The browser's other windows, for "다른 창으로 보내기": each with its tab
// count and whether it holds a hub of `project`.
export interface PdfWindowsRequest {
  type: 'VOCAB_T_PDF_WINDOWS';
  project: string;
}

export function parsePdfWindowsRequest(value: unknown): PdfWindowsRequest | null {
  return isRecord(value) && value.type === 'VOCAB_T_PDF_WINDOWS' && isPdfProjectId(value.project)
    ? { type: 'VOCAB_T_PDF_WINDOWS', project: value.project }
    : null;
}

// Background → hub page broadcast: add these documents to the hub in tab `tabId`.
export interface PdfHubOpenMessage {
  type: 'VOCAB_T_PDF_HUB_OPEN';
  tabId: number;
  docs: PdfHubDoc[];
  activate: boolean;
  /** Bring the hub's settings page to the front instead (no docs). */
  show?: 'settings';
}

export function parsePdfHubOpenMessage(value: unknown): PdfHubOpenMessage | null {
  if (!isRecord(value) || value.type !== 'VOCAB_T_PDF_HUB_OPEN') return null;
  if (typeof value.tabId !== 'number' || !Number.isInteger(value.tabId) || typeof value.activate !== 'boolean') return null;
  const docs = parseHubDocs(value.docs);
  if (!docs || (value.show !== undefined && value.show !== 'settings')) return null;
  return { type: 'VOCAB_T_PDF_HUB_OPEN', tabId: value.tabId, docs, activate: value.activate, ...(value.show ? { show: value.show } : {}) };
}

// An embedded viewer filling (almost) the whole tab — a publisher's "view
// PDF" page that wraps the PDF in an iframe (IEEE stamp.jsp) — asks to move
// the document into the hub. `width`/`height`: its frame, in CSS pixels.
export interface PdfEmbedPromoteRequest {
  type: 'VOCAB_T_PDF_EMBED_PROMOTE';
  url: string;
  width: number;
  height: number;
}

export function parsePdfEmbedPromoteRequest(value: unknown): PdfEmbedPromoteRequest | null {
  if (!isRecord(value) || value.type !== 'VOCAB_T_PDF_EMBED_PROMOTE') return null;
  const { url, width, height } = value;
  if (typeof url !== 'string' || !isPdfViewerSourceUrl(url)) return null;
  if (typeof width !== 'number' || typeof height !== 'number' || !(width > 0) || !(height > 0)) return null;
  return { type: 'VOCAB_T_PDF_EMBED_PROMOTE', url, width, height };
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

// Signs in and connects. When the account is not the one this device last
// synced with (and there is local data) the answer is `needsConfirm:
// 'account-change'`; the page asks the user and sends this again with
// `confirmAccountChange: true` to go ahead.
export interface ConnectGoogleSyncRequest {
  type: 'VOCAB_T_CONNECT_GOOGLE_SYNC';
  confirmAccountChange: boolean;
}

export function parseConnectGoogleSyncRequest(value: unknown): ConnectGoogleSyncRequest | null {
  if (parseEmptyRequest(value, 'VOCAB_T_CONNECT_GOOGLE_SYNC')) return { type: 'VOCAB_T_CONNECT_GOOGLE_SYNC', confirmAccountChange: false };
  if (!isRecord(value) || value.type !== 'VOCAB_T_CONNECT_GOOGLE_SYNC' || Object.keys(value).length !== 2) return null;
  return typeof value.confirmAccountChange === 'boolean' ? { type: 'VOCAB_T_CONNECT_GOOGLE_SYNC', confirmAccountChange: value.confirmAccountChange } : null;
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

// Viewer frame → background: this document's reading position. The background
// is the only writer of the position map (background/pdfDocStateStore.ts).
export interface PdfDocStateSaveRequest {
  type: 'VOCAB_T_PDF_DOC_STATE_SAVE';
  record: PdfDocRecord;
}

export function parsePdfDocStateSaveRequest(value: unknown): PdfDocStateSaveRequest | null {
  if (!isRecord(value) || value.type !== 'VOCAB_T_PDF_DOC_STATE_SAVE' || Object.keys(value).length !== 2) return null;
  const record = parsePdfDocRecord(value.record);
  return record ? { type: 'VOCAB_T_PDF_DOC_STATE_SAVE', record } : null;
}
