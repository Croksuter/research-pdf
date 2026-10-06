// ─── Welcome page: the first run, step by step ───
//
// Opened once when the extension is installed (background/onboarding.ts).
// Hello → open PDFs here (web access, file access) → gather the PDFs already
// open → Google Drive (optional) → a tour, with a demo paper about the
// extension itself to try everything on → done. Every step can be skipped;
// everything here can be changed later on the settings page.

import { DEFAULT_LOCAL_PDF_VIEWER_ENABLED, LOCAL_PDF_VIEWER_ENABLED_SETTING_KEY, WEB_PDF_VIEWER_ENABLED_SETTING_KEY } from '../shared/constants';
import { getSetting, setSetting } from '../db/settingsRepository';
import { PDF_HUB_PAGE, WEB_PDF_HOST_ORIGINS, buildPdfHubEntryUrl, buildPdfHubUrl } from '../shared/localPdf';
import { closeTabs, findOpenPdfTabs, tabPlace, zoomHash, type OpenPdfTab } from './openPdfTabs';
import { currentLanguage, localizeDocument, saveLanguagePref } from '../shared/i18n';
import { S } from './welcome.strings';

const DEMO_BASE = 'https://research-pdf.croksuter.com/demo';
const STEPS = ['hello', 'open', 'gather', 'sync', 'tour', 'done'] as const;
type Step = typeof STEPS[number];

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as T;
};

function send<T>(message: Record<string, unknown>): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(response as T);
      });
    } catch {
      resolve(null);
    }
  });
}

localizeDocument(S);
document.title = S.pageTitle;
const hubBase = chrome.runtime.getURL(PDF_HUB_PAGE);

// ─── Language ───

const languageSelect = byId<HTMLSelectElement>('wl-language');
languageSelect.value = currentLanguage();
languageSelect.addEventListener('change', () => {
  void saveLanguagePref(languageSelect.value === 'en' ? 'en' : 'ko').then(() => {
    location.hash = current;
    location.reload();
  });
});

// ─── Steps ───

const sections = new Map<Step, HTMLElement>(STEPS.map((step) => [step, document.querySelector<HTMLElement>(`[data-step="${step}"]`) as HTMLElement]));
const dots = byId<HTMLOListElement>('wl-dots');
const stepCount = byId<HTMLSpanElement>('wl-step-count');
const skip = byId<HTMLButtonElement>('wl-skip');
let current: Step = STEPS.includes(location.hash.slice(1) as Step) ? location.hash.slice(1) as Step : 'hello';

dots.replaceChildren(...STEPS.map(() => document.createElement('li')));

function show(step: Step): void {
  current = step;
  const index = STEPS.indexOf(step);
  for (const [name, section] of sections) section.hidden = name !== step;
  Array.from(dots.children).forEach((dot, i) => {
    dot.classList.toggle('is-done', i < index);
    dot.classList.toggle('is-on', i === index);
  });
  stepCount.textContent = S.stepOf(index + 1, STEPS.length);
  skip.hidden = step === 'done';
  history.replaceState(null, '', `#${step}`);
  if (step === 'open') void renderOpen();
  if (step === 'gather') void renderGather();
  if (step === 'sync') void renderSync();
  sections.get(step)?.querySelector<HTMLButtonElement>('.wl-primary')?.focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
}

for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-go]'))) {
  button.addEventListener('click', () => {
    const index = STEPS.indexOf(current) + (button.dataset.go === 'back' ? -1 : 1);
    show(STEPS[Math.max(0, Math.min(STEPS.length - 1, index))]);
  });
}
skip.addEventListener('click', () => show('done'));

// ─── Opening PDFs ───

const webButton = byId<HTMLButtonElement>('wl-web');
const webNote = byId<HTMLSpanElement>('wl-web-note');
const fileButton = byId<HTMLButtonElement>('wl-file');
const fileSub = byId<HTMLSpanElement>('wl-file-sub');

async function hasWebAccess(): Promise<boolean> {
  try { return await chrome.permissions.contains({ origins: [...WEB_PDF_HOST_ORIGINS] }); } catch { return false; }
}

async function hasFileAccess(): Promise<boolean> {
  try { return await chrome.extension.isAllowedFileSchemeAccess(); } catch { return false; }
}

async function renderOpen(): Promise<void> {
  const webOn = await hasWebAccess() && await getSetting(WEB_PDF_VIEWER_ENABLED_SETTING_KEY, false);
  webButton.textContent = webOn ? `✓ ${S.webOn}` : S.webTurnOn;
  webButton.disabled = webOn;
  webButton.classList.toggle('wl-primary', !webOn);
  const file = await hasFileAccess();
  fileSub.textContent = file ? S.fileSubOn : S.fileSubOff;
  fileButton.textContent = file ? `✓ ${S.fileOn}` : S.fileOpenChrome;
  fileButton.disabled = file;
}

// The permission prompt has to run inside the click.
webButton.addEventListener('click', () => {
  void (async () => {
    let granted = await hasWebAccess();
    if (!granted) {
      try { granted = await chrome.permissions.request({ origins: [...WEB_PDF_HOST_ORIGINS] }); } catch { granted = false; }
    }
    webNote.hidden = granted;
    webNote.textContent = granted ? '' : S.webDenied;
    if (granted) {
      await setSetting(WEB_PDF_VIEWER_ENABLED_SETTING_KEY, true);
      await send({ type: 'VOCAB_T_SYNC_WEB_PDF_ROUTING' });
    }
    await renderOpen();
  })();
});

fileButton.addEventListener('click', () => {
  void (async () => {
    if (!(await getSetting(LOCAL_PDF_VIEWER_ENABLED_SETTING_KEY, DEFAULT_LOCAL_PDF_VIEWER_ENABLED))) await setSetting(LOCAL_PDF_VIEWER_ENABLED_SETTING_KEY, true);
    void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  })();
});
// Back from Chrome's extension page.
window.addEventListener('focus', () => { if (current === 'open') void renderOpen(); });

// ─── Gather the PDFs open now ───

const gatherList = byId<HTMLUListElement>('wl-gather-list');
const gatherEmpty = byId<HTMLParagraphElement>('wl-gather-empty');
const gatherButton = byId<HTMLButtonElement>('wl-gather');
const gatherCloseRow = byId<HTMLLabelElement>('wl-gather-close-row');
const gatherClose = byId<HTMLInputElement>('wl-gather-close');
const gatherDone = byId<HTMLParagraphElement>('wl-gather-done');

let found: OpenPdfTab[] = [];

async function renderGather(): Promise<void> {
  const result = await findOpenPdfTabs();
  found = result.tabs;
  gatherList.replaceChildren(...found.map((tab) => {
    const li = document.createElement('li');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.dataset.tabId = String(tab.id);
    const text = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = tab.title;
    const where = document.createElement('small');
    where.textContent = tabPlace(tab.url);
    text.append(title, where);
    const label = document.createElement('label');
    label.append(box, text);
    li.append(label);
    return li;
  }));
  gatherEmpty.hidden = found.length > 0;
  gatherEmpty.textContent = found.length ? '' : result.hidden ? `${S.gatherNone} ${S.gatherNeedsAccess}` : S.gatherNone;
  gatherCloseRow.hidden = found.length === 0;
  gatherButton.hidden = found.length === 0;
  updateGatherButton();
}

function chosenTabs(): OpenPdfTab[] {
  const ids = new Set(Array.from(gatherList.querySelectorAll<HTMLInputElement>('input:checked')).map((b) => Number(b.dataset.tabId)));
  return found.filter((t) => ids.has(t.id));
}

function updateGatherButton(): void {
  const n = chosenTabs().length;
  gatherButton.textContent = S.gatherButton(n);
  gatherButton.disabled = n === 0;
}
gatherList.addEventListener('change', updateGatherButton);

gatherButton.addEventListener('click', () => {
  void (async () => {
    const tabs = chosenTabs();
    const urls = tabs.map((t) => t.url);
    if (!urls.length) return;
    // Each opens like a PDF from the web (with its zoom): the first becomes
    // the PDF tab, or hands itself to the one already open, and so do the rest.
    for (const tab of tabs) await chrome.tabs.create({ url: buildPdfHubEntryUrl(tab.url + zoomHash(tab), hubBase), active: false });
    if (gatherClose.checked) await closeTabs(tabs);
    gatherDone.hidden = false;
    gatherDone.textContent = S.gatherDone(urls.length);
    await renderGather();
    gatherEmpty.hidden = true;
  })();
});

// ─── Sync ───

const syncButton = byId<HTMLButtonElement>('wl-sync');
const syncStatus = byId<HTMLParagraphElement>('wl-sync-status');
const syncNext = byId<HTMLButtonElement>('wl-sync-next');

type SyncStatus = { googleConfigured: boolean; googleConnected: boolean; googleAccountEmail: string };

async function renderSync(): Promise<void> {
  const status = await send<SyncStatus | { success: false }>({ type: 'VOCAB_T_GET_CLOUD_SYNC_STATUS' });
  const connected = !!status && !('success' in status) && status.googleConnected;
  if (connected) {
    syncStatus.textContent = S.syncConnected((status as SyncStatus).googleAccountEmail || 'Google');
    syncButton.hidden = true;
    syncNext.textContent = S.next;
    syncNext.classList.add('wl-primary');
  }
  syncButton.disabled = !!status && !('success' in status) && !status.googleConfigured;
}

syncButton.addEventListener('click', () => {
  syncButton.disabled = true;
  syncStatus.textContent = S.syncConnecting;
  void send<{ success: boolean }>({ type: 'VOCAB_T_CONNECT_GOOGLE_SYNC' }).then(async (response) => {
    syncButton.disabled = false;
    if (!response?.success) syncStatus.textContent = S.syncFailed;
    await renderSync();
  });
});

// ─── Tour ───

byId<HTMLButtonElement>('wl-demo').addEventListener('click', () => {
  const demo = `${DEMO_BASE}/researchpdf-demo-${currentLanguage()}.pdf`;
  void chrome.tabs.create({ url: buildPdfHubUrl([demo], 0, hubBase) });
});

const MAC = /Mac|iPhone|iPad/u.test(navigator.platform);
const keyName = (k: string) => (MAC ? ({ Alt: '⌥', Shift: '⇧' } as Record<string, string>)[k] ?? k : k);
const keys: Array<[string[], string]> = [
  [['Alt', 'Shift', '← →'], S.keyNext],
  [['Alt', 'W'], S.keyClose],
  [['Alt', 'Shift', 'T'], S.keyReopen],
  [['S'], S.keyCapture],
];
byId<HTMLDListElement>('wl-keys').replaceChildren(...keys.map(([combo, what]) => {
  const row = document.createElement('div');
  const dt = document.createElement('dt');
  for (const k of combo) {
    const kbd = document.createElement('kbd');
    kbd.textContent = keyName(k);
    dt.append(kbd);
  }
  const dd = document.createElement('dd');
  dd.textContent = what;
  row.append(dt, dd);
  return row;
}));

// ─── Done ───

byId<HTMLButtonElement>('wl-open-tab').addEventListener('click', () => {
  void chrome.tabs.create({ url: hubBase });
});
byId<HTMLButtonElement>('wl-open-settings').addEventListener('click', () => {
  void send({ type: 'VOCAB_T_PDF_SHOW_SETTINGS' });
});

show(current);
