// ─── Paper sources: OpenAlex, Crossref, Semantic Scholar, arXiv ───
//
// The clients the paper strip and its reference list share: one fetchJson
// with a per-lookup context (failures, which source rate-limited it), and
// each source's records mapped to PaperMeta. All four answer with
// `Access-Control-Allow-Origin: *`, so no extra host permission is needed.

import { debugLog } from '../../shared/debugLog';
import {
  type PaperIdentifiers,
  type PaperMeta,
  TITLE_MATCH_THRESHOLD,
  arxivIdFromDoi,
  normalizeDoi,
  titleSimilarity,
} from '../../shared/paperIdentifiers';
import { isOpenAlexUrl, noteOpenAlex429, openAlexBudgetSpent, openAlexUrl } from './openAlexAccess';

export const OPENALEX = 'https://api.openalex.org';
export const CROSSREF = 'https://api.crossref.org';
export const SEMANTIC_SCHOLAR = 'https://api.semanticscholar.org/graph/v1';
const WORK_SELECT = 'id,display_name,publication_year,cited_by_count,referenced_works_count,referenced_works,type,doi,ids,biblio,counts_by_year,primary_location,authorships';
/** What a reference list needs of each cited work. */
export const REF_WORK_SELECT = 'id,display_name,publication_year,cited_by_count,doi,primary_location,authorships';
const FETCH_TIMEOUT_MS = 12_000;

/** Where a request went, for saying who rate-limited a lookup. */
export type PaperSource = 'OpenAlex' | 'Crossref' | 'Semantic Scholar' | 'arXiv';

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

/**
 * GET as JSON through one lookup's context: null on any failure. OpenAlex goes
 * with the API key and stops once its daily budget is spent; a 429 is retried
 * per `retry` (true = once after 1.5 s; an array = the remaining delays), then
 * recorded against its source.
 */
export async function fetchJson<T>(ctx: LookupContext, url: string, timeoutMs = FETCH_TIMEOUT_MS, retry: boolean | number[] = true, headers?: Record<string, string>): Promise<T | null> {
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

export interface OpenAlexWork {
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

export async function openAlexByDoi(ctx: LookupContext, doi: string): Promise<OpenAlexWork | null> {
  const url = `${OPENALEX}/works?filter=doi:${encodeURIComponent(doi)}&per-page=1&select=${encodeURIComponent(WORK_SELECT)}`;
  const page = await fetchJson<{ results?: OpenAlexWork[] }>(ctx, url, OPENALEX_TIMEOUT_MS);
  return page?.results?.[0] ?? null;
}

/** Only candidates `accept` passes (whose first author the PDF names, for a title-only match). */
export type AuthorCheck = (authors: string[], families?: Array<string | null>) => boolean;

export async function openAlexByTitle(ctx: LookupContext, title: string, accept?: AuthorCheck): Promise<OpenAlexWork | null> {
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

export function pickByTitle<T>(title: string, candidates: T[], titleOf: (c: T) => string, weightOf: (c: T) => number): T | null {
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

export function metaFromOpenAlex(work: OpenAlexWork, ids: PaperIdentifiers): PaperMeta {
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
export function enrichWithOpenAlex(meta: PaperMeta, work: OpenAlexWork): PaperMeta {
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

export async function openAlexSourceStats(ctx: LookupContext, sourceId: string): Promise<number | null> {
  const id = sourceId.split('/').pop();
  if (!id) return null;
  const src = await fetchJson<{ summary_stats?: { '2yr_mean_citedness'?: number } }>(
    ctx, `${OPENALEX}/sources/${id}?select=summary_stats`, OPENALEX_TIMEOUT_MS,
  );
  const value = src?.summary_stats?.['2yr_mean_citedness'];
  return typeof value === 'number' ? value : null;
}

// ─── Crossref (primary for DOIs: fast, reliable, BibTeX) ───

export interface CrossrefWork {
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

export function metaFromCrossref(work: CrossrefWork, ids: PaperIdentifiers): PaperMeta {
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

export async function crossrefByDoi(ctx: LookupContext, doi: string): Promise<CrossrefWork | null> {
  const res = await fetchJson<{ message?: CrossrefWork }>(ctx, `${CROSSREF}/works/${encodeURIComponent(doi)}`);
  return res?.message ?? null;
}

export async function crossrefByTitle(ctx: LookupContext, title: string, accept?: AuthorCheck): Promise<CrossrefWork | null> {
  const url = `${CROSSREF}/works?query.bibliographic=${encodeURIComponent(title)}&rows=5`;
  const res = await fetchJson<{ message?: { items?: CrossrefWork[] } }>(ctx, url);
  const items = (res?.message?.items ?? []).filter((w) => {
    if (!accept) return true;
    const meta = metaFromCrossref(w, {});
    return accept(meta.authors, meta.authorFamilies);
  });
  return pickByTitle(title, items, (w) => w.title?.[0] ?? '', (w) => w['is-referenced-by-count'] ?? 0);
}

export async function crossrefBibtex(doi: string): Promise<string | null> {
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

export interface S2Paper {
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

export function setS2ApiKey(key: string): void {
  s2ApiKey = key.trim();
}

export function s2Headers(): Record<string, string> | undefined {
  return s2ApiKey ? { 'x-api-key': s2ApiKey } : undefined;
}

/** null = not found or (after all retries) still rate-limited: then `ctx.limited` has Semantic Scholar. */
export async function semanticScholarByIds(ctx: LookupContext, ids: PaperIdentifiers, backoff: number[] = S2_BACKOFF_MS): Promise<S2Paper | null> {
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
export async function semanticScholarByTitle(ctx: LookupContext, title: string, accept?: AuthorCheck, backoff: number[] = [2_000, 5_000]): Promise<S2Paper | null> {
  ctx.limited.delete('Semantic Scholar');
  const url = `${SEMANTIC_SCHOLAR}/paper/search/match?query=${encodeURIComponent(title)}&fields=${S2_FIELDS}`;
  const page = await fetchJson<{ data?: S2Paper[] }>(ctx, url, 10_000, backoff, s2Headers());
  const data = (page?.data ?? []).filter((p) => !accept || accept((p.authors ?? []).map((a) => a.name ?? '').filter(Boolean)));
  return pickByTitle(title, data, (p) => p.title ?? '', (p) => p.citationCount ?? 0);
}

// Semantic Scholar's DOI for a paper is only a candidate: enrich() adopts it
// once its record checks out as the published version (isPublishedVersion).
export function s2Doi(paper: S2Paper): string | null {
  const doi = paper.externalIds?.DOI ? normalizeDoi(paper.externalIds.DOI) : null;
  return doi && !arxivIdFromDoi(doi) ? doi : null;
}

export function metaFromS2(paper: S2Paper, ids: PaperIdentifiers): PaperMeta {
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
export function enrichWithS2(meta: PaperMeta, paper: S2Paper): PaperMeta {
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

export async function arxivById(ctx: LookupContext, id: string): Promise<PaperMeta | null> {
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
