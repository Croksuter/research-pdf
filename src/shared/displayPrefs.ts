// ─── Display preferences (pure) ───
//
// How the hub names its tabs and draws icons, and where moving a document
// leaves you. Kept in chrome.storage.local so every open hub follows a change
// at once, and synced with the other settings (shared/syncedSettings.ts).

export const DISPLAY_PREFS_STORAGE_KEY = 'rpdfDisplay';

/** The tab's main line: the detected paper title, or the PDF's own title / file name. */
export type TabTitlePref = 'paper' | 'document';
/** The tab's second line: venue and year, the other name, or nothing. */
export type TabSubtitlePref = 'venue' | 'other' | 'none';
/** Document-kind icons in tabs and on home: colored, one color, or a plain file icon. */
export type KindIconPref = 'color' | 'mono' | 'off';
/** After moving documents to another project: stay in this one, or go along to that one. */
export type AfterMovePref = 'stay' | 'follow';

export interface DisplayPrefs {
  tabTitle: TabTitlePref;
  tabSubtitle: TabSubtitlePref;
  kindIcons: KindIconPref;
  /** The hub tab's icon in Chrome is its project's icon. */
  projectFavicon: boolean;
  afterMove: AfterMovePref;
}

export const DEFAULT_DISPLAY_PREFS: DisplayPrefs = { tabTitle: 'paper', tabSubtitle: 'venue', kindIcons: 'color', projectFavicon: true, afterMove: 'stay' };

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly unknown[]).includes(value) ? value as T : fallback;

export function parseDisplayPrefs(value: unknown): DisplayPrefs {
  const raw = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  return {
    tabTitle: pick(raw.tabTitle, ['paper', 'document'] as const, DEFAULT_DISPLAY_PREFS.tabTitle),
    tabSubtitle: pick(raw.tabSubtitle, ['venue', 'other', 'none'] as const, DEFAULT_DISPLAY_PREFS.tabSubtitle),
    kindIcons: pick(raw.kindIcons, ['color', 'mono', 'off'] as const, DEFAULT_DISPLAY_PREFS.kindIcons),
    projectFavicon: typeof raw.projectFavicon === 'boolean' ? raw.projectFavicon : DEFAULT_DISPLAY_PREFS.projectFavicon,
    afterMove: pick(raw.afterMove, ['stay', 'follow'] as const, DEFAULT_DISPLAY_PREFS.afterMove),
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * A tab's two lines. `docName` is the PDF's own title or its file name;
 * `paperTitle` the detected paper, if any; `userTitle` the name the user gave
 * it, which is always the first line (the second: the paper, else the file).
 * The second line never repeats the first.
 */
export function tabLabels(
  input: { docName: string; paperTitle: string | null; venue: string | null; year: number | null; userTitle?: string | null },
  prefs: Pick<DisplayPrefs, 'tabTitle' | 'tabSubtitle'>,
): { title: string; subtitle: string | null } {
  const paper = input.paperTitle?.trim() || null;
  const named = input.userTitle?.trim() || null;
  const title = named ?? (prefs.tabTitle === 'paper' && paper ? paper : input.docName);
  const other = named ? paper ?? input.docName : title === input.docName ? paper : input.docName;
  let subtitle: string | null = null;
  if (prefs.tabSubtitle === 'venue') subtitle = [input.venue, input.year].filter(Boolean).join(' ') || null;
  else if (prefs.tabSubtitle === 'other') subtitle = other;
  if (subtitle && norm(subtitle) === norm(title)) subtitle = null;
  return { title, subtitle };
}
