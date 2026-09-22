import { describe, expect, it } from 'vitest';
import {
  EDITOR_TYPE_FREETEXT,
  EDITOR_TYPE_HIGHLIGHT,
  EDITOR_TYPE_INK,
  PDF_ANNOTATION_CACHE_VERSION,
  cachedItemKey,
  describeCachedItem,
  describeFileAnnotation,
  parsePdfAnnotationCache,
  reconcileAnnotations,
  resolveAnnotationConflict,
  snapshotAnnotations,
  toPlainJson,
  type CachedAnnotationItem,
  type FileAnnotationSummary,
  type PdfAnnotationCache,
} from '../src/shared/pdfAnnotations';

const RECT_A: [number, number, number, number] = [72, 700, 200, 712];
const RECT_B: [number, number, number, number] = [72, 500, 300, 540];

function item(overrides: Partial<CachedAnnotationItem> = {}): CachedAnnotationItem {
  const annotationType = overrides.annotationType ?? EDITOR_TYPE_HIGHLIGHT;
  const pageIndex = overrides.pageIndex ?? 0;
  const rect = overrides.rect ?? RECT_A;
  return {
    key: cachedItemKey(annotationType, pageIndex, rect),
    pageIndex,
    annotationType,
    rect,
    data: { annotationType, pageIndex, rect, color: [255, 255, 152] },
    createdAt: 1,
    ...overrides,
  };
}

function mark(overrides: Partial<FileAnnotationSummary> = {}): FileAnnotationSummary {
  return { id: '12R', pageIndex: 0, subtype: 'Highlight', rect: RECT_A, contents: null, popupRef: null, ...overrides };
}

function cache(overrides: Partial<PdfAnnotationCache> = {}): PdfAnnotationCache {
  return { docId: 'fp:x:3', version: PDF_ANNOTATION_CACHE_VERSION, baseFingerprintModified: 'rev1', items: [], deleted: [], updatedAt: 1, ...overrides };
}

describe('toPlainJson', () => {
  it('flattens typed arrays, nested arrays, and maps', () => {
    const out = toPlainJson({ q: new Float32Array([1, 2]), paths: { points: [new Float32Array([3])] }, m: new Map([['k', 1]]), f: () => 1, u: undefined });
    expect(out).toEqual({ q: [1, 2], paths: { points: [[3]] }, m: { k: 1 } });
  });
});

describe('snapshotAnnotations', () => {
  it('turns editor entries into items, edited file annotations into delete + item, and skips form values', () => {
    const { items, deleted } = snapshotAnnotations({
      entries: [
        ['pdfjs_internal_editor_0', { annotationType: EDITOR_TYPE_INK, pageIndex: 2, rect: new Float32Array(RECT_B), paths: { lines: [], points: [[1, 2]] } }],
        ['34R', { annotationType: EDITOR_TYPE_FREETEXT, pageIndex: 0, rect: RECT_A, value: 'note', id: '34R', annotationElementId: '34R' }],
        ['56R', { deleted: true, id: '56R', pageIndex: 1, popupRef: '57R' }],
        ['field1', { value: 'typed into a form field' }],
      ],
      pending: [],
      previous: null,
      fileMarks: [mark({ id: '56R', pageIndex: 1, subtype: 'Ink', rect: RECT_B })],
      now: 99,
    });
    expect(items.map((i) => [i.annotationType, i.pageIndex, i.createdAt])).toEqual([[EDITOR_TYPE_INK, 2, 99], [EDITOR_TYPE_FREETEXT, 0, 99]]);
    expect(items[0].rect).toEqual(RECT_B);
    expect(items[1].data).not.toHaveProperty('id');
    expect(items[1].data).not.toHaveProperty('annotationElementId');
    expect(deleted).toEqual([
      { id: '34R', pageIndex: 0, popupRef: '', subtype: null, rect: null },
      { id: '56R', pageIndex: 1, popupRef: '57R', subtype: 'Ink', rect: RECT_B },
    ]);
  });

  it('keeps pending (not yet restored) items and the original createdAt of known ones', () => {
    const known = item({ createdAt: 5 });
    const pending = item({ pageIndex: 9, createdAt: 7 });
    const { items } = snapshotAnnotations({
      entries: [['e0', { annotationType: known.annotationType, pageIndex: known.pageIndex, rect: known.rect }]],
      pending: [pending],
      previous: cache({ items: [known] }),
      fileMarks: null,
      now: 99,
    });
    expect(items.map((i) => [i.key, i.createdAt])).toEqual([[known.key, 5], [pending.key, 7]]);
  });
});

describe('reconcileAnnotations', () => {
  it('drops cached items the file already contains (the reopened self-saved copy)', () => {
    const result = reconcileAnnotations(cache({ items: [item()], baseFingerprintModified: 'rev1' }), [mark({ rect: [72.4, 700.6, 199.5, 712] })], 'rev2');
    expect(result.kind).toBe('silent');
    if (result.kind !== 'silent') return;
    expect(result.plan.items).toEqual([]);
    expect(result.cache.items).toEqual([]);
    expect(result.cache.baseFingerprintModified).toBe('rev2');
  });

  it('applies silently when the file revision is the one the cache was reconciled with', () => {
    const cached = item({ rect: RECT_B });
    const result = reconcileAnnotations(cache({ items: [cached] }), [mark({ id: '1R', contents: 'colleague' })], 'rev1');
    expect(result.kind).toBe('silent');
    if (result.kind === 'silent') expect(result.plan.items).toEqual([cached]);
  });

  it('applies silently when only one side has anything the other lacks', () => {
    const cached = item({ rect: RECT_B });
    expect(reconcileAnnotations(cache({ items: [cached] }), [], 'rev2').kind).toBe('silent');
    expect(reconcileAnnotations(cache({ items: [] }), [mark()], 'rev2').kind).toBe('silent');
  });

  it('reports a conflict when both sides diverged on a changed file, ignoring links and widgets', () => {
    const cached = item({ rect: RECT_B });
    const result = reconcileAnnotations(
      cache({ items: [cached] }),
      [mark({ id: 'L1', subtype: 'Link' }), mark({ id: 'W1', subtype: 'Widget' }), mark({ id: '9R', subtype: 'Ink', rect: [10, 10, 20, 20] })],
      'rev2',
    );
    expect(result.kind).toBe('conflict');
    if (result.kind !== 'conflict') return;
    expect(result.fileOnly.map((m) => m.id)).toEqual(['9R']);
    expect(result.cacheOnly).toEqual([cached]);
  });

  it('keeps deletes only while they still point at the recorded annotation', () => {
    const del = { id: '5R', pageIndex: 0, popupRef: '', subtype: 'Ink', rect: RECT_B };
    const same = reconcileAnnotations(cache({ deleted: [del] }), [mark({ id: '5R', subtype: 'Ink', rect: RECT_B })], 'rev2');
    const renumbered = reconcileAnnotations(cache({ deleted: [del] }), [mark({ id: '5R', subtype: 'Highlight', rect: RECT_A })], 'rev2');
    const gone = reconcileAnnotations(cache({ deleted: [del] }), [], 'rev2');
    const sameRevisionUnverified = reconcileAnnotations(cache({ deleted: [{ ...del, subtype: null, rect: null }] }), [mark({ id: '5R' })], 'rev1');
    expect(same.kind === 'silent' && same.plan.deletes).toEqual([del]);
    expect(renumbered.kind === 'silent' && renumbered.plan.deletes).toEqual([]);
    expect(gone.kind === 'silent' && gone.plan.deletes).toEqual([]);
    expect(sameRevisionUnverified.kind === 'silent' && sameRevisionUnverified.plan.deletes.map((d) => d.id)).toEqual(['5R']);
  });
});

describe('resolveAnnotationConflict', () => {
  const cached = item({ rect: RECT_B });
  const fileMark = mark({ id: '9R', subtype: 'Ink', rect: [10, 10, 20, 20], popupRef: '10R' });
  const conflict = reconcileAnnotations(cache({ items: [cached] }), [fileMark], 'rev2');
  if (conflict.kind !== 'conflict') throw new Error('fixture must conflict');

  it('file: discards the browser copy', () => {
    const { plan, cache: next } = resolveAnnotationConflict(conflict, { kind: 'file' });
    expect(plan).toEqual({ items: [], deletes: [] });
    expect(next.items).toEqual([]);
  });

  it('browser: removes the file marks and applies the cache', () => {
    const { plan, cache: next } = resolveAnnotationConflict(conflict, { kind: 'browser' });
    expect(plan.items).toEqual([cached]);
    expect(plan.deletes).toEqual([{ id: '9R', pageIndex: 0, popupRef: '10R', subtype: 'Ink', rect: [10, 10, 20, 20] }]);
    expect(next.deleted).toEqual(plan.deletes);
  });

  it('both: keeps everything', () => {
    const { plan } = resolveAnnotationConflict(conflict, { kind: 'both' });
    expect(plan).toEqual({ items: [cached], deletes: [] });
  });

  it('pick: keeps exactly the chosen ones on each side', () => {
    const keepNothing = resolveAnnotationConflict(conflict, { kind: 'pick', keepFileIds: new Set(), keepItemKeys: new Set() });
    expect(keepNothing.plan.items).toEqual([]);
    expect(keepNothing.plan.deletes.map((d) => d.id)).toEqual(['9R']);
    const keepAll = resolveAnnotationConflict(conflict, { kind: 'pick', keepFileIds: new Set(['9R']), keepItemKeys: new Set([cached.key]) });
    expect(keepAll.plan).toEqual({ items: [cached], deletes: [] });
  });
});

describe('labels and parsing', () => {
  it('describes entries by type, page, and text excerpt', () => {
    expect(describeCachedItem(item({ annotationType: EDITOR_TYPE_FREETEXT, data: { value: '  multi\nline  note ' } }))).toBe('텍스트 · 1쪽 · “multi line note”');
    expect(describeCachedItem(item({ pageIndex: 4 }))).toBe('형광펜 · 5쪽');
    expect(describeFileAnnotation(mark({ subtype: 'Text', contents: 'x'.repeat(80) }))).toBe(`메모 · 1쪽 · “${'x'.repeat(59)}…”`);
    expect(describeFileAnnotation(mark({ subtype: 'Weird' }))).toBe('Weird · 1쪽');
  });

  it('parses stored rows, dropping malformed entries and rejecting other versions', () => {
    const good = cache({ items: [item()], deleted: [{ id: '1R', pageIndex: 0, popupRef: '', subtype: null, rect: null }] });
    expect(parsePdfAnnotationCache(good)).toEqual(good);
    expect(parsePdfAnnotationCache({ ...good, version: 99 })).toBeNull();
    expect(parsePdfAnnotationCache({ ...good, items: [{ key: 'k' }], deleted: ['nope'] })).toMatchObject({ items: [], deleted: [] });
    expect(parsePdfAnnotationCache(null)).toBeNull();
  });
});
