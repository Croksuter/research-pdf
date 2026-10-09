// Captures the raw screens for the Chrome Web Store listing from the built
// extension (dist/), in headless Chromium, with real open-access papers.
//
//   npm run build
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
//   CHROMIUM=/path/to/chrome \
//   [STORE_LANG=ko|en] [FIXTURES=record [OPENALEX_API_KEY=…]] \
//   node artifact/chrome-web-store/tools/capture.cjs
//
// STORE_LANG picks the extension's language and the sample project names
// (default ko); the screens go to raw/<lang>/.
//
// The paper databases (OpenAlex, Crossref, arXiv's API, Semantic Scholar) are
// not asked: their answers come from fixtures/papers.json, so every run shows
// the same venues, citations and references whatever the daily budgets. A
// request with no fixture fails the run. FIXTURES=record asks the databases
// for the requests the file has no answer to and rewrites it with the answers
// this run used (a rate limit or server error fails the run rather than
// being recorded);
// OPENALEX_API_KEY (your own, never stored) spares the keyless OpenAlex
// budget while recording. Delete the file to record from scratch.
//
// Writes artifact/chrome-web-store/tools/raw/<lang>/*.png (git-ignored); compose.cjs
// turns them into the listing images. Every paper shown is CC BY 4.0 (see
// ../README.md). Needs the network for the PDFs (arXiv, PLOS).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const ROOT = path.resolve(__dirname, '../../..');
const LANG = process.env.STORE_LANG === 'en' ? 'en' : 'ko';
const RAW = path.join(__dirname, 'raw', LANG);
const FIXTURE_FILE = path.join(__dirname, 'fixtures', 'papers.json');
const RECORD = process.env.FIXTURES === 'record';
const DATABASES = /^https:\/\/(api\.openalex\.org|api\.crossref\.org|export\.arxiv\.org|api\.semanticscholar\.org)\//u;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAPERS = {
  cot: 'https://arxiv.org/pdf/2201.11903',
  tot: 'https://arxiv.org/pdf/2305.10601',
  react: 'https://arxiv.org/pdf/2210.03629',
  dpo: 'https://arxiv.org/pdf/2305.18290',
  mistral: 'https://arxiv.org/pdf/2310.06825',
  plos: 'https://journals.plos.org/ploscompbiol/article/file?id=10.1371/journal.pcbi.1005510&type=printable',
};

// What a user would have named things, in the language of the shots.
const NAMES = {
  ko: { folder: '박사 연구', reasoning: 'LLM 추론', preference: '선호 정렬', reading: '읽을거리', note: '핵심 아이디어!', locale: 'ko-KR' },
  en: { folder: 'PhD research', reasoning: 'LLM reasoning', preference: 'Preference alignment', reading: 'Reading list', note: 'Key idea!', locale: 'en-US' },
}[LANG];
const FOLDER = { id: 'fphdresearch', name: NAMES.folder };
const PROJECTS = [
  { id: 'pllmreasonin', name: NAMES.reasoning, icon: 'i:brain', color: 'violet', folder: FOLDER.id, order: '1', docs: ['cot', 'tot', 'react'] },
  { id: 'ppreference1', name: NAMES.preference, icon: 'i:target', color: 'green', folder: FOLDER.id, order: '2', docs: ['dpo'] },
  { id: 'preadinglist', name: NAMES.reading, icon: 'e:📚', color: null, folder: null, order: '3', docs: ['plos'] },
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
    locale: NAMES.locale,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--headless=new', `--lang=${NAMES.locale}`],
  });
  // Paper-database answers: replayed, or recorded (see the top).
  const fixtures = fs.existsSync(FIXTURE_FILE) ? JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8')) : {};
  if (!RECORD && Object.keys(fixtures).length === 0) throw new Error(`no fixtures at ${FIXTURE_FILE}: run once with FIXTURES=record`);
  const problems = [];
  const used = new Set();
  /** The request as a fixture key: no key or contact parameters, parameters in order. */
  const fixtureKey = (request) => {
    const url = new URL(request.url());
    url.searchParams.delete('api_key');
    url.searchParams.delete('mailto');
    url.searchParams.sort();
    return `${request.method()} ${url}`;
  };
  await ctx.route(DATABASES, async (route) => {
    const key = fixtureKey(route.request());
    used.add(key);
    const hit = fixtures[key];
    if (hit) return route.fulfill({ status: hit.status, contentType: hit.contentType, body: hit.body, headers: { 'access-control-allow-origin': '*' } });
    if (!RECORD) { problems.push(`no fixture: ${key}`); return route.abort('failed'); }
    const url = new URL(route.request().url());
    if (process.env.OPENALEX_API_KEY && url.hostname === 'api.openalex.org') url.searchParams.set('api_key', process.env.OPENALEX_API_KEY);
    for (let attempt = 0; ; attempt += 1) {
      const response = await route.fetch({ url: url.toString() });
      // Semantic Scholar without a key often says 429 for a while.
      if (response.status() === 429 && attempt < 6) { await sleep(5000 * (attempt + 1)); continue; }
      const body = await response.text();
      if (response.status() === 429 || response.status() >= 500) problems.push(`not recorded (${response.status()}): ${key}`);
      else fixtures[key] = { status: response.status(), contentType: response.headers()['content-type'] ?? 'application/json', body };
      return route.fulfill({ response, body });
    }
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
  const VIEWER_FRAME = '#rpdf-frames iframe[src*="pdf-viewer.html"]:not([hidden])';
  const shot = async (page, name) => {
    // A database that did not answer already failed the run (no fixture); a ⚠
    // left in the strip is the paper's own data (e.g. OpenAlex knowing only part
    // of its citations), shown as the extension shows it.
    const strip = page.frameLocator(VIEWER_FRAME).first().locator('#vocab-t-pdf-paper:not([hidden])');
    const warnings = await strip.locator('.vt-warn, .vt-warn-inline').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent)).catch(() => []);
    await page.screenshot({ path: path.join(RAW, `${name}.png`) });
    console.log('captured', name, warnings.length ? `— ⚠ ${warnings.join(' / ')}` : '');
  };
  const viewer = (page) => page.frameLocator(VIEWER_FRAME).first();
  /** Shows every tab once so each document loads and its paper is looked up. */
  const visitTabs = async (page, wait = 20_000) => {
    const count = await page.locator('.rpdf-tab-main').count();
    for (let i = 0; i < count; i += 1) {
      await page.locator('.rpdf-tab-main').nth(i).click();
      await sleep(wait);
    }
  };

  // The language, chosen before any page of the extension shows text.
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.evaluate(async (lang) => {
    localStorage.setItem('rpdfLanguage', lang);
    await chrome.storage.local.set({ rpdfLanguage: lang });
  }, LANG);
  await popup.close();

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

  // 1. A paper with its citation history open (hover on the sparkline): the
  // PLOS one, whose citations OpenAlex knows nearly all of — the LLM preprints'
  // it knows a tenth of, so their strip leaves the 2-year figure and chart out.
  const reading = hubs.preadinglist;
  await reading.bringToFront();
  await reading.locator('.rpdf-tab-main').nth(0).click();
  await sleep(4000);
  const plos = viewer(reading);
  if (!(await plos.locator('.vt-spark').count())) problems.push('1-paper: no citation chart');
  await plos.locator('.vt-spark').first().hover();
  await sleep(800);
  await shot(reading, '1-paper');
  await main.bringToFront();
  await main.locator('.rpdf-tab-main').nth(0).click();
  await sleep(4000);
  const cot = viewer(main);

  // 2. The reference list (hover on References).
  if (await cot.locator('.vt-paper-refs').count()) {
    await cot.locator('.vt-paper-refs').first().hover();
    await sleep(2500);
  }
  await shot(main, '2-references');
  await main.mouse.move(640, 700);

  // 3. Drawings on the Tree of Thoughts paper: a highlight, a red pen mark, a typed note.
  await main.locator('.rpdf-tab-main').nth(1).click();
  await sleep(4000);
  const v = viewer(main);
  await v.locator('#viewerContainer').evaluate((el) => { el.scrollTop = 420; });
  await sleep(800);
  await v.locator('#vt-annotate-toggle').click();
  await sleep(500);
  const frameBox = await main.locator(VIEWER_FRAME).first().boundingBox();
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
    await main.keyboard.type(NAMES.note);
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

  // 5. Figure capture mode (S), on the ReAct paper's Figure 1 (page 2).
  await main.locator('.rpdf-tab-main').nth(2).click();
  await sleep(4000);
  const r = viewer(main);
  await r.locator('#vt-page').fill('2');
  await r.locator('#vt-page').press('Enter');
  await sleep(2500);
  await r.locator('#viewerContainer').click({ position: { x: 30, y: 300 } });
  await main.keyboard.press('s');
  // The layout model loads on first use, then outlines the pages shown.
  for (let waited = 0; waited < 30_000 && !(await r.locator('.vt-figure-box').count()); waited += 500) await sleep(500);
  await sleep(1000);
  const boxes = await r.locator('.vt-figure-box').count();
  if (!boxes) problems.push('5-figures: no figure outlined');
  console.log('figure boxes:', boxes);
  const box = r.locator('.vt-figure-box').first();
  if (await box.count()) { await box.hover(); await sleep(500); }
  await shot(main, '5-figures');
  await main.keyboard.press('Escape');

  // Extra: moving a document between projects.
  await main.locator('.rpdf-tab-main').nth(0).click();
  await sleep(2500);
  await main.click('#rpdf-move-btn');
  await sleep(800);
  await shot(main, 'x-move');
  await main.keyboard.press('Escape');

  await ctx.close();
  fs.rmSync(ext, { recursive: true, force: true });
  if (RECORD) {
    // Only what this run asked for: answers no screen needs any more drop out.
    const sorted = Object.fromEntries([...used].filter((k) => fixtures[k]).sort().map((k) => [k, fixtures[k]]));
    fs.mkdirSync(path.dirname(FIXTURE_FILE), { recursive: true });
    fs.writeFileSync(FIXTURE_FILE, `${JSON.stringify(sorted, null, 1)}\n`);
    console.log(`recorded ${Object.keys(sorted).length} answers in ${path.relative(ROOT, FIXTURE_FILE)}`);
  }
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):\n${problems.join('\n')}`);
    process.exit(1);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
