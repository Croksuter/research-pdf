// Reference list for the paper strip: the works this paper cites, resolved
// in the background from OpenAlex (batches of ids), each with its link,
// citation count, venue and the venue's 2-year mean citedness. Rendered into
// the 참고문헌 hover panel as batches arrive; cached for a week (paperCache.ts).
// Without an OpenAlex list: Semantic Scholar's, and failing that the list
// printed in the PDF itself (shared/pdfReferences.ts), linked to OpenAlex by
// DOI or arXiv id in batches, and by title — one search each — only while
// the reader has the list open, a few per opening, each kept as it is found.

import { debugLog } from '../../shared/debugLog';
import { formatCount, openAlexSearchText, titleSimilarity } from '../../shared/paperIdentifiers';
import type { PdfReference } from '../../shared/pdfReferences';
import { openAlexBudgetSpent } from './openAlexAccess';
import { el } from './dom';
import { readPaperCache, writePaperCache } from './paperCache';
import { OPENALEX, REF_WORK_SELECT as WORK_SELECT, SEMANTIC_SCHOLAR, fetchJson as fetchWith, newLookup } from './paperSources';
import { S } from './paper.strings';

const S2_PAGE = 500;
const S2_MAX = 1_000;
const BATCH = 50;
const BATCH_GAP_MS = 350;
const MAX_REFS = 400;
const CACHE_PREFIX = 'refs:v2:';
// Linking the PDF's own list: titles are searched one by one, politely, and
// at most this many each time the list is opened (OpenAlex's free daily
// budget is shared by everyone behind the same address).
const TITLE_LOOKUPS_PER_OPEN = 20;
const TITLE_GAP_MS = 150;
const TITLE_MATCH = 0.9;

export interface RefEntry {
  id: string;
  title: string;
  year: number | null;
  authors: string[];
  venue: string | null;
  sourceId: string | null;
  citations: number | null;
  impact: number | null;
  url: string;
  /** From the PDF's own list and not found in OpenAlex. */
  unlinked?: boolean;
  /** Searched by title already (and not found). */
  titleTried?: boolean;
}

interface CachedRefs {
  entries: RefEntry[];
  /** The PDF list's DOI / arXiv batches all answered. */
  idsLinked?: boolean;
}

interface RefWork {
  id?: string;
  display_name?: string;
  publication_year?: number | null;
  cited_by_count?: number;
  doi?: string | null;
  primary_location?: { landing_page_url?: string | null; source?: { id?: string; display_name?: string } | null } | null;
  authorships?: Array<{ author?: { display_name?: string } }>;
}

type Status = 'idle' | 'loading' | 'done' | 'failed';

// One 2 s retry on a 429. The list's own lookups are not reported anywhere,
// so each request gets a context of its own.
function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T | null> {
  return fetchWith<T>(newLookup(), url, undefined, [2_000], headers);
}

function shortId(id: string): string {
  return id.split('/').pop() ?? id;
}

export class ReferenceList {
  private readonly panel: HTMLElement;
  private readonly header: HTMLElement;
  private readonly list: HTMLElement;
  private entries: RefEntry[] = [];
  private status: Status = 'idle';
  private expected = 0;
  private generation = 0;
  private sourceNote: string | null = null;
  /** The PDF's own list being shown (what title linking works on). */
  private pdf: { refs: PdfReference[]; cacheKey: string; idsLinked: boolean } | null = null;
  private linkingTitles = false;
  /** Told how many references the PDF itself lists, when that is the source. */
  onPdfCount: ((count: number) => void) | null = null;

  constructor() {
    this.header = el('div', { className: 'vt-refs-header' });
    this.list = el('ol', { className: 'vt-refs-list' });
    this.panel = el('div', { className: 'vt-paper-pop vt-refs-pop', role: 'tooltip' }, [this.header, this.list]);
    this.renderHeader();
  }

  get element(): HTMLElement {
    return this.panel;
  }

  /** How many references the list shows now. */
  get size(): number {
    return this.entries.length;
  }

  /** Cancels any in-flight load and clears the panel. */
  reset(): void {
    this.generation += 1;
    this.entries = [];
    this.expected = 0;
    this.status = 'idle';
    this.sourceNote = null;
    this.pdf = null;
    this.linkingTitles = false;
    this.list.replaceChildren();
    this.renderHeader();
  }

  /** This source had nothing; the strip tries the next one (no ⚠︎ yet). */
  private nextSource(): void {
    this.reset();
    this.status = 'loading';
    this.renderHeader();
  }

  /** Marks the list as unavailable with a short reason (⚠︎ in the header). */
  unavailable(reason: string): void {
    this.reset();
    this.status = 'failed';
    this.renderHeader(reason);
  }

  /** True when a list was shown (false: nothing usable, the caller tries the next source). */
  async load(workIds: string[], cacheKey: string): Promise<boolean> {
    this.reset();
    const gen = this.generation;
    const ids = workIds.slice(0, MAX_REFS).map(shortId);
    this.expected = ids.length;
    if (ids.length === 0) {
      this.nextSource();
      return false;
    }
    const cached = (await this.readCache(cacheKey))?.entries;
    if (gen !== this.generation) return true;
    if (cached) {
      this.entries = cached;
      this.status = 'done';
      this.renderAll();
      return true;
    }
    this.status = 'loading';
    this.renderHeader();
    const works: RefWork[] = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const page = await fetchJson<{ results?: RefWork[] }>(
        `${OPENALEX}/works?filter=ids.openalex:${chunk.join('|')}&per-page=${BATCH}&select=${encodeURIComponent(WORK_SELECT)}`,
      );
      if (gen !== this.generation) return true;
      if (page?.results) {
        works.push(...page.results);
        this.entries = works.map((w) => this.toEntry(w));
        this.renderAll();
      }
      if (i + BATCH < ids.length) await new Promise((r) => setTimeout(r, BATCH_GAP_MS));
    }
    if (works.length === 0) {
      this.nextSource();
      return false;
    }
    if (!(await this.fillImpact(gen))) return true;
    this.status = 'done';
    this.renderAll();
    void this.writeCache(cacheKey, { entries: this.entries });
    debugLog('paper', `references loaded: ${this.entries.length}/${this.expected}`);
    return true;
  }

  /** Venue impact (2-year mean citedness) for the distinct sources; false if superseded. */
  private async fillImpact(gen: number): Promise<boolean> {
    const sourceIds = [...new Set(this.entries.map((e) => e.sourceId).filter((s): s is string => !!s))];
    const impact = new Map<string, number>();
    for (let i = 0; i < sourceIds.length; i += BATCH) {
      const chunk = sourceIds.slice(i, i + BATCH);
      const page = await fetchJson<{ results?: Array<{ id?: string; summary_stats?: { '2yr_mean_citedness'?: number } }> }>(
        `${OPENALEX}/sources?filter=ids.openalex:${chunk.join('|')}&per-page=${BATCH}&select=id,summary_stats`,
      );
      if (gen !== this.generation) return false;
      for (const src of page?.results ?? []) {
        const v = src.summary_stats?.['2yr_mean_citedness'];
        if (src.id && typeof v === 'number') impact.set(shortId(src.id), v);
      }
      if (i + BATCH < sourceIds.length) await new Promise((r) => setTimeout(r, BATCH_GAP_MS));
    }
    this.entries = this.entries.map((e) => ({ ...e, impact: e.sourceId ? impact.get(e.sourceId) ?? null : null }));
    return true;
  }

  /**
   * The list printed in the PDF, shown at once and then linked to OpenAlex
   * (citations, venue) by DOI or arXiv id in batches. Titles are linked later,
   * while the list is open (opened()). Whatever was linked is cached, also
   * when OpenAlex's budget ran out partway.
   */
  async loadFromPdf(refs: PdfReference[], cacheKey: string, reason: string): Promise<boolean> {
    this.reset();
    const gen = this.generation;
    if (refs.length === 0) { this.unavailable(reason); return false; }
    this.onPdfCount?.(refs.length);
    const pdfKey = `${cacheKey}:pdf`;
    const cached = await this.readCache(pdfKey);
    if (gen !== this.generation) return true;
    const reuse = cached && cached.entries.length === refs.length ? cached : null;
    this.entries = reuse ? reuse.entries : refs.map(entryFromPdf);
    this.expected = refs.length;
    this.pdf = { refs, cacheKey: pdfKey, idsLinked: !!reuse?.idsLinked };
    if (reuse?.idsLinked) {
      this.status = 'done';
      this.sourceNote = this.pdfSourceNote();
      this.renderAll();
      return true;
    }
    this.status = 'loading';
    this.sourceNote = S.pdfListBasis;
    this.renderAll();
    const arxivDoi = (id: string) => `10.48550/arxiv.${id.toLowerCase()}`;
    const keyOf = (r: PdfReference) => (r.doi ? r.doi.toLowerCase() : r.arxivId ? arxivDoi(r.arxivId) : null);
    const withIds = refs.map((r, i) => ({ i, key: keyOf(r) })).filter((x): x is { i: number; key: string } => !!x.key && !!this.entries[x.i].unlinked);
    let answered = true;
    for (let at = 0; at < withIds.length; at += BATCH) {
      const chunk = withIds.slice(at, at + BATCH);
      const page = await fetchJson<{ results?: RefWork[] }>(
        `${OPENALEX}/works?filter=doi:${chunk.map((c) => encodeURIComponent(c.key)).join('|')}&per-page=${BATCH}&select=${encodeURIComponent(WORK_SELECT)}`,
      );
      if (gen !== this.generation) return true;
      if (!page) answered = false;
      for (const work of page?.results ?? []) {
        const doi = (work.doi ?? '').replace(/^https?:\/\/doi\.org\//iu, '').toLowerCase();
        for (const c of chunk) if (c.key === doi) this.entries[c.i] = this.linked(this.entries[c.i], work);
      }
      this.renderAll();
    }
    if (!(await this.fillImpact(gen))) return true;
    this.pdf.idsLinked = answered;
    this.status = 'done';
    this.sourceNote = this.pdfSourceNote();
    this.renderAll();
    void this.writeCache(pdfKey, { entries: this.entries, idsLinked: answered });
    debugLog('paper', `references from the PDF: ${this.entries.length}, linked ${this.entries.filter((e) => !e.unlinked).length}`);
    // The reader is already looking at it.
    if (this.panel.parentElement?.matches(':hover, :focus-within')) this.opened();
    return true;
  }

  /** PDF entries with a title that no search has been tried for yet. */
  private titlesLeft(): number[] {
    const refs = this.pdf?.refs ?? [];
    return this.entries.flatMap((e, i) => (e.unlinked && !e.titleTried && refs[i]?.title ? [i] : []));
  }

  private pdfSourceNote(): string {
    const left = openAlexBudgetSpent() ? 0 : this.titlesLeft().length;
    return pdfNote(this.entries) + (left > 0 ? S.titlesLeftNote(left) : '');
  }

  /**
   * The reader opened the list: link a few more of the PDF's entries by
   * title (TITLE_LOOKUPS_PER_OPEN), then cache what was found.
   */
  opened(): void {
    void this.linkTitles();
  }

  private async linkTitles(): Promise<void> {
    const pdf = this.pdf;
    if (!pdf || this.status !== 'done' || this.linkingTitles || openAlexBudgetSpent()) return;
    const todo = this.titlesLeft().slice(0, TITLE_LOOKUPS_PER_OPEN);
    if (todo.length === 0) return;
    const gen = this.generation;
    this.linkingTitles = true;
    let found = 0;
    try {
      for (const i of todo) {
        if (openAlexBudgetSpent()) break;
        const ref = pdf.refs[i];
        const title = ref.title ?? '';
        const page = await fetchJson<{ results?: RefWork[] }>(
          `${OPENALEX}/works?search=${encodeURIComponent(openAlexSearchText(title))}&per-page=3&select=${encodeURIComponent(WORK_SELECT)}`,
        );
        if (gen !== this.generation) return;
        const match = (page?.results ?? []).find((w) => titleSimilarity(title, w.display_name ?? '') >= TITLE_MATCH
          && (!ref.year || !w.publication_year || Math.abs(ref.year - w.publication_year) <= 1));
        if (match) { this.entries[i] = this.linked(this.entries[i], match); found += 1; }
        else if (page) this.entries[i] = { ...this.entries[i], titleTried: true };
        this.renderAll();
        await new Promise((r) => setTimeout(r, TITLE_GAP_MS));
      }
      if (found > 0 && !(await this.fillImpact(gen))) return;
      if (gen !== this.generation) return;
      this.sourceNote = this.pdfSourceNote();
      this.renderAll();
      void this.writeCache(pdf.cacheKey, { entries: this.entries, idsLinked: pdf.idsLinked });
      debugLog('paper', `references linked by title: ${found}/${todo.length}`);
    } finally {
      if (gen === this.generation) this.linkingTitles = false;
    }
  }

  /** A PDF entry with what OpenAlex knows about it; the PDF keeps its link if it had a DOI or arXiv id. */
  private linked(entry: RefEntry, work: RefWork): RefEntry {
    const found = this.toEntry(work);
    return {
      ...found,
      authors: found.authors.length ? found.authors : entry.authors,
      year: found.year ?? entry.year,
      url: /doi\.org|arxiv\.org/u.test(entry.url) ? entry.url : found.url,
      unlinked: false,
    };
  }

  /**
   * Fallback when OpenAlex has no reference list (typical for preprints):
   * Semantic Scholar's `/references`, which carries each cited paper's
   * citation count and DOI but no venue impact figure.
   */
  async loadFromSemanticScholar(paperId: string, cacheKey: string, headers?: Record<string, string>): Promise<boolean> {
    this.reset();
    const gen = this.generation;
    const cached = (await this.readCache(`${cacheKey}:s2`))?.entries;
    if (gen !== this.generation) return true;
    if (cached) { this.entries = cached; this.expected = cached.length; this.status = 'done'; this.renderAll(); return true; }
    this.status = 'loading';
    this.renderHeader();
    interface S2Ref { citedPaper?: { paperId?: string; title?: string; year?: number | null; venue?: string | null; citationCount?: number; externalIds?: { DOI?: string }; authors?: Array<{ name?: string }> } }
    const entries: RefEntry[] = [];
    for (let offset = 0; offset < S2_MAX; offset += S2_PAGE) {
      const url = `${SEMANTIC_SCHOLAR}/paper/${encodeURIComponent(paperId)}/references?fields=title,year,venue,citationCount,externalIds,authors&limit=${S2_PAGE}&offset=${offset}`;
      let page: { data?: S2Ref[]; next?: number } | null = null;
      for (const delay of [0, 3_000, 8_000, 15_000]) {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        page = await fetchJson<{ data?: S2Ref[]; next?: number }>(url, headers);
        if (page) break;
        if (gen !== this.generation) return true;
      }
      if (gen !== this.generation) return true;
      if (!page) break;
      for (const ref of page.data ?? []) {
        const c = ref.citedPaper;
        if (!c?.paperId) continue;
        const doi = c.externalIds?.DOI ?? null;
        entries.push({
          id: c.paperId,
          title: c.title ?? S.untitled,
          year: c.year ?? null,
          authors: (c.authors ?? []).map((a) => a.name ?? '').filter(Boolean),
          venue: c.venue || null,
          sourceId: null,
          citations: typeof c.citationCount === 'number' ? c.citationCount : null,
          impact: null,
          url: doi ? `https://doi.org/${doi}` : `https://www.semanticscholar.org/paper/${c.paperId}`,
        });
      }
      this.entries = entries;
      this.expected = entries.length;
      this.renderAll();
      if (page.next === undefined || page.next === null) break;
    }
    if (entries.length === 0) { this.nextSource(); return false; }
    this.status = 'done';
    this.sourceNote = S.s2Basis;
    this.renderAll();
    void this.writeCache(`${cacheKey}:s2`, { entries });
    return true;
  }

  private toEntry(w: RefWork): RefEntry {
    const source = w.primary_location?.source ?? null;
    const id = shortId(w.id ?? '');
    const doi = w.doi ? w.doi.replace(/^https?:\/\/doi\.org\//iu, '') : null;
    return {
      id,
      title: w.display_name ?? S.untitled,
      year: w.publication_year ?? null,
      authors: (w.authorships ?? []).map((a) => a.author?.display_name ?? '').filter(Boolean),
      venue: source?.display_name ?? null,
      sourceId: source?.id ? shortId(source.id) : null,
      citations: typeof w.cited_by_count === 'number' ? w.cited_by_count : null,
      impact: null,
      url: doi ? `https://doi.org/${doi}` : (w.primary_location?.landing_page_url ?? `https://openalex.org/${id}`),
    };
  }

  private renderHeader(reason?: string): void {
    this.header.replaceChildren();
    const n = this.entries.length;
    if (this.status === 'failed') {
      this.header.append(el('span', { className: 'vt-warn-inline', textContent: '⚠︎ ' }), el('span', { textContent: reason ?? S.refsNotFound }));
      return;
    }
    if (this.status === 'idle' || (this.status === 'loading' && n === 0 && this.expected === 0)) {
      this.header.append(el('span', { textContent: this.status === 'idle' ? S.refsPreparing : S.refsSearching }));
      return;
    }
    const label = this.status === 'loading' ? S.refsLoadingLabel(n, this.expected) : S.refsDoneLabel(n);
    this.header.append(el('span', { textContent: S.refsHeader(label) }));
    if (this.status === 'done' && n < this.expected) {
      this.header.append(el('span', { className: 'vt-refs-note', textContent: S.refsMissingInOpenAlex(this.expected - n) }));
    }
    if (this.sourceNote) this.header.append(el('span', { className: 'vt-refs-note', textContent: ` · ${this.sourceNote}` }));
  }

  private renderAll(): void {
    this.renderHeader();
    this.list.replaceChildren();
    const sorted = [...this.entries].sort((a, b) => (b.citations ?? -1) - (a.citations ?? -1));
    for (const e of sorted) {
      const meta = [
        e.authors.length ? (e.authors.length > 3 ? S.authorsEtAl(e.authors.slice(0, 3).join(', ')) : e.authors.join(', ')) : null,
        e.year ? String(e.year) : null,
        e.venue,
      ].filter(Boolean).join(' · ');
      const stats = el('span', { className: 'vt-ref-stats' }, [
        el('span', { textContent: typeof e.citations === 'number' ? S.citedCount(formatCount(e.citations)) : e.unlinked ? S.notFoundInOpenAlex : S.noCitationCountShort }),
        el('span', { textContent: typeof e.impact === 'number' ? ` · IF≈${e.impact.toFixed(1)}` : '', title: typeof e.impact === 'number' ? S.venueMeanCitednessShort : '' }),
      ]);
      const link = el('a', { className: 'vt-ref', href: e.url, target: '_blank', rel: 'noopener noreferrer' }, [
        el('span', { className: 'vt-ref-title', textContent: e.title }),
        el('span', { className: 'vt-ref-meta', textContent: meta }),
        stats,
      ]);
      this.list.append(el('li', {}, [link]));
    }
  }

  private async readCache(key: string): Promise<CachedRefs | null> {
    const cached = await readPaperCache<CachedRefs>(CACHE_PREFIX + key);
    return cached && Array.isArray(cached.entries) ? cached : null;
  }

  private writeCache(key: string, value: CachedRefs): Promise<void> {
    return writePaperCache(CACHE_PREFIX + key, value);
  }
}

function entryFromPdf(ref: PdfReference): RefEntry {
  const shown = ref.title ?? (ref.raw.length > 160 ? `${ref.raw.slice(0, 160).trimEnd()}…` : ref.raw);
  const url = ref.doi ? `https://doi.org/${ref.doi}`
    : ref.arxivId ? `https://arxiv.org/abs/${ref.arxivId}`
      : `https://scholar.google.com/scholar?q=${encodeURIComponent(ref.title ?? ref.raw.slice(0, 200))}`;
  return {
    id: `pdf:${ref.index}`,
    title: shown,
    year: ref.year,
    authors: ref.authors,
    venue: null,
    sourceId: null,
    citations: null,
    impact: null,
    url,
    unlinked: true,
  };
}

function pdfNote(entries: readonly RefEntry[]): string {
  const linked = entries.filter((e) => !e.unlinked).length;
  const spent = openAlexBudgetSpent() ? S.budgetSpentNote : '';
  return `${S.pdfNote(linked, entries.length)}${spent}`;
}
