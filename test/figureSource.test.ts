import { describe, expect, it } from 'vitest';
import type { PaperMeta } from '../src/shared/paperIdentifiers';
import {
  DEFAULT_FIGURE_COPY_OPTIONS,
  captionLabel,
  findFigureLabel,
  formatFigureSource,
  groupLines,
  normalizeFigureCopyOptions,
  shortAuthors,
  type PlacedText,
} from '../src/shared/figureSource';

const ARXIV: PaperMeta = {
  title: 'Reasoning Beyond Words? Exploring a Framework for Hidden State Reasoning',
  year: 2024,
  authors: ['Shibo Hao', 'Sainbayar Sukhbaatar', 'DiJia Su'],
  venue: 'arXiv (Cornell University)',
  venueType: 'repository',
  workType: 'preprint',
  doi: null,
  arxivId: '2412.06769',
  openalexId: null,
  citations: { openalex: null, crossref: null, semanticScholar: null },
  citationsByYear: [],
  references: { openalex: null, crossref: null, semanticScholar: null },
  venueTwoYearMeanCitedness: null,
  volume: null,
  issue: null,
  firstPage: null,
  lastPage: null,
  landingUrl: null,
};

describe('captionLabel', () => {
  it('reads the common caption styles', () => {
    expect(captionLabel('Figure 2: The overall pipeline')).toEqual({ kind: 'figure', number: '2', punctuated: true });
    expect(captionLabel('Fig. 12. Results on COCO')).toEqual({ kind: 'figure', number: '12', punctuated: true });
    expect(captionLabel('FIGURE 3 | Overview')).toEqual({ kind: 'figure', number: '3', punctuated: true });
    expect(captionLabel('그림 1: 필기와 읽던 위치')).toEqual({ kind: 'figure', number: '1', punctuated: true });
    expect(captionLabel('표 2. 데이터 출처')).toEqual({ kind: 'table', number: '2', punctuated: true });
    expect(captionLabel('図 3：概要')).toEqual({ kind: 'figure', number: '3', punctuated: true });
    expect(captionLabel('그림 1에서 보듯이')).toBeNull();
    expect(captionLabel('Table 1: Main results')).toEqual({ kind: 'table', number: '1', punctuated: true });
    expect(captionLabel('TABLE IV')).toEqual({ kind: 'table', number: 'IV', punctuated: false });
    expect(captionLabel('Figure S3: Extra')).toMatchObject({ number: 'S3' });
    expect(captionLabel('Figure 2a. Detail')).toMatchObject({ number: '2a' });
  });

  it('marks body sentences as unpunctuated and ignores the rest', () => {
    expect(captionLabel('Figure 2 shows the pipeline')).toMatchObject({ punctuated: false });
    expect(captionLabel('As shown in Figure 2, the model')).toBeNull();
    expect(captionLabel('Figures are drawn')).toBeNull();
    expect(captionLabel('Figure I')).toBeNull();
  });
});

describe('groupLines', () => {
  const at = (str: string, x: number, baseline: number, width = str.length * 5, height = 10): PlacedText => ({ str, x, baseline, width, height });

  it('joins runs on one baseline and splits columns', () => {
    const lines = groupLines([
      at('Figure 2:', 50, 300, 40),
      at('The pipeline', 94, 300.5),
      at('Table 1:', 320, 300, 35),
      at('Next line', 50, 314),
    ]);
    expect(lines.map((l) => l.text)).toEqual(['Figure 2: The pipeline', 'Table 1:', 'Next line']);
    expect(lines[0]).toMatchObject({ left: 50, top: 290, bottom: 300 });
  });
});

describe('findFigureLabel', () => {
  const line = (text: string, left: number, top: number, right = left + 200) => ({ text, left, top, right, bottom: top + 10 });
  const region = { left: 60, top: 100, right: 280, bottom: 260 };

  it('takes the figure caption just below the region', () => {
    const lines = [line('Figure 1: Earlier', 60, 40), line('Figure 2: This one', 60, 268), line('Body text', 60, 290)];
    expect(findFigureLabel(lines, region)).toEqual({ kind: 'figure', number: '2' });
  });

  it('takes the table caption just above the region', () => {
    const lines = [line('Table 3: Results', 60, 84), line('Figure 4: Further down', 60, 300)];
    expect(findFigureLabel(lines, region)).toEqual({ kind: 'table', number: '3' });
  });

  it('takes a caption inside the region, and ignores the other column and far captions', () => {
    expect(findFigureLabel([line('Fig. 5. Inside', 70, 240)], region)).toEqual({ kind: 'figure', number: '5' });
    expect(findFigureLabel([line('Figure 6: Other column', 320, 268)], region)).toBeNull();
    expect(findFigureLabel([line('Figure 7: Far below', 60, 600)], region)).toBeNull();
  });

  it('prefers a real caption over a sentence starting with "Figure N"', () => {
    const lines = [line('Figure 8 shows the result', 60, 264), line('Figure 9: Caption', 60, 278)];
    expect(findFigureLabel(lines, region)).toEqual({ kind: 'figure', number: '9' });
  });
});

describe('formatFigureSource', () => {
  const base = { docTitle: 'paper.pdf', pageNumber: 3, prefix: 'Source:', style: 'short' as const };

  it('writes the short slide credit', () => {
    expect(formatFigureSource({ ...base, meta: ARXIV, label: { kind: 'figure', number: '2' } }))
      .toBe('Source: Hao et al. (2024). Reasoning Beyond Words? Exploring a Framework for Hidden State Reasoning. arXiv. Fig. 2.');
    expect(formatFigureSource({ ...base, prefix: '출처:', meta: { ...ARXIV, authors: ['Shibo Hao', 'Jason Weston'], arxivId: null, venue: 'ICLR' }, label: { kind: 'table', number: '1' } }))
      .toBe('출처: Hao & Weston (2024). Reasoning Beyond Words? Exploring a Framework for Hidden State Reasoning. ICLR. Table 1.');
  });

  it('falls back to the page and the document name', () => {
    expect(formatFigureSource({ ...base, prefix: '', meta: { ...ARXIV, authors: [], year: null }, label: null }))
      .toBe('Reasoning Beyond Words? Exploring a Framework for Hidden State Reasoning. arXiv. p. 3.');
    expect(formatFigureSource({ ...base, meta: null, label: null })).toBe('Source: paper.pdf. p. 3.');
  });

  it('writes the APA reference with the label', () => {
    expect(formatFigureSource({ ...base, style: 'apa', meta: ARXIV, label: { kind: 'figure', number: '2' } }))
      .toBe('Source: Hao, S., Sukhbaatar, S., & Su, D. (2024). Reasoning Beyond Words? Exploring a Framework for Hidden State Reasoning. arXiv. https://doi.org/10.48550/arXiv.2412.06769. Fig. 2.');
  });
});

describe('shortAuthors / options', () => {
  it('shortens author lists', () => {
    expect(shortAuthors([])).toBe('');
    expect(shortAuthors(['Ada Lovelace'])).toBe('Lovelace');
  });

  it('normalizes stored options', () => {
    expect(normalizeFigureCopyOptions(undefined)).toEqual(DEFAULT_FIGURE_COPY_OPTIONS);
    expect(normalizeFigureCopyOptions({ dpi: 123, copy: 'source', prefix: '출처:', annotations: true, continuous: true, autoDetect: 'no', result: 'bar', dismiss: 'manual' }))
      .toEqual({ ...DEFAULT_FIGURE_COPY_OPTIONS, copy: 'source', prefix: '출처:', annotations: true, continuous: true, result: 'bar', dismiss: 'manual' });
    expect(normalizeFigureCopyOptions({ result: 'popup', dismiss: 'later' })).toMatchObject({ result: 'card', dismiss: 'auto' });
  });

  it('reads the single `source` option older builds stored', () => {
    expect(normalizeFigureCopyOptions({ source: 'separate' })).toMatchObject({ copy: 'image', embed: false });
    expect(normalizeFigureCopyOptions({ source: 'together' })).toMatchObject({ copy: 'image-source', embed: false });
    expect(normalizeFigureCopyOptions({ source: 'embed' })).toMatchObject({ copy: 'image', embed: true });
    // Once stored in the new shape, the old field is ignored.
    expect(normalizeFigureCopyOptions({ source: 'embed', copy: 'none', embed: false })).toMatchObject({ copy: 'none', embed: false });
  });
});
