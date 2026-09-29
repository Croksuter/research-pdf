import { describe, expect, it } from 'vitest';

import { fontFits, genericFallback, withEmbeddedFonts } from '../src/ui/pdfViewer/textLayerFonts';

describe('text layer fonts', () => {
  it('names the PDF font first, once, keeping the generic family behind it', () => {
    const chunk = { items: [], styles: { g_d0_f1: { fontFamily: 'sans-serif' }, g_d0_f2: { fontFamily: 'serif' }, 'bad name': { fontFamily: 'serif' } } };
    withEmbeddedFonts(chunk);
    expect(chunk.styles.g_d0_f1.fontFamily).toBe('"g_d0_f1", sans-serif');
    expect(chunk.styles.g_d0_f2.fontFamily).toBe('"g_d0_f2", serif');
    expect(chunk.styles['bad name'].fontFamily).toBe('serif');
    withEmbeddedFonts(chunk);
    expect(chunk.styles.g_d0_f1.fontFamily).toBe('"g_d0_f1", sans-serif');
    expect(withEmbeddedFonts(null)).toBeNull();
  });

  it('reads the generic family back, quoted or as Chrome serializes it', () => {
    expect(genericFallback('"g_d0_f1", sans-serif')).toBe('sans-serif');
    expect(genericFallback('g_d0_f12, monospace')).toBe('monospace');
    expect(genericFallback('sans-serif')).toBeNull();
    expect(genericFallback('Calibri, sans-serif')).toBeNull();
  });

  it('keeps a font whose runs need little and uniform stretching, drops one that scatters', () => {
    // Justified lines: all a little wide, alike.
    expect(fontFits([1.01, 1.03, 0.99, 1.04, 1.02, 1.0])).toBe(true);
    // Wrong glyphs: widths all over the place.
    expect(fontFits([0.7, 1.3, 0.95, 1.6, 0.8, 1.1])).toBe(false);
    // Consistently far off (e.g. a width table the font face does not have).
    expect(fontFits([1.4, 1.41, 1.39, 1.42])).toBe(false);
    // Too few runs to judge by spread: each must be close.
    expect(fontFits([1.03])).toBe(true);
    expect(fontFits([1.2, 1.0])).toBe(false);
    expect(fontFits([])).toBe(true);
  });
});
