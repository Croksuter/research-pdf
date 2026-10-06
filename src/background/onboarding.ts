// ─── First run ───
//
// A fresh install opens the welcome page (ui/welcome.ts): what the extension
// does, the switches that matter on day one, and a demo paper. Updates do
// not; the settings page can show it again.
//
// The guide survives the one reload it causes itself: turning on file-URL
// access on Chrome's extension page reloads the extension and closes the
// guide, so the guide leaves a marker (shared/welcomeResume.ts) and this
// worker's next start — which that reload is — opens it again at that step.

import { WELCOME_RESUME_STORAGE_KEY, welcomeResumeStep } from '../shared/welcomeResume';

export const WELCOME_PAGE = 'welcome.html';

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== chrome.runtime.OnInstalledReason.INSTALL) return;
  void chrome.tabs.create({ url: chrome.runtime.getURL(WELCOME_PAGE) });
});

/** True when a welcome page is open (getContexts sees the extension's own documents without the `tabs` permission). */
async function welcomeOpen(): Promise<boolean> {
  const page = chrome.runtime.getURL(WELCOME_PAGE);
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    return contexts.some((c) => c.documentUrl?.startsWith(page));
  } catch {
    return false;
  }
}

async function resumeWelcome(): Promise<void> {
  const stored = await chrome.storage.local.get(WELCOME_RESUME_STORAGE_KEY).catch(() => ({} as Record<string, unknown>));
  if (!(WELCOME_RESUME_STORAGE_KEY in stored)) return;
  // Still open: the worker merely restarted while the user is on Chrome's
  // page; the marker waits for the reload (or the guide clears it).
  if (await welcomeOpen()) return;
  const step = welcomeResumeStep(stored[WELCOME_RESUME_STORAGE_KEY], Date.now());
  // One reopen per trip to Chrome's extension page.
  await chrome.storage.local.remove(WELCOME_RESUME_STORAGE_KEY).catch(() => undefined);
  if (!step) return;
  await chrome.tabs.create({ url: `${chrome.runtime.getURL(WELCOME_PAGE)}#${step}` }).catch(() => undefined);
}

// Every worker start, not only runtime.onStartup: the extension reload that
// closed the guide starts a new worker without a browser start, and a
// browser start starts the worker too.
void resumeWelcome();
