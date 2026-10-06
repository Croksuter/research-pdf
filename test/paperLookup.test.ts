// Paper lookups end to end with the network mocked (no live OpenAlex /
// Crossref / Semantic Scholar calls).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cachedPaperMeta, lookupPaperQuietly, normalizeMeta, paperCacheKey, type PaperEvidence } from '../src/ui/pdfViewer/paperStrip';
import { readPaperCache, resetPaperCacheForTests } from '../src/ui/pdfViewer/paperCache';
import { formatApa, tidyPaperMeta, type PaperMeta } from '../src/shared/paperIdentifiers';

const LECUN_WORK = {
  id: 'https://openalex.org/W1',
  display_name: 'Deep learning',
  publication_year: 2015,
  cited_by_count: 70000,
  type: 'article',
  doi: 'https://doi.org/10.1038/nature14539',
  primary_location: { source: { id: 'https://openalex.org/S1', display_name: 'Nature', type: 'journal' } },
  authorships: [{ author: { display_name: 'Yann LeCun' } }, { author: { display_name: 'Yoshua Bengio' } }],
};

type Route = (url: string) => { status?: number; body: unknown } | null;

function mockFetch(route: Route) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = String(input);
    calls.push(url);
    const hit = route(url) ?? { status: 404, body: {} };
    return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

function evidence(title: string, pageText: string): PaperEvidence {
  const titles = [title];
  return { ids: {}, titles, evidence: { titles, pageText }, key: paperCacheKey({}, titles), docTitle: null };
}

const searchesOnly: Route = (url) => {
  if (url.includes('api.openalex.org/works?search=')) return { body: { results: [LECUN_WORK] } };
  if (url.includes('api.crossref.org/works?query.bibliographic=')) return { body: { message: { items: [] } } };
  if (url.includes('/paper/search/match')) return { body: { data: [] } };
  return null;
};

describe('paper lookup', () => {
  beforeEach(() => {
    resetPaperCacheForTests();
    vi.stubGlobal('chrome', { storage: { local: { getKeys: async () => [], get: async () => ({}), remove: async () => undefined } } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a slide deck titled "Deep Learning" does not become LeCun et al.\'s review', async () => {
    mockFetch(searchesOnly);
    const deck = evidence('Deep Learning', 'Deep Learning Lecture 3: Convolutional networks Prof. Minsu Kim Spring 2024');
    const result = await lookupPaperQuietly(deck);
    expect(result).toEqual({ meta: null, limited: false });
  });

  it('the review itself is found by title, but only as a title match', async () => {
    mockFetch((url) => searchesOnly(url) ?? (url.includes('filter=doi') ? { body: { results: [LECUN_WORK] } } : null));
    const paper = evidence('Deep learning', 'REVIEW Deep learning Yann LeCun, Yoshua Bengio & Geoffrey Hinton Deep learning allows computational models');
    const result = await lookupPaperQuietly(paper);
    // Found and cached for the strip, as a title match…
    const cached = await readPaperCache<{ meta: PaperMeta }>(`meta:v2:${paper.key}`);
    expect(cached?.meta).toMatchObject({ title: 'Deep learning', matchedBy: 'title' });
    // …but never handed to the library.
    expect(result.meta).toBeNull();
    expect(await cachedPaperMeta(paper.key!)).toBeNull();
  });

  it('attributes a 429 to the source that sent it', async () => {
    mockFetch((url) => (url.includes('api.crossref.org') ? { status: 429, body: {} } : searchesOnly(url)));
    const result = await lookupPaperQuietly({ ...evidence('Some unknown paper title here', 'nothing'), ids: { doi: '10.1/abc' }, key: '10.1/abc' });
    expect(result).toEqual({ meta: null, limited: true });
  }, 20_000);
});

describe('cached paper records', () => {
  it('keep the publisher\'s surnames, so APA reads the same after a reload', () => {
    const meta: PaperMeta = tidyPaperMeta({
      title: 'Software citation principles', year: 2016, authors: ['Neil P. Chue Hong', 'Arfon M. Smith'], authorFamilies: ['Chue Hong', 'Smith'],
      venue: 'PeerJ Computer Science', venueType: 'journal', workType: 'article', doi: '10.7717/peerj-cs.86', arxivId: null, openalexId: null,
      citations: { openalex: null, crossref: null, semanticScholar: null }, citationsByYear: [], references: { openalex: null, crossref: null, semanticScholar: null },
      venueTwoYearMeanCitedness: null, volume: '2', issue: null, firstPage: 'e86', lastPage: null, landingUrl: null,
    });
    const reloaded = normalizeMeta(JSON.parse(JSON.stringify(meta)) as Partial<PaperMeta> & Record<string, unknown>);
    expect(formatApa(tidyPaperMeta(reloaded))).toBe(formatApa(meta));
    expect(formatApa(meta)).toMatch(/^Chue Hong, N\. P\., & Smith, A\. M\./u);
  });

  it('keep how the paper was matched', () => {
    expect(normalizeMeta({ title: 't', matchedBy: 'title' }).matchedBy).toBe('title');
    expect(normalizeMeta({ title: 't' }).matchedBy).toBeUndefined();
  });
});
