import { describe, expect, it } from 'vitest';

import {
  HUB_CLOSED_MAX,
  arxivVersionBadges,
  fileIdentity,
  findOpenDoc,
  homeFilterChoices,
  homePositionKey,
  hubDocKey,
  moveInOrder,
  parseClosedTabs,
  parseLocalTabs,
  progressBucket,
  sameSource,
  visibleSelection,
  pickTabsToSleep,
  pushClosedTab,
  type HubClosedTab,
  type HubSleepCandidate,
} from '../src/shared/hubTabs';

const tab = (url: string | null, docId: string | null = null) => ({ url, docId });

describe('same document detection', () => {
  it('keys arXiv URLs by paper and version', () => {
    expect(hubDocKey('https://arxiv.org/pdf/1706.03762v7.pdf#page=2')).toEqual({ url: 'https://arxiv.org/pdf/1706.03762v7.pdf', paper: '1706.03762', version: 'v7' });
    expect(hubDocKey('https://example.org/a.pdf')).toMatchObject({ paper: null, version: null });
  });

  it('matches the same URL, and arXiv variants of one paper', () => {
    const open = [tab('https://a.org/x.pdf'), tab('https://arxiv.org/pdf/1706.03762v7'), tab('https://arxiv.org/pdf/2401.00001')];
    expect(findOpenDoc('https://a.org/x.pdf#page=3', open)).toBe(0);
    // `.pdf`, www and http all name the same versioned file.
    expect(findOpenDoc('http://www.arxiv.org/pdf/1706.03762v7.pdf', open)).toBe(1);
    // Versionless means latest: any open copy of the paper serves.
    expect(findOpenDoc('https://arxiv.org/pdf/1706.03762', open)).toBe(1);
    // An explicit other version stays apart.
    expect(findOpenDoc('https://arxiv.org/pdf/1706.03762v1', open)).toBe(-1);
    expect(findOpenDoc('https://arxiv.org/pdf/2401.00001v2', open)).toBe(-1);
    expect(findOpenDoc('https://b.org/y.pdf', open)).toBe(-1);
  });

  it('prefers the exact version when several are open', () => {
    const open = [tab('https://arxiv.org/pdf/1706.03762v1'), tab('https://arxiv.org/pdf/1706.03762')];
    expect(findOpenDoc('https://arxiv.org/pdf/1706.03762.pdf', open)).toBe(1);
  });

  it('matches a mirror through the document the library last opened from it', () => {
    const open = [tab('https://a.org/x.pdf', 'doc-1'), tab(null, 'doc-2')];
    const lookup = (url: string) => (url === 'https://mirror.org/x.pdf' ? 'doc-1' : null);
    expect(findOpenDoc('https://mirror.org/x.pdf', open, lookup)).toBe(0);
    expect(findOpenDoc('https://other.org/x.pdf', open, lookup)).toBe(-1);
  });

  it('badges arXiv versions only where two versions of a paper are open', () => {
    expect(arxivVersionBadges([
      'https://arxiv.org/pdf/1706.03762v1',
      'https://arxiv.org/pdf/1706.03762',
      'https://arxiv.org/pdf/2401.00001v2',
      null,
      'https://a.org/x.pdf',
    ])).toEqual(['v1', '최신', null, null, null]);
  });
});

describe('sleeping frames', () => {
  const t = (key: number, lastShownAt: number, over: Partial<HubSleepCandidate> = {}): HubSleepCandidate =>
    ({ key, loaded: true, active: false, lastShownAt, busyUntil: 0, ...over });
  const limits = { maxLoaded: 3, idleMs: 1_000 };

  it('unloads idle frames and the least recently shown beyond the cap, never the front one', () => {
    const now = 10_000;
    expect(pickTabsToSleep([t(1, 9_900), t(2, 9_950), t(3, 9_990, { active: true })], now, limits)).toEqual([]);
    expect(pickTabsToSleep([t(1, 5_000), t(2, 9_950), t(3, 1, { active: true })], now, limits)).toEqual([1]);
    const crowded = [t(1, 9_500), t(2, 9_100), t(3, 9_800), t(4, 9_700), t(5, 9_900, { active: true })];
    expect(pickTabsToSleep(crowded, now, limits)).toEqual([2, 1]);
  });

  it('skips unloaded frames and frames that asked to stay', () => {
    const now = 10_000;
    expect(pickTabsToSleep([t(1, 1, { loaded: false }), t(2, 1, { busyUntil: 20_000 }), t(3, 1)], now, limits)).toEqual([3]);
  });
});

describe('recently closed', () => {
  const closed = (url: string | null, fileId: number | null = null): HubClosedTab =>
    ({ url, fileId, title: url ?? 'local.pdf', paperTitle: null, index: 0, closedAt: 1 });

  it('keeps the newest first, one entry per document, bounded', () => {
    let stack: HubClosedTab[] = [];
    for (let i = 0; i < HUB_CLOSED_MAX + 3; i += 1) stack = pushClosedTab(stack, closed(`https://a.org/${i}.pdf`));
    stack = pushClosedTab(stack, closed('https://a.org/5.pdf'));
    expect(stack).toHaveLength(HUB_CLOSED_MAX);
    expect(stack[0].url).toBe('https://a.org/5.pdf');
    expect(stack.filter((e) => e.url === 'https://a.org/5.pdf')).toHaveLength(1);
  });

  it('reads back only well-formed entries', () => {
    expect(parseClosedTabs([closed('https://a.org/x.pdf'), closed(null, 3), { url: null, fileId: null, title: 't', index: 0, closedAt: 1 }, 'x']))
      .toEqual([closed('https://a.org/x.pdf'), closed(null, 3)]);
    expect(parseClosedTabs('nope')).toEqual([]);
  });
});

describe('reordering', () => {
  it('puts the dragged item before or after the target, or last', () => {
    expect(moveInOrder(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
    expect(moveInOrder(['a', 'b', 'c', 'd'], 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveInOrder(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a']);
    expect(moveInOrder(['a', 'b', 'c'], 'b', 'zz')).toEqual(['a', 'c', 'b']);
    expect(moveInOrder(['a', 'b'], 'a', 'a', true)).toEqual(['a', 'b']);
    // A pin without a tab here (another device's local file) keeps its place.
    expect(moveInOrder(['p1', 'local', 'p2'], 'p2', 'p1')).toEqual(['p2', 'p1', 'local']);
  });
});

describe('home', () => {
  it('keeps only the selected rows still on screen', () => {
    expect([...visibleSelection(['a', 'b', 'c'], ['b', 'c', 'd'])]).toEqual(['b', 'c']);
    expect(visibleSelection(['a'], []).size).toBe(0);
  });

  it('always offers the filter in force', () => {
    expect(homeFilterChoices('all', ['journal', 'preprint'], ['reading'], 'all')).toEqual(['all', 'journal', 'preprint', 'reading']);
    // One kind only: no kind chips — unless that kind is the active filter.
    expect(homeFilterChoices('all', ['journal'], ['reading'], 'all')).toEqual(['all', 'reading']);
    expect(homeFilterChoices('all', ['journal'], ['reading'], 'survey')).toEqual(['all', 'survey', 'reading']);
  });

  it('re-renders only for position changes home shows', () => {
    expect(progressBucket(null, 10)).toBe('unread');
    expect(progressBucket(1, 10)).toBe('unread');
    expect(progressBucket(5, 10)).toBe('reading');
    expect(progressBucket(10, 10)).toBe('done');
    const entries = [{ docId: 'a', numPages: 10 }, { docId: 'b', numPages: 10 }];
    const key = (pages: Record<string, number>, shown: string[], every = false) => homePositionKey(entries, (id) => pages[id] ?? null, new Set(shown), every);
    // b is off screen: moving from page 3 to 4 changes nothing home shows…
    expect(key({ a: 2, b: 3 }, ['a'])).toBe(key({ a: 2, b: 4 }, ['a']));
    // …but starting to read it changes the filter counts,
    expect(key({ a: 2, b: 1 }, ['a'])).not.toBe(key({ a: 2, b: 4 }, ['a']));
    // a row on screen shows its page, and a progress sort orders by every page.
    expect(key({ a: 2, b: 3 }, ['a'])).not.toBe(key({ a: 3, b: 3 }, ['a']));
    expect(key({ a: 2, b: 3 }, ['a'], true)).not.toBe(key({ a: 2, b: 4 }, ['a'], true));
  });
});

describe('gathering and local files', () => {
  it('compares sources without their fragment', () => {
    expect(sameSource('https://x.org/a.pdf#page=2', 'https://x.org/a.pdf')).toBe(true);
    expect(sameSource('https://x.org/a.pdf', 'https://x.org/b.pdf')).toBe(false);
  });

  it('reads the local-file tab record defensively', () => {
    expect(parseLocalTabs([
      { fileId: 3, index: 2, title: 'a.pdf', paperTitle: 'A', active: true },
      { fileId: 3, index: 4, title: 'dup.pdf' },
      { fileId: 'x', index: 0, title: 'bad' },
      { fileId: 4, index: -2, title: 'b.pdf', paperTitle: 7 },
      null,
    ])).toEqual([
      { fileId: 3, index: 2, title: 'a.pdf', paperTitle: 'A', active: true },
      { fileId: 4, index: 0, title: 'b.pdf', paperTitle: null, active: false },
    ]);
    expect(parseLocalTabs('nope')).toEqual([]);
  });

  it('names a file by what it is, not by the object holding it', () => {
    const one = { name: 'a.pdf', size: 10, lastModified: 5 };
    expect(fileIdentity(one)).toBe(fileIdentity({ ...one }));
    expect(fileIdentity(one)).not.toBe(fileIdentity({ ...one, size: 11 }));
  });
});
