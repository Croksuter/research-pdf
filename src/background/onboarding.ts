// ─── First run ───
//
// A fresh install opens the welcome page (ui/welcome.ts): what the extension
// does, the switches that matter on day one, and a demo paper. Updates do
// not; the settings page can show it again.

export const WELCOME_PAGE = 'welcome.html';

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== chrome.runtime.OnInstalledReason.INSTALL) return;
  void chrome.tabs.create({ url: chrome.runtime.getURL(WELCOME_PAGE) });
});
