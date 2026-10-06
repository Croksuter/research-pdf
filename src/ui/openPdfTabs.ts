// ─── PDFs open in Chrome's own viewer, gathered into a PDF tab ───
//
// Shared by home (a banner when there are some), the settings page and the
// welcome page. A tab counts when its address looks like a PDF; Chrome shows
// other tabs' addresses only for sites the extension may access, so without
// web access only local files (with file-URL access) are found.

import { WEB_PDF_HOST_ORIGINS, isLocalPdfUrl, isWebPdfSuffixUrl } from '../shared/localPdf';

/** Message a framed page (settings) sends its hub: add these and close the tabs they came from. */
export const GATHER_MESSAGE = 'rpdf-gather-pdfs';

// What Chrome's viewer lets an extension read: its zoom, which it keeps as
// the tab's zoom. Its scroll position and page stay inside Chrome's own
// viewer, out of any extension's reach.
export interface OpenPdfTab { id: number; url: string; title: string; zoom: number | null }

/** The fragment that reopens a gathered PDF at its zoom in our viewer ('' at the default). */
export function zoomHash(tab: Pick<OpenPdfTab, 'zoom'>): string {
  return tab.zoom && Math.abs(tab.zoom - 1) > 0.01 ? `#zoom=${Math.round(tab.zoom * 100)}` : '';
}

export function looksLikePdf(url: string): boolean {
  return isWebPdfSuffixUrl(url) || isLocalPdfUrl(url) || /^https?:\/\/(?:www\.)?arxiv\.org\/pdf\//iu.test(url);
}

/** The PDF tabs Chrome shows us, and whether some addresses were hidden (no site access). */
export async function findOpenPdfTabs(): Promise<{ tabs: OpenPdfTab[]; hidden: boolean }> {
  const all = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
  const ownPages = chrome.runtime.getURL('');
  const tabs = all
    .filter((t): t is chrome.tabs.Tab & { id: number; url: string } => typeof t.id === 'number' && !!t.url && !t.url.startsWith(ownPages) && looksLikePdf(t.url))
    .map((t) => ({ id: t.id, url: t.url, title: t.title || t.url, zoom: null as number | null }));
  await Promise.all(tabs.map(async (t) => { t.zoom = await chrome.tabs.getZoom(t.id).catch(() => null); }));
  let access = false;
  try { access = await chrome.permissions.contains({ origins: [...WEB_PDF_HOST_ORIGINS] }); } catch { /* none */ }
  return { tabs, hidden: !access && all.some((t) => !t.url) };
}

/** Closes the tabs the documents were gathered from. */
export async function closeTabs(tabs: OpenPdfTab[]): Promise<void> {
  if (tabs.length) await chrome.tabs.remove(tabs.map((t) => t.id)).catch(() => undefined);
}

/** A short "where" for a tab: its file name or host. */
export function tabPlace(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'file:' ? decodeURIComponent(parsed.pathname.split('/').pop() ?? '') : parsed.hostname.replace(/^www\./u, '');
  } catch {
    return '';
  }
}
