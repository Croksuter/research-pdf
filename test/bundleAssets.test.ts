import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dist = resolve(__dirname, '../dist');

// Artifact test: `npm run test:bundle` builds first. Ordinary runs skip it.
describe.skipIf(!existsSync(resolve(dist, 'pdfViewer.js')))('production package', () => {
  it('contains only the viewer, its popup and settings page, the sync background, the upkeep page, PDF.js assets and the layout model', () => {
    const files = readdirSync(dist).filter((name) => !name.endsWith('.map')).sort();
    expect(files).toEqual([
      'background.js', 'icons', 'manifest.json', 'models', 'ort', 'ort.js', 'pdf-hub.html', 'pdf-upkeep.html', 'pdf-viewer.html', 'pdfHub.css', 'pdfHub.js',
      'pdfUpkeep.js', 'pdfViewer.css', 'pdfViewer.js', 'pdfjs', 'popup.css', 'popup.html', 'popup.js', 'settings.css', 'settings.html',
      'settings.js', 'tokens.css',
    ]);
    // Figure auto-detect: the model with its license, and ONNX Runtime's wasm (loaded on first use).
    for (const file of ['models/pp-doclayout-s.onnx', 'models/LICENSE-Apache-2.0.txt', 'models/NOTICE.md', 'ort/ort-wasm-simd-threaded.wasm', 'ort/ort-wasm-simd-threaded.mjs']) {
      expect(existsSync(resolve(dist, file)), `expected ${file}`).toBe(true);
    }
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

  it('ships the PDF.js worker patched to report character positions', () => {
    const worker = readFileSync(resolve(dist, 'pdfjs/pdf.worker.mjs'), 'utf8');
    expect(worker).toContain('charStarts');
  });

  it('ships an inline-script-free hub page that loads only its own bundle', () => {
    const page = readFileSync(resolve(dist, 'pdf-hub.html'), 'utf8');
    expect(page).toContain('src="pdfHub.js"');
    expect(page).not.toMatch(/<script>[^<]/u);
  });

  it('carries the OAuth client ID and no secret', () => {
    const background = readFileSync(resolve(dist, 'background.js'), 'utf8');
    expect(background).toContain('.apps.googleusercontent.com');
    expect(background).not.toMatch(/GOCSPX-/u);
    expect(background).not.toContain('client_secret');
  });
});
