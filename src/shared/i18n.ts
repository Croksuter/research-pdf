// ─── Languages: Korean and English ───
//
// Every module that shows text keeps its own strings in a sibling
// `*.strings.ts`, written as `messages({ ko: {...}, en: {...} })`: both
// languages, the same keys (TypeScript holds them to it). A string is either
// text or a function of its values (`(n: number) => \`${n}개\``). Reading a
// key picks the current language at that moment.
//
// The language is the user's choice on the settings page ("auto" follows the
// browser). Pages read it synchronously from localStorage, which every page of
// the extension shares; the service worker, which has none, reads the copy in
// chrome.storage.local. Static HTML is translated by `localizeDocument`:
// `data-i18n` (text), `data-i18n-title`, `data-i18n-placeholder`,
// `data-i18n-aria-label`, each naming a key.

export type Language = 'ko' | 'en';
export type LanguagePref = 'auto' | Language;
export const LANGUAGE_STORAGE_KEY = 'rpdfLanguage';

type Message = string | ((...args: never[]) => string);
type Table = Record<string, Message>;

function browserLanguage(): Language {
  let tag = '';
  try { tag = chrome.i18n.getUILanguage(); } catch { /* not in an extension */ }
  if (!tag && typeof navigator !== 'undefined') tag = navigator.language ?? '';
  return /^ko\b/iu.test(tag) ? 'ko' : 'en';
}

export function parseLanguagePref(value: unknown): LanguagePref {
  return value === 'ko' || value === 'en' ? value : 'auto';
}

function storedPref(): LanguagePref {
  try { return parseLanguagePref(globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY)); } catch { return 'auto'; }
}

let current: Language = (() => { const pref = storedPref(); return pref === 'auto' ? browserLanguage() : pref; })();

export function currentLanguage(): Language {
  return current;
}

/** Sets the language for this page (tests, and the service worker after reading storage). */
export function setLanguage(language: Language): void {
  current = language;
  if (typeof document !== 'undefined') document.documentElement.lang = language;
}

export function resolveLanguage(pref: LanguagePref): Language {
  return pref === 'auto' ? browserLanguage() : pref;
}

/** Saves the choice where pages and the service worker find it. */
export async function saveLanguagePref(pref: LanguagePref): Promise<void> {
  try { globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, pref); } catch { /* storage blocked */ }
  try { await chrome.storage.local.set({ [LANGUAGE_STORAGE_KEY]: pref }); } catch { /* not in an extension */ }
}

/** The service worker: follow the stored choice (and its changes). */
export function followStoredLanguage(): void {
  try {
    void chrome.storage.local.get(LANGUAGE_STORAGE_KEY).then((r) => setLanguage(resolveLanguage(parseLanguagePref(r[LANGUAGE_STORAGE_KEY]))));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[LANGUAGE_STORAGE_KEY]) setLanguage(resolveLanguage(parseLanguagePref(changes[LANGUAGE_STORAGE_KEY].newValue)));
    });
  } catch { /* not in an extension */ }
}

/** A module's strings in both languages; reads pick the current one. */
export function messages<T extends Table>(table: { ko: T; en: { [K in keyof T]: T[K] } }): T {
  return new Proxy({} as T, {
    get: (_target, key) => (table[current] as Record<string | symbol, Message>)[key] ?? (table.ko as Record<string | symbol, Message>)[key],
  });
}

/** Fills `data-i18n*` attributes under `root` from `strings`. */
export function localizeDocument(strings: Record<string, Message>, root: ParentNode = document): void {
  const text = (key: string | undefined) => {
    if (!key) return null;
    const value = strings[key];
    return typeof value === 'string' ? value : null;
  };
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-i18n]'))) {
    const value = text(el.dataset.i18n);
    if (value !== null) el.textContent = value;
  }
  for (const [attr, name] of [['i18nTitle', 'title'], ['i18nPlaceholder', 'placeholder'], ['i18nAriaLabel', 'aria-label']] as const) {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(`[data-${name === 'aria-label' ? 'i18n-aria-label' : `i18n-${name}`}]`))) {
      const value = text(el.dataset[attr]);
      if (value !== null) el.setAttribute(name, value);
    }
  }
  if (typeof document !== 'undefined') document.documentElement.lang = current;
}
