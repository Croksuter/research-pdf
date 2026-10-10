// ─── Keyboard shortcuts: the one table ───
//
// The settings page lists all of them, the welcome page's tour the ones
// marked `tour`, and README.md carries the same table (test/shortcuts.test.ts
// holds it to this one). Keys are written for Windows/Linux; on a Mac every
// modifier here is the one the viewer and hub accept there: Alt is ⌥, Shift
// ⇧, and Ctrl ⌘ (the viewer takes Ctrl or ⌘ for each Ctrl shortcut).

import { S } from './shortcuts.strings';

export type ShortcutGroup = 'tabs' | 'view' | 'annotate';

export interface Shortcut {
  group: ShortcutGroup;
  /** Alternatives, each a list of keys pressed together. */
  combos: string[][];
  /** Key of its description in shortcuts.strings.ts. */
  label: keyof typeof S;
  /** Shown in the welcome page's tour too. */
  tour?: boolean;
}

export const SHORTCUT_GROUPS: ReadonlyArray<{ group: ShortcutGroup; label: keyof typeof S }> = [
  { group: 'tabs', label: 'groupTabs' },
  { group: 'view', label: 'groupView' },
  { group: 'annotate', label: 'groupAnnotate' },
];

export const SHORTCUTS: readonly Shortcut[] = [
  { group: 'tabs', combos: [['Alt', 'Shift', '←'], ['Alt', 'Shift', '→']], label: 'prevNextTab', tour: true },
  { group: 'tabs', combos: [['Alt', 'W']], label: 'closeTab', tour: true },
  { group: 'tabs', combos: [['Alt', 'Shift', 'T']], label: 'reopenTab', tour: true },
  { group: 'tabs', combos: [['Alt', 'Shift', 'S']], label: 'splitView' },
  { group: 'tabs', combos: [['Alt', 'Shift', 'O']], label: 'otherHalf' },
  { group: 'tabs', combos: [['Alt', '↑'], ['Alt', '↓']], label: 'moveInProject' },
  { group: 'view', combos: [['Ctrl', 'F']], label: 'find' },
  { group: 'view', combos: [['Ctrl', 'G'], ['Ctrl', 'Shift', 'G']], label: 'findNext' },
  { group: 'view', combos: [['Ctrl', '+'], ['Ctrl', '-']], label: 'zoom' },
  { group: 'view', combos: [['Ctrl', '0']], label: 'fit' },
  { group: 'view', combos: [['Ctrl', '['], ['Ctrl', ']']], label: 'rotate' },
  { group: 'view', combos: [['Home'], ['End']], label: 'firstLast' },
  { group: 'view', combos: [['Ctrl', 'P']], label: 'print' },
  { group: 'view', combos: [['Ctrl', 'S']], label: 'download' },
  { group: 'annotate', combos: [['Ctrl', 'Z'], ['Ctrl', 'Y']], label: 'undoRedo' },
  { group: 'annotate', combos: [['S'], ['Ctrl', 'Shift', 'X']], label: 'capture', tour: true },
  { group: 'annotate', combos: [['L']], label: 'latex' },
  { group: 'annotate', combos: [['Esc']], label: 'escape' },
];

const MAC_KEYS: Record<string, string> = { Alt: '⌥', Shift: '⇧', Ctrl: '⌘' };

/** One key as written on this platform. */
export function keyLabel(key: string, mac: boolean): string {
  return mac ? MAC_KEYS[key] ?? key : key;
}

/** A shortcut's keys as text: "Alt+Shift+← / Alt+Shift+→", or "⌥⇧← / ⌥⇧→" on a Mac. */
export function comboText(shortcut: Pick<Shortcut, 'combos'>, mac: boolean): string {
  return shortcut.combos.map((keys) => keys.map((k) => keyLabel(k, mac)).join(mac ? '' : '+')).join(' / ');
}

/** The description in the current language. */
export function shortcutLabel(key: keyof typeof S): string {
  return S[key];
}
