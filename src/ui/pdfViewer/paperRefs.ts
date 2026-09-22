// Reference list for the paper strip: the works this paper cites, resolved
// in the background from OpenAlex (batches of ids), each with its link,
// citation count, venue and the venue's 2-year mean citedness. Rendered into
// the 참고문헌 hover panel as batches arrive; cached for a week.

import { debugLog } from '../../shared/debugLog';
import { formatCount } from '../../shared/paperIdentifiers';
import { el } from './dom';

const OPENALEX = 'https://api.openalex.org';
const SEMANTIC_SCHOLAR = 'https://api.semanticscholar.org/graph/v1';
const S2_PAGE = 500;
const S2_MAX = 1_000;
const BATCH = 50;
const BATCH_GAP_MS = 350;
const MAX_REFS = 400;
const CACHE_PREFIX = 'vtPaperRefs:v2:';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;
const WORK_SELECT = 'id,display_name,publication_year,cited_by_count,doi,primary_location,authorships';

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

async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 2_000));
      const again = await fetch(url, { signal: ctrl.signal, headers });
      return again.ok ? await again.json() as T : null;
    }
    return res.ok ? await res.json() as T : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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

  constructor() {
    this.header = el('div', { className: 'vt-refs-header' });
    this.list = el('ol', { className: 'vt-refs-list' });
    this.panel = el('div', { className: 'vt-paper-pop vt-refs-pop', role: 'tooltip' }, [this.header, this.list]);
    this.renderHeader();
  }

  get element(): HTMLElement {
    return this.panel;
  }

  /** Cancels any in-flight load and clears the panel. */
  reset(): void {
    this.generation += 1;
    this.entries = [];
    this.expected = 0;
    this.status = 'idle';
    this.sourceNote = null;
    this.list.replaceChildren();
    this.renderHeader();
  }

  /** Marks the list as unavailable with a short reason (⚠︎ in the header). */
  unavailable(reason: string): void {
    this.reset();
    this.status = 'failed';
    this.renderHeader(reason);
  }

  async load(workIds: string[], cacheKey: string): Promise<void> {
    this.reset();
    const gen = this.generation;
    const ids = workIds.slice(0, MAX_REFS).map(shortId);
    this.expected = ids.length;
    if (ids.length === 0) {
      this.unavailable('OpenAlex에 이 논문의 참고문헌 목록이 없습니다.');
      return;
    }
    const cached = await this.readCache(cacheKey);
    if (gen !== this.generation) return;
    if (cached) {
      this.entries = cached;
      this.status = 'done';
      this.renderAll();
      return;
    }
    this.status = 'loading';
    this.renderHeader();
    const works: RefWork[] = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const page = await fetchJson<{ results?: RefWork[] }>(
        `${OPENALEX}/works?filter=ids.openalex:${chunk.join('|')}&per-page=${BATCH}&select=${encodeURIComponent(WORK_SELECT)}`,
      );
      if (gen !== this.generation) return;
      if (page?.results) {
        works.push(...page.results);
        this.entries = works.map((w) => this.toEntry(w));
        this.renderAll();
      }
      if (i + BATCH < ids.length) await new Promise((r) => setTimeout(r, BATCH_GAP_MS));
    }
    if (works.length === 0) {
      this.unavailable('참고문헌을 OpenAlex에서 불러오지 못했습니다.');
      return;
    }
    // Venue impact (2-year mean citedness) for the distinct sources.
    const sourceIds = [...new Set(this.entries.map((e) => e.sourceId).filter((s): s is string => !!s))];
    const impact = new Map<string, number>();
    for (let i = 0; i < sourceIds.length; i += BATCH) {
      const chunk = sourceIds.slice(i, i + BATCH);
      const page = await fetchJson<{ results?: Array<{ id?: string; summary_stats?: { '2yr_mean_citedness'?: number } }> }>(
        `${OPENALEX}/sources?filter=ids.openalex:${chunk.join('|')}&per-page=${BATCH}&select=id,summary_stats`,
      );
      if (gen !== this.generation) return;
      for (const src of page?.results ?? []) {
        const v = src.summary_stats?.['2yr_mean_citedness'];
        if (src.id && typeof v === 'number') impact.set(shortId(src.id), v);
      }
      if (i + BATCH < sourceIds.length) await new Promise((r) => setTimeout(r, BATCH_GAP_MS));
    }
    this.entries = this.entries.map((e) => ({ ...e, impact: e.sourceId ? impact.get(e.sourceId) ?? null : null }));
    this.status = 'done';
    this.renderAll();
    void this.writeCache(cacheKey, this.entries);
    debugLog('paper', `references loaded: ${this.entries.length}/${this.expected}`);
  }

  /**
   * Fallback when OpenAlex has no reference list (typical for preprints):
   * Semantic Scholar's `/references`, which carries each cited paper's
   * citation count and DOI but no venue impact figure.
   */
  async loadFromSemanticScholar(paperId: string, cacheKey: string, headers?: Record<string, string>): Promise<void> {
    this.reset();
    const gen = this.generation;
    const cached = await this.readCache(`${cacheKey}:s2`);
    if (gen !== this.generation) return;
    if (cached) { this.entries = cached; this.expected = cached.length; this.status = 'done'; this.renderAll(); return; }
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
        if (gen !== this.generation) return;
      }
      if (gen !== this.generation) return;
      if (!page) break;
      for (const ref of page.data ?? []) {
        const c = ref.citedPaper;
        if (!c?.paperId) continue;
        const doi = c.externalIds?.DOI ?? null;
        entries.push({
          id: c.paperId,
          title: c.title ?? '(제목 없음)',
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
    if (entries.length === 0) { this.unavailable('참고문헌 목록을 Semantic Scholar에서 불러오지 못했습니다 (요청 제한일 수 있음 — 설정의 Semantic Scholar API 키 참고).'); return; }
    this.status = 'done';
    this.sourceNote = 'Semantic Scholar 기준 · 게재처 IF 지표는 OpenAlex 전용';
    this.renderAll();
    void this.writeCache(`${cacheKey}:s2`, entries);
  }

  private toEntry(w: RefWork): RefEntry {
    const source = w.primary_location?.source ?? null;
    const id = shortId(w.id ?? '');
    const doi = w.doi ? w.doi.replace(/^https?:\/\/doi\.org\//iu, '') : null;
    return {
      id,
      title: w.display_name ?? '(제목 없음)',
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
      this.header.append(el('span', { className: 'vt-warn-inline', textContent: '⚠︎ ' }), el('span', { textContent: reason ?? '참고문헌 목록을 못 찾았습니다.' }));
      return;
    }
    if (this.status === 'idle') {
      this.header.append(el('span', { textContent: '참고문헌 목록 준비 중…' }));
      return;
    }
    const label = this.status === 'loading' ? `불러오는 중 ${n}/${this.expected}` : `${n}편 · 인용 많은 순`;
    this.header.append(el('span', { textContent: `참고문헌 ${label}` }));
    if (this.status === 'done' && n < this.expected) {
      this.header.append(el('span', { className: 'vt-refs-note', textContent: ` · ${this.expected - n}편은 OpenAlex에 없음` }));
    }
    if (this.sourceNote) this.header.append(el('span', { className: 'vt-refs-note', textContent: ` · ${this.sourceNote}` }));
  }

  private renderAll(): void {
    this.renderHeader();
    this.list.replaceChildren();
    const sorted = [...this.entries].sort((a, b) => (b.citations ?? -1) - (a.citations ?? -1));
    for (const e of sorted) {
      const meta = [
        e.authors.length ? (e.authors.length > 3 ? `${e.authors.slice(0, 3).join(', ')} 외` : e.authors.join(', ')) : null,
        e.year ? String(e.year) : null,
        e.venue,
      ].filter(Boolean).join(' · ');
      const stats = el('span', { className: 'vt-ref-stats' }, [
        el('span', { textContent: typeof e.citations === 'number' ? `인용 ${formatCount(e.citations)}` : '⚠︎ 인용 수 없음' }),
        el('span', { textContent: typeof e.impact === 'number' ? ` · IF≈${e.impact.toFixed(1)}` : '', title: typeof e.impact === 'number' ? '게재처 2년 평균 피인용 (OpenAlex)' : '' }),
      ]);
      const link = el('a', { className: 'vt-ref', href: e.url, target: '_blank', rel: 'noopener noreferrer' }, [
        el('span', { className: 'vt-ref-title', textContent: e.title }),
        el('span', { className: 'vt-ref-meta', textContent: meta }),
        stats,
      ]);
      this.list.append(el('li', {}, [link]));
    }
  }

  private async readCache(key: string): Promise<RefEntry[] | null> {
    try {
      const stored = await chrome.storage.local.get(CACHE_PREFIX + key);
      const entry = stored[CACHE_PREFIX + key] as { fetchedAt: number; entries: RefEntry[] } | undefined;
      if (!entry || Date.now() - entry.fetchedAt > CACHE_TTL_MS || !Array.isArray(entry.entries)) return null;
      return entry.entries;
    } catch {
      return null;
    }
  }

  private async writeCache(key: string, entries: RefEntry[]): Promise<void> {
    try {
      await chrome.storage.local.set({ [CACHE_PREFIX + key]: { fetchedAt: Date.now(), entries } });
    } catch {
      /* best effort */
    }
  }
}
