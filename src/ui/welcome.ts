// ─── Welcome page: the first run, step by step ───
//
// Opened once when the extension is installed (background/onboarding.ts).
// Hello → open PDFs here (web access, file access) → gather the PDFs already
// open → Google Drive (optional) → a tour, with a demo paper about the
// extension itself to try everything on → done. Every step can be skipped;
// everything here can be changed later on the settings page.

import { DEFAULT_LOCAL_PDF_VIEWER_ENABLED, LOCAL_PDF_VIEWER_ENABLED_SETTING_KEY, WEB_PDF_VIEWER_ENABLED_SETTING_KEY } from '../shared/constants';
import { getSetting, setSetting } from '../db/settingsRepository';
import { PDF_HUB_PAGE, WEB_PDF_HOST_ORIGINS, buildPdfHubUrl } from '../shared/localPdf';
import { findOpenPdfTabs, tabPlace, type OpenPdfTab } from './openPdfTabs';
import { LANGUAGE_STORAGE_KEY, currentLanguage, localizeDocument, parseLanguagePref, saveLanguagePref } from '../shared/i18n';
import { SHORTCUTS, shortcutLabel } from '../shared/shortcuts';
import { WELCOME_RESUME_STORAGE_KEY, type WelcomeResume } from '../shared/welcomeResume';
import type { PdfSyncPublicStatus } from '../background/pdfSyncService';
import { byId, closeWhenGathered, hasFileAccess, hasWebAccess, openExtensionDetails, openInHub, send, shortcutKeys } from './pageKit';
import { S } from './welcome.strings';

const DEMO_BASE = 'https://research-pdf.croksuter.com/demo';
const STEPS = ['hello', 'open', 'gather', 'sync', 'tour', 'done'] as const;
type Step = typeof STEPS[number];

localizeDocument(S);
document.title = S.pageTitle;
const hubBase = chrome.runtime.getURL(PDF_HUB_PAGE);

// ─── Language ───

// As on the settings page: auto follows the browser, a choice pins it.
const languageSelect = byId<HTMLSelectElement>('wl-language');
languageSelect.value = parseLanguagePref(localStorage.getItem(LANGUAGE_STORAGE_KEY));
languageSelect.addEventListener('change', () => {
  void saveLanguagePref(parseLanguagePref(languageSelect.value)).then(() => {
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
  // Finished or skipped: nothing to resume after a reload any more.
  if (step === 'done') void chrome.storage.local.remove(WELCOME_RESUME_STORAGE_KEY).catch(() => undefined);
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

// Turning file-URL access on there reloads the extension, which closes this
// page; the marker has the background bring it back at this step
// (background/onboarding.ts).
fileButton.addEventListener('click', () => {
  void (async () => {
    if (!(await getSetting(LOCAL_PDF_VIEWER_ENABLED_SETTING_KEY, DEFAULT_LOCAL_PDF_VIEWER_ENABLED))) await setSetting(LOCAL_PDF_VIEWER_ENABLED_SETTING_KEY, true);
    const marker: WelcomeResume = { step: current, at: Date.now() };
    await chrome.storage.local.set({ [WELCOME_RESUME_STORAGE_KEY]: marker }).catch(() => undefined);
    openExtensionDetails();
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

// Each opens like a PDF from the web (with its zoom); an original tab closes
// only once its document is in the PDF tab (ui/pageKit.ts), the rest stay.
gatherButton.addEventListener('click', () => {
  void (async () => {
    const tabs = chosenTabs();
    if (!tabs.length) return;
    gatherButton.disabled = true;
    const since = Date.now();
    await openInHub(tabs);
    gatherDone.hidden = false;
    gatherDone.textContent = S.gatherOpened(tabs.length);
    if (gatherClose.checked) {
      gatherDone.textContent = S.gatherClosing(0, tabs.length);
      const { kept } = await closeWhenGathered(tabs, since, (closed) => { gatherDone.textContent = S.gatherClosing(closed, tabs.length); });
      gatherDone.textContent = kept.length ? `${S.gatherDone(tabs.length)} ${S.gatherKept(kept.length)}` : S.gatherDone(tabs.length);
    } else {
      gatherDone.textContent = S.gatherDone(tabs.length);
    }
    await renderGather();
    gatherEmpty.hidden = true;
  })();
});

// ─── Sync ───

const syncButton = byId<HTMLButtonElement>('wl-sync');
const syncStatus = byId<HTMLParagraphElement>('wl-sync-status');
const syncNext = byId<HTMLButtonElement>('wl-sync-next');

async function renderSync(): Promise<void> {
  const status = await send<PdfSyncPublicStatus | { success: false }>({ type: 'VOCAB_T_GET_CLOUD_SYNC_STATUS' });
  const connected = !!status && !('success' in status) && status.googleConnected;
  if (connected) {
    syncStatus.textContent = S.syncConnected((status as PdfSyncPublicStatus).googleAccountEmail || 'Google');
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

// The tour's few from the one shortcut table (shared/shortcuts.ts).
byId<HTMLDListElement>('wl-keys').replaceChildren(...SHORTCUTS.filter((s) => s.tour).map((shortcut) => {
  const row = document.createElement('div');
  const dt = shortcutKeys(shortcut, document.createElement('dt'));
  const dd = document.createElement('dd');
  dd.textContent = shortcutLabel(shortcut.label);
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
