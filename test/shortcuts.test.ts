import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SHORTCUTS, SHORTCUT_GROUPS, comboText, keyLabel, shortcutLabel } from '../src/shared/shortcuts';
import { setLanguage } from '../src/shared/i18n';

afterEach(() => setLanguage('ko'));

describe('shortcut table', () => {
  it('writes keys per platform: Alt ⌥, Shift ⇧, Ctrl ⌘ on a Mac', () => {
    expect(keyLabel('Alt', true)).toBe('⌥');
    expect(keyLabel('Shift', true)).toBe('⇧');
    expect(keyLabel('Ctrl', true)).toBe('⌘');
    expect(keyLabel('Ctrl', false)).toBe('Ctrl');
    expect(keyLabel('S', true)).toBe('S');
  });

  it('joins alternatives with " / " and keys with + (none on a Mac)', () => {
    const tabs = SHORTCUTS.find((s) => s.label === 'prevNextTab');
    expect(tabs && comboText(tabs, false)).toBe('Alt+Shift+← / Alt+Shift+→');
    expect(tabs && comboText(tabs, true)).toBe('⌥⇧← / ⌥⇧→');
    const zoom = SHORTCUTS.find((s) => s.label === 'zoom');
    expect(zoom && comboText(zoom, false)).toBe('Ctrl++ / Ctrl+-');
    expect(zoom && comboText(zoom, true)).toBe('⌘+ / ⌘-');
  });

  it('puts every shortcut in a listed group and gives the tour a few', () => {
    const groups = new Set(SHORTCUT_GROUPS.map((g) => g.group));
    for (const shortcut of SHORTCUTS) expect(groups.has(shortcut.group)).toBe(true);
    expect(SHORTCUTS.filter((s) => s.tour).map((s) => s.label)).toEqual(['prevNextTab', 'closeTab', 'reopenTab', 'capture']);
  });

  it('has a description in both languages', () => {
    for (const language of ['ko', 'en'] as const) {
      setLanguage(language);
      for (const shortcut of SHORTCUTS) expect(shortcutLabel(shortcut.label)).toMatch(/\S/u);
    }
  });

  it('matches the table in README.md', () => {
    const readme = readFileSync(resolve(__dirname, '../README.md'), 'utf8');
    setLanguage('en');
    for (const shortcut of SHORTCUTS) {
      expect(readme).toContain(`| ${comboText(shortcut, false)} | ${shortcutLabel(shortcut.label)} |`);
    }
    const rows = readme.split('\n').filter((line) => /^\| [^-|]/u.test(line) && !line.startsWith('| Keys |'));
    expect(rows).toHaveLength(SHORTCUTS.length);
  });
});
