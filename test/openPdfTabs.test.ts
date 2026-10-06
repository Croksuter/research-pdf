import { describe, expect, it } from 'vitest';

import { GATHER_MESSAGE, GATHER_RESULT_MESSAGE, SETTINGS_SHOWN_MESSAGE, looksLikePdf, tabPlace, zoomHash } from '../src/ui/openPdfTabs';

describe('PDFs open in Chrome\'s viewer', () => {
  it('carries Chrome\'s zoom over as a fragment, none at 100 %', () => {
    expect(zoomHash({ zoom: 1.25 })).toBe('#zoom=125');
    expect(zoomHash({ zoom: 1 })).toBe('');
    expect(zoomHash({ zoom: 1.004 })).toBe('');
    expect(zoomHash({ zoom: null })).toBe('');
  });

  it('counts addresses that look like a PDF', () => {
    expect(looksLikePdf('https://example.org/paper.pdf')).toBe(true);
    expect(looksLikePdf('https://arxiv.org/pdf/1706.03762')).toBe(true);
    expect(looksLikePdf('file:///home/me/a.pdf')).toBe(true);
    expect(looksLikePdf('https://example.org/paper.html')).toBe(false);
  });

  it('names a tab by its file or host', () => {
    expect(tabPlace('https://www.example.org/x/a.pdf')).toBe('example.org');
    expect(tabPlace('file:///home/me/My%20Paper.pdf')).toBe('My Paper.pdf');
    expect(tabPlace('not a url')).toBe('');
  });

  it('keeps the hub ↔ settings message names apart', () => {
    expect(new Set([GATHER_MESSAGE, GATHER_RESULT_MESSAGE, SETTINGS_SHOWN_MESSAGE]).size).toBe(3);
  });
});
