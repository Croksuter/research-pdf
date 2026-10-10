import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DRAG_PREFS, TAB_DRAG_TYPE, dropCase, parseDragPrefs, parseTabPayload, sourceOfTypes, sourceType, windowAtPoint,
} from '../src/shared/tabTransfer';

const payload = { from: 12, key: 3, project: 'p1x', url: 'https://arxiv.org/pdf/2401.00001', docId: 'fp:abc:3', title: 'T', paperTitle: null, pinned: false };

describe('moving a tab between hubs', () => {
  it('names the source hub and project in a type of its own, readable while dragging', () => {
    const types = ['text/html', TAB_DRAG_TYPE, sourceType(12, 'p1x')];
    expect(sourceOfTypes(types)).toEqual({ from: 12, project: 'p1x' });
    expect(sourceOfTypes([TAB_DRAG_TYPE, sourceType(5, 'my-proj_2')])).toEqual({ from: 5, project: 'my-proj_2' });
    expect(sourceOfTypes([TAB_DRAG_TYPE])).toBeNull();
    expect(sourceOfTypes(['application/x-rpdf-src-x-p1x'])).toBeNull();
  });

  it('reads a payload by shape, as JSON or an object, and never a script address', () => {
    expect(parseTabPayload(JSON.stringify(payload))).toEqual(payload);
    expect(parseTabPayload({ ...payload, url: null, docId: null })).toMatchObject({ url: null, docId: null });
    expect(parseTabPayload({ ...payload, url: 'javascript:alert(1)' })).toBeNull();
    expect(parseTabPayload({ ...payload, project: '../x' })).toBeNull();
    expect(parseTabPayload({ ...payload, from: '12' })).toBeNull();
    expect(parseTabPayload('{not json')).toBeNull();
    expect(parseTabPayload({ ...payload, title: 'x'.repeat(900) })?.title).toHaveLength(300);
  });

  it('tells the three cases apart: same project (or already there), another project, the default one', () => {
    expect(dropCase('p1x', 'p1x', false)).toBe('same');
    expect(dropCase('p1x', 'p2y', true)).toBe('same');
    expect(dropCase('p1x', 'p2y', false)).toBe('other');
    expect(dropCase('default', 'p2y', false)).toBe('other');
    expect(dropCase('p1x', 'default', false)).toBe('default');
    expect(dropCase('default', 'default', false)).toBe('same');
  });

  it('reads the device settings, asking by default and the window drop off (beta)', () => {
    expect(parseDragPrefs(undefined)).toEqual(DEFAULT_DRAG_PREFS);
    expect(DEFAULT_DRAG_PREFS).toEqual({ same: 'ask', other: 'ask', default: 'ask', windowDrop: false });
    expect(parseDragPrefs({ same: 'move', other: 'keep', default: 'nope', windowDrop: true })).toEqual({ same: 'move', other: 'keep', default: 'ask', windowDrop: true });
  });

  it('finds the window under a point: the one focused last of those there, never the excluded or a minimized one', () => {
    const windows = [
      { id: 1, left: 0, top: 0, width: 1000, height: 800, minimized: false },
      { id: 2, left: 800, top: 0, width: 1000, height: 800, minimized: false },
      { id: 3, left: 900, top: 0, width: 500, height: 500, minimized: true },
    ];
    expect(windowAtPoint(windows, { x: 900, y: 100 }, [2, 1], null)).toBe(2);
    expect(windowAtPoint(windows, { x: 900, y: 100 }, [1, 2], null)).toBe(1);
    expect(windowAtPoint(windows, { x: 900, y: 100 }, [], null)).toBe(1);
    expect(windowAtPoint(windows, { x: 900, y: 100 }, [1, 2], 1)).toBe(2);
    expect(windowAtPoint(windows, { x: 100, y: 100 }, [1], 1)).toBeNull();
    expect(windowAtPoint(windows, { x: 1000, y: 900 }, [3], null)).toBeNull();
    // The right and bottom edges belong to the next window over.
    expect(windowAtPoint(windows, { x: 1800, y: 100 }, [], null)).toBeNull();
  });
});
