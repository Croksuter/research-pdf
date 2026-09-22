// Paper strip: when the open PDF is a scholarly paper, a row under the toolbar
// shows venue / year, citation count (+ 5-year trend), the venue's 2-year mean
// citedness (the Impact-Factor definition, from OpenAlex), reference count,
// external links, and BibTeX / APA copy buttons.
//
// Detection: DOI or arXiv id from the source URL, the PDF metadata, or the
// first page's text; otherwise the largest-font text on page 1 is title-
// searched and accepted only above TITLE_MATCH_THRESHOLD. Data comes from
// OpenAlex and Crossref, both of which answer with `Access-Control-Allow-
// Origin: *`, so no extra host permission is needed. Google Scholar has no API
// and is linked, not scraped. Results are cached for a week.

import type { PDFDocumentProxy } from 'pdfjs-dist';
import { getSetting } from '../../db/settingsRepository';
import { debugError, debugLog } from '../../shared/debugLog';
import { DEFAULT_PAPER_INFO_ENABLED, PAPER_INFO_ENABLED_SETTING_KEY, SEMANTIC_SCHOLAR_API_KEY_SETTING_KEY } from '../../shared/constants';
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
  titleSimilarity,
} from '../../shared/paperIdentifiers';
import { byId, el } from './dom';
import { buildCitationChart } from './paperChart';
import { ReferenceList } from './paperRefs';

const OPENALEX = 'https://api.openalex.org';
const CROSSREF = 'https://api.crossref.org';
const SEMANTIC_SCHOLAR = 'https://api.semanticscholar.org/graph/v1';
const WORK_SELECT = 'id,display_name,publication_year,cited_by_count,referenced_works_count,referenced_works,type,doi,ids,biblio,counts_by_year,primary_location,authorships';
// Bumped whenever PaperMeta gains fields: an entry from an older build must
// not be rendered with a newer renderer.
const CACHE_PREFIX = 'vtPaperMeta:v2:';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;
// Whole first page: the arXiv margin stamp is rotated text and comes last in
// the item order, so a short cap used to miss it.
const FIRST_PAGE_TEXT_LIMIT = 20_000;
// Right after Chrome starts, requests from extension pages can stall for
// ~20 s (observed in fresh profiles); a lookup that failed only because of
// aborted/errored fetches is retried once after this delay.
const NETWORK_RETRY_DELAY_MS = 15_000;
let networkFailures = 0;

const KIND_TITLE: Record<string, string> = {
  survey: '서베이/리뷰 논문 (제목·유형으로 판별)',
  conference: '학회(컨퍼런스) 논문',
  journal: '저널 논문',
  technical: '기술 보고서 / 학위논문',
  preprint: '프리프린트 (출판본 미확인)',
};

interface CacheEntry { fetchedAt: number; meta: PaperMeta }

let lastRateLimited = false;

async function fetchJson<T>(url: string, timeoutMs = FETCH_TIMEOUT_MS, retry: boolean | number[] = true, headers?: Record<string, string>): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const startedAt = performance.now();
  const label = url.replace(/\?.*$/u, '').slice(0, 90);
  // `retry`: true = one 1.5 s retry on 429; an array = remaining backoff delays.
  const backoff = retry === true ? [1_500] : retry === false ? [] : retry;
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers });
    if (res.status === 429 && backoff.length > 0) {
      debugLog('paper', `fetch 429, retrying in ${backoff[0]}ms: ${label}`);
      await new Promise((r) => setTimeout(r, backoff[0]));
      return fetchJson<T>(url, timeoutMs, backoff.slice(1), headers);
    }
    if (res.status === 429) lastRateLimited = true;
    debugLog('paper', `fetch ${res.status} in ${Math.round(performance.now() - startedAt)}ms: ${label}`);
    if (!res.ok) return null;
    return await res.json() as T;
  } catch (error) {
    networkFailures += 1;
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

async function openAlexByDoi(doi: string): Promise<OpenAlexWork | null> {
  const url = `${OPENALEX}/works?filter=doi:${encodeURIComponent(doi)}&per-page=1&select=${encodeURIComponent(WORK_SELECT)}`;
  const page = await fetchJson<{ results?: OpenAlexWork[] }>(url, OPENALEX_TIMEOUT_MS);
  return page?.results?.[0] ?? null;
}

async function openAlexByTitle(title: string): Promise<OpenAlexWork | null> {
  const url = `${OPENALEX}/works?search=${encodeURIComponent(title)}&per-page=5&select=${encodeURIComponent(WORK_SELECT)}`;
  const page = await fetchJson<{ results?: OpenAlexWork[] }>(url, OPENALEX_TIMEOUT_MS, false);
  return pickByTitle(title, page?.results ?? [], (w) => w.display_name ?? '', (w) => w.cited_by_count ?? 0);
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
  return {
    title: work.display_name ?? '',
    year: work.publication_year ?? null,
    authors: (work.authorships ?? []).map((a) => a.author?.display_name ?? '').filter(Boolean),
    venue: source?.display_name ?? null,
    venueType: source?.type ?? null,
    workType: work.type ?? null,
    doi: doi && !arxivFromDoi ? doi : (ids.doi ?? null),
    arxivId: ids.arxivId ?? arxivFromDoi,
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

async function openAlexSourceStats(sourceId: string): Promise<number | null> {
  const id = sourceId.split('/').pop();
  if (!id) return null;
  const src = await fetchJson<{ summary_stats?: { '2yr_mean_citedness'?: number } }>(
    `${OPENALEX}/sources/${id}?select=summary_stats`, OPENALEX_TIMEOUT_MS,
  );
  const value = src?.summary_stats?.['2yr_mean_citedness'];
  return typeof value === 'number' ? value : null;
}

// ─── Crossref (primary for DOIs: fast, reliable, BibTeX) ───

interface CrossrefWork {
  DOI?: string;
  title?: string[];
  author?: Array<{ given?: string; family?: string; name?: string }>;
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
    venue: work['container-title']?.[0] ?? null,
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
    firstPage: firstPage || null,
    lastPage: lastPage || null,
    landingUrl: work.URL ?? (doi ? `https://doi.org/${doi}` : null),
  };
}

async function crossrefByDoi(doi: string): Promise<CrossrefWork | null> {
  const res = await fetchJson<{ message?: CrossrefWork }>(`${CROSSREF}/works/${encodeURIComponent(doi)}`);
  return res?.message ?? null;
}

async function crossrefByTitle(title: string): Promise<CrossrefWork | null> {
  const url = `${CROSSREF}/works?query.bibliographic=${encodeURIComponent(title)}&rows=5`;
  const res = await fetchJson<{ message?: { items?: CrossrefWork[] } }>(url);
  return pickByTitle(title, res?.message?.items ?? [], (w) => w.title?.[0] ?? '', (w) => w['is-referenced-by-count'] ?? 0);
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

/** null = not found or (after all retries) still rate-limited; check `lastRateLimited`. */
async function semanticScholarByIds(ids: PaperIdentifiers, backoff: number[] = S2_BACKOFF_MS): Promise<S2Paper | null> {
  const key = ids.arxivId ? `arXiv:${ids.arxivId}` : ids.doi ? `DOI:${ids.doi}` : null;
  if (!key) return null;
  lastRateLimited = false;
  return fetchJson<S2Paper>(`${SEMANTIC_SCHOLAR}/paper/${encodeURIComponent(key)}?fields=${S2_FIELDS}`, 10_000, backoff, s2Headers());
}

function metaFromS2(paper: S2Paper, ids: PaperIdentifiers): PaperMeta {
  const doi = paper.externalIds?.DOI ? normalizeDoi(paper.externalIds.DOI) : null;
  const arxivFromDoi = doi ? arxivIdFromDoi(doi) : null;
  const venueType = paper.publicationVenue?.type ?? null;
  return {
    title: paper.title ?? '',
    year: paper.year ?? null,
    authors: (paper.authors ?? []).map((a) => a.name ?? '').filter(Boolean),
    venue: paper.publicationVenue?.name ?? paper.venue ?? null,
    venueType,
    workType: doi && !arxivFromDoi ? 'article' : (ids.arxivId || paper.externalIds?.ArXiv ? 'preprint' : null),
    doi: doi && !arxivFromDoi ? doi : (ids.doi ?? null),
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
    landingUrl: doi && !arxivFromDoi ? `https://doi.org/${doi}` : null,
    s2PaperId: paper.paperId ?? null,
  };
}

/** Folds Semantic Scholar counts (and its published-version DOI) into an existing meta. */
function enrichWithS2(meta: PaperMeta, paper: S2Paper): PaperMeta {
  const doi = paper.externalIds?.DOI ? normalizeDoi(paper.externalIds.DOI) : null;
  const publishedDoi = doi && !arxivIdFromDoi(doi) ? doi : null;
  return {
    ...meta,
    doi: meta.doi ?? publishedDoi,
    citations: { ...meta.citations, semanticScholar: paper.citationCount ?? null },
    references: { ...meta.references, semanticScholar: paper.referenceCount ?? null },
    s2PaperId: paper.paperId ?? meta.s2PaperId ?? null,
    venue: meta.venue && !/arxiv/iu.test(meta.venue) ? meta.venue : (paper.publicationVenue?.name ?? meta.venue),
    year: meta.year ?? paper.year ?? null,
  };
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

interface Resolved { meta: PaperMeta; openAlexWork: OpenAlexWork | null; s2?: S2Paper | null }
/** Transient (never cached): Semantic Scholar could not be consulted, so the total may be low. */
const s2Unavailable = new WeakSet<PaperMeta>();

async function resolvePrimary(ids: PaperIdentifiers, titles: string[]): Promise<Resolved | null> {
  if (ids.doi) {
    const [cr, oa] = await Promise.all([crossrefByDoi(ids.doi), openAlexByDoi(ids.doi)]);
    if (cr) return { meta: oa ? enrichWithOpenAlex(metaFromCrossref(cr, ids), oa) : metaFromCrossref(cr, ids), openAlexWork: oa };
    if (oa) return { meta: metaFromOpenAlex(oa, ids), openAlexWork: oa };
  }
  if (ids.arxivId) {
    const oa = await openAlexByDoi(`10.48550/arXiv.${ids.arxivId}`);
    if (oa) return { meta: metaFromOpenAlex(oa, ids), openAlexWork: oa };
  }
  if (ids.doi || ids.arxivId) {
    // As a last-resort primary source (Crossref and OpenAlex both missed the
    // id) retry only briefly: an unknown id is the likely reason, and a long
    // backoff would just delay the "not found" verdict.
    const s2 = await semanticScholarByIds(ids, [2_000]);
    if (s2) return { meta: metaFromS2(s2, ids), openAlexWork: null, s2 };
  }
  for (const title of titles) {
    const oa = await openAlexByTitle(title);
    if (oa) return { meta: metaFromOpenAlex(oa, ids), openAlexWork: oa };
    const cr = await crossrefByTitle(title);
    if (cr) return { meta: metaFromCrossref(cr, ids), openAlexWork: null };
  }
  return null;
}

async function enrich(resolved: Resolved): Promise<PaperMeta> {
  let { meta } = resolved;
  let work = resolved.openAlexWork;
  // Semantic Scholar merges preprint and published versions (like Google
  // Scholar), so it supplies the most complete count and, for a preprint, the
  // DOI of the published version — which then unlocks the OpenAlex/Crossref
  // records of that version (per-year citations, venue, references).
  let s2Failed = false;
  const s2 = resolved.s2 ?? (meta.citations.semanticScholar === null
    ? await semanticScholarByIds({ doi: meta.doi ?? undefined, arxivId: meta.arxivId ?? undefined })
    : null);
  if (s2) meta = enrichWithS2(meta, s2);
  else if (!resolved.s2 && meta.citations.semanticScholar === null && lastRateLimited) s2Failed = true;
  const isPreprintWork = !work || work.type === 'preprint' || /arxiv/iu.test(work.primary_location?.source?.display_name ?? '');
  if (meta.doi && (!work || (isPreprintWork && (work.doi ?? '').toLowerCase().includes('arxiv')))) {
    const published = await openAlexByDoi(meta.doi);
    if (published) { work = published; meta = enrichWithOpenAlex(meta, published); }
  }
  const sourceId = work?.primary_location?.source?.id;
  const [twoYear, crossref] = await Promise.all([
    sourceId ? openAlexSourceStats(sourceId) : Promise.resolve(null),
    meta.doi && meta.citations.crossref === null ? crossrefByDoi(meta.doi) : Promise.resolve(null),
  ]);
  if (twoYear !== null) meta = { ...meta, venueTwoYearMeanCitedness: twoYear };
  if (crossref) {
    const cr = metaFromCrossref(crossref, { doi: meta.doi ?? undefined, arxivId: meta.arxivId ?? undefined });
    meta = {
      ...meta,
      citations: { ...meta.citations, crossref: crossref['is-referenced-by-count'] ?? null },
      references: { ...meta.references, crossref: crossref['reference-count'] ?? null },
      // A preprint that turned out to be published: show the published venue.
      venue: meta.venue && !/arxiv/iu.test(meta.venue) ? meta.venue : (cr.venue ?? meta.venue),
      venueType: meta.venueType && meta.venueType !== 'repository' ? meta.venueType : (cr.venueType ?? meta.venueType),
      workType: cr.workType ?? meta.workType,
      year: meta.year ?? cr.year,
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
function normalizeMeta(raw: Partial<PaperMeta> & Record<string, unknown>): PaperMeta {
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
  };
}

async function readCache(key: string): Promise<PaperMeta | null> {
  try {
    const stored = await chrome.storage.local.get(CACHE_PREFIX + key);
    const entry = stored[CACHE_PREFIX + key] as CacheEntry | undefined;
    if (!entry || Date.now() - entry.fetchedAt > CACHE_TTL_MS || !entry.meta) return null;
    return normalizeMeta(entry.meta as Partial<PaperMeta> & Record<string, unknown>);
  } catch {
    return null;
  }
}

async function writeCache(key: string, meta: PaperMeta): Promise<void> {
  try {
    await chrome.storage.local.set({ [CACHE_PREFIX + key]: { fetchedAt: Date.now(), meta } satisfies CacheEntry });
  } catch {
    /* cache is best-effort */
  }
}

// ─── UI ───

export class PaperStrip {
  private readonly root = byId<HTMLElement>('vocab-t-pdf-paper');
  private readonly body = byId<HTMLDivElement>('vt-paper-body');
  private readonly closeBtn = byId<HTMLButtonElement>('vt-paper-close');
  private generation = 0;
  private meta: PaperMeta | null = null;
  private bibtexCache: string | null = null;
  private readonly refs = new ReferenceList();

  /**
   * @param onLayoutChange called whenever the strip appears/disappears; the
   *   viewer container's top edge moves, so PDF.js must re-measure (the host
   *   dispatches its `resize` event, exactly as for the sidebar toggle).
   */
  constructor(private readonly onLayoutChange: () => void) {
    this.closeBtn.addEventListener('click', () => this.hide());
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
    if (meta.referencedWorks && meta.referencedWorks.length > 0) void this.refs.load(meta.referencedWorks, key);
    else if (meta.s2PaperId) void this.refs.loadFromSemanticScholar(meta.s2PaperId, key, s2Headers());
    else this.refs.unavailable(meta.openalexId ? 'OpenAlex·Semantic Scholar에 이 논문의 참고문헌 목록이 없습니다.' : '이 논문을 OpenAlex·Semantic Scholar에서 못 찾아 참고문헌 목록을 만들 수 없습니다.');
  }

  /** Detects whether `doc` is a paper and, if so, renders the strip. */
  async show(doc: PDFDocumentProxy, sourceUrl: string | null): Promise<void> {
    const gen = ++this.generation;
    this.hide();
    this.meta = null;
    this.bibtexCache = null;
    try {
      if (!(await getSetting(PAPER_INFO_ENABLED_SETTING_KEY, DEFAULT_PAPER_INFO_ENABLED))) {
        debugLog('paper', 'paper info disabled by setting');
        return;
      }
      s2ApiKey = (await getSetting<string>(SEMANTIC_SCHOLAR_API_KEY_SETTING_KEY, '')).trim();
      const [fromMeta, page] = await Promise.all([metadataIdentifiers(doc), firstPageText(doc)]);
      if (gen !== this.generation) return;
      const ids = mergeIdentifiers(sourceUrl ? identifiersFromUrl(sourceUrl) : {}, fromMeta.ids, identifiersFromText(page.text));
      const titles = [fromMeta.title, page.bigTitle].filter((t): t is string => !!t);
      debugLog('paper', 'detection', () => ({ ids, titles, textSample: page.text.slice(0, 160) }));
      if (!ids.doi && !ids.arxivId && titles.length === 0) return;
      const what = ids.doi ? `DOI ${ids.doi}` : ids.arxivId ? `arXiv:${ids.arxivId}` : `제목 "${titles[0].slice(0, 60)}"`;
      this.renderStatus('loading', `${what} 조회 중…`);

      const key = ids.doi ?? (ids.arxivId ? `arxiv:${ids.arxivId}` : `title:${normalizeTitle(titles[0])}`);
      const cached = await readCache(key);
      if (cached) {
        debugLog('paper', 'resolved (cache)', () => ({ key, meta: cached }));
        if (gen !== this.generation) return;
        this.meta = cached;
        this.render(cached);
        this.startReferences(cached, key);
        return;
      }
      networkFailures = 0;
      let primary = await resolvePrimary(ids, titles);
      if (!primary && networkFailures > 0) {
        debugLog('paper', `lookup hit ${networkFailures} network failure(s); retrying in ${NETWORK_RETRY_DELAY_MS}ms`);
        await new Promise((r) => setTimeout(r, NETWORK_RETRY_DELAY_MS));
        if (gen !== this.generation) return;
        primary = await resolvePrimary(ids, titles);
      }
      debugLog('paper', primary ? 'resolved (primary)' : 'no match', () => ({ key, meta: primary?.meta }));
      if (gen !== this.generation) return;
      if (!primary) {
        this.renderStatus('failed', networkFailures > 0
          ? `${what}: OpenAlex·Crossref·Semantic Scholar 조회가 실패했습니다 (네트워크 지연 또는 요청 제한).`
          : (ids.doi || ids.arxivId)
            ? `${what}: 어느 데이터베이스(OpenAlex·Crossref·Semantic Scholar)에도 없습니다.`
            : `${what}: 제목 검색에서 일치하는 논문을 못 찾았습니다.`, () => { void this.show(doc, sourceUrl); });
        return;
      }
      this.meta = primary.meta;
      this.render(primary.meta);
      const enriched = await enrich(primary);
      if (gen !== this.generation) return;
      debugLog('paper', 'enriched', () => ({ key, meta: enriched }));
      this.meta = enriched;
      this.bibtexCache = null;
      this.render(enriched);
      this.startReferences(enriched, key);
      // A lookup that Semantic Scholar rate-limited is incomplete: leave it
      // uncached so the next open tries again.
      if (!s2Unavailable.has(enriched)) void writeCache(key, enriched);
    } catch (error) {
      debugError('paper', 'paper strip failed', () => ({ error: error instanceof Error ? error.message : String(error) }));
      if (gen === this.generation) {
        this.renderStatus('failed', `논문 정보를 처리하는 중 오류: ${error instanceof Error ? error.message : String(error)}`, () => { void this.show(doc, sourceUrl); });
      }
    }
  }

  /** Strip with only the 논문정보 label and a status (조회 중 / ⚠︎ reason + 다시 시도). */
  private renderStatus(kind: 'loading' | 'failed', text: string, retry?: () => void): void {
    this.body.replaceChildren();
    const value = el('span', { className: 'vt-paper-value vt-paper-status' });
    if (kind === 'loading') {
      value.append(el('span', { className: 'vt-paper-spinner', 'aria-hidden': 'true' }), text);
    } else {
      value.append(el('span', { className: 'vt-warn-inline', textContent: '⚠︎ ' }), text);
      if (retry) {
        const btn = el('button', { type: 'button', className: 'vt-btn vt-btn-text vt-paper-copy', textContent: '다시 시도' });
        btn.addEventListener('click', retry);
        value.append(' ', btn);
      }
    }
    this.body.append(el('span', { className: 'vt-paper-seg' }, [el('span', { className: 'vt-paper-label', textContent: '논문정보' }), value]));
    const wasHidden = this.root.hidden;
    this.root.hidden = false;
    document.body.classList.add('vt-has-paper');
    if (wasHidden) this.onLayoutChange();
  }

  private render(meta: PaperMeta): void {
    this.body.replaceChildren();
    const segment = (label: string, children: Array<Node | string>, title?: string) => el('span', { className: 'vt-paper-seg', title }, [
      el('span', { className: 'vt-paper-label', textContent: label }),
      el('span', { className: 'vt-paper-value' }, children),
    ]);
    // Missing data is never rendered as 0 or a default: a ⚠︎ with a one-line
    // reason on hover takes the value's place.
    const warn = (reason: string) => {
      const w = el('span', { className: 'vt-warn', tabindex: '0', role: 'img', 'aria-label': `정보 없음: ${reason}` }, ['⚠︎']);
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
    const kindBadge = el('span', { className: `vt-kind vt-kind-${kind}`, textContent: kind, title: KIND_TITLE[kind] });
    const info = segment('논문정보', join([
      kindBadge,
      meta.venue ?? (kind === 'preprint' ? null : warn('게재처(저널/학회)를 못 찾았습니다.')),
      meta.year ? String(meta.year) : warn('출판 연도를 못 찾았습니다.'),
    ]));
    info.classList.add('vt-paper-info');
    info.setAttribute('tabindex', '0');
    info.append(this.buildPopover(meta));
    this.body.append(info);

    // ── 2년/전체 인용수 + sparkline (hover → detailed chart)
    const total = bestCitationCount(meta);
    const twoYear = recentTwoYearCitations(meta);
    const history = citationHistory(meta);
    const sourcesDetail = [
      typeof meta.citations.semanticScholar === 'number' ? `Semantic Scholar ${formatCount(meta.citations.semanticScholar)}` : null,
      typeof meta.citations.openalex === 'number' ? `OpenAlex ${formatCount(meta.citations.openalex)}` : null,
      typeof meta.citations.crossref === 'number' ? `Crossref ${formatCount(meta.citations.crossref)}` : null,
    ].filter(Boolean).join(' · ');
    const cites = segment('2년/전체 인용수', [
      twoYear === null ? warn('연도별 인용 데이터가 없어 최근 2년 인용을 계산하지 못했습니다 (OpenAlex).') : formatCount(twoYear),
      '/',
      total === null ? warn('인용 수를 Semantic Scholar·OpenAlex·Crossref 어디서도 못 찾았습니다.') : formatCount(total),
      ...(s2Unavailable.has(meta) ? [' ', warn('Semantic Scholar 조회가 요청 제한(429)으로 실패해 실제보다 낮을 수 있습니다. 설정에 Semantic Scholar API 키를 넣으면 안정적으로 조회됩니다.')] : []),
    ], total === null ? undefined : `올해·작년 인용 (OpenAlex 연도별) / 전체 인용 = 소스 최대값 (${sourcesDetail}).\nGoogle Scholar는 프리프린트·학위논문·중복 레코드까지 합산해 보통 더 높습니다.`);
    if (history.some((p) => p.count > 0)) {
      const series = recentCitationSeries(meta);
      const max = Math.max(...series.map((p) => p.count));
      const spark = el('span', { className: 'vt-spark', tabindex: '0', 'aria-label': '연도별 인용 그래프' });
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
    const refs = segment('참고문헌', [references === null ? warn('참고문헌 수를 Crossref·OpenAlex 어디서도 못 찾았습니다.') : formatCount(references)]);
    refs.classList.add('vt-paper-refs');
    refs.setAttribute('tabindex', '0');
    refs.append(this.refs.element);
    this.body.append(refs);

    // ── right-aligned copy buttons
    const actions = el('span', { className: 'vt-paper-actions' });
    const copyBib = el('button', { type: 'button', className: 'vt-btn vt-btn-text vt-paper-copy', title: 'BibTeX 복사' }, ['BibTeX']);
    copyBib.addEventListener('click', () => { void this.copy(copyBib, 'bibtex'); });
    const copyApa = el('button', { type: 'button', className: 'vt-btn vt-btn-text vt-paper-copy', title: 'APA 7 서식 복사' }, ['APA']);
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
    if (meta.authors.length) {
      const shown = meta.authors.slice(0, 6).join(', ') + (meta.authors.length > 6 ? ` 외 ${meta.authors.length - 6}명` : '');
      pop.append(el('div', { className: 'vt-paper-pop-authors', textContent: shown }));
    }
    const facts: string[] = [];
    if (meta.doi) facts.push(`DOI ${meta.doi}`);
    if (meta.arxivId) facts.push(`arXiv:${meta.arxivId}`);
    if (meta.venueType !== 'repository' && meta.workType !== 'preprint') {
      facts.push(meta.venueTwoYearMeanCitedness !== null
        ? `게재처 2년 평균 피인용 ${meta.venueTwoYearMeanCitedness.toFixed(1)} (IF와 같은 정의, OpenAlex)`
        : '⚠︎ 게재처 2년 평균 피인용을 OpenAlex에서 못 찾았습니다.');
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
      button.textContent = '복사됨';
    } catch {
      button.textContent = '실패';
    } finally {
      setTimeout(() => { button.textContent = original; button.disabled = false; }, 1_500);
    }
  }
}
