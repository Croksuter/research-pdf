// ─── Scholarly paper identification & citation formatting (pure) ───
//
// Used by the PDF viewer's paper strip. Everything here is DOM- and
// network-free so it can be unit-tested: pulling DOIs / arXiv ids out of URLs
// and page text, judging whether a title search hit is really the same paper,
// and rendering APA / BibTeX strings from normalized metadata.

export interface PaperIdentifiers {
  doi?: string;
  arxivId?: string;
}

// DOI: prefix 10.<4+ digits>/<suffix>. Suffixes may contain almost anything,
// so trailing sentence punctuation and closing brackets are trimmed after the
// match. Case-insensitive; DOIs are case-insensitive by definition.
const DOI_PATTERN = /\b(10\.\d{4,9}\/[^\s"'<>]+)/iu;
const DOI_TRAILING = /[.,;:)\]}>]+$/u;

// arXiv new-style ids (YYMM.NNNNN, optional vN) and old-style (archive/YYMMNNN).
const ARXIV_NEW = /(\d{4}\.\d{4,5})(?:v\d+)?/u;
const ARXIV_OLD = /([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?/u;
// `submit/NNNNNNN` is the stamp of a submission not yet announced, not an id.
const ARXIV_URL = /arxiv\.org\/(?:abs|pdf|html)\/(?:(\d{4}\.\d{4,5})|((?!submit\/)[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(?:v\d+)?/iu;
const ARXIV_TEXT = /arXiv:\s?(?:(\d{4}\.\d{4,5})|((?!submit\/)[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(?:v\d+)?/u;
// arXiv DOIs registered via DataCite.
const ARXIV_DOI = /^10\.48550\/arxiv\.(.+)$/iu;

export function normalizeDoi(raw: string): string | null {
  let value = raw.trim();
  value = value.replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//iu, '').replace(/^doi:\s*/iu, '');
  const m = DOI_PATTERN.exec(value);
  if (!m) return null;
  const doi = m[1].replace(DOI_TRAILING, '');
  return doi.toLowerCase();
}

/** Strips a version suffix and lowercases the archive part of old-style ids. */
export function normalizeArxivId(raw: string): string | null {
  const value = raw.trim().replace(/^arxiv:\s*/iu, '');
  const n = ARXIV_NEW.exec(value);
  if (n && n.index === 0) return n[1];
  const o = ARXIV_OLD.exec(value);
  if (o && o.index === 0) return o[1];
  return null;
}

/** DOI / arXiv id carried by the PDF's own URL (arxiv.org, doi.org, publisher paths). */
export function identifiersFromUrl(url: string): PaperIdentifiers {
  const out: PaperIdentifiers = {};
  let host = '';
  let path = url;
  try {
    const parsed = new URL(url);
    host = parsed.host;
    // Query strings (`?download=true`) and fragments are never part of a DOI.
    path = parsed.pathname;
  } catch {
    /* not a URL; scan the raw string */
  }
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    /* keep raw */
  }
  const arxiv = ARXIV_URL.exec(`${host}${decoded}`);
  if (arxiv) out.arxivId = arxiv[1] ?? arxiv[2];
  const doi = normalizeDoi(decoded);
  const clean = doi ? doiFromUrlPath(doi) : null;
  if (clean && !ARXIV_DOI.test(clean)) out.doi = clean;
  return out;
}

/**
 * A DOI read from a URL path without the file or view parts publishers put
 * after it (`/full`, `.full.pdf`, `.pdf`) and, for bioRxiv/medRxiv, the
 * version (`v7`), which is not part of the DOI.
 */
export function doiFromUrlPath(doi: string): string {
  let value = doi.replace(/\/(?:full|pdf|epdf|abstract|fulltext|full-text|reader|download)(?:\/.*)?$/iu, '');
  value = value.replace(/(?:\.full)?(?:\.pdf|\.html?)?(?:\+html)?$/iu, '').replace(/\.full$/iu, '');
  if (/^10\.1101\//u.test(value)) value = value.replace(/v\d+$/u, '');
  return value;
}

/** DOI / arXiv id printed in the page text (first page usually carries both). */
export function identifiersFromText(text: string): PaperIdentifiers {
  const out: PaperIdentifiers = {};
  // A DOI broken at the end of a line ("10.1145/3788646." / "3789535").
  text = text.replace(/(10\.\d{4,9}\/[^\s"'<>]*\.)\s+(\d{5,})/gu, '$1$2');
  const arxiv = ARXIV_TEXT.exec(text);
  if (arxiv) out.arxivId = arxiv[1] ?? arxiv[2];
  // Prefer an explicit "doi:" / doi.org mention; fall back to a bare DOI.
  const explicit = /(?:doi\.org\/|doi:\s?)(10\.\d{4,9}\/[^\s"'<>]+)/iu.exec(text);
  const doi = normalizeDoi(explicit ? explicit[1] : text);
  if (doi && !ARXIV_DOI.test(doi)) out.doi = doi;
  return out;
}

/** The year an arXiv id was first posted: 1706.03762 → 2017, hep-th/9711200 → 1997. */
export function arxivIdYear(id: string): number | null {
  const m = /^(\d{2})\d{2}\.\d{4,5}$/u.exec(id) ?? /\/(\d{2})\d{5}$/u.exec(id);
  if (!m) return null;
  const yy = Number(m[1]);
  return yy >= 91 ? 1900 + yy : 2000 + yy;
}

/** An arXiv id embedded in a DataCite arXiv DOI (10.48550/arXiv.<id>). */
export function arxivIdFromDoi(doi: string): string | null {
  const m = ARXIV_DOI.exec(doi);
  return m ? normalizeArxivId(m[1]) : null;
}

export function mergeIdentifiers(...sources: PaperIdentifiers[]): PaperIdentifiers {
  const out: PaperIdentifiers = {};
  for (const s of sources) {
    if (!out.doi && s.doi) out.doi = s.doi;
    if (!out.arxivId && s.arxivId) out.arxivId = s.arxivId;
  }
  return out;
}

// ─── Text from metadata sources ───

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—' };

/** Decodes HTML entities, drops markup (<i>, <sub>) and TeX math dollars, collapses spaces. */
export function cleanMetaText(value: string): string {
  return value
    .replace(/<\/?[a-z][a-z0-9:-]*(?:\s[^>]*)?>/giu, '')
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/giu, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      return ENTITIES[(name ?? '').toLowerCase()] ?? whole;
    })
    .replace(/\$([^$]{1,60})\$/gu, (_, inner: string) => inner.replace(/[{}\\]/gu, ''))
    .replace(/\s+/gu, ' ')
    .trim();
}

/** An author name as a person would write it: not ALL CAPS, a space after initials. */
export function normalizeAuthorName(name: string): string {
  let value = cleanMetaText(name).replace(/\b(\p{Lu})\.(?=\p{Lu}\p{Ll})/gu, '$1. ');
  if (/\p{Lu}{2}/u.test(value) && value === value.toUpperCase() && /\s/u.test(value)) {
    value = value.toLowerCase().replace(/(^|[\s'’-])(\p{Ll})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
  }
  return value;
}

/** Placeholder titles that tools write into PDF metadata. */
export function isGenericTitle(title: string): boolean {
  const t = title.trim();
  return /^(?:microsoft\s+(?:word|powerpoint)\s*-|powerpoint\s+presentation$|presentation\d*$|slide\s*\d*$|untitled|title$|paper\s+title|document\d*$|layout\s*\d+$|template|draft$|manuscript$|main$|article$|thesis$|report$|\(?anonymous\)?|arxiv$|preprint$|arxiv:)/iu.test(t)
    || /\.(?:docx?|pptx?|tex|dvi|indd|qxd)$/iu.test(t);
}

/**
 * Whether a looked-up record is the document: its title matches a title
 * found in the PDF, or (when those are missing or unreliable) its words are
 * on the first page.
 */
export function recordMatchesDocument(recordTitle: string, detectedTitles: readonly string[], firstPageText: string): boolean {
  if (detectedTitles.some((t) => titleSimilarity(recordTitle, t) >= 0.6)) return true;
  const words = normalizeTitle(recordTitle).split(' ').filter((w) => w.length > 2);
  if (words.length === 0) return false;
  const page = ` ${normalizeTitle(firstPageText)} `;
  const found = words.filter((w) => page.includes(` ${w} `)).length;
  return found / words.length >= 0.75;
}

// ─── Title matching ───

export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Dice coefficient over word tokens; 1 = identical. */
export function titleSimilarity(a: string, b: string): number {
  const ta = normalizeTitle(a).split(' ').filter(Boolean);
  const tb = normalizeTitle(b).split(' ').filter(Boolean);
  if (ta.length === 0 || tb.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const t of ta) counts.set(t, (counts.get(t) ?? 0) + 1);
  let overlap = 0;
  for (const t of tb) {
    const c = counts.get(t) ?? 0;
    if (c > 0) { overlap += 1; counts.set(t, c - 1); }
  }
  return (2 * overlap) / (ta.length + tb.length);
}

export const TITLE_MATCH_THRESHOLD = 0.85;

const CJK = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * Whether a record found only by its title is this document: titles alone
 * collide ("Deep Learning", the talk, against LeCun et al.'s review), so the
 * record's first author must be named on the first page too — the surname
 * as a whole word, or for a CJK name the whole name. No first author, or no
 * page text, cannot confirm it.
 */
export function titleMatchConfirmed(record: { authors: readonly string[]; authorFamilies?: ReadonlyArray<string | null> }, firstPageText: string): boolean {
  const first = record.authors[0]?.trim();
  if (!first || !firstPageText.trim()) return false;
  if (CJK.test(first)) {
    const squeeze = (text: string) => normalizeTitle(text).replace(/\s+/gu, '');
    const name = squeeze(first.includes(',') ? first.split(',').reverse().join('') : first);
    return name.length >= 2 && squeeze(firstPageText).includes(name);
  }
  const family = normalizeTitle(record.authorFamilies?.[0] ?? splitAuthor(first).last);
  return family.length >= 2 && ` ${normalizeTitle(firstPageText)} `.includes(` ${family} `);
}

// ─── Normalized metadata ───

export interface PaperMeta {
  title: string;
  year: number | null;
  authors: string[];
  venue: string | null;
  venueType: string | null;        // journal | conference | repository | preprint | …
  workType: string | null;         // article | preprint | book-chapter | …
  doi: string | null;
  arxivId: string | null;
  openalexId: string | null;       // e.g. W639708223
  citations: { openalex: number | null; crossref: number | null; semanticScholar: number | null };
  citationsByYear: Array<{ year: number; count: number }>;
  references: { openalex: number | null; crossref: number | null; semanticScholar: number | null };
  /** Semantic Scholar paper id, when the paper was found there (merged preprint + published versions). */
  s2PaperId?: string | null;
  venueTwoYearMeanCitedness: number | null;
  volume: string | null;
  issue: string | null;
  firstPage: string | null;
  lastPage: string | null;
  landingUrl: string | null;
  /** OpenAlex ids (W…) of the works this paper cites, when OpenAlex knows them. */
  referencedWorks?: string[];
  /** Surnames aligned with `authors`, when the source splits names (Crossref). */
  authorFamilies?: Array<string | null>;
  /**
   * 'title': found by a title search alone (the PDF named no DOI or arXiv id
   * that led to it). Shown as such, and never names the document.
   */
  matchedBy?: 'title';
}

/** Titles, venue and names cleaned of markup and entities; authors as people write them, once each. */
export function tidyPaperMeta(meta: PaperMeta): PaperMeta {
  const seen = new Set<string>();
  const authors: string[] = [];
  const families: Array<string | null> = [];
  meta.authors.forEach((raw, i) => {
    const name = normalizeAuthorName(raw);
    const key = normalizeTitle(name);
    if (!name || seen.has(key)) return;
    seen.add(key);
    authors.push(name);
    families.push(meta.authorFamilies?.[i] ? normalizeAuthorName(meta.authorFamilies[i] as string) : null);
  });
  const venue = meta.venue ? cleanMetaText(meta.venue) : null;
  return {
    ...meta,
    title: cleanMetaText(meta.title),
    venue: venue && /^arxiv\b/iu.test(venue) ? 'arXiv' : venue,
    authors,
    authorFamilies: meta.authorFamilies ? families : undefined,
  };
}

/**
 * Largest count across sources. Semantic Scholar merges a paper's preprint and
 * published versions (as Google Scholar does) and usually reports the highest;
 * OpenAlex and Crossref count only citations from works they index, so the
 * three legitimately differ and the maximum is the least-undercounted view.
 */
// ─── Paper kind ───

export type PaperKind = 'survey' | 'conference' | 'journal' | 'technical' | 'preprint';

const SURVEY_TITLE = /\b(survey|review|overview|tutorial|outlook|perspectives?|roadmap|state of the art|state-of-the-art review|systematic review|meta-analysis)\b/iu;
const CONFERENCE_VENUE = /\b(proceedings|conference|symposium|workshop|congress|meeting)\b|robotics: science and systems|conference on robot learning|international conference on|\b(cvpr|iccv|eccv|wacv|neurips|nips|icml|iclr|icra|iros|rss|corl|humanoids|aaai|ijcai|acl|emnlp|naacl|kdd|sigir|sigmod|vldb|www|chi|uist|siggraph|icassp|interspeech|osdi|sosp|nsdi|usenix|ccs|s&p|ndss|icse|fse|pldi|popl)\b/iu;
const TECHNICAL_VENUE = /technical report|tech\.? report|white ?paper|working paper|thesis|dissertation/iu;

/**
 * One of five reader-facing kinds. Content kind (survey) wins over venue
 * kind; venue kinds come from the resolved metadata (OpenAlex source type,
 * Crossref work type, Semantic Scholar venue type) with name-pattern
 * fallbacks; an arXiv-only paper with no published venue is a preprint.
 */
export function classifyPaperKind(meta: PaperMeta): PaperKind {
  const title = meta.title ?? '';
  const venue = meta.venue ?? '';
  const workType = (meta.workType ?? '').toLowerCase();
  const venueType = (meta.venueType ?? '').toLowerCase();
  if (workType === 'review' || SURVEY_TITLE.test(title)) return 'survey';
  const isRepositoryVenue = venueType === 'repository' || /arxiv|biorxiv|medrxiv|ssrn|hal\b|zenodo|preprints?\b/iu.test(venue);
  if (workType === 'report' || workType === 'dissertation' || workType === 'thesis' || TECHNICAL_VENUE.test(venue) || TECHNICAL_VENUE.test(title)) return 'technical';
  if (venueType === 'conference' || workType === 'proceedings-article' || CONFERENCE_VENUE.test(venue)) return 'conference';
  if (venueType === 'journal' || workType === 'journal-article' || /\b(journal|transactions|letters|magazine)\b|^ieee\b|^acm\b|^nature\b|^science\b/iu.test(venue)) return 'journal';
  if (workType === 'preprint' || isRepositoryVenue || (!venue && meta.arxivId)) return 'preprint';
  if (venue) return 'journal';
  if (meta.arxivId) return 'preprint';
  // No venue, DOI or arXiv id: never formally published (course projects,
  // reports, theses indexed only by Semantic Scholar).
  return meta.doi ? 'journal' : 'technical';
}

export function bestCitationCount(meta: PaperMeta): number | null {
  const values = [meta.citations.openalex, meta.citations.crossref, meta.citations.semanticScholar]
    .filter((v): v is number => typeof v === 'number');
  return values.length ? Math.max(...values) : null;
}

/** What a DOI's record says, enough to tell whether it is a paper's published version. */
export interface WorkSummary {
  title: string;
  year: number | null;
  /** Crossref or OpenAlex work type. */
  type: string | null;
  /** Hosted by a repository (arXiv, Zenodo, SSRN…), not a venue. */
  repository: boolean;
}

/**
 * Whether `candidate` (a DOI Semantic Scholar attached to a preprint) is the
 * published version of it: the same title, published around the preprint's
 * time or in the following years, and an article — not another preprint, a
 * repository copy or a re-post (Semantic Scholar does attach such DOIs).
 */
export function isPublishedVersion(preprint: { title: string; year: number | null }, candidate: WorkSummary): boolean {
  if (titleSimilarity(preprint.title, candidate.title) < 0.85) return false;
  if (candidate.repository) return false;
  if (candidate.type && /^(?:posted-content|preprint|dataset|peer-review|component|other|paratext|erratum|retraction|report|standard)$/iu.test(candidate.type)) return false;
  if (preprint.year && candidate.year && (candidate.year < preprint.year - 1 || candidate.year > preprint.year + 5)) return false;
  return true;
}

/**
 * Crossref's count is what the publisher deposited — the paper's own list —
 * so it wins when present; otherwise the largest of the indexes' counts
 * (each misses works it does not know).
 */
export function bestReferenceCount(meta: PaperMeta): number | null {
  if (typeof meta.references.crossref === 'number' && meta.references.crossref > 0) return meta.references.crossref;
  const values = [meta.references.openalex, meta.references.semanticScholar]
    .filter((v): v is number => typeof v === 'number' && v > 0);
  return values.length ? Math.max(...values) : null;
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

// ─── Citation strings ───

export interface AuthorName { last: string; initials: string }

const GROUP_AUTHOR = /\b(?:collaboration|consortium|group|team|committee|project|initiative|organi[sz]ation|association|society|council|network|alliance|investigators|authors)\b/iu;

export function splitAuthor(name: string): AuthorName {
  const cleaned = name.replace(/\s+/gu, ' ').trim();
  // "Planck Collaboration" is not Collaboration, P.
  if (GROUP_AUTHOR.test(cleaned)) return { last: cleaned, initials: '' };
  if (cleaned.includes(',')) {
    const [last, first = ''] = cleaned.split(',').map((s) => s.trim());
    return { last, initials: initialsOf(first) };
  }
  const parts = cleaned.split(' ');
  if (parts.length === 1) return { last: parts[0], initials: '' };
  const last = parts.pop() as string;
  return { last, initials: initialsOf(parts.join(' ')) };
}

function initialsOf(first: string): string {
  // "Klaus-Robert" → "K.-R.", as APA keeps the hyphen.
  return first
    .split(/\s+/u)
    .filter(Boolean)
    .map((word) => word.split('-').filter(Boolean).map((p) => `${p[0].toUpperCase()}.`).join('-'))
    .join(' ');
}

/** Surname and initials, using the source's own surname when it gave one ("Neil P. Chue Hong"). */
function authorWithFamily(name: string, family: string | null | undefined): AuthorName {
  if (family && !name.includes(',') && name.endsWith(family) && name.length > family.length) {
    return { last: family, initials: initialsOf(name.slice(0, -family.length).trim()) };
  }
  return splitAuthor(name);
}

/** Removes repeated author names (Crossref sometimes lists a corresponding author twice). */
export function dedupeAuthors(authors: string[]): string[] {
  const seen = new Set<string>();
  return authors.filter((name) => {
    const key = name.replace(/\s+/gu, ' ').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function apaAuthors(authors: string[], families?: Array<string | null>): string {
  const kept = dedupeAuthors(authors);
  const names = kept.map((name) => authorWithFamily(name, families?.[authors.indexOf(name)])).map((a) => (a.initials ? `${a.last}, ${a.initials}` : a.last));
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length <= 20) return `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}`;
  return `${names.slice(0, 19).join(', ')}, … ${names[names.length - 1]}`;
}

/** APA 7th-style reference. */
export function formatApa(meta: PaperMeta): string {
  const authors = apaAuthors(meta.authors, meta.authorFamilies);
  const year = meta.year ? `(${meta.year}).` : '(n.d.).';
  const title = meta.title.replace(/\.?$/u, '.');
  let source = '';
  if (meta.arxivId && (!meta.venue || /arxiv/iu.test(meta.venue))) {
    source = `arXiv. https://doi.org/10.48550/arXiv.${meta.arxivId}`;
  } else {
    const parts: string[] = [];
    if (meta.venue) {
      let v = meta.venue;
      if (meta.volume) v += `, ${meta.volume}`;
      if (meta.issue) v += `(${meta.issue})`;
      if (meta.firstPage) v += `, ${meta.firstPage}${meta.lastPage ? `–${meta.lastPage}` : ''}`;
      parts.push(`${v}.`);
    }
    if (meta.doi) parts.push(`https://doi.org/${meta.doi}`);
    else if (meta.landingUrl) parts.push(meta.landingUrl);
    source = parts.join(' ');
  }
  return [authors, year, title, source].filter(Boolean).join(' ').trim();
}

function bibKey(meta: PaperMeta): string {
  const last = meta.authors[0] ? splitAuthor(meta.authors[0]).last : 'anon';
  const word = normalizeTitle(meta.title).split(' ').find((w) => w.length > 3) ?? 'paper';
  return `${last}${meta.year ?? ''}${word}`.replace(/[^a-z0-9]/giu, '');
}

function bibEscape(value: string): string {
  return value.replace(/[{}]/gu, '');
}

/** BibTeX entry generated from normalized metadata (used when Crossref has none). */
export function formatBibtex(meta: PaperMeta): string {
  const lines: string[] = [];
  const isPreprint = !!meta.arxivId && (!meta.venue || /arxiv/iu.test(meta.venue));
  const inProceedings = !isPreprint && classifyPaperKind(meta) === 'conference';
  lines.push(`@${isPreprint ? 'misc' : inProceedings ? 'inproceedings' : 'article'}{${bibKey(meta)},`);
  lines.push(`  title = {${bibEscape(meta.title)}},`);
  const authors = dedupeAuthors(meta.authors);
  if (authors.length) lines.push(`  author = {${authors.map(bibEscape).join(' and ')}},`);
  if (meta.year) lines.push(`  year = {${meta.year}},`);
  if (isPreprint) {
    lines.push(`  eprint = {${meta.arxivId}},`);
    lines.push('  archivePrefix = {arXiv},');
    lines.push(`  doi = {10.48550/arXiv.${meta.arxivId}},`);
    lines.push(`  url = {https://arxiv.org/abs/${meta.arxivId}},`);
  } else {
    if (meta.venue) lines.push(`  ${inProceedings ? 'booktitle' : 'journal'} = {${bibEscape(meta.venue)}},`);
    if (meta.volume) lines.push(`  volume = {${meta.volume}},`);
    if (meta.issue) lines.push(`  number = {${meta.issue}},`);
    if (meta.firstPage) lines.push(`  pages = {${meta.firstPage}${meta.lastPage ? `--${meta.lastPage}` : ''}},`);
    if (meta.doi) lines.push(`  doi = {${meta.doi}},`);
    if (meta.doi) lines.push(`  url = {https://doi.org/${meta.doi}},`);
    else if (meta.landingUrl) lines.push(`  url = {${meta.landingUrl}},`);
  }
  // Drop the trailing comma of the last field.
  lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/u, '');
  lines.push('}');
  return lines.join('\n');
}

// ─── External links ───

export function scholarLinks(meta: PaperMeta): Array<{ label: string; url: string }> {
  const links: Array<{ label: string; url: string }> = [];
  if (meta.openalexId) links.push({ label: 'OpenAlex', url: `https://openalex.org/${meta.openalexId}` });
  if (meta.arxivId) {
    links.push({ label: 'arXiv', url: `https://arxiv.org/abs/${meta.arxivId}` });
    links.push({ label: 'Semantic Scholar', url: `https://www.semanticscholar.org/arxiv/${meta.arxivId}` });
  } else if (meta.doi) {
    links.push({ label: 'Semantic Scholar', url: `https://www.semanticscholar.org/search?q=${encodeURIComponent(meta.doi)}` });
  }
  if (meta.doi) links.push({ label: 'DOI', url: `https://doi.org/${meta.doi}` });
  links.push({ label: 'Google Scholar', url: `https://scholar.google.com/scholar?q=${encodeURIComponent(meta.doi ? meta.doi : meta.title)}` });
  return links;
}

export interface CitationHistoryPoint { year: number; count: number; cumulative: number | null }

/**
 * Per-year citation history, oldest first, every year from the first known
 * year to `now` (gaps filled with 0). `cumulative` is the running total
 * through that year, derived from the overall count so that years older than
 * the per-year data are still included: cum(Y) = total − Σ count(y > Y).
 */
export function citationHistory(meta: PaperMeta, now = new Date()): CitationHistoryPoint[] {
  if (meta.citationsByYear.length === 0) return [];
  const byYear = new Map(meta.citationsByYear.map((c) => [c.year, c.count]));
  const first = Math.min(...byYear.keys());
  const last = Math.max(now.getFullYear(), ...byYear.keys());
  const total = bestCitationCount(meta);
  const years: number[] = [];
  for (let y = first; y <= last; y += 1) years.push(y);
  let later = 0;
  const points: CitationHistoryPoint[] = [];
  for (let i = years.length - 1; i >= 0; i -= 1) {
    const year = years[i];
    const count = byYear.get(year) ?? 0;
    points.unshift({ year, count, cumulative: total === null ? null : Math.max(0, total - later) });
    later += count;
  }
  return points;
}

/** Citations received in the current and the previous calendar year (null when no per-year data). */
export function recentTwoYearCitations(meta: PaperMeta, now = new Date()): number | null {
  if (meta.citationsByYear.length === 0) return null;
  const thisYear = now.getFullYear();
  return meta.citationsByYear
    .filter((c) => c.year === thisYear || c.year === thisYear - 1)
    .reduce((sum, c) => sum + c.count, 0);
}

/** Last N years of citation counts, oldest first, padded with zeros. */
export function recentCitationSeries(meta: PaperMeta, years = 5, now = new Date()): Array<{ year: number; count: number }> {
  const thisYear = now.getFullYear();
  const byYear = new Map(meta.citationsByYear.map((c) => [c.year, c.count]));
  const series: Array<{ year: number; count: number }> = [];
  for (let y = thisYear - years + 1; y <= thisYear; y += 1) series.push({ year: y, count: byYear.get(y) ?? 0 });
  return series;
}
