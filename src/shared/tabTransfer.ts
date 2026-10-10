// ─── Moving a document's tab between hubs (pure) ───
//
// A hub's tab can be dragged out of its strip onto another hub page (another
// window, the other half of Arc's split view), sent to another window from
// its menu, or — a beta — dropped on another window's empty space. Every way
// ends the same: the receiving hub decides what happens (asking when the
// device's settings say so), takes the document from the hub it came from
// (which stores where the reader is first, and lets the tab go on a move),
// and opens it.
//
//   • same project (or a project the document is already in): move the tab
//     here, or keep it in both hubs;
//   • another project: move the document to this project, or add it here too;
//   • the default project: take it out of its projects, or just open it here
//     as a guest.
//
// The drag carries only our own type, never the address as text: dropped on
// Chrome's own tab strip, a PDF address would navigate that tab — a hub's
// tab losing its documents.

import { DEFAULT_PROJECT_ID, isPdfProjectId } from './pdfProjects';
import { TAB_DRAG_TYPE } from './pdfHubProtocol';

export { TAB_DRAG_TYPE };
// While dragging, other pages see only the types, not the data: the source
// hub and its project ride in a type of their own (types are lower-case).
const SOURCE_TYPE_PREFIX = 'application/x-rpdf-src-';

/** What a dragged (or sent) tab carries. */
export interface TabPayload {
  /** The hub tab the document is in. */
  from: number;
  /** The tab's key in that hub. */
  key: number;
  project: string;
  url: string | null;
  docId: string | null;
  title: string;
  paperTitle: string | null;
  pinned: boolean;
}

export function sourceType(hubTabId: number, project: string): string {
  return `${SOURCE_TYPE_PREFIX}${hubTabId}-${project}`;
}

/** The hub and project a drag came from, read from its types (during dragover). */
export function sourceOfTypes(types: readonly string[]): { from: number; project: string } | null {
  for (const type of types) {
    if (!type.startsWith(SOURCE_TYPE_PREFIX)) continue;
    const match = /^(\d+)-(.+)$/u.exec(type.slice(SOURCE_TYPE_PREFIX.length));
    if (match && isPdfProjectId(match[2])) return { from: Number(match[1]), project: match[2] };
  }
  return null;
}

const TEXT_MAX = 300;

export function parseTabPayload(value: unknown): TabPayload | null {
  let raw = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (!Number.isInteger(p.from) || !Number.isInteger(p.key) || !isPdfProjectId(p.project)) return null;
  if (p.url !== null && (typeof p.url !== 'string' || !/^(?:https?|file):/iu.test(p.url) || p.url.length > 4_096)) return null;
  if (p.docId !== null && (typeof p.docId !== 'string' || p.docId.length > 128)) return null;
  if (typeof p.title !== 'string' || typeof p.pinned !== 'boolean') return null;
  return {
    from: p.from as number,
    key: p.key as number,
    project: p.project,
    url: p.url as string | null,
    docId: p.docId as string | null,
    title: p.title.slice(0, TEXT_MAX),
    paperTitle: typeof p.paperTitle === 'string' ? p.paperTitle.slice(0, TEXT_MAX) : null,
    pinned: p.pinned,
  };
}

// ─── What a drop means ───

export type DropCase = 'same' | 'other' | 'default';
/** `move`: the tab leaves where it was; `keep`: it stays there too. */
export type DropAction = 'move' | 'keep';

/**
 * The case of a document from `source` arriving in a hub of `target`:
 * `inTarget` — already registered there (then only its tab moves, as within
 * one project).
 */
export function dropCase(source: string, target: string, inTarget: boolean): DropCase {
  if (source === target || inTarget) return 'same';
  return target === DEFAULT_PROJECT_ID ? 'default' : 'other';
}

// ─── Settings (per device) ───

export const DRAG_PREFS_STORAGE_KEY = 'rpdfDragPrefs';

export type DropChoice = 'ask' | DropAction;

export interface DragPrefs {
  same: DropChoice;
  other: DropChoice;
  default: DropChoice;
  /** Beta: a tab dropped on another window's empty space goes into that window. */
  windowDrop: boolean;
}

export const DEFAULT_DRAG_PREFS: DragPrefs = { same: 'ask', other: 'ask', default: 'ask', windowDrop: false };

const choice = (value: unknown): DropChoice => (value === 'move' || value === 'keep' ? value : 'ask');

export function parseDragPrefs(value: unknown): DragPrefs {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return { same: choice(raw.same), other: choice(raw.other), default: choice(raw.default), windowDrop: raw.windowDrop === true };
}

// ─── Which window is under a point (an empty-space drop) ───

export interface WindowBox {
  id: number;
  left: number;
  top: number;
  width: number;
  height: number;
  minimized: boolean;
}

/**
 * The window at screen point (`x`, `y`): of those containing it (minimized
 * ones and `exclude` left out), the one focused most recently — Chrome gives
 * no stacking order, and the last focused is the likeliest on top.
 * `focusOrder`: window ids, most recently focused first.
 */
export function windowAtPoint(windows: readonly WindowBox[], point: { x: number; y: number }, focusOrder: readonly number[], exclude: number | null): number | null {
  const under = windows.filter((w) => !w.minimized && w.id !== exclude
    && point.x >= w.left && point.x < w.left + w.width && point.y >= w.top && point.y < w.top + w.height);
  if (under.length === 0) return null;
  const rank = (id: number) => {
    const at = focusOrder.indexOf(id);
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  return [...under].sort((a, b) => rank(a.id) - rank(b.id))[0].id;
}
