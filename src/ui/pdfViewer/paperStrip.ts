// Paper strip: when the open PDF is a scholarly paper, a row under the toolbar
// shows venue / year, citation count (+ 5-year trend), the venue's 2-year mean
// citedness (the Impact-Factor definition, from OpenAlex), reference count,
// external links, and BibTeX / APA copy buttons.
//
// Detection: DOI or arXiv id from the source URL, the PDF metadata, or the
// first page's text; otherwise the largest-font text on page 1 is title-
// searched and accepted only above TITLE_MATCH_THRESHOLD and with the
// record's first author named on page 1 (shown as "matched by title"). Data
// comes from OpenAlex and Crossref, both of which answer with `Access-Control-
// Allow-Origin: *`, so no extra host permission is needed. Google Scholar has
// no API and is linked, not scraped. Results are cached for a week
// (paperCache.ts).

import type { PDFDocumentProxy } from 'pdfjs-dist';
import { getSetting } from '../../db/settingsRepository';
import { debugError, debugLog } from '../../shared/debugLog';
import { DEFAULT_PAPER_INFO_ENABLED, OPENALEX_API_KEY_SETTING_KEY, PAPER_INFO_ENABLED_SETTING_KEY, SEMANTIC_SCHOLAR_API_KEY_SETTING_KEY } from '../../shared/constants';
import {
  type PaperIdentifiers,
  type PaperMeta,
  TITLE_MATCH_THRESHOLD,
  arxivIdFromDoi,
  bestCitationCount,
  bestReferenceCount,
  formatApa,
  formatBibtex,
  formatCount,
  identifiersFromText,
  identifiersFromUrl,
  mergeIdentifiers,
  normalizeDoi,
  normalizeTitle,
  citationHistory,
  classifyPaperKind,
  recentCitationSeries,
  recentTwoYearCitations,
  scholarLinks,
  arxivIdYear,
  isGenericTitle,
  isPublishedVersion,
  recordMatchesDocument,
  splitAuthor,
  tidyPaperMeta,
  titleMatchConfirmed,
  titleSimilarity,
  type WorkSummary,
} from '../../shared/paperIdentifiers';
import { dropPaperCache, readPaperCache, writePaperCache } from './paperCache';
import { byId, el } from './dom';
import { buildCitationChart } from './paperChart';
import { ReferenceList } from './paperRefs';
import { OPENALEX_BUDGET_REASON, isOpenAlexUrl, noteOpenAlex429, openAlexBudgetSpent, openAlexUrl, setOpenAlexApiKey } from './openAlexAccess';
import { pdfReferences } from './pdfText';
import { S } from './paper.strings';

const OPENALEX = 'https://api.openalex.org';
const CROSSREF = 'https://api.crossref.org';
const SEMANTIC_SCHOLAR = 'https://api.semanticscholar.org/graph/v1';
const WORK_SELECT = 'id,display_name,publication_year,cited_by_count,referenced_works_count,referenced_works,type,doi,ids,biblio,counts_by_year,primary_location,authorships';
// Bumped whenever PaperMeta gains fields: an entry from an older build must
// not be rendered with a newer renderer.
const CACHE_PREFIX = 'meta:v2:';
const FETCH_TIMEOUT_MS = 12_000;
// Whole first page: the arXiv margin stamp is rotated text and comes last in
// the item order, so a short cap used to miss it.
const FIRST_PAGE_TEXT_LIMIT = 20_000;
// Right after Chrome starts, requests from extension pages can stall for
// ~20 s (observed in fresh profiles); a lookup that failed only because of
// aborted/errored fetches is retried once after this delay.
const NETWORK_RETRY_DELAY_MS = 15_000;

/** Where a request went, for saying who rate-limited a lookup. */
type PaperSource = 'OpenAlex' | 'Crossref' | 'Semantic Scholar' | 'arXiv';

/**
 * One lookup's record of the network: requests that failed outright, and
 * the sources that answered 429 after every retry. Each lookup has its own,
 * so overlapping lookups (two documents, the upkeep frame) never mix them.
 */
export interface LookupContext {
  networkFailures: number;
  limited: Set<PaperSource>;
}

export function newLookup(): LookupContext {
  return { networkFailures: 0, limited: new Set() };
}

function sourceOf(url: string): PaperSource {
  if (isOpenAlexUrl(url)) return 'OpenAlex';
  if (url.startsWith(CROSSREF)) return 'Crossref';
  if (url.startsWith(SEMANTIC_SCHOLAR)) return 'Semantic Scholar';
  return 'arXiv';
}

const kindTitles = (): Record<string, string> => ({
  survey: S.kindSurvey,
  conference: S.kindConference,
  journal: S.kindJournal,
  technical: S.kindTechnical,
  preprint: S.kindPreprint,
});

interface CacheEntry { meta: PaperMeta }

async function fetchJson<T>(ctx: LookupContext, url: string, timeoutMs = FETCH_TIMEOUT_MS, retry: boolean | number[] = true, headers?: Record<string, string>): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const startedAt = performance.now();
  const label = url.replace(/\?.*$/u, '').slice(0, 90);
  // `retry`: true = one 1.5 s retry on 429; an array = remaining backoff delays.
  const backoff = retry === true ? [1_500] : retry === false ? [] : retry;
  try {
    if (isOpenAlexUrl(url) && openAlexBudgetSpent()) return null;
    const res = await fetch(isOpenAlexUrl(url) ? openAlexUrl(url) : url, { signal: ctrl.signal, headers });
    // OpenAlex's spent daily budget does not come back by retrying.
    if (res.status === 429 && isOpenAlexUrl(url) && noteOpenAlex429(await res.clone().text().catch(() => ''))) {
      debugLog('paper', `fetch 429 (OpenAlex daily budget spent): ${label}`);
      return null;
    }
    if (res.status === 429 && backoff.length > 0) {
      debugLog('paper', `fetch 429, retrying in ${backoff[0]}ms: ${label}`);
      await new Promise((r) => setTimeout(r, backoff[0]));
      return fetchJson<T>(ctx, url, timeoutMs, backoff.slice(1), headers);
    }
    if (res.status === 429) ctx.limited.add(sourceOf(url));
    debugLog('paper', `fetch ${res.status} in ${Math.round(performance.now() - startedAt)}ms: ${label}`);
    if (!res.ok) return null;
    return await res.json() as T;
  } catch (error) {
    ctx.networkFailures += 1;
    debugLog('paper', `fetch failed after ${Math.round(performance.now() - startedAt)}ms (${error instanceof Error ? error.name : 'error'}): ${label}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── OpenAlex (enrichment: citations by year, venue 2-year citedness) ───
//
// Observed from the extension page: `/works/<W id>`, `/works?filter=doi:…`
// and `/sources/<S id>` answer quickly, while `/works/doi:…` path lookups can
// hang and anonymous `search=` is rate-limited under load. So lookups go
// through `filter=doi:` and the search is a best-effort first attempt only.

interface OpenAlexWork {
  id?: string;
  display_name?: string;
  publication_year?: number | null;
  cited_by_count?: number;
  referenced_works_count?: number;
  referenced_works?: string[];
  type?: string | null;
  doi?: string | null;
  ids?: { openalex?: string; doi?: string };
  biblio?: { volume?: string | null; issue?: string | null; first_page?: string | null; last_page?: string | null };
  counts_by_year?: Array<{ year: number; cited_by_count: number }>;
  primary_location?: {
    landing_page_url?: string | null;
    source?: { id?: string; display_name?: string; type?: string } | null;
  } | null;
  authorships?: Array<{ author?: { display_name?: string } }>;
}

const OPENALEX_TIMEOUT_MS = 8_000;

async function openAlexByDoi(ctx: LookupContext, doi: string): Promise<OpenAlexWork | null> {
  const url = `${OPENALEX}/works?filter=doi:${encodeURIComponent(doi)}&per-page=1&select=${encodeURIComponent(WORK_SELECT)}`;
  const page = await fetchJson<{ results?: OpenAlexWork[] }>(ctx, url, OPENALEX_TIMEOUT_MS);
  return page?.results?.[0] ?? null;
}

/** Only candidates `accept` passes (whose first author the PDF names, for a title-only match). */
type AuthorCheck = (authors: string[], families?: Array<string | null>) => boolean;

async function openAlexByTitle(ctx: LookupContext, title: string, accept?: AuthorCheck): Promise<OpenAlexWork | null> {
  const url = `${OPENALEX}/works?search=${encodeURIComponent(title)}&per-page=5&select=${encodeURIComponent(WORK_SELECT)}`;
  const page = await fetchJson<{ results?: OpenAlexWork[] }>(ctx, url, OPENALEX_TIMEOUT_MS, false);
  const results = (page?.results ?? []).filter((w) => !accept || accept(openAlexAuthors(w)));
  return pickByTitle(title, results, (w) => w.display_name ?? '', (w) => w.cited_by_count ?? 0);
}

function openAlexAuthors(work: OpenAlexWork): string[] {
  return (work.authorships ?? []).map((a) => a.author?.display_name ?? '').filter(Boolean);
}

// Same-title hits are common (reprints, translations, preprint + published);
// among candidates whose similarity ties within TITLE_TIE_MARGIN the most
// cited one is the canonical paper the reader most likely has.
const TITLE_TIE_MARGIN = 0.02;

function pickByTitle<T>(title: string, candidates: T[], titleOf: (c: T) => string, weightOf: (c: T) => number): T | null {
  let best: { item: T; score: number; weight: number } | null = null;
  for (const item of candidates) {
    const score = titleSimilarity(title, titleOf(item));
    const weight = weightOf(item);
    if (!best || score > best.score + TITLE_TIE_MARGIN || (Math.abs(score - best.score) <= TITLE_TIE_MARGIN && weight > best.weight)) {
      best = { item, score, weight };
    }
  }
  return best && best.score >= TITLE_MATCH_THRESHOLD ? best.item : null;
}

function metaFromOpenAlex(work: OpenAlexWork, ids: PaperIdentifiers): PaperMeta {
  const doiRaw = work.doi ?? work.ids?.doi ?? null;
  const doi = doiRaw ? normalizeDoi(doiRaw) : null;
  const arxivFromDoi = doi ? arxivIdFromDoi(doi) : null;
  const source = work.primary_location?.source ?? null;
  // A repository (arXiv, a university's, RePEc) hosts a copy; it is not where
  // the paper appeared.
  const repository = source?.type === 'repository';
  const arxivId = ids.arxivId ?? arxivFromDoi;
  return {
    title: work.display_name ?? '',
    year: work.publication_year ?? null,
    authors: openAlexAuthors(work),
    venue: repository ? (arxivId || /arxiv/iu.test(source?.display_name ?? '') ? 'arXiv' : null) : source?.display_name ?? null,
    venueType: source?.type ?? null,
    workType: work.type ?? null,
    doi: doi && !arxivFromDoi ? doi : (ids.doi ?? null),
    arxivId,
    openalexId: (work.ids?.openalex ?? work.id ?? '').split('/').pop() || null,
    citations: { openalex: work.cited_by_count ?? null, crossref: null, semanticScholar: null },
    citationsByYear: (work.counts_by_year ?? []).map((c) => ({ year: c.year, count: c.cited_by_count })),
    references: { openalex: work.referenced_works_count ?? null, crossref: null, semanticScholar: null },
    venueTwoYearMeanCitedness: null,
    volume: work.biblio?.volume ?? null,
    issue: work.biblio?.issue ?? null,
    firstPage: work.biblio?.first_page ?? null,
    lastPage: work.biblio?.last_page ?? null,
    landingUrl: work.primary_location?.landing_page_url ?? null,
    referencedWorks: work.referenced_works ?? [],
  };
}

/** Folds OpenAlex data into a meta that already came from Crossref. */
function enrichWithOpenAlex(meta: PaperMeta, work: OpenAlexWork): PaperMeta {
  const oa = metaFromOpenAlex(work, { doi: meta.doi ?? undefined, arxivId: meta.arxivId ?? undefined });
  const metaIsArxivVenue = !meta.venue || /arxiv/iu.test(meta.venue);
  const oaIsArxivVenue = !oa.venue || /arxiv/iu.test(oa.venue);
  return {
    ...meta,
    arxivId: meta.arxivId ?? oa.arxivId,
    openalexId: oa.openalexId,
    venue: metaIsArxivVenue && !oaIsArxivVenue ? oa.venue : meta.venue,
    venueType: metaIsArxivVenue && !oaIsArxivVenue ? oa.venueType : (meta.venueType ?? oa.venueType),
    workType: metaIsArxivVenue && !oaIsArxivVenue ? oa.workType : meta.workType,
    year: meta.year ?? oa.year,
    citations: { ...meta.citations, openalex: oa.citations.openalex },
    citationsByYear: oa.citationsByYear,
    references: { ...meta.references, openalex: oa.references.openalex },
    referencedWorks: oa.referencedWorks,
  };
}

async function openAlexSourceStats(ctx: LookupContext, sourceId: string): Promise<number | null> {
  const id = sourceId.split('/').pop();
  if (!id) return null;
  const src = await fetchJson<{ summary_stats?: { '2yr_mean_citedness'?: number } }>(
    ctx, `${OPENALEX}/sources/${id}?select=summary_stats`, OPENALEX_TIMEOUT_MS,
  );
  const value = src?.summary_stats?.['2yr_mean_citedness'];
  return typeof value === 'number' ? value : null;
}

// ─── Crossref (primary for DOIs: fast, reliable, BibTeX) ───

interface CrossrefWork {
  DOI?: string;
  title?: string[];
  author?: Array<{ given?: string; family?: string; name?: string }>;
  'article-number'?: string;
  institution?: Array<{ name?: string }>;
  'group-title'?: string;
  issued?: { 'date-parts'?: number[][] };
  published?: { 'date-parts'?: number[][] };
  'container-title'?: string[];
  volume?: string;
  issue?: string;
  page?: string;
  type?: string;
  URL?: string;
  'is-referenced-by-count'?: number;
  'reference-count'?: number;
}

const CROSSREF_TYPE: Record<string, { venueType: string | null; workType: string }> = {
  'journal-article': { venueType: 'journal', workType: 'article' },
  'proceedings-article': { venueType: 'conference', workType: 'article' },
  'posted-content': { venueType: null, workType: 'preprint' },
  'book-chapter': { venueType: null, workType: 'book-chapter' },
  book: { venueType: null, workType: 'book' },
  monograph: { venueType: null, workType: 'book' },
  dissertation: { venueType: null, workType: 'dissertation' },
  dataset: { venueType: null, workType: 'dataset' },
};

function metaFromCrossref(work: CrossrefWork, ids: PaperIdentifiers): PaperMeta {
  const year = work.issued?.['date-parts']?.[0]?.[0] ?? work.published?.['date-parts']?.[0]?.[0] ?? null;
  const [firstPage, lastPage] = (work.page ?? '').split(/[-–]/u).map((p) => p.trim());
  const kind = CROSSREF_TYPE[work.type ?? ''] ?? { venueType: null, workType: work.type ?? null };
  const doi = work.DOI ? normalizeDoi(work.DOI) : (ids.doi ?? null);
  return {
    title: work.title?.[0] ?? '',
    year: typeof year === 'number' ? year : null,
    authors: (work.author ?? []).map((a) => a.name ?? [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean),
    // The surname as the publisher split it ("Chue Hong"), for APA.
    authorFamilies: (work.author ?? []).filter((a) => a.name ?? [a.given, a.family].filter(Boolean).join(' ')).map((a) => a.family ?? null),
    // A posted preprint has no container; its server is the venue (bioRxiv, medRxiv…).
    venue: work['container-title']?.[0] ?? (work.type === 'posted-content' ? work.institution?.[0]?.name ?? work['group-title'] ?? null : null),
    venueType: kind.venueType,
    workType: kind.workType,
    doi,
    arxivId: ids.arxivId ?? null,
    openalexId: null,
    citations: { openalex: null, crossref: work['is-referenced-by-count'] ?? null, semanticScholar: null },
    citationsByYear: [],
    references: { openalex: null, crossref: work['reference-count'] ?? null, semanticScholar: null },
    venueTwoYearMeanCitedness: null,
    volume: work.volume ?? null,
    issue: work.issue ?? null,
    // Article-numbered journals (Nature family, PLOS) have no pages.
    firstPage: firstPage || work['article-number'] || null,
    lastPage: firstPage ? lastPage || null : null,
    landingUrl: work.URL ?? (doi ? `https://doi.org/${doi}` : null),
  };
}

async function crossrefByDoi(ctx: LookupContext, doi: string): Promise<CrossrefWork | null> {
  const res = await fetchJson<{ message?: CrossrefWork }>(ctx, `${CROSSREF}/works/${encodeURIComponent(doi)}`);
  return res?.message ?? null;
}

async function crossrefByTitle(ctx: LookupContext, title: string, accept?: AuthorCheck): Promise<CrossrefWork | null> {
  const url = `${CROSSREF}/works?query.bibliographic=${encodeURIComponent(title)}&rows=5`;
  const res = await fetchJson<{ message?: { items?: CrossrefWork[] } }>(ctx, url);
  const items = (res?.message?.items ?? []).filter((w) => {
    if (!accept) return true;
    const meta = metaFromCrossref(w, {});
    return accept(meta.authors, meta.authorFamilies);
  });
  return pickByTitle(title, items, (w) => w.title?.[0] ?? '', (w) => w['is-referenced-by-count'] ?? 0);
}

async function crossrefBibtex(doi: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${CROSSREF}/works/${encodeURIComponent(doi)}/transform/application/x-bibtex`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return text.startsWith('@') ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Semantic Scholar (merged preprint + published versions; closest to Google Scholar) ───
//
// The anonymous pool is tight (roughly one request per second shared), so a
// 429 is retried with growing backoff instead of being treated as "no data".

interface S2Paper {
  paperId?: string;
  title?: string;
  year?: number | null;
  venue?: string | null;
  publicationVenue?: { name?: string; type?: string } | null;
  citationCount?: number;
  referenceCount?: number;
  externalIds?: { DOI?: string; ArXiv?: string };
  authors?: Array<{ name?: string }>;
}

const S2_FIELDS = 'paperId,title,year,venue,publicationVenue,citationCount,referenceCount,externalIds,authors';
const S2_BACKOFF_MS = [2_000, 5_000, 10_000, 20_000];
let s2ApiKey = '';

export function s2Headers(): Record<string, string> | undefined {
  return s2ApiKey ? { 'x-api-key': s2ApiKey } : undefined;
}

/** null = not found or (after all retries) still rate-limited: then `ctx.limited` has Semantic Scholar. */
async function semanticScholarByIds(ctx: LookupContext, ids: PaperIdentifiers, backoff: number[] = S2_BACKOFF_MS): Promise<S2Paper | null> {
  const key = ids.arxivId ? `arXiv:${ids.arxivId}` : ids.doi ? `DOI:${ids.doi}` : null;
  if (!key) return null;
  ctx.limited.delete('Semantic Scholar'); // this answer's verdict, not an earlier one's
  return fetchJson<S2Paper>(ctx, `${SEMANTIC_SCHOLAR}/paper/${encodeURIComponent(key)}?fields=${S2_FIELDS}`, 10_000, backoff, s2Headers());
}

/**
 * Title lookup for papers only Semantic Scholar indexes (course reports,
 * workshop papers without DOIs). Its match endpoint answers with the single
 * closest title, which must still clear the usual similarity threshold.
 */
async function semanticScholarByTitle(ctx: LookupContext, title: string, accept?: AuthorCheck, backoff: number[] = [2_000, 5_000]): Promise<S2Paper | null> {
  ctx.limited.delete('Semantic Scholar');
  const url = `${SEMANTIC_SCHOLAR}/paper/search/match?query=${encodeURIComponent(title)}&fields=${S2_FIELDS}`;
  const page = await fetchJson<{ data?: S2Paper[] }>(ctx, url, 10_000, backoff, s2Headers());
  const data = (page?.data ?? []).filter((p) => !accept || accept((p.authors ?? []).map((a) => a.name ?? '').filter(Boolean)));
  return pickByTitle(title, data, (p) => p.title ?? '', (p) => p.citationCount ?? 0);
}

// Semantic Scholar's DOI for a paper is only a candidate: enrich() adopts it
// once its record checks out as the published version (isPublishedVersion).
function s2Doi(paper: S2Paper): string | null {
  const doi = paper.externalIds?.DOI ? normalizeDoi(paper.externalIds.DOI) : null;
  return doi && !arxivIdFromDoi(doi) ? doi : null;
}

function metaFromS2(paper: S2Paper, ids: PaperIdentifiers): PaperMeta {
  const raw = paper.externalIds?.DOI ? normalizeDoi(paper.externalIds.DOI) : null;
  const arxivFromDoi = raw ? arxivIdFromDoi(raw) : null;
  const doi = ids.doi ?? null;
  const venueType = paper.publicationVenue?.type ?? null;
  return {
    title: paper.title ?? '',
    year: paper.year ?? null,
    authors: (paper.authors ?? []).map((a) => a.name ?? '').filter(Boolean),
    venue: paper.publicationVenue?.name || paper.venue || null,
    venueType,
    workType: doi ? 'article' : (ids.arxivId || paper.externalIds?.ArXiv || arxivFromDoi ? 'preprint' : null),
    doi,
    arxivId: ids.arxivId ?? paper.externalIds?.ArXiv ?? arxivFromDoi,
    openalexId: null,
    citations: { openalex: null, crossref: null, semanticScholar: paper.citationCount ?? null },
    citationsByYear: [],
    references: { openalex: null, crossref: null, semanticScholar: paper.referenceCount ?? null },
    venueTwoYearMeanCitedness: null,
    volume: null,
    issue: null,
    firstPage: null,
    lastPage: null,
    landingUrl: doi ? `https://doi.org/${doi}` : null,
    s2PaperId: paper.paperId ?? null,
  };
}

/** Folds Semantic Scholar counts into an existing meta (its DOI is checked separately). */
function enrichWithS2(meta: PaperMeta, paper: S2Paper): PaperMeta {
  return {
    ...meta,
    citations: { ...meta.citations, semanticScholar: paper.citationCount ?? null },
    references: { ...meta.references, semanticScholar: paper.referenceCount ?? null },
    s2PaperId: paper.paperId ?? meta.s2PaperId ?? null,
    ...(meta.venue && !/arxiv/iu.test(meta.venue) || !paper.publicationVenue?.name ? {} : {
      // The published venue Semantic Scholar knows (conference / journal), with its kind.
      venueType: paper.publicationVenue.type ?? meta.venueType,
      workType: paper.publicationVenue.type === 'conference' || paper.publicationVenue.type === 'journal' ? 'article' : meta.workType,
    }),
    venue: meta.venue && !/arxiv/iu.test(meta.venue) ? meta.venue : (paper.publicationVenue?.name ?? meta.venue),
    year: meta.year ?? paper.year ?? null,
  };
}

// ─── arXiv's own API (fallback for arXiv ids) ───

const ARXIV_API = 'https://export.arxiv.org/api/query';

async function arxivById(ctx: LookupContext, id: string): Promise<PaperMeta | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${ARXIV_API}?id_list=${encodeURIComponent(id)}&max_results=1`, { signal: ctrl.signal });
    debugLog('paper', `fetch ${res.status}: ${ARXIV_API}`);
    if (!res.ok) return null;
    const xml = new DOMParser().parseFromString(await res.text(), 'application/xml');
    const entry = xml.getElementsByTagName('entry')[0];
    const text = (parent: Element, tag: string) => parent.getElementsByTagName(tag)[0]?.textContent?.replace(/\s+/gu, ' ').trim() || null;
    const title = entry ? text(entry, 'title') : null;
    if (!entry || !title || /^error$/iu.test(title)) return null;
    const published = text(entry, 'published');
    const journalRef = text(entry, 'arxiv:journal_ref');
    const doiRaw = text(entry, 'arxiv:doi');
    const doi = doiRaw ? normalizeDoi(doiRaw.split(/\s+/u)[0]) : null;
    const year = published ? Number(published.slice(0, 4)) : NaN;
    return {
      title,
      year: Number.isFinite(year) ? year : null,
      authors: Array.from(entry.getElementsByTagName('author')).map((a) => text(a, 'name') ?? '').filter(Boolean),
      venue: journalRef ?? 'arXiv',
      venueType: journalRef ? null : 'repository',
      workType: doi ? 'article' : 'preprint',
      doi,
      arxivId: id,
      openalexId: null,
      citations: { openalex: null, crossref: null, semanticScholar: null },
      citationsByYear: [],
      references: { openalex: null, crossref: null, semanticScholar: null },
      venueTwoYearMeanCitedness: null,
      volume: null,
      issue: null,
      firstPage: null,
      lastPage: null,
      landingUrl: `https://arxiv.org/abs/${id}`,
    };
  } catch {
    ctx.networkFailures += 1;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Detection from the PDF itself ───

interface TextItemLike { str: string; height: number; transform: number[] }

async function firstPageText(doc: PDFDocumentProxy): Promise<{ text: string; bigTitle: string | null }> {
  try {
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const items = (content.items as unknown as Array<Partial<TextItemLike>>)
      .filter((it): it is TextItemLike => typeof it.str === 'string' && typeof it.height === 'number' && Array.isArray(it.transform));
    const text = items.map((it) => it.str).join(' ').slice(0, FIRST_PAGE_TEXT_LIMIT);
    // Title heuristic: the tallest glyph runs near the top of the page.
    const viewport = page.getViewport({ scale: 1 });
    const maxHeight = Math.max(0, ...items.map((it) => it.height));
    const topBand = viewport.height * 0.55;
    const big = items
      .filter((it) => it.height >= maxHeight * 0.85 && it.str.trim() && (viewport.height - it.transform[5]) <= topBand)
      .map((it) => it.str.trim());
    const bigTitle = big.join(' ').replace(/\s+/gu, ' ').trim();
    return { text, bigTitle: bigTitle.length >= 12 && bigTitle.length <= 300 ? bigTitle : null };
  } catch {
    return { text: '', bigTitle: null };
  }
}

async function metadataIdentifiers(doc: PDFDocumentProxy): Promise<{ ids: PaperIdentifiers; title: string | null }> {
  try {
    const { info, metadata } = await doc.getMetadata();
    const rec = (info ?? {}) as Record<string, unknown>;
    const fields = ['Subject', 'Keywords', 'Title', 'doi', 'DOI'].map((k) => String(rec[k] ?? '')).join(' ');
    let xmp = '';
    try {
      const md = metadata as { getAll?: () => Record<string, unknown> } | null;
      const all = md?.getAll?.() ?? {};
      xmp = Object.values(all).map((v) => (typeof v === 'string' ? v : '')).join(' ');
    } catch {
      /* no XMP */
    }
    const title = typeof rec.Title === 'string' && rec.Title.trim().length >= 12 && !/\.pdf$/iu.test(rec.Title.trim())
      ? rec.Title.trim()
      : null;
    return { ids: identifiersFromText(`${fields} ${xmp}`), title };
  } catch {
    return { ids: {}, title: null };
  }
}

// ─── Resolution ───
//
// `primary` returns as soon as one source identified the paper (the strip is
// rendered immediately); `enrich` then folds in OpenAlex's per-year citations
// and the venue's 2-year mean citedness when available.

interface Resolved {
  meta: PaperMeta;
  openAlexWork: OpenAlexWork | null;
  s2?: S2Paper | null;
  /** A DOI the record carries that may be the published version (checked in enrich). */
  candidateDoi?: string | null;
}
/** Transient (never cached): Semantic Scholar could not be consulted, so the total may be low. */
const s2Unavailable = new WeakSet<PaperMeta>();

// Crossref records that are a whole volume or series, not one paper: a DOI
// cut at a line break often lands on the proceedings itself.
const CONTAINER_TYPES = /^(?:proceedings|journal|journal-issue|journal-volume|book-series|proceedings-series|book-set|report-series|component|database)$/iu;

/** What the PDF itself says, to check looked-up records against. */
interface DocumentEvidence { titles: string[]; pageText: string }

/** A record found by id is trusted only if it is this document (PDFs without text cannot tell). */
function isThisDocument(title: string, evidence: DocumentEvidence): boolean {
  if (evidence.pageText.trim().length < 200 && evidence.titles.length === 0) return true;
  return recordMatchesDocument(title, evidence.titles, evidence.pageText);
}

async function resolvePrimary(ctx: LookupContext, ids: PaperIdentifiers, titles: string[], evidence: DocumentEvidence): Promise<Resolved | null> {
  if (ids.doi) {
    const [cr, oa] = await Promise.all([crossrefByDoi(ctx, ids.doi), openAlexByDoi(ctx, ids.doi)]);
    const title = cr?.title?.[0] ?? oa?.display_name ?? '';
    if ((cr || oa) && (CONTAINER_TYPES.test(cr?.type ?? '') || !isThisDocument(title, evidence))) {
      debugLog('paper', 'ignored a DOI whose record is not this document', () => ({ doi: ids.doi, title, type: cr?.type }));
    } else {
      if (cr) return { meta: oa ? enrichWithOpenAlex(metaFromCrossref(cr, ids), oa) : metaFromCrossref(cr, ids), openAlexWork: oa };
      if (oa) return { meta: metaFromOpenAlex(oa, ids), openAlexWork: oa };
    }
  }
  if (ids.arxivId) {
    const oa = await openAlexByDoi(ctx, `10.48550/arXiv.${ids.arxivId}`);
    if (oa && isThisDocument(oa.display_name ?? '', evidence)) return arxivRecord(metaFromOpenAlex(oa, ids), oa);
    if (oa) debugLog('paper', 'ignored an OpenAlex arXiv record that is not this document', () => ({ title: oa.display_name }));
    // arXiv itself: always there for an arXiv id, no daily budget, and it
    // carries the DOI the authors gave for the published version.
    const ax = await arxivById(ctx, ids.arxivId);
    if (ax) return { meta: ax, openAlexWork: null };
  }
  if (ids.doi || ids.arxivId) {
    // As a last-resort primary source (Crossref and OpenAlex both missed the
    // id) retry only briefly: an unknown id is the likely reason, and a long
    // backoff would just delay the "not found" verdict.
    const s2 = await semanticScholarByIds(ctx, ids, [2_000]);
    if (s2 && isThisDocument(s2.title ?? '', evidence)) return { meta: metaFromS2(s2, ids), openAlexWork: null, s2 };
  }
  // By title alone: a hit counts only if its first author is on page 1.
  const accept: AuthorCheck = (authors, authorFamilies) => titleMatchConfirmed({ authors, authorFamilies }, evidence.pageText);
  const byTitle = (resolved: Resolved): Resolved => ({ ...resolved, meta: { ...resolved.meta, matchedBy: 'title' } });
  for (const title of titles) {
    const oa = await openAlexByTitle(ctx, title, accept);
    if (oa) return byTitle({ meta: metaFromOpenAlex(oa, ids), openAlexWork: oa });
    const cr = await crossrefByTitle(ctx, title, accept);
    if (cr && !CONTAINER_TYPES.test(cr.type ?? '')) return byTitle({ meta: metaFromCrossref(cr, ids), openAlexWork: null });
  }
  // Last resort, after every title missed the open databases: Semantic
  // Scholar's pool is rate-limited, so it is asked once per title only here.
  for (const title of titles) {
    const s2 = await semanticScholarByTitle(ctx, title, accept);
    if (s2) return byTitle({ meta: metaFromS2(s2, ids), openAlexWork: null, s2 });
  }
  return null;
}

/**
 * OpenAlex's record of an arXiv paper, repaired: the year is the arXiv
 * posting year (records get re-dated by later copies), and a non-arXiv DOI
 * on it is only a candidate for the published version — OpenAlex merges
 * re-posts and spam copies into arXiv records.
 */
function arxivRecord(meta: PaperMeta, work: OpenAlexWork): Resolved {
  const idYear = meta.arxivId ? arxivIdYear(meta.arxivId) : null;
  const year = idYear && (!meta.year || meta.year > idYear) ? idYear : meta.year;
  if (!meta.doi) return { meta: { ...meta, year }, openAlexWork: work };
  return {
    meta: { ...meta, year, doi: null, workType: 'preprint', landingUrl: meta.arxivId ? `https://arxiv.org/abs/${meta.arxivId}` : meta.landingUrl },
    openAlexWork: work,
    candidateDoi: meta.doi,
  };
}

/** The record a candidate DOI points to, in the form the published-version check reads. */
async function workSummary(ctx: LookupContext, doi: string): Promise<{ summary: WorkSummary | null; openAlex: OpenAlexWork | null; firstAuthor: string | null }> {
  const published = await openAlexByDoi(ctx, doi);
  if (published) {
    return {
      summary: { title: published.display_name ?? '', year: published.publication_year ?? null, type: published.type ?? null, repository: published.primary_location?.source?.type === 'repository' },
      openAlex: published,
      firstAuthor: published.authorships?.[0]?.author?.display_name ?? null,
    };
  }
  const record = await crossrefByDoi(ctx, doi);
  if (!record) return { summary: null, openAlex: null, firstAuthor: null };
  return {
    summary: { title: record.title?.[0] ?? '', year: record.issued?.['date-parts']?.[0]?.[0] ?? null, type: record.type ?? null, repository: false },
    openAlex: null,
    firstAuthor: record.author?.[0] ? record.author[0].family ?? record.author[0].name ?? null : null,
  };
}

/** Same first author (by surname), when both sides name one. */
function sameFirstAuthor(authors: readonly string[], other: string | null): boolean {
  if (!authors[0] || !other) return true;
  const a = normalizeTitle(splitAuthor(authors[0]).last);
  const b = normalizeTitle(other);
  return !!a && (b.includes(a) || a.includes(b.split(' ').pop() ?? b));
}

async function enrich(ctx: LookupContext, resolved: Resolved): Promise<PaperMeta> {
  let { meta } = resolved;
  let work = resolved.openAlexWork;
  // Semantic Scholar merges preprint and published versions (like Google
  // Scholar), so it supplies the most complete count and, for a preprint, the
  // DOI of the published version — which then unlocks the OpenAlex/Crossref
  // records of that version (per-year citations, venue, references).
  let s2Failed = false;
  const s2 = resolved.s2 ?? (meta.citations.semanticScholar === null
    ? await semanticScholarByIds(ctx, { doi: meta.doi ?? undefined, arxivId: meta.arxivId ?? undefined })
    : null);
  if (s2) meta = enrichWithS2(meta, s2);
  else if (!resolved.s2 && meta.citations.semanticScholar === null && ctx.limited.has('Semantic Scholar')) s2Failed = true;
  // A preprint's published version: a DOI the records name, or Crossref's
  // best title match — each adopted only if it checks out.
  let published = false;
  if (!meta.doi) {
    const candidates = [resolved.candidateDoi ?? null, s2 ? s2Doi(s2) : null].filter((d): d is string => !!d);
    if (meta.arxivId || meta.workType === 'preprint') {
      const byTitle = meta.title ? await crossrefByTitle(ctx, meta.title) : null;
      const doi = byTitle?.DOI ? normalizeDoi(byTitle.DOI) : null;
      if (doi && !arxivIdFromDoi(doi) && /^(?:journal-article|proceedings-article|book-chapter)$/u.test(byTitle?.type ?? '')) candidates.push(doi);
    }
    for (const candidate of [...new Set(candidates)]) {
      const found = await workSummary(ctx, candidate);
      if (found.summary && isPublishedVersion({ title: meta.title, year: meta.year }, found.summary) && sameFirstAuthor(meta.authors, found.firstAuthor)) {
        meta = { ...meta, doi: candidate, landingUrl: `https://doi.org/${candidate}` };
        published = true;
        if (found.openAlex) { work = found.openAlex; meta = enrichWithOpenAlex(meta, found.openAlex); }
        break;
      }
      debugLog('paper', 'ignored a DOI that is not the published version', () => ({ candidate, summary: found.summary }));
    }
  }
  const isPreprintWork = !work || work.type === 'preprint' || /arxiv/iu.test(work.primary_location?.source?.display_name ?? '');
  if (meta.doi && (!work || (isPreprintWork && (work.doi ?? '').toLowerCase().includes('arxiv')))) {
    const record = await openAlexByDoi(ctx, meta.doi);
    if (record) { work = record; meta = enrichWithOpenAlex(meta, record); }
  }
  const sourceId = work?.primary_location?.source?.type === 'repository' ? null : work?.primary_location?.source?.id;
  const [twoYear, crossref] = await Promise.all([
    sourceId ? openAlexSourceStats(ctx, sourceId) : Promise.resolve(null),
    meta.doi && meta.citations.crossref === null ? crossrefByDoi(ctx, meta.doi) : Promise.resolve(null),
  ]);
  if (twoYear !== null) meta = { ...meta, venueTwoYearMeanCitedness: twoYear };
  if (crossref) {
    const cr = metaFromCrossref(crossref, { doi: meta.doi ?? undefined, arxivId: meta.arxivId ?? undefined });
    const wasPreprint = !meta.venue || meta.venueType === 'repository' || /arxiv/iu.test(meta.venue);
    // A preprint that turned out to be published: the published venue AND
    // its year, so the strip, APA and BibTeX agree.
    const usePublished = (published || wasPreprint) && !!cr.venue;
    meta = {
      ...meta,
      citations: { ...meta.citations, crossref: crossref['is-referenced-by-count'] ?? null },
      references: { ...meta.references, crossref: crossref['reference-count'] ?? null },
      venue: usePublished ? cr.venue : meta.venue,
      venueType: usePublished ? cr.venueType : (meta.venueType ?? cr.venueType),
      workType: cr.workType ?? meta.workType,
      year: usePublished ? cr.year ?? meta.year : meta.year ?? cr.year,
      volume: meta.volume ?? cr.volume,
      issue: meta.issue ?? cr.issue,
      firstPage: meta.firstPage ?? cr.firstPage,
      lastPage: meta.lastPage ?? cr.lastPage,
    };
  }
  if (s2Failed) s2Unavailable.add(meta);
  return meta;
}

/** Fills fields a cached meta from an older schema may lack, so renderers never see `undefined`. */
export function normalizeMeta(raw: Partial<PaperMeta> & Record<string, unknown>): PaperMeta {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const cit = (raw.citations ?? {}) as Record<string, unknown>;
  const ref = (raw.references ?? {}) as Record<string, unknown>;
  return {
    title: typeof raw.title === 'string' ? raw.title : '',
    year: num(raw.year),
    authors: Array.isArray(raw.authors) ? raw.authors.filter((a): a is string => typeof a === 'string') : [],
    venue: str(raw.venue),
    venueType: str(raw.venueType),
    workType: str(raw.workType),
    doi: str(raw.doi),
    arxivId: str(raw.arxivId),
    openalexId: str(raw.openalexId),
    citations: { openalex: num(cit.openalex), crossref: num(cit.crossref), semanticScholar: num(cit.semanticScholar) },
    citationsByYear: Array.isArray(raw.citationsByYear)
      ? raw.citationsByYear.filter((c) => c && typeof c.year === 'number' && typeof c.count === 'number')
      : [],
    references: { openalex: num(ref.openalex), crossref: num(ref.crossref), semanticScholar: num(ref.semanticScholar) },
    venueTwoYearMeanCitedness: num(raw.venueTwoYearMeanCitedness),
    volume: str(raw.volume),
    issue: str(raw.issue),
    firstPage: str(raw.firstPage),
    lastPage: str(raw.lastPage),
    landingUrl: str(raw.landingUrl),
    referencedWorks: Array.isArray(raw.referencedWorks) ? raw.referencedWorks.filter((w): w is string => typeof w === 'string') : [],
    s2PaperId: str(raw.s2PaperId),
    // Aligned with `authors`; without it APA would split "Chue Hong" wrongly.
    ...(Array.isArray(raw.authorFamilies) ? { authorFamilies: raw.authorFamilies.map((f) => (typeof f === 'string' ? f : null)) } : {}),
    ...(raw.matchedBy === 'title' ? { matchedBy: 'title' as const } : {}),
  };
}

async function readCache(key: string): Promise<PaperMeta | null> {
  const entry = await readPaperCache<CacheEntry>(CACHE_PREFIX + key);
  return entry?.meta ? normalizeMeta(entry.meta as Partial<PaperMeta> & Record<string, unknown>) : null;
}

function dropCache(key: string): Promise<void> {
  return dropPaperCache(CACHE_PREFIX + key);
}

function writeCache(key: string, meta: PaperMeta): Promise<void> {
  return writePaperCache(CACHE_PREFIX + key, { meta } satisfies CacheEntry);
}

// ─── Without the strip (background upkeep, ui/pdfUpkeep.ts) ───

/** What a document says about itself, and the cache key a lookup goes under. */
export interface PaperEvidence {
  ids: PaperIdentifiers;
  titles: string[];
  evidence: DocumentEvidence;
  key: string | null;
  /** The PDF's own Title metadata, when it names something. */
  docTitle: string | null;
}

export function paperCacheKey(ids: PaperIdentifiers, titles: readonly string[]): string | null {
  return ids.doi ?? (ids.arxivId ? `arxiv:${ids.arxivId}` : titles[0] ? `title:${normalizeTitle(titles[0])}` : null);
}

export async function paperEvidence(doc: PDFDocumentProxy, sourceUrl: string | null): Promise<PaperEvidence> {
  const [fromMeta, page] = await Promise.all([metadataIdentifiers(doc), firstPageText(doc)]);
  const ids = mergeIdentifiers(sourceUrl ? identifiersFromUrl(sourceUrl) : {}, fromMeta.ids, identifiersFromText(page.text));
  const titles = [fromMeta.title, page.bigTitle].filter((t): t is string => !!t && !isGenericTitle(t));
  const docTitle = fromMeta.title && !isGenericTitle(fromMeta.title) ? fromMeta.title : null;
  return { ids, titles, evidence: { titles, pageText: page.text }, key: paperCacheKey(ids, titles), docTitle };
}

/** Whether lookups are on, with the user's API keys applied. */
export async function loadPaperSettings(): Promise<boolean> {
  s2ApiKey = (await getSetting<string>(SEMANTIC_SCHOLAR_API_KEY_SETTING_KEY, '')).trim();
  setOpenAlexApiKey(await getSetting<string>(OPENALEX_API_KEY_SETTING_KEY, ''));
  return getSetting(PAPER_INFO_ENABLED_SETTING_KEY, DEFAULT_PAPER_INFO_ENABLED);
}

/**
 * A cached paper good enough to describe a library row: found by an
 * identifier, not by its title alone (that one only shows in the strip).
 */
export function cachedPaperMeta(key: string): Promise<PaperMeta | null> {
  return readCache(key).then((meta) => (meta && meta.matchedBy !== 'title' ? tidyPaperMeta(meta) : null));
}

/**
 * Resolves and enriches like the strip, shows nothing, and caches the result
 * as the strip would. `meta` only for a paper found by an identifier (as
 * cachedPaperMeta). `limited`: no answer because of a rate limit, a spent
 * budget or a network failure — worth trying again later, not now.
 */
export async function lookupPaperQuietly(found: PaperEvidence): Promise<{ meta: PaperMeta | null; limited: boolean }> {
  const ctx = newLookup();
  const primary = await resolvePrimary(ctx, found.ids, found.titles, found.evidence);
  if (!primary) return { meta: null, limited: ctx.networkFailures > 0 || openAlexBudgetSpent() || ctx.limited.size > 0 };
  const raw = await enrich(ctx, primary);
  const meta = tidyPaperMeta(raw);
  if (found.key && !s2Unavailable.has(raw) && !openAlexBudgetSpent()) await writeCache(found.key, meta);
  return { meta: meta.matchedBy === 'title' ? null : meta, limited: false };
}

// ─── UI ───

export class PaperStrip {
  private readonly root = byId<HTMLElement>('vocab-t-pdf-paper');
  private readonly body = byId<HTMLDivElement>('vt-paper-body');
  private readonly closeBtn = byId<HTMLButtonElement>('vt-paper-close');
  private readonly reparseBtn = byId<HTMLButtonElement>('vt-paper-reparse');
  private generation = 0;
  private current: { doc: PDFDocumentProxy; sourceUrl: string | null } | null = null;
  /** Documents (by fingerprint) whose strip the reader closed in this page. */
  private readonly dismissed = new Set<string>();
  private meta: PaperMeta | null = null;
  private bibtexCache: string | null = null;
  private readonly refs = new ReferenceList();

  /**
   * @param onLayoutChange called whenever the strip appears/disappears; the
   *   viewer container's top edge moves, so PDF.js must re-measure (the host
   *   dispatches its `resize` event, exactly as for the sidebar toggle).
   * @param onPaperMeta called with the resolved paper (its title names the
   *   document better than a file name like `2401.12345`).
   */
  constructor(private readonly onLayoutChange: () => void, private readonly onPaperMeta?: (meta: PaperMeta) => void) {
    this.closeBtn.addEventListener('click', () => this.dismiss());
    this.reparseBtn.addEventListener('click', () => {
      if (this.current) void this.show(this.current.doc, this.current.sourceUrl, { fresh: true });
    });
  }

  /** The resolved paper of the open document, if any. */
  get paperMeta(): PaperMeta | null {
    return this.meta;
  }

  /** × : the strip stays closed for this document, and a lookup still running stops. */
  dismiss(): void {
    this.generation += 1;
    const fingerprint = this.current?.doc.fingerprints[0];
    if (fingerprint) this.dismissed.add(fingerprint);
    this.hide();
  }

  hide(): void {
    const wasVisible = !this.root.hidden;
    this.root.hidden = true;
    document.body.classList.remove('vt-has-paper');
    this.refs.reset();
    if (wasVisible) this.onLayoutChange();
  }

  /** Kicks off the background reference lookup for a fully resolved meta. */
  private startReferences(meta: PaperMeta, key: string): void {
    void this.loadReferences(meta, key, this.generation);
  }

  /**
   * OpenAlex's list, else Semantic Scholar's (skipped when it was just rate
   * limited: the retries would only delay the next step), else the list
   * printed in the PDF.
   */
  private async loadReferences(meta: PaperMeta, key: string, gen: number): Promise<void> {
    // A database list far shorter than the paper's count (OpenAlex knowing 2
    // of 65) is replaced by the PDF's own list when that one is longer.
    const expected = bestReferenceCount(meta);
    const enough = () => this.refs.size > 0 && (expected === null || this.refs.size >= expected * 0.6);
    let loaded = false;
    if (meta.referencedWorks && meta.referencedWorks.length > 0) loaded = await this.refs.load(meta.referencedWorks, key);
    if (gen !== this.generation) return;
    const s2Limited = s2Unavailable.has(meta);
    if ((!loaded || !enough()) && meta.s2PaperId && !s2Limited) {
      const before = loaded ? this.refs.size : 0;
      const s2 = await this.refs.loadFromSemanticScholar(meta.s2PaperId, key, s2Headers());
      if (s2 && this.refs.size < before && meta.referencedWorks?.length) await this.refs.load(meta.referencedWorks, key);
      loaded = loaded || s2;
    }
    if (gen !== this.generation || !this.current) return;
    if (loaded && enough()) return;
    const refs = await pdfReferences(this.current.doc);
    if (gen !== this.generation) return;
    if (loaded && refs.length <= this.refs.size) return;
    const databases = openAlexBudgetSpent()
      ? S.refsBudgetSpent(s2Limited)
      : s2Limited
      ? S.refsS2Limited
      : meta.openalexId || meta.s2PaperId ? S.refsNoList : S.refsPaperNotFound;
    await this.refs.loadFromPdf(refs, key, S.refsNotInPdfEither(databases));
  }

  /**
   * Detects whether `doc` is a paper and renders the strip: the paper's data,
   * or a quiet "not a paper" note — reading never depends on it. `fresh`
   * (the 재파싱 button) skips and drops the cached lookup.
   */
  async show(doc: PDFDocumentProxy, sourceUrl: string | null, { fresh = false } = {}): Promise<void> {
    const gen = ++this.generation;
    this.current = { doc, sourceUrl };
    this.hide();
    this.meta = null;
    this.bibtexCache = null;
    if (this.dismissed.has(doc.fingerprints[0] ?? '')) return;
    try {
      if (!(await loadPaperSettings())) {
        debugLog('paper', 'paper info disabled by setting');
        return;
      }
      const { ids, titles, evidence } = await paperEvidence(doc, sourceUrl);
      if (gen !== this.generation) return;
      debugLog('paper', 'detection', () => ({ ids, titles, textSample: evidence.pageText.slice(0, 160) }));
      if (!ids.doi && !ids.arxivId && titles.length === 0) {
        this.renderStatus('none', S.notRecognized, S.notRecognizedNoIds);
        return;
      }
      const what = ids.doi ? S.whatDoi(ids.doi) : ids.arxivId ? S.whatArxiv(ids.arxivId) : S.whatTitle(titles[0].length > 60 ? `${titles[0].slice(0, 60).trimEnd()}…` : titles[0]);
      this.renderStatus('loading', S.lookingUp(what));

      const key = paperCacheKey(ids, titles) as string;
      if (fresh) await dropCache(key);
      // A title-only match is checked against this document again: another
      // document with the same title shares the key.
      const hit = fresh ? null : await readCache(key);
      const cached = hit && (hit.matchedBy !== 'title' || titleMatchConfirmed(hit, evidence.pageText)) ? hit : null;
      if (cached) {
        debugLog('paper', 'resolved (cache)', () => ({ key, meta: cached }));
        if (gen !== this.generation) return;
        this.meta = tidyPaperMeta(cached);
        this.render(this.meta);
        this.startReferences(this.meta, key);
        return;
      }
      const ctx = newLookup();
      let primary = await resolvePrimary(ctx, ids, titles, evidence);
      if (!primary && ctx.networkFailures > 0 && gen === this.generation) {
        debugLog('paper', `lookup hit ${ctx.networkFailures} network failure(s); retrying in ${NETWORK_RETRY_DELAY_MS}ms`);
        await new Promise((r) => setTimeout(r, NETWORK_RETRY_DELAY_MS));
        if (gen !== this.generation) return;
        primary = await resolvePrimary(ctx, ids, titles, evidence);
      }
      debugLog('paper', primary ? 'resolved (primary)' : 'no match', () => ({ key, meta: primary?.meta }));
      if (gen !== this.generation) return;
      if (!primary) {
        // A transient failure or a DOI/arXiv id nobody knows is worth a
        // warning; a title nobody knows most likely just isn't a paper.
        if (openAlexBudgetSpent()) {
          this.renderStatus('failed', `${what}: ${OPENALEX_BUDGET_REASON}`);
        } else if (ctx.networkFailures > 0) {
          this.renderStatus('failed', S.lookupFailedNetwork(what));
        } else if (ctx.limited.has('Semantic Scholar')) {
          this.renderStatus('failed', S.lookupFailedS2Limited(what));
        } else if (ctx.limited.size > 0) {
          this.renderStatus('failed', S.lookupFailedLimited(what, [...ctx.limited].join('·')));
        } else if (ids.doi || ids.arxivId) {
          this.renderStatus('failed', S.lookupFailedNotFound(what));
        } else {
          this.renderStatus('none', S.notRecognized, S.notRecognizedSearched(what));
        }
        return;
      }
      this.meta = tidyPaperMeta(primary.meta);
      this.render(this.meta);
      const raw = await enrich(ctx, primary);
      const enriched = tidyPaperMeta(raw);
      if (s2Unavailable.has(raw)) s2Unavailable.add(enriched);
      if (gen !== this.generation) return;
      debugLog('paper', 'enriched', () => ({ key, meta: enriched }));
      this.meta = enriched;
      this.bibtexCache = null;
      this.render(enriched);
      this.startReferences(enriched, key);
      // A lookup that Semantic Scholar rate-limited is incomplete: leave it
      // uncached so the next open tries again.
      if (!s2Unavailable.has(enriched) && !openAlexBudgetSpent()) void writeCache(key, enriched);
    } catch (error) {
      debugError('paper', 'paper strip failed', () => ({ error: error instanceof Error ? error.message : String(error) }));
      if (gen === this.generation) {
        this.renderStatus('failed', S.processingError(error instanceof Error ? error.message : String(error)));
      }
    }
  }

  /**
   * Strip with only the 논문정보 label and a status: 조회 중, ⚠︎ reason, or a
   * neutral "not a paper" note (`detail` on hover). Retrying is the 재파싱
   * button's job.
   */
  private renderStatus(kind: 'loading' | 'failed' | 'none', text: string, detail?: string): void {
    this.body.replaceChildren();
    const value = el('span', { className: 'vt-paper-value vt-paper-status', title: detail });
    if (kind === 'loading') {
      value.append(el('span', { className: 'vt-paper-spinner', 'aria-hidden': 'true' }), text);
    } else if (kind === 'failed') {
      value.append(el('span', { className: 'vt-warn-inline', textContent: '⚠︎ ' }), text);
    } else {
      value.append(text);
    }
    this.body.append(el('span', { className: 'vt-paper-seg' }, [el('span', { className: 'vt-paper-label', textContent: S.paperInfo }), value]));
    const wasHidden = this.root.hidden;
    this.root.hidden = false;
    document.body.classList.add('vt-has-paper');
    if (wasHidden) this.onLayoutChange();
  }

  private render(meta: PaperMeta): void {
    if (meta.title.trim()) this.onPaperMeta?.(meta);
    this.body.replaceChildren();
    const segment = (label: string, children: Array<Node | string>, title?: string) => el('span', { className: 'vt-paper-seg', title }, [
      el('span', { className: 'vt-paper-label', textContent: label }),
      el('span', { className: 'vt-paper-value' }, children),
    ]);
    // Missing data is never rendered as 0 or a default: a ⚠︎ with a one-line
    // reason on hover takes the value's place.
    const warn = (reason: string) => {
      const w = el('span', { className: 'vt-warn', tabindex: '0', role: 'img', 'aria-label': S.noInfo(reason) }, ['⚠︎']);
      w.append(el('span', { className: 'vt-warn-pop', textContent: reason }));
      return w;
    };
    const join = (parts: Array<Node | string | null>, sep = ' · ') => {
      const out: Array<Node | string> = [];
      for (const part of parts) { if (part === null) continue; if (out.length) out.push(sep); out.push(part); }
      return out;
    };

    // ── 논문정보: kind badge · venue · year, with a hover popover for details/links.
    const kind = classifyPaperKind(meta);
    const kindBadge = el('span', { className: `vt-kind vt-kind-${kind}`, textContent: kind, title: kindTitles()[kind] });
    const info = segment(S.paperInfo, join([
      kindBadge,
      meta.venue ?? (kind === 'preprint' ? null : warn(S.noVenue)),
      meta.year ? String(meta.year) : warn(S.noYear),
    ]));
    info.classList.add('vt-paper-info');
    info.setAttribute('tabindex', '0');
    info.append(this.buildPopover(meta));
    if (meta.matchedBy === 'title') {
      info.querySelector('.vt-paper-value')?.append(' ', el('span', { className: 'vt-paper-matched', textContent: S.matchedByTitle }));
    }
    this.body.append(info);

    // ── 2년/전체 인용수 + sparkline (hover → detailed chart)
    const total = bestCitationCount(meta);
    // The 2-year figure comes from OpenAlex's per-year counts. When OpenAlex
    // knows only a small share of the citations (an arXiv-only record of a
    // famous paper) it would sit next to another source's total as nonsense.
    const openAlexShare = total && typeof meta.citations.openalex === 'number' ? meta.citations.openalex / total : null;
    const partial = openAlexShare !== null && openAlexShare < 0.5;
    const recent = meta.year !== null && meta.year >= new Date().getFullYear() - 1;
    // A paper under two years old: every citation is a recent one.
    const twoYear = partial ? null : recentTwoYearCitations(meta) ?? (recent ? total : null);
    const twoYearWarning = openAlexBudgetSpent() ? OPENALEX_BUDGET_REASON
      : partial ? S.twoYearPartial(Math.round((openAlexShare ?? 0) * 100))
        : S.twoYearNoHistory;
    const history = citationHistory(meta);
    const sourcesDetail = [
      typeof meta.citations.semanticScholar === 'number' ? `Semantic Scholar ${formatCount(meta.citations.semanticScholar)}` : null,
      typeof meta.citations.openalex === 'number' ? `OpenAlex ${formatCount(meta.citations.openalex)}` : null,
      typeof meta.citations.crossref === 'number' ? `Crossref ${formatCount(meta.citations.crossref)}` : null,
    ].filter(Boolean).join(' · ');
    const cites = segment(S.citesLabel, [
      twoYear === null ? warn(twoYearWarning) : formatCount(twoYear),
      '/',
      total === null ? warn(S.noCitationCount) : formatCount(total),
      ...(s2Unavailable.has(meta) ? [' ', warn(S.s2RateLimited)] : []),
    ], total === null ? undefined : S.citesTooltip(sourcesDetail));
    if (history.some((p) => p.count > 0)) {
      const series = recentCitationSeries(meta);
      const max = Math.max(...series.map((p) => p.count));
      const spark = el('span', { className: 'vt-spark', tabindex: '0', 'aria-label': S.citationChartLabel });
      for (const p of series) {
        const bar = el('i');
        bar.style.height = `${Math.max(2, Math.round((p.count / Math.max(1, max)) * 16))}px`;
        spark.append(bar);
      }
      const chartPop = el('div', { className: 'vt-paper-pop vt-chart-pop', role: 'tooltip' }, [buildCitationChart(history)]);
      spark.append(chartPop);
      cites.append(spark);
    }
    this.body.append(cites);

    // ── 참고문헌 (hover → resolved reference list)
    const references = bestReferenceCount(meta);
    const refs = segment(S.referencesLabel, [references === null ? warn(S.noReferenceCount) : formatCount(references)]);
    // No database count: the PDF's own list gives it, once read.
    // No publisher count: the PDF's own list gives it, once read, when it is
    // more than the indexes know.
    this.refs.onPdfCount = meta.references.crossref ? null : (count) => {
      const value = refs.querySelector('.vt-paper-value');
      if (!value || this.meta !== meta || (references !== null && count <= references)) return;
      value.replaceChildren(formatCount(count));
      refs.title = S.referencesCountedFromPdf;
    };
    refs.classList.add('vt-paper-refs');
    refs.setAttribute('tabindex', '0');
    refs.append(this.refs.element);
    // Linking the PDF's own list by title costs a search per entry: done
    // when the reader looks at the list, a few at a time.
    const opened = () => this.refs.opened();
    refs.addEventListener('mouseenter', opened);
    refs.addEventListener('focusin', opened);
    this.body.append(refs);

    // ── right-aligned copy buttons
    const actions = el('span', { className: 'vt-paper-actions' });
    const copyBib = el('button', { type: 'button', className: 'vt-btn vt-btn-text vt-paper-copy', title: S.copyBibtex }, ['BibTeX']);
    copyBib.addEventListener('click', () => { void this.copy(copyBib, 'bibtex'); });
    const copyApa = el('button', { type: 'button', className: 'vt-btn vt-btn-text vt-paper-copy', title: S.copyApa }, ['APA']);
    copyApa.addEventListener('click', () => { void this.copy(copyApa, 'apa'); });
    actions.append(copyBib, copyApa);
    this.body.append(actions);

    const wasHidden = this.root.hidden;
    this.root.hidden = false;
    document.body.classList.add('vt-has-paper');
    if (wasHidden) this.onLayoutChange();
  }

  /** Floating panel under 논문정보: title, authors, links, venue 2-year citedness. */
  private buildPopover(meta: PaperMeta): HTMLElement {
    const pop = el('div', { className: 'vt-paper-pop', role: 'tooltip' });
    pop.append(el('div', { className: 'vt-paper-pop-title', textContent: meta.title }));
    if (meta.matchedBy === 'title') pop.append(el('div', { className: 'vt-paper-pop-fact vt-paper-matched-detail', textContent: S.matchedByTitleDetail }));
    if (meta.authors.length) {
      const shown = meta.authors.slice(0, 6).join(', ') + (meta.authors.length > 6 ? S.authorsMore(meta.authors.length - 6) : '');
      pop.append(el('div', { className: 'vt-paper-pop-authors', textContent: shown }));
    }
    const facts: string[] = [];
    if (meta.doi) facts.push(`DOI ${meta.doi}`);
    if (meta.arxivId) facts.push(`arXiv:${meta.arxivId}`);
    if (meta.venueType !== 'repository' && meta.workType !== 'preprint') {
      facts.push(meta.venueTwoYearMeanCitedness !== null
        ? S.venueMeanCitedness(meta.venueTwoYearMeanCitedness.toFixed(1))
        : S.noVenueMeanCitedness);
    }
    for (const f of facts) pop.append(el('div', { className: 'vt-paper-pop-fact', textContent: f }));
    const links = el('div', { className: 'vt-paper-links' });
    for (const link of scholarLinks(meta)) {
      links.append(el('a', { href: link.url, target: '_blank', rel: 'noopener noreferrer' }, [link.label]));
    }
    pop.append(links);
    return pop;
  }

  private async copy(button: HTMLButtonElement, kind: 'bibtex' | 'apa'): Promise<void> {
    const meta = this.meta;
    if (!meta) return;
    const original = button.textContent;
    button.disabled = true;
    try {
      let text: string;
      if (kind === 'apa') {
        text = formatApa(meta);
      } else {
        if (this.bibtexCache === null) {
          this.bibtexCache = (meta.doi ? await crossrefBibtex(meta.doi) : null) ?? formatBibtex(meta);
        }
        text = this.bibtexCache;
      }
      await navigator.clipboard.writeText(text);
      button.textContent = S.copied;
    } catch {
      button.textContent = S.copyFailed;
    } finally {
      setTimeout(() => { button.textContent = original; button.disabled = false; }, 1_500);
    }
  }
}
