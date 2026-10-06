import { describe, expect, it } from 'vitest';
import { compareOrderKeys, isOrderKey, orderKeyAtEnd, orderKeyBetween, orderKeysBetween } from '../src/shared/orderKey';

describe('order keys', () => {
  it('puts a key strictly between two others, at either open end too', () => {
    for (const [a, b] of [[null, null], ['1', null], [null, '1'], ['1', '2'], ['V', 'V1'], ['z', null], ['a', 'b'], ['0V', '1']] as const) {
      const key = orderKeyBetween(a, b);
      expect(isOrderKey(key)).toBe(true);
      if (a !== null) expect(compareOrderKeys(a, key)).toBe(-1);
      if (b !== null) expect(compareOrderKeys(key, b)).toBe(-1);
    }
  });

  it('refuses bounds out of order', () => {
    expect(() => orderKeyBetween('b', 'a')).toThrow();
    expect(() => orderKeyBetween('a', 'a')).toThrow();
  });

  it('keeps inserting at the same spot without running out', () => {
    let low = '1';
    const high = '2';
    for (let i = 0; i < 200; i += 1) {
      const key = orderKeyBetween(low, high);
      expect(compareOrderKeys(low, key)).toBe(-1);
      expect(compareOrderKeys(key, high)).toBe(-1);
      low = key;
    }
    expect(low.length).toBeLessThan(80);
  });

  it('gives short increasing keys for a whole list', () => {
    const keys = orderKeysBetween(null, null, 50);
    expect(keys.every((k) => k.length === 1)).toBe(true);
    expect([...keys].sort(compareOrderKeys)).toEqual(keys);
    const inside = orderKeysBetween('3', '4', 10);
    expect([...inside].sort(compareOrderKeys)).toEqual(inside);
    expect(compareOrderKeys('3', inside[0])).toBe(-1);
    expect(compareOrderKeys(inside[9], '4')).toBe(-1);
    expect(compareOrderKeys('k', orderKeyAtEnd('k'))).toBe(-1);
    expect(compareOrderKeys('z', orderKeyAtEnd('z'))).toBe(-1);
  });

  it('validates keys', () => {
    expect(isOrderKey('a1')).toBe(true);
    expect(isOrderKey('a0')).toBe(false);
    expect(isOrderKey('')).toBe(false);
    expect(isOrderKey('a-b')).toBe(false);
  });
});
