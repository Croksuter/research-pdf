// ─── Home: the project's pinned, recently closed and other documents ───
//
// Only this project's documents (the default project's: those of no other
// project). Filters and sort (per device), paging, search within the project
// — or, asked for, over the whole library, where a document of elsewhere can
// be added here. A re-render keeps the scroll and the focused control;
// reading positions saved elsewhere re-render only when home shows what changed.

import { homeFilterChoices, homePositionKey, progressBucket } from '../../../shared/hubTabs';
import { DEFAULT_PROJECT_ID } from '../../../shared/pdfProjects';
import { libraryEntryKind, relativeTime, searchPdfLibrary, type PdfDocKind, type PdfLibraryEntry } from '../../../shared/pdfLibrary';
import { currentLanguage } from '../../../shared/i18n';
import { S } from '../../pdfHub.strings';
import { HOME, SETTINGS, activeKey, annotated, currentProject, docRecords, entryName, inThisProject, library, loadAnnotated, membershipIndex, openTabFor, pinnedDocIds, projectId, projectName } from '../store';
import { fileInput, home, homeBtn, homeOpen, homeSearch, homeSections, homeTitle, settingsBtn } from '../dom';
import { el, icon, listRow, showToast } from '../uiKit';
import { activate, addDocs, leaveTabs, render, showSettings } from '../tabStrip';
import { closed, reopenClosed } from '../session';
import { homeRow } from './homeRow';
import { renderSelectionBar, keepSelected } from './selection';
import { gatherBanner, refreshOpenPdfs } from './gather';
import { KIND_LABEL, KIND_ORDER, projectBadge } from '../looks';

export const HOME_PAGE_SIZE = 30;
export const SEARCH_PAGE_SIZE = 100;

export function showHome(focusSearch: boolean): void {
  // Split view: home was in the half behind, which came in front.
  if (!leaveTabs(HOME)) { if (focusSearch) homeSearch.focus(); return; }
  resetHomeLimits();
  renderHome();
  void loadAnnotated().then(() => scheduleHomeRender());
  void refreshOpenPdfs();
  if (focusSearch) homeSearch.focus();
  render();
}

/**
 * The settings page in place of the documents. Its frame (settings.html,
 * which styles itself for the hub when framed) is made on first use and
 * kept; each later showing tells it to refresh what may have gone stale.
 */

// ─── Home: the library ───

export type HomeList = 'docs' | 'search';
export const homeLimits: Record<HomeList, number> = { docs: HOME_PAGE_SIZE, search: SEARCH_PAGE_SIZE };
// The search looks beyond this project (asked for; until the search is cleared).
let searchEverywhere = false;
export let homeRenderQueued = false;
// What the last render showed: the rows (by document) and the reading positions it depended on.
export let homeShownDocs = new Set<string>();
export let homePositions = '';

export function resetHomeLimits(): void {
  homeLimits.docs = HOME_PAGE_SIZE;
  homeLimits.search = SEARCH_PAGE_SIZE;
}

export function scheduleHomeRender(): void {
  if (activeKey !== HOME || homeRenderQueued) return;
  homeRenderQueued = true;
  requestAnimationFrame(() => {
    homeRenderQueued = false;
    if (activeKey === HOME) renderHome();
  });
}

export function positionKey(): string {
  return homePositionKey(Object.values(library), (docId) => docRecords[docId]?.page ?? null, homeShownDocs, homeView.sort === 'progress');
}

/** A reading position was saved (any viewer, any window): home re-renders only if it shows what changed. */
export function onPositionsChanged(): void {
  if (activeKey === HOME && positionKey() !== homePositions) scheduleHomeRender();
}

export function openEntry(entry: PdfLibraryEntry): void {
  const existing = openTabFor(entry.docId);
  if (existing) { activate(existing.key); return; }
  const url = entry.urls[0];
  if (!url) {
    showToast(S.localReselect);
    fileInput.click();
    return;
  }
  addDocs([{ url, hash: '', file: null }], true);
}

// ─── Home: filters, sort, selection (this page; filter and sort remembered per device) ───

export type HomeFilter = 'all' | PdfDocKind | 'annotated' | 'reading' | 'unread';
export type HomeSort = 'recent' | 'title' | 'year' | 'progress';
export const HOME_VIEW_KEY = 'rpdfHomeView';
// Getters: the language is read when a label is shown, not when this module loads.
export const HOME_FILTER_LABEL: Record<Exclude<HomeFilter, PdfDocKind>, string> = {
  get all() { return S.filterAll; },
  get annotated() { return S.filterAnnotated; },
  get reading() { return S.filterReading; },
  get unread() { return S.filterUnread; },
};
export const HOME_SORT_LABEL: Record<HomeSort, string> = {
  get recent() { return S.sortRecent; },
  get title() { return S.sortTitle; },
  get year() { return S.sortYear; },
  get progress() { return S.sortProgress; },
};

export function loadHomeView(): { filter: HomeFilter; sort: HomeSort } {
  try {
    const raw = JSON.parse(localStorage.getItem(HOME_VIEW_KEY) ?? '{}') as { filter?: string; sort?: string };
    const filter = (['all', 'annotated', 'reading', 'unread', ...KIND_ORDER] as string[]).includes(raw.filter ?? '') ? raw.filter as HomeFilter : 'all';
    const sort = (Object.keys(HOME_SORT_LABEL) as string[]).includes(raw.sort ?? '') ? raw.sort as HomeSort : 'recent';
    return { filter, sort };
  } catch {
    return { filter: 'all', sort: 'recent' };
  }
}
// Read at boot (it needs the kinds declared further down).
export let homeView: { filter: HomeFilter; sort: HomeSort } = { filter: 'all', sort: 'recent' };
export function initHomeView(): void {
  homeView = loadHomeView();
}

export function setHomeView(next: Partial<typeof homeView>): void {
  homeView = { ...homeView, ...next };
  try { localStorage.setItem(HOME_VIEW_KEY, JSON.stringify(homeView)); } catch { /* a nicety */ }
  resetHomeLimits();
  renderHome();
}

/** Reading progress 0–1, or null when never opened past the first page. */
export function progressOf(entry: PdfLibraryEntry): number | null {
  const page = docRecords[entry.docId]?.page ?? null;
  return page && page > 1 ? Math.min(1, page / Math.max(1, entry.numPages)) : null;
}

export function matchesFilter(entry: PdfLibraryEntry, filter: HomeFilter): boolean {
  switch (filter) {
    case 'all': return true;
    case 'annotated': return annotated.has(entry.docId);
    case 'reading': return progressBucket(docRecords[entry.docId]?.page ?? null, entry.numPages) === 'reading';
    case 'unread': return progressOf(entry) === null;
    default: return libraryEntryKind(entry) === filter;
  }
}

export function sortEntries(entries: PdfLibraryEntry[], sort: HomeSort): PdfLibraryEntry[] {
  const list = [...entries];
  switch (sort) {
    case 'title': return list.sort((a, b) => entryName(a).localeCompare(entryName(b), currentLanguage()));
    case 'year': return list.sort((a, b) => (b.year ?? -1) - (a.year ?? -1) || b.openedAt - a.openedAt);
    case 'progress': return list.sort((a, b) => (progressOf(b) ?? -1) - (progressOf(a) ?? -1) || b.openedAt - a.openedAt);
    default: return list.sort((a, b) => b.openedAt - a.openedAt);
  }
}

export function homeSection(title: string, rows: HTMLElement[], extra?: HTMLElement, tools?: HTMLElement): HTMLElement {
  const section = el('section', { className: 'rpdf-home-section' });
  const head = el('div', { className: 'rpdf-home-section-head' });
  head.append(el('h2', { textContent: title }));
  if (tools) head.append(tools);
  section.append(head);
  const list = el('ul', { className: 'rpdf-items' });
  list.append(...rows);
  section.append(list);
  if (extra) section.append(extra);
  return section;
}

/** "Show more" under a list cut at its page size. */
export function moreButton(list: HomeList, total: number, step = HOME_PAGE_SIZE): HTMLElement | undefined {
  if (total <= homeLimits[list]) return undefined;
  const more = el('button', { type: 'button', className: 'rpdf-more', textContent: S.showMore(total - homeLimits[list]) });
  more.dataset.list = list;
  more.addEventListener('click', () => { homeLimits[list] += step; renderHome(); });
  return more;
}

/** Filter chips (with counts over `entries`) and the sort menu. */
export function homeTools(entries: PdfLibraryEntry[]): HTMLElement {
  const bar = el('div', { className: 'rpdf-home-tools' });
  const chips = el('div', { className: 'rpdf-chips', role: 'group' });
  chips.setAttribute('aria-label', S.filterAria);
  // Kind chips only when there is more than one kind to tell apart; the active filter always.
  const kinds = KIND_ORDER.filter((k) => entries.some((e) => libraryEntryKind(e) === k));
  const filters = homeFilterChoices<HomeFilter>('all', kinds, ['annotated', 'reading', 'unread'], homeView.filter);
  for (const filter of filters) {
    const count = entries.filter((e) => matchesFilter(e, filter)).length;
    if (count === 0 && filter !== 'all' && filter !== homeView.filter) continue;
    const label = filter in HOME_FILTER_LABEL ? HOME_FILTER_LABEL[filter as keyof typeof HOME_FILTER_LABEL] : KIND_LABEL[filter as PdfDocKind];
    const chip = el('button', { type: 'button', className: 'rpdf-chip', textContent: `${label} ${count}` });
    chip.dataset.filter = filter;
    chip.setAttribute('aria-pressed', String(homeView.filter === filter));
    chip.addEventListener('click', () => setHomeView({ filter: homeView.filter === filter ? 'all' : filter }));
    chips.append(chip);
  }
  const sort = el('select', { className: 'rpdf-sort' });
  sort.setAttribute('aria-label', S.sortAria);
  for (const [value, label] of Object.entries(HOME_SORT_LABEL)) sort.append(el('option', { value, textContent: label, selected: homeView.sort === value }));
  sort.addEventListener('change', () => setHomeView({ sort: sort.value as HomeSort }));
  bar.append(chips, sort);
  return bar;
}

// Controls of a row that keep focus across a re-render (by document and kind of control).
export const ROW_CONTROLS = ['rpdf-item-check', 'rpdf-item-main', 'rpdf-item-act', 'rpdf-item-pin', 'rpdf-item-more'];

/** Where focus is on home, to put it back after a render. */
export function homeFocus(): (() => void) | null {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !homeSections.contains(active)) return null;
  const docId = active.closest<HTMLElement>('[data-doc-id]')?.dataset.docId;
  if (docId) {
    // The most specific class (⋯ is also an action button).
    const control = [...ROW_CONTROLS].reverse().find((c) => active.classList.contains(c));
    if (!control) return null;
    return () => {
      const row = Array.from(homeSections.querySelectorAll<HTMLElement>('[data-doc-id]')).find((r) => r.dataset.docId === docId);
      row?.querySelector<HTMLElement>(`.${control}`)?.focus({ preventScroll: true });
    };
  }
  const chip = active.dataset.filter;
  if (chip) return () => homeSections.querySelector<HTMLElement>(`.rpdf-chip[data-filter="${chip}"]`)?.focus({ preventScroll: true });
  if (active.classList.contains('rpdf-sort')) return () => homeSections.querySelector<HTMLElement>('.rpdf-sort')?.focus({ preventScroll: true });
  const list = active.dataset.list;
  if (list) return () => homeSections.querySelector<HTMLElement>(`.rpdf-more[data-list="${list}"]`)?.focus({ preventScroll: true });
  return null;
}

export function renderHome(): void {
  const refocus = homeFocus();
  const scroll = home.scrollTop;
  buildHome();
  // Selection follows what is on screen: a hidden row is never acted on.
  const shown = Array.from(homeSections.querySelectorAll<HTMLElement>('[data-doc-id]'));
  homeShownDocs = new Set(shown.map((r) => r.dataset.docId ?? ''));
  const selectable = shown.filter((r) => r.querySelector('.rpdf-item-check')).map((r) => r.dataset.docId ?? '');
  keepSelected(selectable);
  renderSelectionBar();
  homePositions = positionKey();
  home.scrollTop = scroll;
  refocus?.();
}

export function buildHome(): void {
  const project = currentProject();
  homeTitle.replaceChildren(projectBadge(project), document.createTextNode(project.name));
  const entries = Object.values(library);
  const index = membershipIndex();
  const isDefault = projectId === DEFAULT_PROJECT_ID;
  const otherNames = (docId: string) => (index.get(docId) ?? []).filter((id) => id !== projectId).map(projectName);
  const pinnedIds = pinnedDocIds();
  const pinnedSet = new Set(pinnedIds);
  const query = homeSearch.value.trim();
  const sections: HTMLElement[] = [];
  const here = (e: PdfLibraryEntry) => pinnedSet.has(e.docId) || inThisProject(e.docId, index);
  if (!query) searchEverywhere = false;
  if (query) {
    const found = searchPdfLibrary(searchEverywhere ? entries : entries.filter(here), query);
    const beyond = searchEverywhere ? 0 : searchPdfLibrary(entries.filter((e) => !here(e)), query).length;
    // Searched everywhere: a document of elsewhere can be added here.
    const rows = found.slice(0, homeLimits.search).map((e) => homeRow(e, { pinned: pinnedSet.has(e.docId), elsewhere: otherNames(e.docId), add: !here(e) }));
    sections.push(found.length
      ? homeSection(searchEverywhere ? S.searchResultsEverywhere(found.length) : S.searchResults(found.length), rows, moreButton('search', found.length, SEARCH_PAGE_SIZE))
      : el('p', { className: 'rpdf-home-empty', textContent: searchEverywhere ? S.noMatchingPdf : S.noMatchingPdfHere }));
    if (searchEverywhere || beyond > 0) {
      const scope = el('button', { type: 'button', className: 'rpdf-more rpdf-home-scope', textContent: searchEverywhere ? S.searchHereOnly : S.searchEverywhere(beyond) });
      scope.addEventListener('click', () => { searchEverywhere = !searchEverywhere; resetHomeLimits(); renderHome(); });
      sections.push(scope);
    }
    homeSections.replaceChildren(...sections);
    return;
  }
  const banner = gatherBanner();
  if (banner) sections.push(banner);
  const pinned = pinnedIds.map((id) => library[id]).filter((e): e is PdfLibraryEntry => !!e);
  if (pinned.length) {
    const hint = el('span', { className: 'rpdf-home-hint-inline', textContent: pinned.length > 1 ? S.dragToReorder : '' });
    sections.push(homeSection(S.pinnedHeading, pinned.map((e) => homeRow(e, { pinned: true, pinnedList: true })), undefined, hint));
  }
  if (closed.length) {
    const rows = closed.slice(0, 6).map((entry) => listRow({
      variant: 'item',
      icon: icon('i-restore'),
      title: entry.paperTitle ?? entry.title,
      sub: S.closedAgo(relativeTime(entry.closedAt)),
      onClick: () => reopenClosed(entry),
    }));
    sections.push(homeSection(S.recentlyClosed, rows));
  }
  const mine = entries.filter((e) => !pinnedSet.has(e.docId) && inThisProject(e.docId, index));
  const tools = homeTools(mine);
  const shown = (list: PdfLibraryEntry[]) => sortEntries(list.filter((e) => matchesFilter(e, homeView.filter)), homeView.sort);
  const mineShown = shown(mine);
  if (isDefault) {
    if (mine.length) {
      sections.push(homeSection(S.documents, mineShown.slice(0, homeLimits.docs).map((e) => homeRow(e, { pinned: false })), moreButton('docs', mineShown.length), tools));
      if (mineShown.length === 0) sections[sections.length - 1].append(el('p', { className: 'rpdf-home-hint', textContent: S.noMatchFilter }));
    }
    if (sections.length === 0) sections.push(el('p', { className: 'rpdf-home-empty', textContent: S.emptyDefault }));
    homeSections.replaceChildren(...sections);
    return;
  }
  const own = homeSection(S.projectDocs, mineShown.slice(0, homeLimits.docs).map((e) => homeRow(e, { pinned: false, remove: true })), moreButton('docs', mineShown.length), tools);
  if (mine.length === 0) own.append(el('p', { className: 'rpdf-home-hint', textContent: S.emptyProject }));
  else if (mineShown.length === 0) own.append(el('p', { className: 'rpdf-home-hint', textContent: S.noMatchFilter }));
  sections.push(own);
  homeSections.replaceChildren(...sections);
}

homeBtn.addEventListener('click', () => showHome(true));
settingsBtn.addEventListener('click', () => { if (activeKey === SETTINGS) showHome(false); else showSettings(); });
homeOpen.addEventListener('click', () => fileInput.click());
export let homeSearchTimer: ReturnType<typeof setTimeout> | null = null;
homeSearch.addEventListener('input', () => {
  if (homeSearchTimer) clearTimeout(homeSearchTimer);
  homeSearchTimer = setTimeout(() => { resetHomeLimits(); renderHome(); }, 80);
});
homeSearch.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  homeSections.querySelector<HTMLButtonElement>('.rpdf-item-main')?.click();
});
