// ─── PDF hub ↔ viewer frame protocol (window.postMessage, same origin) ───
//
// The hub page (ui/pdfHub.ts) hosts one viewer iframe per document. Both are
// extension pages, so every message is checked for our origin and for coming
// from the expected window before it is parsed here.

export const HUB_MESSAGE_TAG = 'rpdf-hub';

export type HubKeyAction = 'prev' | 'next' | 'close';

export type ViewerToHubMessage =
  | { tag: typeof HUB_MESSAGE_TAG; kind: 'doc'; title: string }
  | { tag: typeof HUB_MESSAGE_TAG; kind: 'key'; action: HubKeyAction }
  | { tag: typeof HUB_MESSAGE_TAG; kind: 'open-files'; files: File[] };

export type HubToViewerMessage =
  | { tag: typeof HUB_MESSAGE_TAG; kind: 'open-file'; file: File }
  | { tag: typeof HUB_MESSAGE_TAG; kind: 'hash'; hash: string };

const TITLE_MAX_CHARS = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFile(value: unknown): value is File {
  return typeof File !== 'undefined' && value instanceof File;
}

export function parseViewerToHubMessage(value: unknown): ViewerToHubMessage | null {
  if (!isRecord(value) || value.tag !== HUB_MESSAGE_TAG) return null;
  switch (value.kind) {
    case 'doc':
      return typeof value.title === 'string'
        ? { tag: HUB_MESSAGE_TAG, kind: 'doc', title: value.title.slice(0, TITLE_MAX_CHARS) }
        : null;
    case 'key':
      return value.action === 'prev' || value.action === 'next' || value.action === 'close'
        ? { tag: HUB_MESSAGE_TAG, kind: 'key', action: value.action }
        : null;
    case 'open-files':
      return Array.isArray(value.files) && value.files.length > 0 && value.files.every(isFile)
        ? { tag: HUB_MESSAGE_TAG, kind: 'open-files', files: value.files as File[] }
        : null;
    default:
      return null;
  }
}

export function parseHubToViewerMessage(value: unknown): HubToViewerMessage | null {
  if (!isRecord(value) || value.tag !== HUB_MESSAGE_TAG) return null;
  if (value.kind === 'open-file') return isFile(value.file) ? { tag: HUB_MESSAGE_TAG, kind: 'open-file', file: value.file } : null;
  if (value.kind === 'hash') {
    return typeof value.hash === 'string' && /^#[^\s]{1,512}$/u.test(value.hash)
      ? { tag: HUB_MESSAGE_TAG, kind: 'hash', hash: value.hash }
      : null;
  }
  return null;
}

/**
 * Hub tab switching keys. Ctrl+Tab / Ctrl+PgUp / Ctrl+W belong to Chrome, so
 * the hub uses Alt+Shift+←/→ to switch and Alt+W to close (matched on
 * `code`, since macOS Option turns the key itself into a symbol).
 */
export function hubKeyAction(e: { altKey: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; code: string }): HubKeyAction | null {
  if (!e.altKey || e.ctrlKey || e.metaKey) return null;
  if (e.shiftKey && e.code === 'ArrowLeft') return 'prev';
  if (e.shiftKey && e.code === 'ArrowRight') return 'next';
  if (!e.shiftKey && e.code === 'KeyW') return 'close';
  return null;
}

/** Tab-header title for the hub: the active document, prefixed by the count. */
export function hubDocumentTitle(activeTitle: string, count: number, appName: string): string {
  const title = activeTitle.trim() || 'PDF';
  return count > 1 ? `(${count}) ${title} · ${appName}` : `${title} · ${appName}`;
}
