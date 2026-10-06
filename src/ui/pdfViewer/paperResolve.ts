// ─── Resolving a paper: which record is this document, then enrichment ───
//
// `resolvePrimary` returns as soon as one source identified the paper (the
// strip renders it at once); `enrich` then folds in Semantic Scholar's count,
// the published version of a preprint, OpenAlex's per-year citations and the
// venue's 2-year mean citedness. Also the lookups without the strip
// (background upkeep, ui/pdfUpkeep.ts) and the cached records.

import { getSetting } from '../../db/settingsRepository';
import { debugLog } from '../../shared/debugLog';
import { DEFAULT_PAPER_INFO_ENABLED, OPENALEX_API_KEY_SETTING_KEY, PAPER_INFO_ENABLED_SETTING_KEY, SEMANTIC_SCHOLAR_API_KEY_SETTING_KEY } from '../../shared/constants';
import {
  type PaperIdentifiers,
  type PaperMeta,
  type WorkSummary,
  arxivIdFromDoi,
  arxivIdYear,
  isPublishedVersion,
  normalizeDoi,
  normalizeTitle,
  recordMatchesDocument,
  splitAuthor,
  tidyPaperMeta,
  titleMatchConfirmed,
} from '../../shared/paperIdentifiers';
import { openAlexBudgetSpent, setOpenAlexApiKey } from './openAlexAccess';
import { dropPaperCache, readPaperCache, writePaperCache } from './paperCache';
import type { DocumentEvidence, PaperEvidence } from './paperEvidence';
import {
  type AuthorCheck,
  type LookupContext,
  type OpenAlexWork,
  type S2Paper,
  arxivById,
  crossrefByDoi,
  crossrefByTitle,
  enrichWithOpenAlex,
  enrichWithS2,
  metaFromCrossref,
  metaFromOpenAlex,
  metaFromS2,
  newLookup,
  openAlexByDoi,
  openAlexByTitle,
  openAlexSourceStats,
  s2Doi,
  semanticScholarByIds,
  semanticScholarByTitle,
  setS2ApiKey,
} from './paperSources';

// Bumped whenever PaperMeta gains fields: an entry from an older build must
// not be rendered with a newer renderer.
const CACHE_PREFIX = 'meta:v2:';

interface CacheEntry { meta: PaperMeta }

export interface Resolved {
  meta: PaperMeta;
  openAlexWork: OpenAlexWork | null;
  s2?: S2Paper | null;
  /** A DOI the record carries that may be the published version (checked in enrich). */
  candidateDoi?: string | null;
}
/** Transient (never cached): Semantic Scholar could not be consulted, so the total may be low. */
export const s2Unavailable = new WeakSet<PaperMeta>();

// Crossref records that are a whole volume or series, not one paper: a DOI
// cut at a line break often lands on the proceedings itself.
const CONTAINER_TYPES = /^(?:proceedings|journal|journal-issue|journal-volume|book-series|proceedings-series|book-set|report-series|component|database)$/iu;

/** A record found by id is trusted only if it is this document (PDFs without text cannot tell). */
function isThisDocument(title: string, evidence: DocumentEvidence): boolean {
  if (evidence.pageText.trim().length < 200 && evidence.titles.length === 0) return true;
  return recordMatchesDocument(title, evidence.titles, evidence.pageText);
}

export async function resolvePrimary(ctx: LookupContext, ids: PaperIdentifiers, titles: string[], evidence: DocumentEvidence): Promise<Resolved | null> {
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

export async function enrich(ctx: LookupContext, resolved: Resolved): Promise<PaperMeta> {
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

export async function readCachedMeta(key: string): Promise<PaperMeta | null> {
  const entry = await readPaperCache<CacheEntry>(CACHE_PREFIX + key);
  return entry?.meta ? normalizeMeta(entry.meta as Partial<PaperMeta> & Record<string, unknown>) : null;
}

export function dropCachedMeta(key: string): Promise<void> {
  return dropPaperCache(CACHE_PREFIX + key);
}

export function writeCachedMeta(key: string, meta: PaperMeta): Promise<void> {
  return writePaperCache(CACHE_PREFIX + key, { meta } satisfies CacheEntry);
}

// ─── Without the strip (background upkeep, ui/pdfUpkeep.ts) ───

/** Whether lookups are on, with the user's API keys applied. */
export async function loadPaperSettings(): Promise<boolean> {
  setS2ApiKey(await getSetting<string>(SEMANTIC_SCHOLAR_API_KEY_SETTING_KEY, ''));
  setOpenAlexApiKey(await getSetting<string>(OPENALEX_API_KEY_SETTING_KEY, ''));
  return getSetting(PAPER_INFO_ENABLED_SETTING_KEY, DEFAULT_PAPER_INFO_ENABLED);
}

/**
 * A cached paper good enough to describe a library row: found by an
 * identifier, or by its title when its first author is on this document's
 * first page (`pageText`; without it a title match is not trusted).
 */
export function cachedPaperMeta(key: string, pageText = ''): Promise<PaperMeta | null> {
  return readCachedMeta(key).then((meta) => (meta && (meta.matchedBy !== 'title' || titleMatchConfirmed(meta, pageText)) ? tidyPaperMeta(meta) : null));
}

/**
 * Resolves and enriches like the strip, shows nothing, and caches the result
 * as the strip would (a title match only with its first author on the page). `limited`: no answer because of a rate limit, a spent
 * budget or a network failure — worth trying again later, not now.
 */
export async function lookupPaperQuietly(found: PaperEvidence): Promise<{ meta: PaperMeta | null; limited: boolean }> {
  const ctx = newLookup();
  const primary = await resolvePrimary(ctx, found.ids, found.titles, found.evidence);
  if (!primary) return { meta: null, limited: ctx.networkFailures > 0 || openAlexBudgetSpent() || ctx.limited.size > 0 };
  const raw = await enrich(ctx, primary);
  const meta = tidyPaperMeta(raw);
  if (found.key && !s2Unavailable.has(raw) && !openAlexBudgetSpent()) await writeCachedMeta(found.key, meta);
  return { meta, limited: false };
}
