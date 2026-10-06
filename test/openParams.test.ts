import { describe, expect, it } from 'vitest';

import { classifyViewerHash } from '../src/ui/pdfViewer/openParams';

describe('viewer URL fragment', () => {
  it('nothing, or only chrome the viewer has no use for: the remembered position applies', () => {
    expect(classifyViewerHash('')).toEqual({ kind: 'none' });
    expect(classifyViewerHash('#')).toEqual({ kind: 'none' });
    expect(classifyViewerHash('toolbar=0&navpanes=0')).toEqual({ kind: 'none' });
    expect(classifyViewerHash('#toolbar=0&navpanes=0&scrollbar=0&statusbar=0&messages=0')).toEqual({ kind: 'none' });
  });

  it('a page, a named destination or a bare destination is a place', () => {
    expect(classifyViewerHash('page=3')).toEqual({ kind: 'position', hash: 'page=3' });
    expect(classifyViewerHash('#page=3&zoom=150')).toEqual({ kind: 'position', hash: 'page=3&zoom=150' });
    expect(classifyViewerHash('toolbar=0&PAGE=2')).toEqual({ kind: 'position', hash: 'toolbar=0&PAGE=2' });
    expect(classifyViewerHash('nameddest=sec2')).toEqual({ kind: 'position', hash: 'nameddest=sec2' });
    expect(classifyViewerHash('section.2')).toEqual({ kind: 'position', hash: 'section.2' });
  });

  it('a plain zoom keeps the remembered page at that zoom', () => {
    expect(classifyViewerHash('zoom=150')).toEqual({ kind: 'view', scale: '1.5', linkHash: null, setsZoom: true });
    expect(classifyViewerHash('toolbar=0&zoom=80')).toEqual({ kind: 'view', scale: '0.8', linkHash: null, setsZoom: true });
  });

  it('view=Fit… becomes a scale value', () => {
    expect(classifyViewerHash('view=FitH')).toEqual({ kind: 'view', scale: 'page-width', linkHash: null, setsZoom: true });
    expect(classifyViewerHash('toolbar=0&view=Fit')).toEqual({ kind: 'view', scale: 'page-fit', linkHash: null, setsZoom: true });
    expect(classifyViewerHash('view=FitBH,100')).toEqual({ kind: 'view', scale: 'page-width', linkHash: null, setsZoom: true });
    expect(classifyViewerHash('view=Weird')).toEqual({ kind: 'none' });
  });

  it('what only PDF.js reads goes to it after the remembered page', () => {
    expect(classifyViewerHash('zoom=100,0,200')).toEqual({ kind: 'view', scale: null, linkHash: 'zoom=100,0,200', setsZoom: true });
    expect(classifyViewerHash('zoom=FitH')).toEqual({ kind: 'view', scale: null, linkHash: 'zoom=FitH', setsZoom: true });
    expect(classifyViewerHash('search=deep%20learning')).toEqual({ kind: 'view', scale: null, linkHash: 'search=deep%20learning', setsZoom: false });
    expect(classifyViewerHash('zoom=120&pagemode=thumbs')).toEqual({ kind: 'view', scale: '1.2', linkHash: 'pagemode=thumbs', setsZoom: true });
  });
});
