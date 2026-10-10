import { describe, expect, it } from 'vitest';
import { mergeSyncedSettings, parseSyncedSettingList } from '../src/shared/syncedSettings';

describe('synced settings', () => {
  it('keeps the latest change per key, and keys this build does not know', () => {
    const here = [{ key: 'rpdfDisplay', value: { tabTitle: 'file' }, updatedAt: 20 }, { key: 'paperStripShown', value: true, updatedAt: 5 }];
    const there = [{ key: 'paperStripShown', value: false, updatedAt: 9 }, { key: 'rpdfDisplay', value: { tabTitle: 'paper' }, updatedAt: 10 }, { key: 'futureThing', value: 1, updatedAt: 3 }];
    const merged = mergeSyncedSettings(here, there);
    expect(merged).toEqual([
      { key: 'futureThing', value: 1, updatedAt: 3 },
      { key: 'paperStripShown', value: false, updatedAt: 9 },
      { key: 'rpdfDisplay', value: { tabTitle: 'file' }, updatedAt: 20 },
    ]);
    expect(mergeSyncedSettings(there, here)).toEqual(merged);
    // A tie picks the same row on both sides.
    const a = [{ key: 'k', value: 'a', updatedAt: 1 }];
    const b = [{ key: 'k', value: 'b', updatedAt: 1 }];
    expect(mergeSyncedSettings(a, b)).toEqual(mergeSyncedSettings(b, a));
  });

  it('refuses a list another build could not read back', () => {
    expect(parseSyncedSettingList([{ key: 'k', value: 1, updatedAt: 1 }])).toEqual([{ key: 'k', value: 1, updatedAt: 1 }]);
    expect(parseSyncedSettingList([{ key: 'k', value: 1, updatedAt: 1 }, { key: 'k', value: 2, updatedAt: 2 }])).toBeNull();
    expect(parseSyncedSettingList([{ key: 'k', updatedAt: 1 }])).toBeNull();
    expect(parseSyncedSettingList([{ key: 'k', value: 'x'.repeat(20_000), updatedAt: 1 }])).toBeNull();
    expect(parseSyncedSettingList('nope')).toBeNull();
  });
});
