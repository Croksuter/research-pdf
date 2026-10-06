// ─── Upkeep runner: older library rows brought up to date, quietly ───
//
// Loaded by a settled hub in a hidden frame (shared/pdfUpkeep.ts says which
// rows and why). One row at a time, cheapest source first:
//   1. the paper-lookup cache, by the identifiers the row's URLs carry;
//   2. the PDF itself, from the local file cache or a local file — never
//      downloaded again from the web — read like the viewer reads it;
//   3. the databases, as the paper strip asks them, paced, and only when
//      paper info is on. A rate limit or a network failure ends the run; the
//      rows left are tried the next time a hub settles.
// A row is marked done when it got its answer, including "not a paper". One
// hub runs it at a time (a Web Lock); the frame tells the hub when it is done.

import * as pdfjsLib from 'pdfjs-dist';
import { readCachedPdf } from '../db/pdfFileCache';
import { debugLog, initDebugLogging } from '../shared/debugLog';
import { classifyPaperKind, identifiersFromUrl, mergeIdentifiers, type PaperMeta } from '../shared/paperIdentifiers';
import { PDF_LIBRARY_STORAGE_KEY, parsePdfLibrary, type PdfLibraryEntry, type PdfLibraryUpdate } from '../shared/pdfLibrary';
import { PDF_UPKEEP_DONE_MESSAGE, PDF_UPKEEP_STORAGE_KEY, markPdfUpkeepDone, parsePdfUpkeepState, rowsNeedingUpkeep } from '../shared/pdfUpkeep';
import { cachedPaperMeta, loadPaperSettings, lookupPaperQuietly, paperCacheKey, paperEvidence, type PaperEvidence } from './pdfViewer/paperStrip';

initDebugLogging();
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdfjs/pdf.worker.mjs');

const MAX_ROWS_PER_RUN = 60;
// Between rows that went to the network: the databases are shared with the
// documents the user is opening.
const NETWORK_PAUSE_MS = 3_000;
const MAX_PDF_BYTES = 80 * 1024 * 1024;

type Outcome = 'done' | 'later' | 'stop';

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

function send(update: PdfLibraryUpdate): Promise<unknown> {
  return chrome.runtime.sendMessage({ type: 'VOCAB_T_PDF_LIBRARY_UPDATE', update }).catch(() => undefined);
}

function record(entry: PdfLibraryEntry, meta: PaperMeta): Promise<unknown> {
  // Fills what the row lacks; what it has came from the same lookup when the
  // document was open.
  return send({
    kind: 'meta',
    docId: entry.docId,
    docTitle: null,
    title: entry.title ? null : meta.title,
    venue: entry.venue ? null : meta.venue,
    year: entry.year ? null : meta.year,
    paperKind: classifyPaperKind(meta),
  });
}

/** The PDF's bytes, if this device has them without the web. */
async function localBytes(entry: PdfLibraryEntry): Promise<Uint8Array | null> {
  for (const url of entry.urls) {
    try {
      if (url.startsWith('file:')) {
        const response = await fetch(url);
        if (!response.ok) continue;
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > 0 && bytes.byteLength <= MAX_PDF_BYTES) return bytes;
      } else {
        const cached = await readCachedPdf(url);
        if (cached) return cached.bytes;
      }
    } catch {
      /* not available here */
    }
  }
  return null;
}

async function readPdf(bytes: Uint8Array, sourceUrl: string | null): Promise<PaperEvidence | null> {
  const task = pdfjsLib.getDocument({
    data: bytes,
    cMapUrl: chrome.runtime.getURL('pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: chrome.runtime.getURL('pdfjs/standard_fonts/'),
    wasmUrl: chrome.runtime.getURL('pdfjs/wasm/'),
    iccUrl: chrome.runtime.getURL('pdfjs/iccs/'),
  });
  try {
    const doc = await task.promise;
    return await paperEvidence(doc, sourceUrl);
  } catch {
    return null; // a password, a damaged file
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

async function upkeepRow(entry: PdfLibraryEntry, network: boolean): Promise<{ outcome: Outcome; usedNetwork: boolean }> {
  const urlIds = mergeIdentifiers(...entry.urls.map((url) => identifiersFromUrl(url)));
  for (const key of [paperCacheKey(urlIds, []), entry.title ? paperCacheKey({}, [entry.title]) : null]) {
    const meta = key ? await cachedPaperMeta(key) : null;
    if (meta) { await record(entry, meta); return { outcome: 'done', usedNetwork: false }; }
  }
  const bytes = await localBytes(entry);
  let found = bytes ? await readPdf(bytes, entry.urls[0] ?? null) : null;
  if (found?.docTitle && !entry.docTitle) {
    await send({ kind: 'meta', docId: entry.docId, docTitle: found.docTitle, title: null, venue: null, year: null });
  }
  if (!found) {
    const titles = entry.title ? [entry.title] : [];
    found = { ids: urlIds, titles, evidence: { titles, pageText: '' }, key: paperCacheKey(urlIds, titles), docTitle: null };
  }
  // Nothing to look a paper up by: a plain PDF, as far as anyone can tell.
  if (!found.ids.doi && !found.ids.arxivId && found.titles.length === 0) return { outcome: 'done', usedNetwork: false };
  const cached = found.key ? await cachedPaperMeta(found.key, found.evidence.pageText) : null;
  if (cached) { await record(entry, cached); return { outcome: 'done', usedNetwork: false }; }
  if (!network) return { outcome: 'later', usedNetwork: false };
  const { meta, limited } = await lookupPaperQuietly(found);
  if (meta) { await record(entry, meta); return { outcome: 'done', usedNetwork: true }; }
  return { outcome: limited ? 'stop' : 'done', usedNetwork: true };
}

async function run(): Promise<void> {
  const stored = await chrome.storage.local.get([PDF_LIBRARY_STORAGE_KEY, PDF_UPKEEP_STORAGE_KEY]);
  const library = parsePdfLibrary(stored[PDF_LIBRARY_STORAGE_KEY]);
  let state = parsePdfUpkeepState(stored[PDF_UPKEEP_STORAGE_KEY]);
  const rows = rowsNeedingUpkeep(library, state).slice(0, MAX_ROWS_PER_RUN);
  if (rows.length === 0) return;
  const network = await loadPaperSettings().catch(() => false);
  debugLog('upkeep', `bringing ${rows.length} library row(s) up to date`, () => ({ network }));
  let done = 0;
  for (const entry of rows) {
    let result: { outcome: Outcome; usedNetwork: boolean };
    try {
      result = await upkeepRow(entry, network);
    } catch (error) {
      debugLog('upkeep', 'row failed', () => ({ docId: entry.docId, error: error instanceof Error ? error.message : String(error) }));
      result = { outcome: 'later', usedNetwork: false };
    }
    if (result.outcome === 'done') {
      done += 1;
      const latest = parsePdfLibrary((await chrome.storage.local.get(PDF_LIBRARY_STORAGE_KEY))[PDF_LIBRARY_STORAGE_KEY]);
      state = markPdfUpkeepDone(state, [entry.docId], latest);
      await chrome.storage.local.set({ [PDF_UPKEEP_STORAGE_KEY]: state });
    }
    if (result.outcome === 'stop') { debugLog('upkeep', 'stopped: rate limited or offline'); break; }
    await sleep(result.usedNetwork ? NETWORK_PAUSE_MS : 50);
  }
  debugLog('upkeep', `brought ${done} row(s) up to date`);
}

void (async () => {
  try {
    // One runner across hubs; another one already running means nothing to do here.
    await navigator.locks.request('rpdf-upkeep', { ifAvailable: true }, async (lock) => {
      if (lock) await run();
    });
  } catch (error) {
    debugLog('upkeep', 'upkeep failed', () => ({ error: error instanceof Error ? error.message : String(error) }));
  } finally {
    window.parent.postMessage(PDF_UPKEEP_DONE_MESSAGE, location.origin);
  }
})();
