// ─── Where an opened PDF goes: the hub of this window, or of the browser (pure) ───
//
// A project's hub is one tab. People who keep one browser window and switch
// spaces in it (Arc and the like) want every PDF in that one tab wherever it
// is; people who work in several Chrome windows want a PDF to stay in the
// window it was opened in, not to pull another window to the front.
//
//   • 'window' — a PDF goes to its project's hub in the window it opened in,
//     or a new hub there; each window can hold a hub of the same project.
//   • 'browser' — a PDF goes to its project's hub wherever it is (that
//     window comes forward); one hub per project.
//
// With a single window the two are the same. Per device (habits differ),
// kept in chrome.storage.local; never synced.

export const HUB_SCOPE_STORAGE_KEY = 'rpdfHubScope';

export type HubScope = 'window' | 'browser';

export const DEFAULT_HUB_SCOPE: HubScope = 'window';

export function parseHubScope(value: unknown): HubScope {
  return value === 'window' || value === 'browser' ? value : DEFAULT_HUB_SCOPE;
}

/** A registered hub tab where it is now (`active`: the tab in front of its window). */
export interface HubCandidate {
  tabId: number;
  windowId: number;
  active: boolean;
}

/**
 * The hub a PDF opened in window `windowId` goes to, of a project's live
 * hubs in the order they were registered (the oldest first): one in that
 * window — the one in front there, else the oldest — and, with scope
 * 'browser', otherwise the oldest anywhere. Null: a new hub is made.
 */
export function pickHub<T extends HubCandidate>(candidates: readonly T[], windowId: number | null, scope: HubScope): T | null {
  const here = windowId === null ? [] : candidates.filter((c) => c.windowId === windowId);
  const inWindow = here.find((c) => c.active) ?? here[0];
  if (inWindow) return inWindow;
  return scope === 'browser' ? candidates[0] ?? null : null;
}
