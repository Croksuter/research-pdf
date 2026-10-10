// ─── PDF hub ↔ viewer frame protocol (window.postMessage, same origin) ───
//
// The hub page (ui/pdfHub.ts) hosts one viewer iframe per document. Both are
// extension pages, so every message is checked for our origin and for coming
// from the expected window before it is parsed here.

export const HUB_MESSAGE_TAG = 'rpdf-hub';

/** A hub tab's own drag type (shared/tabTransfer.ts); a viewer seeing it tells its hub. */
export const TAB_DRAG_TYPE = 'application/x-rpdf-tab';

export type HubKeyAction = 'prev' | 'next' | 'close' | 'reopen' | 'split' | 'pane';
const HUB_KEY_ACTIONS: readonly HubKeyAction[] = ['prev', 'next', 'close', 'reopen', 'split', 'pane'];


export type ViewerToHubMessage =
  | { tag: typeof HUB_MESSAGE_TAG; kind: 'doc'; title: string; paperTitle: string | null; docId: string | null }
  | { tag: typeof HUB_MESSAGE_TAG; kind: 'key'; action: HubKeyAction }
  | { tag: typeof HUB_MESSAGE_TAG; kind: 'open-files'; files: File[] }
  // The reader pressed or focused inside this viewer (split view: its pane comes in front).
  | { tag: typeof HUB_MESSAGE_TAG; kind: 'focus' }
  // Another hub's tab is dragged over this viewer: the hub shows where it can go.
  | { tag: typeof HUB_MESSAGE_TAG; kind: 'drag' }
  // Answer to `sleep`: `ok` once drawings and position are stored (false
  // while presenting, printing or asking for a password); `hash` reopens an
  // untouched document where it was.
  | { tag: typeof HUB_MESSAGE_TAG; kind: 'sleep-reply'; id: number; ok: boolean; hash: string };

export type HubToViewerMessage =
  | { tag: typeof HUB_MESSAGE_TAG; kind: 'open-file'; file: File }
  | { tag: typeof HUB_MESSAGE_TAG; kind: 'hash'; hash: string }
  // The hub is about to unload this frame to free memory.
  | { tag: typeof HUB_MESSAGE_TAG; kind: 'sleep'; id: number }
  // This view is in front now: it is the one that remembers the reading position.
  | { tag: typeof HUB_MESSAGE_TAG; kind: 'active' };

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
    case 'focus':
      return { tag: HUB_MESSAGE_TAG, kind: 'focus' };
    case 'drag':
      return { tag: HUB_MESSAGE_TAG, kind: 'drag' };
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
  if (value.kind === 'active') return { tag: HUB_MESSAGE_TAG, kind: 'active' };
  return null;
}

/**
 * Hub tab switching keys. Ctrl+Tab / Ctrl+PgUp / Ctrl+W / Ctrl+Shift+T belong
 * to Chrome, so the hub uses Alt+Shift+←/→ to switch, Alt+W to close and
 * Alt+Shift+T to reopen; Alt+Shift+S splits the view in two (or joins it)
 * and Alt+Shift+O brings the other half in front (matched on `code`, since
 * macOS Option turns the key itself into a symbol).
 */
export function hubKeyAction(e: { altKey: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; code: string; target?: unknown }): HubKeyAction | null {
  if (!e.altKey || e.ctrlKey || e.metaKey) return null;
  // In a text field these are editing keys (macOS Option+Shift+← selects a word).
  if (isEditableTarget(e.target)) return null;
  if (e.shiftKey && e.code === 'ArrowLeft') return 'prev';
  if (e.shiftKey && e.code === 'ArrowRight') return 'next';
  if (!e.shiftKey && e.code === 'KeyW') return 'close';
  if (e.shiftKey && e.code === 'KeyT') return 'reopen';
  if (e.shiftKey && e.code === 'KeyS') return 'split';
  if (e.shiftKey && e.code === 'KeyO') return 'pane';
  return null;
}

// Inputs that take no text: hub keys stay hub keys there.
const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit']);

/** Whether a key event's target takes text: an input, a textarea, a select or an editable element. */
export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const t = target as { tagName?: unknown; type?: unknown; isContentEditable?: unknown };
  if (t.isContentEditable === true) return true;
  const tag = typeof t.tagName === 'string' ? t.tagName.toUpperCase() : '';
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  return !NON_TEXT_INPUTS.has(typeof t.type === 'string' ? t.type.toLowerCase() : 'text');
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
