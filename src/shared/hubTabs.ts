// ─── PDF hub tab policy (pure) ───
//
// Decisions the hub page (ui/pdfHub.ts) makes about its tabs, kept free of
// DOM so they are unit-tested: whether an incoming document is one already
// open, which arXiv tabs need a version badge, which frames to unload, and
// the recently-closed stack.

import { pdfCacheAliases } from './pdfCachePolicy';

export interface HubDocKey {
  /** The URL without fragment. */
  url: string;
  /** arXiv paper id (`2401.12345`), when the URL is an arXiv PDF. */
  paper: string | null;
  /** Its explicit version (`v2`), or null for "latest". */
  version: string | null;
}

export function hubDocKey(url: string): HubDocKey {
  let bare = url;
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    bare = parsed.href;
  } catch {
    /* keep as is */
  }
  const arxiv = pdfCacheAliases(url).find((alias) => alias.startsWith('arxiv:'));
  const match = arxiv ? /^arxiv:(.+?)(v\d+)?$/u.exec(arxiv) : null;
  return { url: bare, paper: match ? match[1] : null, version: match?.[2] ?? null };
}

export interface HubTabIdentity {
  url: string | null;
  docId: string | null;
}

/**
 * Index of the open tab showing the document `url` names, or -1:
 *   • the same URL (fragment ignored);
 *   • the same arXiv paper, when the incoming URL asks for no version (it
 *     means "latest", and any open copy of the paper is taken as that) or
 *     for exactly the version a tab shows — `v1` and `v2` stay apart;
 *   • the document the library last opened from this URL (`docIdForUrl`),
 *     which catches mirrors and redirects before anything is downloaded.
 */
export function findOpenDoc(url: string, tabs: readonly HubTabIdentity[], docIdForUrl: (url: string) => string | null = () => null): number {
  const key = hubDocKey(url);
  const keys = tabs.map((t) => (t.url ? hubDocKey(t.url) : null));
  const sameUrl = keys.findIndex((k) => k?.url === key.url);
  if (sameUrl >= 0) return sameUrl;
  if (key.paper) {
    const samePaper = keys
      .map((k, index) => ({ k, index }))
      .filter(({ k }) => k?.paper === key.paper && (key.version === null || k.version === key.version));
    const preferred = samePaper.find(({ k }) => k?.version === key.version) ?? samePaper[0];
    if (preferred) return preferred.index;
  }
  const docId = docIdForUrl(key.url);
  return docId ? tabs.findIndex((t) => t.docId === docId) : -1;
}

/**
 * Version labels for arXiv tabs that share a paper with another tab showing a
 * different version (`v1` / `v2` / `최신`); other tabs get none.
 */
export function arxivVersionBadges(urls: ReadonlyArray<string | null>): Array<string | null> {
  const keys = urls.map((url) => (url ? hubDocKey(url) : null));
  const versions = new Map<string, Set<string>>();
  for (const k of keys) {
    if (!k?.paper) continue;
    const set = versions.get(k.paper) ?? new Set<string>();
    set.add(k.version ?? '');
    versions.set(k.paper, set);
  }
  return keys.map((k) => (k?.paper && (versions.get(k.paper)?.size ?? 0) > 1 ? k.version ?? '최신' : null));
}

// ─── Sleeping frames ───

export const HUB_MAX_LOADED_FRAMES = 6;
export const HUB_IDLE_SLEEP_MS = 30 * 60 * 1000;

export interface HubSleepCandidate {
  key: number;
  loaded: boolean;
  active: boolean;
  lastShownAt: number;
  /** A frame that asked to stay loaded is not asked again before this. */
  busyUntil: number;
}

/**
 * Frames to unload: any not shown for `idleMs`, and beyond that the least
 * recently shown ones while more than `maxLoaded` are loaded. The tab in
 * front never sleeps.
 */
export function pickTabsToSleep(
  tabs: readonly HubSleepCandidate[],
  now: number,
  limits: { maxLoaded: number; idleMs: number } = { maxLoaded: HUB_MAX_LOADED_FRAMES, idleMs: HUB_IDLE_SLEEP_MS },
): number[] {
  const candidates = tabs
    .filter((t) => t.loaded && !t.active && t.busyUntil <= now)
    .sort((a, b) => a.lastShownAt - b.lastShownAt);
  const picked = new Set(candidates.filter((t) => now - t.lastShownAt >= limits.idleMs).map((t) => t.key));
  let loaded = tabs.filter((t) => t.loaded).length - picked.size;
  for (const t of candidates) {
    if (loaded <= limits.maxLoaded) break;
    if (picked.has(t.key)) continue;
    picked.add(t.key);
    loaded -= 1;
  }
  return candidates.filter((t) => picked.has(t.key)).map((t) => t.key);
}

// ─── Recently closed ───

export const HUB_CLOSED_MAX = 20;

export interface HubClosedTab {
  /** Source URL, or null for a local file (reopenable while `fileId` is known). */
  url: string | null;
  fileId: number | null;
  title: string;
  paperTitle: string | null;
  index: number;
  closedAt: number;
}

export function pushClosedTab(stack: readonly HubClosedTab[], entry: HubClosedTab): HubClosedTab[] {
  const rest = stack.filter((e) => !(e.url !== null && e.url === entry.url) && !(e.fileId !== null && e.fileId === entry.fileId));
  return [entry, ...rest].slice(0, HUB_CLOSED_MAX);
}

export function parseClosedTabs(value: unknown): HubClosedTab[] {
  if (!Array.isArray(value)) return [];
  const out: HubClosedTab[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const url = typeof e.url === 'string' && e.url.length <= 2_048 ? e.url : null;
    const fileId = Number.isInteger(e.fileId) ? e.fileId as number : null;
    if ((url === null) === (fileId === null)) continue;
    if (typeof e.title !== 'string' || !Number.isInteger(e.index) || typeof e.closedAt !== 'number') continue;
    out.push({
      url,
      fileId,
      title: e.title.slice(0, 300),
      paperTitle: typeof e.paperTitle === 'string' ? e.paperTitle.slice(0, 300) : null,
      index: Math.max(0, e.index as number),
      closedAt: e.closedAt,
    });
    if (out.length >= HUB_CLOSED_MAX) break;
  }
  return out;
}
