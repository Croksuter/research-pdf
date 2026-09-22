import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PDF_SYNC_SOON_ALARM_NAME,
  PDF_SYNC_STATE_SETTING_KEY,
  autoSyncPdfIfConnected,
  connectPdfSyncGoogle,
  disconnectPdfSyncGoogle,
  getPdfSyncStatus,
  requestPdfSyncSoon,
  setPdfSyncEnabled,
  syncPdfNow,
} from '../src/background/pdfSyncService';
import { dbGet, dbGetAll, dbPut } from '../src/db/database';
import { STORE_PDF_ANNOTATIONS, STORE_SETTINGS } from '../src/shared/constants';
import { PDF_ANNOTATION_CACHE_VERSION, type CachedAnnotationItem, type PdfAnnotationCache } from '../src/shared/pdfAnnotations';
import { PDF_DOC_STATE_STORAGE_KEY, type PdfDocRecord } from '../src/shared/pdfIdentity';
import {
  PdfSyncSnapshot,
  mergeAnnotationCaches,
  mergePdfSyncSnapshots,
  parsePdfSyncSnapshot,
} from '../src/shared/pdfSync';
import { parsePdfSyncHintRequest, parseSetPdfSyncEnabledRequest } from '../src/shared/messages';
import researchManifest from '../manifest.json';
import { FakeGoogle, createFakeGoogle } from './fakeGoogleDrive';
import { clearAllStores } from './helpers';

const DOC_A = 'a'.repeat(32);
const DOC_B = 'b'.repeat(32);
/** Reading positions are pruned by age; keep test timestamps recent. */
const NOW = Date.now();
const ago = (seconds: number) => NOW - seconds * 1_000;

function item(key: string, pageIndex = 0, createdAt = 1): CachedAnnotationItem {
  return { key, pageIndex, annotationType: 15, rect: [0, 0, 10, 10], data: { annotationType: 15, pageIndex, key }, createdAt };
}

function cache(docId: string, items: CachedAnnotationItem[], updatedAt: number, deleted: PdfAnnotationCache['deleted'] = []): PdfAnnotationCache {
  return { docId, version: PDF_ANNOTATION_CACHE_VERSION, baseFingerprintModified: null, items, deleted, updatedAt };
}

function doc(docId: string, page: number, updatedAt: number): PdfDocRecord {
  return {
    docId, fingerprint: null, fingerprintModified: null, numPages: 10, sha256: null,
    sourceUrl: null, fileName: `${docId.slice(0, 4)}.pdf`, page, zoom: 'auto', updatedAt,
  };
}

function snapshot(docs: PdfDocRecord[] = [], annotations: PdfAnnotationCache[] = []): PdfSyncSnapshot {
  return { version: 1, exportedAt: '2026-09-01T00:00:00.000Z', docs, annotations };
}

const keysOf = (cache: PdfAnnotationCache | undefined) => (cache?.items ?? []).map((entry) => entry.key).sort();

describe('pdf sync merge', () => {
  it('keeps both devices\' drawings on the same paper and drops a drawing erased on one side', () => {
    const base = cache(DOC_A, [item('shared'), item('erased-here')], 10);
    const local = cache(DOC_A, [item('shared'), item('mine')], 20);
    const remote = cache(DOC_A, [item('shared'), item('erased-here'), item('theirs')], 30);
    const merged = mergeAnnotationCaches(local, remote, base);
    expect(keysOf(merged)).toEqual(['mine', 'shared', 'theirs']);
    expect(merged.updatedAt).toBe(30);
  });

  it('unions additively without a base, so a first sync can only add', () => {
    const merged = mergeAnnotationCaches(cache(DOC_A, [item('mine')], 1), cache(DOC_A, [item('theirs')], 2), null);
    expect(keysOf(merged)).toEqual(['mine', 'theirs']);
  });

  it('propagates a whole-document erase over an unchanged peer, and keeps a re-drawn one', () => {
    const base = snapshot([], [cache(DOC_A, [item('x')], 1), cache(DOC_B, [item('y')], 1)]);
    const local = snapshot([], [cache(DOC_B, [item('y')], 1)]); // erased A, B untouched
    const remote = snapshot([], [cache(DOC_A, [item('x'), item('x2')], 5), cache(DOC_B, [item('y')], 1)]);
    const merged = mergePdfSyncSnapshots(local, remote, base);
    // A: local erased, remote drew more → remote (the modification) wins.
    expect(merged.annotations.map((entry) => entry.docId)).toEqual([DOC_A, DOC_B]);
    const unchangedPeer = mergePdfSyncSnapshots(local, snapshot([], base.annotations), base);
    expect(unchangedPeer.annotations.map((entry) => entry.docId)).toEqual([DOC_B]);
  });

  it('takes the newest reading position per document', () => {
    const merged = mergePdfSyncSnapshots(
      snapshot([doc(DOC_A, 3, ago(30))]),
      snapshot([doc(DOC_A, 7, ago(20)), doc(DOC_B, 1, ago(40))]),
      null,
    );
    expect(merged.docs.map((entry) => [entry.docId, entry.page])).toEqual([[DOC_A, 7], [DOC_B, 1]]);
  });

  it('refuses a document another build could not read back', () => {
    expect(parsePdfSyncSnapshot({ version: 2, exportedAt: '2026-01-01T00:00:00.000Z', docs: [], annotations: [] })).toBeNull();
    expect(parsePdfSyncSnapshot({ version: 1, exportedAt: 'nope', docs: [], annotations: [] })).toBeNull();
    expect(parsePdfSyncSnapshot({ version: 1, exportedAt: '2026-01-01T00:00:00.000Z', docs: [{ docId: 'x' }], annotations: [] })).toBeNull();
    expect(parsePdfSyncSnapshot(snapshot([doc(DOC_A, 1, ago(1))], [cache(DOC_A, [item('k')], 1)]))).not.toBeNull();
  });

  it('accepts only exact viewer hint and enable messages', () => {
    expect(parsePdfSyncHintRequest({ type: 'VOCAB_T_PDF_SYNC_HINT', reason: 'open' })).toEqual({ type: 'VOCAB_T_PDF_SYNC_HINT', reason: 'open' });
    expect(parsePdfSyncHintRequest({ type: 'VOCAB_T_PDF_SYNC_HINT', reason: 'now' })).toBeNull();
    expect(parsePdfSyncHintRequest({ type: 'VOCAB_T_PDF_SYNC_HINT', reason: 'edit', extra: 1 })).toBeNull();
    expect(parseSetPdfSyncEnabledRequest({ type: 'VOCAB_T_SET_PDF_SYNC_ENABLED', enabled: false })).toEqual({ type: 'VOCAB_T_SET_PDF_SYNC_ENABLED', enabled: false });
    expect(parseSetPdfSyncEnabledRequest({ type: 'VOCAB_T_SET_PDF_SYNC_ENABLED', enabled: 'yes' })).toBeNull();
  });
});

describe('package boundary', () => {
  it('ships no content script, no vocabulary data, and no Google host permission', () => {
    expect(researchManifest.name).toBe('ResearchPDF');
    expect('content_scripts' in researchManifest).toBe(false);
    expect(researchManifest.permissions).toContain('identity');
    expect(researchManifest.permissions).not.toContain('activeTab');
    expect(JSON.stringify(researchManifest)).not.toContain('vocab');
    expect(JSON.stringify(researchManifest)).not.toContain('googleapis');
    expect(researchManifest.web_accessible_resources.flatMap((entry) => entry.resources)).toEqual(['pdf-viewer.html']);
  });
});

describe('drive sync', () => {
  let google: FakeGoogle;

  beforeEach(async () => {
    await clearAllStores();
    google = createFakeGoogle();
    vi.stubGlobal('chrome', google.chrome);
    vi.stubGlobal('fetch', google.fetch);
  });

  afterEach(() => vi.unstubAllGlobals());

  async function setDocs(records: PdfDocRecord[]): Promise<void> {
    await google.chrome.storage.local.set({ [PDF_DOC_STATE_STORAGE_KEY]: Object.fromEntries(records.map((record) => [record.docId, record])) });
  }

  async function localDocs(): Promise<Record<string, PdfDocRecord>> {
    return ((await google.chrome.storage.local.get(PDF_DOC_STATE_STORAGE_KEY))[PDF_DOC_STATE_STORAGE_KEY] ?? {}) as Record<string, PdfDocRecord>;
  }

  async function localCaches(): Promise<Map<string, PdfAnnotationCache>> {
    return new Map((await dbGetAll<PdfAnnotationCache>(STORE_PDF_ANNOTATIONS)).map((entry) => [entry.docId, entry]));
  }

  async function connect(): Promise<void> {
    await expect(connectPdfSyncGoogle()).resolves.toMatchObject({ success: true });
    await expect(syncPdfNow()).resolves.toMatchObject({ success: true });
  }

  it('uploads drawings and reading positions to its own file, and skips transfer when unchanged', async () => {
    await dbPut(STORE_PDF_ANNOTATIONS, cache(DOC_A, [item('k1')], 5));
    await setDocs([doc(DOC_A, 4, ago(50))]);
    await connect();

    expect(google.files.size).toBe(1);
    const body = await google.headBody<PdfSyncSnapshot>();
    expect(body.version).toBe(1);
    expect(body.docs.map((entry) => entry.page)).toEqual([4]);
    expect(keysOf(body.annotations[0])).toEqual(['k1']);
    expect(JSON.stringify(body)).not.toContain('perm-main');

    const before = google.dataRequests().length;
    await expect(syncPdfNow()).resolves.toMatchObject({ success: true, merged: false });
    expect(google.dataRequests().length).toBe(before);
  });

  it('pulls another profile\'s drawings into the same paper and its reading position', async () => {
    await dbPut(STORE_PDF_ANNOTATIONS, cache(DOC_A, [item('mine')], 5));
    await setDocs([doc(DOC_A, 2, ago(50))]);
    await connect();

    google.remoteWrite(snapshot([doc(DOC_A, 9, ago(10))], [cache(DOC_A, [item('mine'), item('theirs')], 50)]));
    await expect(syncPdfNow()).resolves.toMatchObject({ success: true, merged: true });

    expect(keysOf((await localCaches()).get(DOC_A))).toEqual(['mine', 'theirs']);
    expect((await localDocs())[DOC_A].page).toBe(9);
    const state = await dbGet<{ value: { pendingLocalChanges: boolean; base: PdfSyncSnapshot } }>(STORE_SETTINGS, PDF_SYNC_STATE_SETTING_KEY);
    expect(state?.value.pendingLocalChanges).toBe(false);
    expect(keysOf(state?.value.base.annotations[0])).toEqual(['mine', 'theirs']);
  });

  it('leaves a document the viewer changed mid-sync alone and marks it pending', async () => {
    await dbPut(STORE_PDF_ANNOTATIONS, cache(DOC_A, [item('mine')], 5));
    await connect();
    google.remoteWrite(snapshot([], [cache(DOC_A, [item('mine'), item('theirs')], 50)]));

    let injected = false;
    const realFetch = google.fetch.getMockImplementation()!;
    google.fetch.mockImplementation(async (input, init) => {
      const response = await realFetch(input, init);
      // The viewer stores a new stroke after this sync exported local state.
      if (!injected && String(input).includes('/upload/')) {
        injected = true;
        await dbPut(STORE_PDF_ANNOTATIONS, cache(DOC_A, [item('mine'), item('late')], 60));
      }
      return response;
    });

    await expect(syncPdfNow()).resolves.toMatchObject({ success: true });
    expect(keysOf((await localCaches()).get(DOC_A))).toEqual(['late', 'mine']);
    const state = await dbGet<{ value: { pendingLocalChanges: boolean } }>(STORE_SETTINGS, PDF_SYNC_STATE_SETTING_KEY);
    expect(state?.value.pendingLocalChanges).toBe(true);

    google.fetch.mockImplementation(realFetch);
    await expect(syncPdfNow()).resolves.toMatchObject({ success: true });
    expect(keysOf((await localCaches()).get(DOC_A))).toEqual(['late', 'mine', 'theirs']);
    expect(keysOf((await google.headBody<PdfSyncSnapshot>()).annotations[0])).toEqual(['late', 'mine', 'theirs']);
  });

  it('folds a clobbered revision back in additively', async () => {
    await dbPut(STORE_PDF_ANNOTATIONS, cache(DOC_A, [item('shared')], 5));
    await connect();
    await dbPut(STORE_PDF_ANNOTATIONS, cache(DOC_A, [item('shared'), item('mine')], 10));

    let raced = false;
    google.state.beforeUploadCommit = () => {
      if (raced) return;
      raced = true;
      google.remoteWrite(snapshot([], [cache(DOC_A, [item('shared'), item('theirs')], 8)]));
    };
    await expect(syncPdfNow()).resolves.toMatchObject({ success: true });
    expect(keysOf((await google.headBody<PdfSyncSnapshot>()).annotations[0])).toEqual(['mine', 'shared', 'theirs']);
    expect(keysOf((await localCaches()).get(DOC_A))).toEqual(['mine', 'shared', 'theirs']);
  });

  it('refuses to sync when silent renewal answers for another account, and reports an expired session', async () => {
    await dbPut(STORE_PDF_ANNOTATIONS, cache(DOC_A, [item('private')], 5));
    await connect();
    await dbPut(STORE_PDF_ANNOTATIONS, cache(DOC_A, [item('private'), item('more')], 6));
    google.clearSessionCache();
    google.state.session = { id: 'perm-other', email: 'other@example.test' };
    const uploads = () => google.requests.filter((request) => request.url.includes('/upload/')).length;
    const before = uploads();
    await expect(syncPdfNow()).resolves.toMatchObject({ success: false, error: expect.stringContaining('다른 계정') });
    expect(uploads()).toBe(before);

    google.clearSessionCache();
    google.state.session = null;
    await expect(syncPdfNow()).resolves.toEqual({
      success: false,
      error: 'Google 로그인이 만료되었습니다. 설정에서 Google 계정을 다시 연결하세요.',
    });
    await expect(getPdfSyncStatus()).resolves.toMatchObject({ error: expect.stringContaining('만료') });
  });

  it('disable stops unattended sync; disconnect forgets the account and revokes the token', async () => {
    await connect();
    await expect(setPdfSyncEnabled(false)).resolves.toMatchObject({ enabled: false, googleConnected: true });
    const before = google.requests.length;
    await autoSyncPdfIfConnected();
    expect(google.requests.length).toBe(before);
    await expect(syncPdfNow()).resolves.toMatchObject({ success: false });

    await expect(disconnectPdfSyncGoogle()).resolves.toMatchObject({ success: true, status: { googleConnected: false } });
    expect(google.revoked.length).toBe(1);
    expect(google.files.size).toBe(1);
    const state = await dbGet<{ value: { base: unknown } }>(STORE_SETTINGS, PDF_SYNC_STATE_SETTING_KEY);
    expect(state?.value.base ?? null).toBeNull();
  });

  it('coalesces edit hints into one delayed alarm', () => {
    requestPdfSyncSoon();
    requestPdfSyncSoon();
    expect(google.chrome.alarms.created.get(PDF_SYNC_SOON_ALARM_NAME)).toEqual({ delayInMinutes: 0.5 });
  });
});
