// Captures the raw screens for the Chrome Web Store listing from the built
// extension (dist/), in headless Chromium, with real open-access papers.
//
//   npm run build
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
//   CHROMIUM=/path/to/chrome \
//   [OPENALEX_API_KEY=…] \
//   node artifact/chrome-web-store/tools/capture.cjs
//
// OPENALEX_API_KEY (optional, your own) is saved in the throwaway profile's
// settings, so the shots do not depend on the keyless daily budget.
//
// Writes artifact/chrome-web-store/tools/raw/*.png (git-ignored); compose.cjs
// turns them into the listing images. Every paper shown is CC BY 4.0 (see
// ../README.md). Needs the network: arXiv, PLOS and the paper databases.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const ROOT = path.resolve(__dirname, '../../..');
const RAW = path.join(__dirname, 'raw');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAPERS = {
  cot: 'https://arxiv.org/pdf/2201.11903',
  tot: 'https://arxiv.org/pdf/2305.10601',
  react: 'https://arxiv.org/pdf/2210.03629',
  dpo: 'https://arxiv.org/pdf/2305.18290',
  mistral: 'https://arxiv.org/pdf/2310.06825',
  plos: 'https://journals.plos.org/ploscompbiol/article/file?id=10.1371/journal.pcbi.1005510&type=printable',
};

const FOLDER = { id: 'fphdresearch', name: '박사 연구' };
const PROJECTS = [
  { id: 'pllmreasonin', name: 'LLM 추론', icon: 'i:brain', color: 'violet', folder: FOLDER.id, order: '1', docs: ['cot', 'tot', 'react'] },
  { id: 'ppreference1', name: '선호 정렬', icon: 'i:target', color: 'green', folder: FOLDER.id, order: '2', docs: ['dpo'] },
  { id: 'preadinglist', name: '읽을거리', icon: 'e:📚', color: null, folder: null, order: '3', docs: ['plos'] },
];
const DEFAULT_DOCS = ['mistral'];

/** dist/ copied with the web-PDF host permissions granted up front (the user grants them in the popup). */
function extensionCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpdf-store-'));
  fs.cpSync(path.join(ROOT, 'dist'), dir, { recursive: true });
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), 'https://*/*', 'http://*/*'])];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

(async () => {
  fs.rmSync(RAW, { recursive: true, force: true });
  fs.mkdirSync(RAW, { recursive: true });
  const ext = extensionCopy();
  const ctx = await chromium.launchPersistentContext('', {
    executablePath: process.env.CHROMIUM || undefined,
    headless: true,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    locale: 'ko-KR',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--headless=new', '--lang=ko-KR'],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;
  const hubUrl = (project, docs) => {
    const params = new URLSearchParams();
    if (project) params.set('p', project);
    params.set('a', '0');
    for (const doc of docs) params.append('f', PAPERS[doc]);
    return `chrome-extension://${id}/pdf-hub.html?${params}`;
  };
  const shot = async (page, name) => {
    await page.screenshot({ path: path.join(RAW, `${name}.png`) });
    // A ⚠ in the paper strip means a database did not answer (rate limit, spent budget).
    const warnings = await page.frameLocator('#rpdf-frames iframe:not([hidden])').first().locator('#vocab-t-pdf-paper:not([hidden]) .vt-warn').count().catch(() => 0);
    console.log('captured', name, warnings ? `— ${warnings} ⚠ in the paper strip: retake once the databases answer` : '');
  };
  const viewer = (page) => page.frameLocator('#rpdf-frames iframe:not([hidden])').first();
  /** Shows every tab once so each document loads and its paper is looked up. */
  const visitTabs = async (page, wait = 20_000) => {
    const count = await page.locator('.rpdf-tab').count();
    for (let i = 0; i < count; i += 1) {
      await page.locator('.rpdf-tab').nth(i).click();
      await sleep(wait);
    }
  };

  if (process.env.OPENALEX_API_KEY) {
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.fill('#openalex-api-key-input', process.env.OPENALEX_API_KEY);
    await popup.click('#openalex-api-key-save');
    await sleep(500);
    await popup.close();
  }

  // Projects, their folder and looks — as the user would have set them up.
  const setup = await ctx.newPage();
  await setup.goto(`chrome-extension://${id}/pdf-hub.html`);
  await sleep(1500);
  const send = (update) => setup.evaluate((u) => chrome.runtime.sendMessage({ type: 'VOCAB_T_PDF_PROJECT_UPDATE', update: u }), update);
  await send({ kind: 'folder-create', id: FOLDER.id, name: FOLDER.name, order: '2' });
  for (const p of PROJECTS) {
    await send({ kind: 'create', id: p.id, name: p.name });
    await send({ kind: 'style', id: p.id, icon: p.icon, color: p.color });
  }
  await send({ kind: 'arrange', projects: PROJECTS.map((p) => ({ id: p.id, folder: p.folder, order: p.order })), folders: [{ id: FOLDER.id, order: '2' }] });
  await setup.close();

  // Each project's documents, opened in its own hub.
  const hubs = {};
  for (const p of [{ id: null, docs: DEFAULT_DOCS }, ...PROJECTS.slice().reverse()]) {
    const page = await ctx.newPage();
    await page.goto(hubUrl(p.id, p.docs));
    await sleep(3000);
    await visitTabs(page);
    hubs[p.id ?? 'default'] = page;
  }

  const main = hubs.pllmreasonin;
  await main.bringToFront();
  const library = await sw.evaluate(() => chrome.storage.local.get('rpdfLibrary').then((r) => Object.values(r.rpdfLibrary ?? {}).map((e) => [e.title ?? e.fileName, e.paperKind])));
  console.log('library:', JSON.stringify(library));

  // 1. The paper in front, its citation history open (hover on the sparkline).
  await main.locator('.rpdf-tab').nth(0).click();
  await sleep(4000);
  const cot = viewer(main);
  if (await cot.locator('.vt-spark').count()) {
    await cot.locator('.vt-spark').first().hover();
    await sleep(800);
  }
  await shot(main, '1-paper');

  // 2. The reference list (hover on 참고문헌).
  if (await cot.locator('.vt-paper-refs').count()) {
    await cot.locator('.vt-paper-refs').first().hover();
    await sleep(2500);
  }
  await shot(main, '2-references');
  await main.mouse.move(640, 700);

  // 3. Drawings on the Tree of Thoughts paper: a highlight, a red pen mark, a typed note.
  await main.locator('.rpdf-tab').nth(1).click();
  await sleep(4000);
  const v = viewer(main);
  await v.locator('#viewerContainer').evaluate((el) => { el.scrollTop = 420; });
  await sleep(800);
  await v.locator('#vt-annotate-toggle').click();
  await sleep(500);
  const frameBox = await main.locator('#rpdf-frames iframe:not([hidden])').first().boundingBox();
  /** A line of page 1's text, in page coordinates (its word spans have no box of their own). */
  const lineBox = async (text) => {
    const r = await v.locator('.page[data-page-number="1"] .textLayer').evaluate((layer, wanted) => {
      const line = [...layer.querySelectorAll('span')].find((span) => span.textContent.includes(wanted));
      if (!line) return null;
      const range = document.createRange();
      range.selectNodeContents(line);
      const box = range.getBoundingClientRect();
      return { x: box.left, y: box.top, width: box.width, height: box.height };
    }, text);
    return r && frameBox ? { ...r, x: r.x + frameBox.x, y: r.y + frameBox.y } : null;
  };
  const hl = await lineBox('which generalizes over the');
  if (hl) {
    await main.mouse.move(hl.x + 2, hl.y + hl.height / 2);
    await main.mouse.down();
    await main.mouse.move(hl.x + hl.width - 2, hl.y + hl.height / 2, { steps: 15 });
    await main.mouse.up();
    await sleep(600);
  }
  // Switching tools also lets go of the new highlight.
  await v.locator('.vt-tool[data-editor-mode="15"]').click();
  await sleep(300);
  const swatches = v.locator('#vt-annotate-colors button');
  if (await swatches.count() > 1) await swatches.nth(1).click();
  await sleep(200);
  const pen = await lineBox('exploration over coherent units of text');
  if (pen) {
    // A wavy underline under "coherent units of text".
    const y = pen.y + pen.height - 1;
    const from = pen.x + pen.width * 0.24;
    const to = pen.x + pen.width * 0.62;
    await main.mouse.move(from, y);
    await main.mouse.down();
    for (let x = from; x <= to; x += 4) await main.mouse.move(x, y + Math.sin((x - from) / 5) * 2.2);
    await main.mouse.up();
    await sleep(400);
  }
  if (hl) {
    // A typed note in the right margin, next to the highlight.
    await v.locator('.vt-tool[data-editor-mode="3"]').click();
    await sleep(300);
    await main.mouse.click(hl.x + hl.width + 18, hl.y - 4);
    await sleep(400);
    await main.keyboard.type('핵심 아이디어!');
    await sleep(300);
    // Clicking outside the note commits it.
    await main.mouse.click(hl.x + hl.width + 60, hl.y + 220);
    await sleep(400);
  }
  await v.locator('.vt-tool[aria-pressed="true"]').click().catch(() => undefined);
  await main.mouse.move(1270, 790);
  await sleep(600);
  await shot(main, '3-annotate');
  await v.locator('#vt-annotate-toggle').click();
  await sleep(300);

  // 4. Home with the project list open: folders, icons, paper kinds.
  await main.click('#rpdf-home-btn');
  await sleep(1000);
  await main.click('#rpdf-project-btn');
  await sleep(800);
  await shot(main, '4-projects');
  await main.keyboard.press('Escape');

  // 5. Figure capture, auto-detect mode (S twice), on a page of the ReAct paper with figures.
  await main.locator('.rpdf-tab').nth(2).click();
  await sleep(4000);
  const r = viewer(main);
  await r.locator('#vt-page').fill('3');
  await r.locator('#vt-page').press('Enter');
  await sleep(2500);
  await r.locator('#viewerContainer').click({ position: { x: 30, y: 300 } });
  await main.keyboard.press('s');
  await sleep(300);
  await main.keyboard.press('s');
  await sleep(15_000);
  console.log('figure boxes:', await r.locator('.vt-figure-box').count());
  const box = r.locator('.vt-figure-box').first();
  if (await box.count()) { await box.hover(); await sleep(500); }
  await shot(main, '5-figures');
  await main.keyboard.press('Escape');

  // Extra: moving a document between projects.
  await main.locator('.rpdf-tab').nth(0).click();
  await sleep(2500);
  await main.click('#rpdf-move-btn');
  await sleep(800);
  await shot(main, 'x-move');
  await main.keyboard.press('Escape');

  await ctx.close();
  fs.rmSync(ext, { recursive: true, force: true });
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
