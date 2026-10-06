import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LANGUAGE_STORAGE_KEY, currentLanguage, followStoredLanguage, languageReady, localizeDocument, messages, parseLanguagePref, setLanguage,
} from '../src/shared/i18n';
import { S as shared } from '../src/shared/shared.strings';
import { S as settings } from '../src/ui/settings.strings';
import { S as welcome } from '../src/ui/welcome.strings';

// test/setup.ts starts every file in Korean; these switch to English.
afterEach(() => {
  setLanguage('ko');
  vi.unstubAllGlobals();
});

describe('English counts', () => {
  it('says "1 day ago", not "1 days ago"', () => {
    setLanguage('en');
    expect(shared.daysAgo(1)).toBe('1 day ago');
    expect(shared.daysAgo(3)).toBe('3 days ago');
    setLanguage('ko');
    expect(shared.daysAgo(1)).toBe('1일 전');
  });

  it('agrees with the count on the settings and welcome pages', () => {
    setLanguage('en');
    expect(settings.gatherDone(1)).toBe('Gathered 1 PDF.');
    expect(settings.gatherDone(2)).toBe('Gathered 2 PDFs.');
    expect(settings.restoredTabs(1)).toBe('Reopened 1 PDF tab.');
    expect(settings.nothingToRestore(2)).toBe('No tabs to restore (2 PDF tabs are open).');
    expect(settings.savedPdfsUsage(1, '1MB', '1024MB')).toBe('1 saved PDF · 1MB / 1024MB');
    expect(settings.gatherKept(1)).toMatch(/^One original tab was left open.*Close it yourself once you see it there\.$/u);
    expect(settings.gatherKept(3)).toMatch(/^3 original tabs were left open.*Close them yourself/u);
    expect(settings.confirmClearCache(1, '2.0MB')).toMatch(/^Delete 1 saved PDF \(2\.0MB\)/u);
    expect(welcome.gatherButton(1)).toBe('Gather 1 PDF');
    expect(welcome.gatherButton(4)).toBe('Gather 4 PDFs');
    expect(welcome.gatherKept(1)).toMatch(/^One hadn’t opened.*its original tab was left open/u);
    expect(welcome.gatherKept(2)).toMatch(/^2 hadn’t opened.*their original tabs were left open/u);
  });
});

describe('messages', () => {
  it('reads the current language at the moment of reading', () => {
    const T = messages({ ko: { hi: '안녕', n: (k: number) => `${k}개` }, en: { hi: 'Hi', n: (k: number) => `${k} items` } });
    expect(T.hi).toBe('안녕');
    setLanguage('en');
    expect(T.hi).toBe('Hi');
    expect(T.n(2)).toBe('2 items');
  });

  it('falls back to Korean for a key English lacks', () => {
    const T = messages({ ko: { only: '한국어만' }, en: {} as { only: string } });
    setLanguage('en');
    expect(T.only).toBe('한국어만');
  });

  it('keeps an unknown stored choice as automatic', () => {
    expect(parseLanguagePref('en')).toBe('en');
    expect(parseLanguagePref('fr')).toBe('auto');
    expect(parseLanguagePref(null)).toBe('auto');
  });
});

describe('localizeDocument', () => {
  // Just enough of a DOM: elements with data-* and attributes, found by attribute.
  class El {
    textContent = '';
    attrs: Record<string, string> = {};
    constructor(public dataset: Record<string, string>) {}
    setAttribute(name: string, value: string) { this.attrs[name] = value; }
  }
  const camel = (name: string) => name.replace(/-([a-z])/gu, (_m, c: string) => c.toUpperCase());
  function root(elements: El[]): ParentNode {
    return {
      querySelectorAll: (selector: string) => {
        const attr = /^\[data-([a-z0-9-]+)\]$/u.exec(selector)?.[1] ?? '';
        return elements.filter((el) => camel(attr) in el.dataset);
      },
    } as unknown as ParentNode;
  }

  it('fills text, title, placeholder and aria-label from the keys named', () => {
    setLanguage('en');
    const T = messages({
      ko: { save: '저장', find: '찾기', hint: '키 붙여넣기', fn: (n: number) => `${n}` },
      en: { save: 'Save', find: 'Find', hint: 'Paste key', fn: (n: number) => `${n}` },
    });
    const text = new El({ i18n: 'save' });
    const titled = new El({ i18nTitle: 'find' });
    const input = new El({ i18nPlaceholder: 'hint', i18nAriaLabel: 'find' });
    const missing = new El({ i18n: 'nope' });
    missing.textContent = 'kept';
    const fn = new El({ i18n: 'fn' });
    fn.textContent = 'static';
    localizeDocument(T, root([text, titled, input, missing, fn]));
    expect(text.textContent).toBe('Save');
    expect(titled.attrs.title).toBe('Find');
    expect(input.attrs.placeholder).toBe('Paste key');
    expect(input.attrs['aria-label']).toBe('Find');
    // A missing key, or one that needs values, leaves the page's own text.
    expect(missing.textContent).toBe('kept');
    expect(fn.textContent).toBe('static');
  });
});

describe('followStoredLanguage (the service worker)', () => {
  it('takes the stored choice before languageReady resolves, then follows changes', async () => {
    let onChanged: ((changes: Record<string, { newValue?: unknown }>, area: string) => void) | null = null;
    vi.stubGlobal('chrome', {
      storage: {
        local: { get: async (key: string) => ({ [key]: 'en' }) },
        onChanged: { addListener: (listener: typeof onChanged) => { onChanged = listener; } },
      },
    });
    setLanguage('ko');
    const ready = followStoredLanguage();
    expect(languageReady()).toBe(ready);
    await languageReady();
    expect(currentLanguage()).toBe('en');
    onChanged!({ [LANGUAGE_STORAGE_KEY]: { newValue: 'ko' } }, 'local');
    expect(currentLanguage()).toBe('ko');
    onChanged!({ [LANGUAGE_STORAGE_KEY]: { newValue: 'en' } }, 'sync');
    expect(currentLanguage()).toBe('ko');
  });

  it('resolves even when storage cannot be read', async () => {
    vi.stubGlobal('chrome', {
      storage: {
        local: { get: async () => { throw new Error('gone'); } },
        onChanged: { addListener: () => undefined },
      },
    });
    setLanguage('ko');
    await expect(followStoredLanguage()).resolves.toBeUndefined();
    expect(currentLanguage()).toBe('ko');
  });
});
