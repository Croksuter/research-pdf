// ─── PDF hub ↔ viewer frame protocol (window.postMessage, same origin) ───
//
// The hub page (ui/pdfHub.ts) hosts one viewer iframe per document. Both are
// extension pages, so every message is checked for our origin and for coming
// from the expected window before it is parsed here.

export const HUB_MESSAGE_TAG = 'rpdf-hub';

export type HubKeyAction = 'prev' | 'next' | 'close' | 'reopen';
const HUB_KEY_ACTIONS: readonly HubKeyAction[] = ['prev', 'next', 'close', 'reopen'];

export type ViewerToHubMessage =
  | { tag: typeof HUB_MESSAGE_TAG; kind: 'doc'; title: string; paperTitle: string | null; docId: string | null }
  | { tag: typeof HUB_MESSAGE_TAG; kind: 'key'; action: HubKeyAction }
  | { tag: typeof HUB_MESSAGE_TAG; kind: 'open-files'; files: File[] }
  // Answer to `sleep`: `ok` once drawings and position are stored (false
  // while presenting, printing or asking for a password); `hash` reopens an
  // untouched document where it was.
  | { tag: typeof HUB_MESSAGE_TAG; kind: 'sleep-reply'; id: number; ok: boolean; hash: string };

export type HubToViewerMessage =
  | { tag: typeof HUB_MESSAGE_TAG; kind: 'open-file'; file: File }
  | { tag: typeof HUB_MESSAGE_TAG; kind: 'hash'; hash: string }
  // The hub is about to unload this frame to free memory.
  | { tag: typeof HUB_MESSAGE_TAG; kind: 'sleep'; id: number };

const HASH_PATTERN = /^#[^\s]{1,512}$/u;
const DOC_ID_MAX_CHARS = 128;

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
    case 'doc': {
      if (typeof value.title !== 'string') return null;
      if (value.paperTitle !== null && typeof value.paperTitle !== 'string') return null;
      const paperTitle = typeof value.paperTitle === 'string' && value.paperTitle.trim()
        ? value.paperTitle.trim().slice(0, TITLE_MAX_CHARS)
        : null;
      const docId = typeof value.docId === 'string' && value.docId && value.docId.length <= DOC_ID_MAX_CHARS ? value.docId : null;
      return { tag: HUB_MESSAGE_TAG, kind: 'doc', title: value.title.slice(0, TITLE_MAX_CHARS), paperTitle, docId };
    }
    case 'key':
      return HUB_KEY_ACTIONS.includes(value.action as HubKeyAction)
        ? { tag: HUB_MESSAGE_TAG, kind: 'key', action: value.action as HubKeyAction }
        : null;
    case 'sleep-reply':
      if (!Number.isInteger(value.id) || typeof value.ok !== 'boolean' || typeof value.hash !== 'string') return null;
      return { tag: HUB_MESSAGE_TAG, kind: 'sleep-reply', id: value.id as number, ok: value.ok, hash: HASH_PATTERN.test(value.hash) ? value.hash : '' };
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
    return typeof value.hash === 'string' && HASH_PATTERN.test(value.hash)
      ? { tag: HUB_MESSAGE_TAG, kind: 'hash', hash: value.hash }
      : null;
  }
  if (value.kind === 'sleep') return Number.isInteger(value.id) ? { tag: HUB_MESSAGE_TAG, kind: 'sleep', id: value.id as number } : null;
  return null;
}

/**
 * Hub tab switching keys. Ctrl+Tab / Ctrl+PgUp / Ctrl+W / Ctrl+Shift+T belong
 * to Chrome, so the hub uses Alt+Shift+←/→ to switch, Alt+W to close and
 * Alt+Shift+T to reopen (matched on `code`, since macOS Option turns the key
 * itself into a symbol).
 */
export function hubKeyAction(e: { altKey: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; code: string }): HubKeyAction | null {
  if (!e.altKey || e.ctrlKey || e.metaKey) return null;
  if (e.shiftKey && e.code === 'ArrowLeft') return 'prev';
  if (e.shiftKey && e.code === 'ArrowRight') return 'next';
  if (!e.shiftKey && e.code === 'KeyW') return 'close';
  if (e.shiftKey && e.code === 'KeyT') return 'reopen';
  return null;
}

/** Same title up to case, spacing and punctuation (a PDF's metadata often repeats the paper title). */
export function sameTitle(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return norm(a) === norm(b);
}

/** Tab-header title for the hub: the active document, prefixed by the count. */
export function hubDocumentTitle(activeTitle: string, count: number, appName: string): string {
  const title = activeTitle.trim() || 'PDF';
  return count > 1 ? `(${count}) ${title} · ${appName}` : `${title} · ${appName}`;
}
