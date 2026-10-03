// ResearchPDF paper-strip audit harness.
//
//   node audit.cjs <pdf-url> [more urls…]          → JSON per paper on stdout
//   node audit.cjs --list urls.txt --out out.jsonl  → one JSON line per paper
//
// Loads the built extension (EXT env or ./ext) in headless Chromium with host
// access to every site, opens each PDF in the hub exactly as routing would,
// waits for the paper strip and its reference list to settle, and dumps what
// the strip shows plus what the lookup resolved (from the debug log).
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/home/hoyeong-choi/development/Grasp/node_modules/playwright-core');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const listIdx = args.indexOf('--list');
const outIdx = args.indexOf('--out');
const keepCache = args.includes('--keep-cache');
let urls = args.filter((a, i) => !a.startsWith('--') && (listIdx < 0 || i !== listIdx + 1) && (outIdx < 0 || i !== outIdx + 1));
if (listIdx >= 0) urls = urls.concat(fs.readFileSync(args[listIdx + 1], 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
const out = outIdx >= 0 ? args[outIdx + 1] : null;
const ext = process.env.EXT || prepareExtension();

/** A copy of ../../dist that may reach every site, like a user who granted web-PDF access. */
function prepareExtension() {
  const dist = path.join(__dirname, '..', '..', 'dist');
  const copy = path.join(__dirname, '.ext');
  if (!fs.existsSync(path.join(dist, 'manifest.json'))) throw new Error('build first: npm run build');
  fs.rmSync(copy, { recursive: true, force: true });
  fs.cpSync(dist, copy, { recursive: true });
  const manifestPath = path.join(copy, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), 'https://*/*', 'http://*/*'])];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  return copy;
}
const TIMEOUT_MS = Number(process.env.AUDIT_TIMEOUT_MS || 120_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function auditOne(ctx, sw, id, url) {
  const started = Date.now();
  const logs = [];
  const errors = [];
  const onConsole = async (m) => {
    const text = m.text();
    if (m.type() === 'error' && !/Failed to load resource|blocked by CORS/u.test(text)) errors.push(text.slice(0, 300));
    if (!text.includes('[ResearchPDF][paper]')) return;
    const vals = await Promise.all(m.args().map((a) => a.jsonValue().catch(() => null)));
    logs.push({ message: String(vals[0] ?? text).replace(/^\[ResearchPDF\]\[paper\]\[[^\]]*\] /u, ''), payload: vals[1] ?? null });
  };
  ctx.on('console', onConsole);
  const page = await ctx.newPage();
  const result = { url, ok: false };
  try {
    if (!keepCache) {
      await sw.evaluate(() => chrome.storage.local.get(null).then((all) => chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('vtPaper')))));
    }
    await page.goto(`chrome-extension://${id}/pdf-hub.html?file=${encodeURIComponent(url)}`);
    let frame = null;
    let state = null;
    while (Date.now() - started < TIMEOUT_MS) {
      await sleep(1000);
      for (const p of ctx.pages()) for (const f of p.frames()) if (f.url().includes('pdf-viewer.html')) frame = f;
      if (!frame) continue;
      state = await frame.evaluate(() => {
        const root = document.getElementById('vocab-t-pdf-paper');
        const body = document.getElementById('vt-paper-body');
        const msg = document.querySelector('#vt-message, .vt-message, [role="alert"]');
        const pages = document.querySelector('#vt-page-count, .vt-page-count');
        const plain = (node) => {
          const clone = node.cloneNode(true);
          clone.querySelectorAll('.vt-paper-pop, .vt-warn-pop').forEach((p) => p.remove());
          return clone.textContent.replace(/\s+/gu, ' ').trim();
        };
        const refsHeader = document.querySelector('.vt-refs-header')?.textContent ?? null;
        return {
          stripHidden: root ? root.hidden : null,
          stripText: body ? plain(body) : null,
          refsHeader,
          message: msg && !msg.hidden ? msg.textContent.trim().slice(0, 300) : null,
          pageCount: pages?.textContent?.trim() ?? null,
        };
      }).catch(() => null);
      if (!state) continue;
      const loading = !state.stripText || /조회 중/u.test(state.stripText);
      const refsBusy = state.refsHeader === null || /불러오는 중|준비 중|찾는 중/u.test(state.refsHeader);
      const notPaper = /논문으로 인식되지 않았습니다|⚠︎/u.test(state.stripText ?? '') && !/2년\/전체/u.test(state.stripText ?? '');
      if (!state.stripHidden && !loading && (!refsBusy || notPaper)) break;
      if (state.message && /열지 못했|오류|실패/u.test(state.message) && Date.now() - started > 15_000) break;
    }
    if (!frame) throw new Error('viewer frame never appeared');
    const details = await frame.evaluate(async () => {
      const q = (sel, root = document) => root.querySelector(sel);
      const info = q('.vt-paper-info .vt-paper-pop');
      const copies = {};
      const original = navigator.clipboard.writeText.bind(navigator.clipboard);
      let last = null;
      navigator.clipboard.writeText = async (t) => { last = t; };
      for (const b of document.querySelectorAll('.vt-paper-copy')) {
        const label = b.textContent.trim() || b.title;
        last = null;
        b.click();
        for (let i = 0; i < 40 && last === null; i++) await new Promise((r) => setTimeout(r, 250));
        copies[label] = last;
      }
      navigator.clipboard.writeText = original;
      return {
        copies,
        kindBadge: q('.vt-kind')?.textContent ?? null,
        warnings: [...document.querySelectorAll('#vt-paper-body .vt-warn-pop')].map((w) => w.textContent),
        statusTitle: q('.vt-paper-status')?.title || null,
        popover: info ? {
          title: q('.vt-paper-pop-title', info)?.textContent ?? null,
          authors: q('.vt-paper-pop-authors', info)?.textContent ?? null,
          facts: [...info.querySelectorAll('.vt-paper-pop-fact')].map((f) => f.textContent),
          links: [...info.querySelectorAll('.vt-paper-links a')].map((a) => ({ label: a.textContent, href: a.href })),
        } : null,
        refs: [...document.querySelectorAll('.vt-refs-list li')].map((li) => ({
          title: q('.vt-ref-title', li)?.textContent ?? '',
          meta: q('.vt-ref-meta', li)?.textContent ?? '',
          stats: q('.vt-ref-stats', li)?.textContent ?? '',
          href: q('a', li)?.href ?? '',
        })),
        toolbarTitle: q('#vt-paper-title')?.textContent || q('#vt-file-name, .vt-file-name')?.textContent || null,
        firstPageText: [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')].map((s) => s.textContent).join(' ').replace(/\s+/gu, ' ').slice(0, 1500),
      };
    });
    const pick = (re) => [...logs].reverse().find((l) => re.test(l.message))?.payload ?? null;
    Object.assign(result, {
      ok: true,
      seconds: Math.round((Date.now() - started) / 1000),
      timedOut: Date.now() - started >= TIMEOUT_MS,
      ...state,
      ...details,
      refCount: details.refs.length,
      refs: details.refs.slice(0, 12),
      detection: pick(/^detection/u),
      meta: pick(/^enriched|^resolved \(cache\)/u) ?? pick(/^resolved \(primary\)/u),
      log: logs.map((l) => l.message).slice(-25),
      consoleErrors: errors.slice(0, 10),
    });
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    ctx.off('console', onConsole);
    for (const p of ctx.pages()) await p.close().catch(() => {});
  }
  return result;
}

(async () => {
  if (urls.length === 0) { console.error('usage: node audit.cjs <pdf-url>… | --list urls.txt [--out out.jsonl]'); process.exit(2); }
  const ctx = await chromium.launchPersistentContext('', {
    executablePath: require('os').homedir() + '/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
    headless: true,
    viewport: { width: 1400, height: 900 },
    // Some hosts (OSF) refuse the HeadlessChrome user agent; real Chrome is what users run.
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--headless=new'],
  });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;
  await sw.evaluate(() => chrome.storage.local.set({ debugLoggingEnabled: true }));
  if (process.env.S2_FIXTURE) {
    const fixture = fs.readFileSync(process.env.S2_FIXTURE, 'utf8');
    await ctx.route(/api\.semanticscholar\.org/u, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: route.request().url().includes('/references') ? '{"data":[]}' : fixture,
    }));
  }
  if (process.env.NETLOG) ctx.on('response', (r) => { const u = r.url(); if (!/openalex|semanticscholar|crossref|arxiv\.org\/api|chrome-extension/u.test(u)) console.error('[net]', r.status(), r.request().method(), (r.request().headers().range ?? ''), u.slice(0, 120)); });
  if (process.env.OA_FIXTURES) {
    // [{ "match": "<substring of the decoded URL>", "body": {...} }]; the rest of OpenAlex answers as it does.
    const fixtures = JSON.parse(fs.readFileSync(process.env.OA_FIXTURES, 'utf8'));
    await ctx.route(/api\.openalex\.org/u, (route) => {
      const url = decodeURIComponent(route.request().url());
      const hit = fixtures.find((f) => url.includes(f.match));
      if (hit) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hit.body) });
      return route.continue();
    });
  }
  if (process.env.BLOCK_S2) await ctx.route(/api\.semanticscholar\.org/u, (route) => route.fulfill({ status: 429, body: '{}' }));
  if (process.env.S2_API_KEY) {
    // Same setting the popup writes (IndexedDB settings store) — set via a viewer page below if needed.
  }
  for (const url of urls) {
    const r = await auditOne(ctx, sw, id, url);
    const line = JSON.stringify(r);
    if (out) fs.appendFileSync(out, line + '\n');
    else console.log(JSON.stringify(r, null, 2));
    if (out) console.log(`${r.ok ? 'done' : 'ERR '} ${r.seconds ?? '-'}s ${url} :: ${r.stripText ?? r.error ?? ''}`.slice(0, 220));
  }
  await ctx.close();
})().catch((e) => { console.error(e); process.exit(1); });
