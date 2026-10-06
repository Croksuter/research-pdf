// ─── Order keys: a list order that merges without conflicts (pure) ───
//
// Each item carries its own key and the list is sorted by key. Putting an item
// between two others gives it a key between theirs and changes nothing else,
// so two devices reordering different items never overwrite each other (an
// array of ids would). Keys are base-62 fractions compared as plain strings
// (code unit order, never `localeCompare`); none ends in '0', so there is
// always room between two of them.

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const ORDER_KEY_MAX_CHARS = 80;
const KEY_PATTERN = /^[0-9A-Za-z]*[1-9A-Za-z]$/u;

export function isOrderKey(value: unknown): value is string {
  return typeof value === 'string' && value.length <= ORDER_KEY_MAX_CHARS && KEY_PATTERN.test(value);
}

/**
 * A well-formed key that may be a little over the stored limit: what a page
 * computes between two long neighbours. Accepted in an update, whose apply
 * then re-keys that level (stored keys are always `isOrderKey`).
 */
export function isOrderKeyCandidate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= ORDER_KEY_MAX_CHARS * 2 && KEY_PATTERN.test(value);
}

export function compareOrderKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// The midpoint of two fractions written as digit strings (`b` null: 1).
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n += 1;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const low = a ? DIGITS.indexOf(a[0]) : 0;
  const high = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (high - low > 1) return DIGITS[Math.round((low + high) / 2)];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[low] + midpoint(a.slice(1), null);
}

/** A key strictly between `before` and `after` (null: an open end). */
export function orderKeyBetween(before: string | null, after: string | null): string {
  if (before !== null && after !== null && compareOrderKeys(before, after) >= 0) {
    throw new Error(`order keys out of order: ${before} >= ${after}`);
  }
  return midpoint(before ?? '', after);
}

/** A key after `before` (null: the first key), one step on rather than halfway to the end. */
function orderKeyAfter(before: string | null): string {
  const digit = before ? DIGITS.indexOf(before[0]) : 0;
  return digit + 1 < DIGITS.length ? DIGITS[digit + 1] : midpoint(before ?? '', null);
}

/**
 * `count` increasing keys spread evenly over the whole range, as short as the
 * count allows (one character up to 61 items): a fresh start for a level.
 */
export function evenOrderKeys(count: number): string[] {
  let width = 1;
  while (DIGITS.length ** width < count + 1) width += 1;
  const span = DIGITS.length ** width;
  const keys: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let n = Math.floor(((i + 1) * span) / (count + 1));
    let key = '';
    for (let d = 0; d < width; d += 1) {
      key = DIGITS[n % DIGITS.length] + key;
      n = Math.floor(n / DIGITS.length);
    }
    keys.push(key.replace(/0+$/u, ''));
  }
  return keys;
}

/** `count` increasing keys between `before` and `after` (both open: evenly spread). */
export function orderKeysBetween(before: string | null, after: string | null, count: number): string[] {
  if (before === null && after === null) return evenOrderKeys(count);
  const keys: string[] = [];
  let low = before;
  for (let i = 0; i < count; i += 1) {
    const key = after === null ? orderKeyAfter(low) : orderKeyBetween(low, after);
    keys.push(key);
    low = key;
  }
  return keys;
}

/** A key for the end of a list whose last key is `last`. */
export function orderKeyAtEnd(last: string | null): string {
  return orderKeyAfter(last);
}
