import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dist = resolve(__dirname, '../dist');

// Artifact test: `npm run test:bundle` builds first. Ordinary runs skip it.
describe.skipIf(!existsSync(resolve(dist, 'pdfViewer.js')))('production package', () => {
  it('contains only the viewer, its popup, the sync background, and PDF.js assets', () => {
    const files = readdirSync(dist).filter((name) => !name.endsWith('.map')).sort();
    expect(files).toEqual([
      'background.js', 'icons', 'manifest.json', 'pdf-viewer.html', 'pdfViewer.css', 'pdfViewer.js',
      'pdfjs', 'popup.css', 'popup.html', 'popup.js', 'tokens.css',
    ]);
    for (const dir of ['pdfjs/cmaps', 'pdfjs/standard_fonts', 'pdfjs/wasm', 'pdfjs/iccs', 'pdfjs/images']) {
      expect(existsSync(resolve(dist, dir)), `expected ${dir}/`).toBe(true);
    }
  });

  it('ships an inline-script-free viewer page that loads only its own bundle', () => {
    const page = readFileSync(resolve(dist, 'pdf-viewer.html'), 'utf8');
    expect(page).toContain('<title>PDF · ResearchPDF</title>');
    expect(page).toContain('src="pdfViewer.js"');
    expect(page).not.toContain('content.js');
    expect(page).not.toMatch(/<script>[^<]/u);
    const viewer = readFileSync(resolve(dist, 'pdfViewer.js'), 'utf8');
    expect(viewer).toContain('pdfjs/pdf.worker.mjs');
  });

  it('carries the OAuth client ID and no secret', () => {
    const background = readFileSync(resolve(dist, 'background.js'), 'utf8');
    expect(background).toContain('.apps.googleusercontent.com');
    expect(background).not.toMatch(/GOCSPX-/u);
    expect(background).not.toContain('client_secret');
  });
});
