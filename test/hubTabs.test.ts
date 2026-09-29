import { describe, expect, it } from 'vitest';

import {
  HUB_CLOSED_MAX,
  arxivVersionBadges,
  findOpenDoc,
  hubDocKey,
  parseClosedTabs,
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
