import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dropPaperCache, migrateLegacyPaperCache, readPaperCache, resetPaperCacheForTests, trimPaperCache, writePaperCache } from '../src/ui/pdfViewer/paperCache';

const DAY = 24 * 60 * 60 * 1000;

function fakeStorage(initial: Record<string, unknown>) {
  const data = { ...initial };
  const local = {
    getKeys: vi.fn(async () => Object.keys(data)),
    get: vi.fn(async () => ({ ...data })),
    remove: vi.fn(async (keys: string[]) => { for (const key of keys) delete data[key]; }),
  };
  vi.stubGlobal('chrome', { storage: { local } });
  return { data, local };
}

async function freshDb(): Promise<void> {
  resetPaperCacheForTests();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('ResearchPDF-papers');
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

describe('paper lookup cache', () => {
  beforeEach(async () => {
    fakeStorage({});
    await freshDb();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns what was written, until it is a week old', async () => {
    const t0 = 1_000_000_000_000;
    await writePaperCache('10.1/x', { title: 'A' }, t0);
    expect(await readPaperCache('10.1/x', t0 + DAY)).toEqual({ title: 'A' });
    expect(await readPaperCache('10.1/x', t0 + 8 * DAY)).toBeNull();
    // Expired rows are gone, not just hidden.
    expect(await readPaperCache('10.1/x', t0)).toBeNull();
  });

  it('drops an entry on request', async () => {
    await writePaperCache('k', 1);
    await dropPaperCache('k');
    expect(await readPaperCache('k')).toBeNull();
  });

  it('keeps the most recently used entries within the cap', async () => {
    const t0 = 1_000_000_000_000;
    for (let i = 0; i < 6; i += 1) await writePaperCache(`k${i}`, i, t0 + i);
    // k0 read last: now the most recently used.
    expect(await readPaperCache('k0', t0 + 100)).toBe(0);
    expect(await trimPaperCache(3, t0 + 200)).toBe(3);
    expect(await readPaperCache('k0', t0 + 300)).toBe(0);
    expect(await readPaperCache('k5', t0 + 300)).toBe(5);
    expect(await readPaperCache('k4', t0 + 300)).toBe(4);
    expect(await readPaperCache('k1', t0 + 300)).toBeNull();
  });

  it('removes the old chrome.storage.local copies once, and nothing else', async () => {
    const { data, local } = fakeStorage({
      'vtPaperMeta:v2:10.1/x': { fetchedAt: 1, meta: {} },
      'vtPaperRefs:v2:10.1/x:s2': { fetchedAt: 1, entries: [] },
      rpdfLibrary: { rows: [] },
      pdfDocState: {},
    });
    await migrateLegacyPaperCache();
    expect(Object.keys(data).sort()).toEqual(['pdfDocState', 'rpdfLibrary']);
    // A new page (module state reset) finds the marker and leaves storage alone.
    resetPaperCacheForTests();
    data['vtPaperMeta:v2:other'] = {};
    await migrateLegacyPaperCache();
    expect(local.getKeys).toHaveBeenCalledTimes(1);
    expect(data['vtPaperMeta:v2:other']).toBeDefined();
  });
});
