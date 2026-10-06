// ─── Display preferences (pure) ───
//
// How the hub names its tabs and draws icons. Per device (screens and habits
// differ), kept in chrome.storage.local so every open hub follows a change at
// once; never synced.

export const DISPLAY_PREFS_STORAGE_KEY = 'rpdfDisplay';

/** The tab's main line: the detected paper title, or the PDF's own title / file name. */
export type TabTitlePref = 'paper' | 'document';
/** The tab's second line: venue and year, the other name, or nothing. */
export type TabSubtitlePref = 'venue' | 'other' | 'none';
/** Document-kind icons in tabs and on home: colored, one color, or a plain file icon. */
export type KindIconPref = 'color' | 'mono' | 'off';

export interface DisplayPrefs {
  tabTitle: TabTitlePref;
  tabSubtitle: TabSubtitlePref;
  kindIcons: KindIconPref;
  /** The hub tab's icon in Chrome is its project's icon. */
  projectFavicon: boolean;
}

export const DEFAULT_DISPLAY_PREFS: DisplayPrefs = { tabTitle: 'paper', tabSubtitle: 'venue', kindIcons: 'color', projectFavicon: true };

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly unknown[]).includes(value) ? value as T : fallback;

export function parseDisplayPrefs(value: unknown): DisplayPrefs {
  const raw = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  return {
    tabTitle: pick(raw.tabTitle, ['paper', 'document'] as const, DEFAULT_DISPLAY_PREFS.tabTitle),
    tabSubtitle: pick(raw.tabSubtitle, ['venue', 'other', 'none'] as const, DEFAULT_DISPLAY_PREFS.tabSubtitle),
    kindIcons: pick(raw.kindIcons, ['color', 'mono', 'off'] as const, DEFAULT_DISPLAY_PREFS.kindIcons),
    projectFavicon: typeof raw.projectFavicon === 'boolean' ? raw.projectFavicon : DEFAULT_DISPLAY_PREFS.projectFavicon,
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * A tab's two lines. `docName` is the PDF's own title or its file name;
 * `paperTitle` the detected paper, if any. The second line never repeats the
 * first.
 */
export function tabLabels(
  input: { docName: string; paperTitle: string | null; venue: string | null; year: number | null },
  prefs: Pick<DisplayPrefs, 'tabTitle' | 'tabSubtitle'>,
): { title: string; subtitle: string | null } {
  const paper = input.paperTitle?.trim() || null;
  const title = prefs.tabTitle === 'paper' && paper ? paper : input.docName;
  const other = title === input.docName ? paper : input.docName;
  let subtitle: string | null = null;
  if (prefs.tabSubtitle === 'venue') subtitle = [input.venue, input.year].filter(Boolean).join(' ') || null;
  else if (prefs.tabSubtitle === 'other') subtitle = other;
  if (subtitle && norm(subtitle) === norm(title)) subtitle = null;
  return { title, subtitle };
}
