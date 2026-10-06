import { describe, expect, it } from 'vitest';
import { ORDER_KEY_MAX_CHARS, compareOrderKeys, evenOrderKeys, isOrderKey, isOrderKeyCandidate, orderKeyAtEnd, orderKeyBetween, orderKeysBetween } from '../src/shared/orderKey';

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

  it('runs past the length limit after some hundreds of moves to one spot, which the model then re-keys', () => {
    let low = '1';
    let moves = 0;
    while (isOrderKey(orderKeyBetween(low, '2'))) { low = orderKeyBetween(low, '2'); moves += 1; }
    // Between 200 and a thousand moves (the model test drives 1,000 through re-keying).
    expect(moves).toBeGreaterThan(200);
    expect(moves).toBeLessThan(1_000);
    const next = orderKeyBetween(low, '2');
    expect(next.length).toBeGreaterThan(ORDER_KEY_MAX_CHARS);
    expect(isOrderKeyCandidate(next)).toBe(true);
    expect(isOrderKeyCandidate('V'.repeat(ORDER_KEY_MAX_CHARS * 2 + 1))).toBe(false);
  });

  it('spreads a fresh level evenly, as short as the count allows', () => {
    for (const count of [0, 1, 2, 61, 62, 300, 4_000]) {
      const keys = evenOrderKeys(count);
      expect(keys).toHaveLength(count);
      expect(keys.every(isOrderKey)).toBe(true);
      expect(new Set(keys).size).toBe(count);
      expect([...keys].sort(compareOrderKeys)).toEqual(keys);
    }
    expect(evenOrderKeys(61).every((k) => k.length === 1)).toBe(true);
    expect(Math.max(...evenOrderKeys(300).map((k) => k.length))).toBe(2);
    // Room is left at both ends and between neighbours.
    const keys = evenOrderKeys(300);
    expect(isOrderKey(orderKeyBetween(null, keys[0]))).toBe(true);
    expect(isOrderKey(orderKeyBetween(keys[299], null))).toBe(true);
    expect(keys.slice(1).every((k, i) => isOrderKey(orderKeyBetween(keys[i], k)))).toBe(true);
  });
});
