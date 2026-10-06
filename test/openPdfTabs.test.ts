import { describe, expect, it } from 'vitest';
import { GATHER_MESSAGE, GATHER_RESULT_MESSAGE, SETTINGS_SHOWN_MESSAGE, looksLikePdf, tabPlace, zoomHash } from '../src/ui/openPdfTabs';

describe('PDFs open in Chrome’s viewer', () => {
  it('counts a tab whose address looks like a PDF', () => {
    expect(looksLikePdf('https://example.org/paper.pdf')).toBe(true);
    expect(looksLikePdf('https://example.org/paper.PDF?download=1')).toBe(true);
    expect(looksLikePdf('file:///home/me/paper.pdf')).toBe(true);
    expect(looksLikePdf('https://arxiv.org/pdf/1706.03762')).toBe(true);
    expect(looksLikePdf('https://www.arxiv.org/pdf/1706.03762v7')).toBe(true);
    expect(looksLikePdf('https://arxiv.org/abs/1706.03762')).toBe(false);
    expect(looksLikePdf('https://example.org/paper.html')).toBe(false);
    expect(looksLikePdf('file:///home/me/notes.txt')).toBe(false);
    expect(looksLikePdf('chrome://extensions/')).toBe(false);
    expect(looksLikePdf('not a url')).toBe(false);
  });

  it('carries a zoom other than 100 % as #zoom=N', () => {
    expect(zoomHash({ zoom: 1.25 })).toBe('#zoom=125');
    expect(zoomHash({ zoom: 0.667 })).toBe('#zoom=67');
    expect(zoomHash({ zoom: 1 })).toBe('');
    expect(zoomHash({ zoom: 1.005 })).toBe('');
    expect(zoomHash({ zoom: null })).toBe('');
    expect(zoomHash({ zoom: 0 })).toBe('');
  });

  it('names a tab by its file or host', () => {
    expect(tabPlace('file:///home/me/My%20Paper.pdf')).toBe('My Paper.pdf');
    expect(tabPlace('https://www.example.org/a/b.pdf')).toBe('example.org');
    expect(tabPlace('https://arxiv.org/pdf/1706.03762')).toBe('arxiv.org');
    expect(tabPlace('nonsense')).toBe('');
  });

  it('keeps the hub ↔ settings message names apart', () => {
    expect(new Set([GATHER_MESSAGE, GATHER_RESULT_MESSAGE, SETTINGS_SHOWN_MESSAGE]).size).toBe(3);
  });
});
