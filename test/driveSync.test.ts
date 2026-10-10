import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PDF_SYNC_SOON_ALARM_NAME,
  PDF_SYNC_STATE_SETTING_KEY,
  exportPdfSyncSnapshot,
  autoSyncPdfIfConnected,
  connectPdfSyncGoogle,
  disconnectPdfSyncGoogle,
  getPdfSyncStatus,
  pullPdfSyncForOpen,
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
  changedPdfDocIds,
  mergeAnnotationCaches,
  mergePdfSyncSnapshots,
  parsePdfSyncSnapshot,
  pdfSyncSnapshotDataEquals,
} from '../src/shared/pdfSync';
import { parseConnectGoogleSyncRequest, parsePdfDocStateSaveRequest, parsePdfSyncHintRequest, parseSetPdfSyncEnabledRequest } from '../src/shared/messages';
import { type SyncedSetting, settingStampKey } from '../src/shared/syncedSettings';
import { getSetting, setSetting } from '../src/db/settingsRepository';
import { PDF_LIBRARY_STORAGE_KEY, type PdfLibraryEntry, noUserFields } from '../src/shared/pdfLibrary';
import type { PdfProject, PdfProjectFolder } from '../src/shared/pdfProjects';
import researchManifest from '../manifest.json';
import { FakeGoogle, createFakeGoogle } from './fakeGoogleDrive';
import { clearAllStores } from './helpers';
import { savePdfDocRecord } from '../src/background/pdfDocStateStore';
import { setLanguage } from '../src/shared/i18n';
import { syncStatusErrorText } from '../src/shared/syncErrors';
import { PDF_DOC_RECORD_MAX_AGE_MS } from '../src/shared/pdfIdentity';

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

function snapshot(docs: PdfDocRecord[] = [], annotations: PdfAnnotationCache[] = [], library: PdfLibraryEntry[] = [], projects: PdfProject[] = [], folders: PdfProjectFolder[] = [], settings: SyncedSetting[] = []): PdfSyncSnapshot {
  return { version: 6, exportedAt: '2026-09-01T00:00:00.000Z', docs, annotations, library, projects, folders, settings };
}

function project(id: string, overrides: Partial<PdfProject> = {}): PdfProject {
  return { id, name: id, createdAt: ago(500), renamedAt: ago(500), deletedAt: 0, members: [], layout: { urls: [], active: 0, show: null, savedAt: 0 },
    icon: null, color: null, styledAt: 0, folder: null, order: null, placedAt: 0, ...overrides };
}

function entry(docId: string, overrides: Partial<PdfLibraryEntry> = {}): PdfLibraryEntry {
  return {
    docId, urls: [`https://example.org/${docId.slice(0, 4)}.pdf`], fileName: null, docTitle: null, title: null, venue: null, year: null,
    numPages: 10, openedAt: ago(60), pinned: false, pinChangedAt: 0, paperKind: null, userKind: null, userKindAt: 0, ...noUserFields(), ...overrides,
  };
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

  it('joins the library: latest open names it, latest pin change wins, URLs union', () => {
    const local = snapshot([], [], [entry(DOC_A, { openedAt: ago(10), title: 'Local title', urls: ['https://a.org/x.pdf'], pinned: true, pinChangedAt: ago(100) })]);
    const remote = snapshot([], [], [
      entry(DOC_A, { openedAt: ago(20), title: 'Remote title', venue: 'NeurIPS', urls: ['https://b.org/x.pdf'], pinned: false, pinChangedAt: ago(50) }),
      entry(DOC_B),
    ]);
    const merged = mergePdfSyncSnapshots(local, remote, null);
    expect(merged.library.map((e) => e.docId)).toEqual([DOC_A, DOC_B]);
    const a = merged.library[0];
    expect(a.title).toBe('Local title');
    expect(a.venue).toBe('NeurIPS');
    expect(a.urls).toEqual(['https://a.org/x.pdf', 'https://b.org/x.pdf']);
    expect(a.pinned).toBe(false); // unpinned later on the other device
    expect(mergePdfSyncSnapshots(remote, local, null).library).toEqual(merged.library);
  });

  it('joins projects: the latest rename and saved tabs, final deletions, the latest change per document', () => {
    const local = snapshot([], [], [entry(DOC_A)], [
      project('pa', { name: 'Local name', renamedAt: ago(10), members: [{ docId: DOC_A, member: true, pinned: true, changedAt: ago(30) , pinOrder: null}] }),
      project('pb'),
    ]);
    const remote = snapshot([], [], [entry(DOC_B)], [
      project('pa', { name: 'Remote name', renamedAt: ago(20), members: [{ docId: DOC_A, member: false, pinned: false, changedAt: ago(5) , pinOrder: null}, { docId: DOC_B, member: true, pinned: false, changedAt: ago(5) , pinOrder: null}],
        layout: { urls: ['https://a.org/x.pdf'], active: 0, show: null, savedAt: ago(1) } }),
      project('pb', { deletedAt: ago(2) }),
    ]);
    const merged = mergePdfSyncSnapshots(local, remote, null);
    const pa = merged.projects.find((p) => p.id === 'pa')!;
    expect(pa.name).toBe('Local name');
    expect(pa.members.map((m) => [m.docId, m.member, m.pinned])).toEqual([[DOC_A, false, false], [DOC_B, true, false]]);
    expect(pa.layout.urls).toEqual(['https://a.org/x.pdf']);
    expect(merged.projects.find((p) => p.id === 'pb')).toMatchObject({ deletedAt: ago(2), members: [] });
    expect(mergePdfSyncSnapshots(remote, local, null).projects).toEqual(merged.projects);
    expect(pdfSyncSnapshotDataEquals(merged, mergePdfSyncSnapshots(merged, merged, null))).toBe(true);
  });

  it('keeps every library row a project still refers to', () => {
    const old = entry(DOC_A, { openedAt: ago(400 * 24 * 60 * 60) });
    const kept = mergePdfSyncSnapshots(snapshot([], [], [old], [project('pa', { members: [{ docId: DOC_A, member: true, pinned: false, changedAt: ago(1) , pinOrder: null}] })]), snapshot(), null);
    expect(kept.library.map((e) => e.docId)).toEqual([DOC_A]);
    expect(mergePdfSyncSnapshots(snapshot([], [], [old]), snapshot(), null).library).toEqual([]);
  });

  it('reads an older build\'s document with what it lacks empty', () => {
    const parsed = parsePdfSyncSnapshot({ version: 1, exportedAt: '2026-01-01T00:00:00.000Z', docs: [], annotations: [] });
    expect(parsed).toEqual({ version: 6, exportedAt: '2026-01-01T00:00:00.000Z', docs: [], annotations: [], library: [], projects: [], folders: [], settings: [] });
    expect(parsePdfSyncSnapshot({ version: 2, exportedAt: '2026-01-01T00:00:00.000Z', docs: [], annotations: [], library: [] })?.projects).toEqual([]);
    // Version 3: projects without looks or places, library rows without kinds.
    const v3 = parsePdfSyncSnapshot({
      version: 3, exportedAt: '2026-01-01T00:00:00.000Z', docs: [], annotations: [],
      library: [{ docId: DOC_A, urls: [], fileName: null, docTitle: null, title: null, venue: null, year: null, numPages: 3, openedAt: 1, pinned: false, pinChangedAt: 0 }],
      projects: [{ id: 'pa', name: 'A', createdAt: 1, renamedAt: 1, deletedAt: 0, members: [], layout: { urls: [], active: 0, show: null, savedAt: 0 } }],
    });
    expect(v3?.folders).toEqual([]);
    expect(v3?.projects[0]).toMatchObject({ icon: null, color: null, styledAt: 0, folder: null, order: null, placedAt: 0 });
    expect(v3?.library[0]).toMatchObject({ paperKind: null, userKind: null, userKindAt: 0, userTitle: null, note: null, links: [], driveFileId: null });
    // Version 5: no settings yet.
    expect(parsePdfSyncSnapshot({ version: 5, exportedAt: '2026-01-01T00:00:00.000Z', docs: [], annotations: [], library: [], projects: [], folders: [] })?.settings).toEqual([]);
  });

  it('refuses a document another build could not read back', () => {
    expect(parsePdfSyncSnapshot({ version: 7, exportedAt: '2026-01-01T00:00:00.000Z', docs: [], annotations: [], library: [], projects: [], folders: [], settings: [] })).toBeNull();
    expect(parsePdfSyncSnapshot({ version: 6, exportedAt: '2026-01-01T00:00:00.000Z', docs: [], annotations: [], library: [], projects: [], folders: [] })).toBeNull();
    expect(parsePdfSyncSnapshot({ version: 6, exportedAt: '2026-01-01T00:00:00.000Z', docs: [], annotations: [], library: [], projects: [], folders: [], settings: [{ key: 'x' }] })).toBeNull();
    expect(parsePdfSyncSnapshot({ version: 4, exportedAt: '2026-01-01T00:00:00.000Z', docs: [], annotations: [], library: [], projects: [] })).toBeNull();
    expect(parsePdfSyncSnapshot({ version: 4, exportedAt: '2026-01-01T00:00:00.000Z', docs: [], annotations: [], library: [], projects: [], folders: [{ id: 'f1' }] })).toBeNull();
    expect(parsePdfSyncSnapshot({ version: 3, exportedAt: '2026-01-01T00:00:00.000Z', docs: [], annotations: [], library: [] })).toBeNull();
    expect(parsePdfSyncSnapshot({ version: 3, exportedAt: '2026-01-01T00:00:00.000Z', docs: [], annotations: [], library: [], projects: [{ id: 'x' }] })).toBeNull();
    expect(parsePdfSyncSnapshot({ version: 2, exportedAt: '2026-01-01T00:00:00.000Z', docs: [], annotations: [] })).toBeNull();
    expect(parsePdfSyncSnapshot({ version: 2, exportedAt: '2026-01-01T00:00:00.000Z', docs: [], annotations: [], library: [{ docId: 'x' }] })).toBeNull();
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
    expect(parseConnectGoogleSyncRequest({ type: 'VOCAB_T_CONNECT_GOOGLE_SYNC' })).toEqual({ type: 'VOCAB_T_CONNECT_GOOGLE_SYNC', confirmAccountChange: false });
    expect(parseConnectGoogleSyncRequest({ type: 'VOCAB_T_CONNECT_GOOGLE_SYNC', confirmAccountChange: true })).toEqual({ type: 'VOCAB_T_CONNECT_GOOGLE_SYNC', confirmAccountChange: true });
    expect(parseConnectGoogleSyncRequest({ type: 'VOCAB_T_CONNECT_GOOGLE_SYNC', confirmAccountChange: 'yes' })).toBeNull();
    expect(parseConnectGoogleSyncRequest({ type: 'VOCAB_T_CONNECT_GOOGLE_SYNC', confirmAccountChange: true, extra: 1 })).toBeNull();
    const record = doc(DOC_A, 3, 5);
    expect(parsePdfDocStateSaveRequest({ type: 'VOCAB_T_PDF_DOC_STATE_SAVE', record })).toEqual({ type: 'VOCAB_T_PDF_DOC_STATE_SAVE', record });
    expect(parsePdfDocStateSaveRequest({ type: 'VOCAB_T_PDF_DOC_STATE_SAVE', record: { ...record, numPages: 0 } })).toBeNull();
    expect(parsePdfDocStateSaveRequest({ type: 'VOCAB_T_PDF_DOC_STATE_SAVE', record, extra: 1 })).toBeNull();
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
    expect(researchManifest.web_accessible_resources.flatMap((entry) => entry.resources)).toEqual(['pdf-hub.html', 'pdf-viewer.html']);
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

  it('carries the preferences changed on purpose, the latest change winning per key', async () => {
    await connect();
    expect((await google.headBody<PdfSyncSnapshot>()).settings).toEqual([]); // nothing changed yet: no defaults sent
    await setSetting('paperStripShown', false);
    await setSetting('semanticScholarApiKey', 'secret'); // never synced
    await expect(syncPdfNow()).resolves.toMatchObject({ success: true });
    const pushed = await google.headBody<PdfSyncSnapshot>();
    expect(pushed.settings.map((s) => [s.key, s.value])).toEqual([['paperStripShown', false]]);
    expect(JSON.stringify(pushed)).not.toContain('secret');

    // Another device, later: a newer strip choice, a language, a key this build does not know; an older display choice loses.
    const later = Date.now() + 60_000;
    await google.chrome.storage.local.set({ rpdfDisplay: { tabTitle: 'file' }, [settingStampKey('rpdfDisplay')]: later + 5 });
    google.remoteWrite({ ...pushed, settings: [
      { key: 'futureThing', value: 1, updatedAt: later },
      { key: 'paperStripShown', value: true, updatedAt: later },
      { key: 'rpdfDisplay', value: { tabTitle: 'paper' }, updatedAt: later },
      { key: 'rpdfLanguage', value: 'en', updatedAt: later },
    ] });
    await expect(syncPdfNow()).resolves.toMatchObject({ success: true });
    expect(await getSetting('paperStripShown', null)).toBe(true);
    const stored = await google.chrome.storage.local.get(['rpdfLanguage', 'rpdfDisplay', settingStampKey('paperStripShown')]);
    expect(stored).toMatchObject({ rpdfLanguage: 'en', rpdfDisplay: { tabTitle: 'file' }, [settingStampKey('paperStripShown')]: later });
    expect((await google.headBody<PdfSyncSnapshot>()).settings.map((s) => s.key)).toEqual(['futureThing', 'paperStripShown', 'rpdfDisplay', 'rpdfLanguage']);
  });

  it('uploads drawings and reading positions to its own file, and skips transfer when unchanged', async () => {
    await dbPut(STORE_PDF_ANNOTATIONS, cache(DOC_A, [item('k1')], 5));
    await setDocs([doc(DOC_A, 4, ago(50))]);
    await connect();

    expect(google.files.size).toBe(1);
    const body = await google.headBody<PdfSyncSnapshot>();
    expect(body.version).toBe(6);
    expect(body.docs.map((entry) => entry.page)).toEqual([4]);
    expect(keysOf(body.annotations[0])).toEqual(['k1']);
    expect(JSON.stringify(body)).not.toContain('perm-main');

    const before = google.dataRequests().length;
    await expect(syncPdfNow()).resolves.toMatchObject({ success: true, merged: false });
    expect(google.dataRequests().length).toBe(before);
  });

  it('carries the library both ways: local opens up, another device\'s pin down', async () => {
    await google.chrome.storage.local.set({ [PDF_LIBRARY_STORAGE_KEY]: { [DOC_A]: entry(DOC_A, { title: 'Mine' }) } });
    await connect();
    expect((await google.headBody<PdfSyncSnapshot>()).library.map((e) => e.title)).toEqual(['Mine']);

    google.remoteWrite(snapshot([], [], [entry(DOC_A, { title: 'Mine', pinned: true, pinChangedAt: ago(5) }), entry(DOC_B, { title: 'Theirs' })]));
    await expect(syncPdfNow()).resolves.toMatchObject({ success: true, merged: true });
    const local = (await google.chrome.storage.local.get(PDF_LIBRARY_STORAGE_KEY))[PDF_LIBRARY_STORAGE_KEY] as Record<string, PdfLibraryEntry>;
    expect(local[DOC_A].pinned).toBe(true);
    expect(local[DOC_B].title).toBe('Theirs');
    // A library change alone is not a document change: no viewer reloads.
    google.remoteWrite(snapshot([], [], [entry(DOC_A, { title: 'Mine', pinned: false, pinChangedAt: ago(1) }), entry(DOC_B, { title: 'Theirs' })]));
    await expect(syncPdfNow()).resolves.toMatchObject({ success: true, changedDocIds: [] });
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

  it('reports which documents a pull changed, and an open right after a sync skips Drive', async () => {
    await dbPut(STORE_PDF_ANNOTATIONS, cache(DOC_A, [item('mine')], 5));
    await setDocs([doc(DOC_A, 2, ago(50)), doc(DOC_B, 1, ago(50))]);
    await connect();

    // Just synced: opening a document costs no Drive request at all.
    const before = google.requests.length;
    await expect(pullPdfSyncForOpen()).resolves.toEqual({ changedDocIds: [] });
    expect(google.requests.length).toBe(before);

    // A minute later, with another device's work waiting, the open pulls it
    // and names the one document it touched.
    const state = await dbGet<{ key: string; value: Record<string, unknown> }>(STORE_SETTINGS, PDF_SYNC_STATE_SETTING_KEY);
    await dbPut(STORE_SETTINGS, { ...state!, value: { ...state!.value, lastSyncAt: new Date(Date.now() - 120_000).toISOString() } });
    google.remoteWrite(snapshot([doc(DOC_A, 9, ago(10)), doc(DOC_B, 1, ago(50))], [cache(DOC_A, [item('mine')], 5)]));
    await expect(pullPdfSyncForOpen()).resolves.toEqual({ changedDocIds: [DOC_A] });
    expect((await localDocs())[DOC_A].page).toBe(9);
  });

  it('names the documents that differ between two snapshots', () => {
    const before = snapshot([doc(DOC_A, 1, 1), doc(DOC_B, 1, 1)], [cache(DOC_A, [item('k')], 1)]);
    expect(changedPdfDocIds(before, before)).toEqual([]);
    expect(changedPdfDocIds(before, snapshot([doc(DOC_A, 1, 1), doc(DOC_B, 2, 2)], [cache(DOC_A, [item('k')], 1)]))).toEqual([DOC_B]);
    expect(changedPdfDocIds(before, snapshot([doc(DOC_A, 1, 1), doc(DOC_B, 1, 1)], []))).toEqual([DOC_A]);
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
      errorCode: 'auth-expired',
    });
    await expect(getPdfSyncStatus()).resolves.toMatchObject({ errorCode: 'auth-expired', error: expect.stringContaining('만료') });
  });

  it('stores what went wrong as a code, so a page shows it in its own language; an older stored sentence still shows', async () => {
    await connect();
    google.clearSessionCache();
    google.state.session = null;
    await syncPdfNow();
    const stored = await dbGet<{ value: Record<string, unknown> }>(STORE_SETTINGS, PDF_SYNC_STATE_SETTING_KEY);
    expect(stored?.value).toMatchObject({ errorCode: 'auth-expired', error: null });
    const status = await getPdfSyncStatus();
    try {
      setLanguage('en');
      expect(syncStatusErrorText(status)).toBe('Google sign-in expired. Reconnect your Google account in settings.');
    } finally {
      setLanguage('ko');
    }
    expect(syncStatusErrorText({ errorCode: 'drive-http', errorDetail: '503' })).toBe('Google Drive 요청이 실패했습니다 (HTTP 503).');
    // An older build stored the sentence itself.
    await dbPut(STORE_SETTINGS, { key: PDF_SYNC_STATE_SETTING_KEY, value: { ...stored!.value, errorCode: undefined, errorDetail: undefined, error: 'Old sentence.' } });
    const legacy = await getPdfSyncStatus();
    expect(legacy).toMatchObject({ errorCode: null, error: 'Old sentence.' });
    expect(syncStatusErrorText(legacy)).toBe('Old sentence.');
    expect(syncStatusErrorText({ errorCode: null, error: null })).toBeNull();
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

  // ─── Two devices on one account ───

  interface Device { local: Map<string, unknown>; session: Map<string, unknown>; settings: unknown[]; annotations: unknown[] }

  async function saveDevice(): Promise<Device> {
    return {
      local: new Map(google.localStore), session: new Map(google.sessionStore),
      settings: await dbGetAll(STORE_SETTINGS), annotations: await dbGetAll(STORE_PDF_ANNOTATIONS),
    };
  }

  async function loadDevice(device: Device): Promise<void> {
    google.localStore.clear();
    device.local.forEach((value, key) => google.localStore.set(key, value));
    google.sessionStore.clear();
    device.session.forEach((value, key) => google.sessionStore.set(key, value));
    await clearAllStores();
    for (const row of device.settings) await dbPut(STORE_SETTINGS, row);
    for (const row of device.annotations) await dbPut(STORE_PDF_ANNOTATIONS, row);
  }

  const uploads = () => google.requests.filter((request) => request.url.includes('/upload/') && request.method === 'PUT').length;

  it('converges two devices and then stops writing: a merge that only brings the remote side in pushes nothing', async () => {
    // Device A.
    await dbPut(STORE_PDF_ANNOTATIONS, cache(DOC_A, [item('a')], 5));
    await setDocs([doc(DOC_A, 3, ago(50))]);
    await connect();
    const deviceA = await saveDevice();

    // Device B, same account, its own papers.
    await loadDevice({ local: new Map(), session: new Map(), settings: [], annotations: [] });
    await setDocs([doc(DOC_B, 7, ago(40))]);
    await connect();
    expect((await google.headBody<PdfSyncSnapshot>()).docs.map((d) => d.docId)).toEqual([DOC_A, DOC_B]);
    const deviceB = await saveDevice();

    // From here on both have everything: nobody writes, and nobody downloads again.
    const before = uploads();
    await loadDevice(deviceA);
    await expect(syncPdfNow()).resolves.toMatchObject({ success: true, changedDocIds: [DOC_B] });
    expect((await localDocs())[DOC_B].page).toBe(7);
    const deviceA2 = await saveDevice();
    await loadDevice(deviceB);
    const downloads = google.dataRequests().length;
    await expect(syncPdfNow()).resolves.toMatchObject({ success: true, merged: false });
    await loadDevice(deviceA2);
    await expect(syncPdfNow()).resolves.toMatchObject({ success: true, merged: false });
    await expect(syncPdfNow()).resolves.toMatchObject({ success: true, merged: false });
    expect(uploads()).toBe(before);
    expect(google.dataRequests().length).toBe(downloads);
    const state = await dbGet<{ value: { pendingLocalChanges: boolean; errorCode: unknown } }>(STORE_SETTINGS, PDF_SYNC_STATE_SETTING_KEY);
    expect(state?.value).toMatchObject({ pendingLocalChanges: false, errorCode: null });
  });

  it('keeps a reading position the viewer saves while the sync applies its merge', async () => {
    await setDocs([doc(DOC_A, 2, ago(50))]);
    await dbPut(STORE_PDF_ANNOTATIONS, cache(DOC_A, [item('mine')], 5));
    await connect();
    google.remoteWrite(snapshot([doc(DOC_A, 9, ago(30)), doc(DOC_B, 1, ago(30))], [cache(DOC_A, [item('mine'), item('theirs')], 50)]));
    await dbPut(STORE_PDF_ANNOTATIONS, cache(DOC_A, [item('mine'), item('new')], 60));

    // The viewer saves right as the sync reads the position map to apply its merge.
    const saved = doc(DOC_A, 42, Date.now());
    let uploaded = false;
    let viewerSave: Promise<boolean> | null = null;
    const realGet = google.chrome.storage.local.get;
    google.chrome.storage.local.get = async (key: string | string[]) => {
      const result = await realGet(key);
      if (uploaded && key === PDF_DOC_STATE_STORAGE_KEY && !viewerSave) viewerSave = savePdfDocRecord(saved);
      return result;
    };
    const realFetch = google.fetch.getMockImplementation()!;
    google.fetch.mockImplementation(async (input, init) => {
      const response = await realFetch(input, init);
      if (String(input).includes('upload_id=')) uploaded = true;
      return response;
    });
    try {
      await expect(syncPdfNow()).resolves.toMatchObject({ success: true });
      expect(viewerSave).not.toBeNull();
      await viewerSave;
    } finally {
      google.chrome.storage.local.get = realGet;
      google.fetch.mockImplementation(realFetch);
    }
    expect((await localDocs())[DOC_A].page).toBe(42);
    expect((await localDocs())[DOC_B].page).toBe(1);
    // And the next sync carries it.
    await expect(syncPdfNow()).resolves.toMatchObject({ success: true });
    expect((await google.headBody<PdfSyncSnapshot>()).docs.find((d) => d.docId === DOC_A)?.page).toBe(42);
  });

  it('prunes reading positions past the age limit here too, so they are not a local change forever', async () => {
    await setDocs([doc(DOC_A, 2, Date.now() - PDF_DOC_RECORD_MAX_AGE_MS - 60_000), doc(DOC_B, 5, ago(10))]);
    await connect();
    expect(Object.keys(await localDocs())).toEqual([DOC_B]);
    const state = await dbGet<{ value: { pendingLocalChanges: boolean } }>(STORE_SETTINGS, PDF_SYNC_STATE_SETTING_KEY);
    expect(state?.value.pendingLocalChanges).toBe(false);
    const before = google.dataRequests().length;
    await expect(syncPdfNow()).resolves.toMatchObject({ success: true, merged: false });
    expect(google.dataRequests().length).toBe(before);
  });

  it('never drops a document with drawings from the sync document, however many there are', () => {
    const caches = Array.from({ length: 260 }, (_, i) => cache(`${String(i).padStart(32, '0')}`, [item(`k${i}`)], i));
    const merged = mergePdfSyncSnapshots(snapshot([], caches.slice(0, 150)), snapshot([], caches.slice(100)), null);
    expect(merged.annotations).toHaveLength(260);
    expect(parsePdfSyncSnapshot(merged)?.annotations).toHaveLength(260);
  });

  it('runs once more after a sync that was asked for while one was running; an open\'s pull joins the running one', async () => {
    await connect();
    const first = syncPdfNow();
    const joined = syncPdfNow({ join: true });
    const second = syncPdfNow();
    const third = syncPdfNow();
    expect(joined).toBe(first);
    expect(second).not.toBe(first);
    expect(third).toBe(second);
    // Stored while the first run is going: the follow-up pushes it.
    await setDocs([doc(DOC_A, 11, ago(1))]);
    await expect(first).resolves.toMatchObject({ success: true });
    await expect(second).resolves.toMatchObject({ success: true });
    expect((await google.headBody<PdfSyncSnapshot>()).docs.map((d) => d.page)).toEqual([11]);
    await expect(getPdfSyncStatus()).resolves.toMatchObject({ syncing: false });
  });

  it('asks before adding this device\'s data to a different Google account, and connects once confirmed', async () => {
    await setDocs([doc(DOC_A, 4, ago(20))]);
    await connect();
    await disconnectPdfSyncGoogle();

    google.state.session = { id: 'perm-other', email: 'other@example.test' };
    await expect(connectPdfSyncGoogle()).resolves.toEqual({
      success: false, needsConfirm: 'account-change', previousEmail: 'main@example.test', email: 'other@example.test',
    });
    await expect(getPdfSyncStatus()).resolves.toMatchObject({ googleConnected: false });
    const flows = google.state.authFlows.length;
    await expect(connectPdfSyncGoogle({ confirmAccountChange: true })).resolves.toMatchObject({ success: true, status: { googleConnected: true, googleAccountEmail: 'other@example.test' } });
    // The confirmation used the sign-in already made.
    expect(google.state.authFlows.length).toBe(flows);
    await expect(syncPdfNow()).resolves.toMatchObject({ success: true });

    // Back to the first account, now from the second: asked again.
    google.state.session = { id: 'perm-main', email: 'main@example.test' };
    await expect(connectPdfSyncGoogle()).resolves.toMatchObject({ needsConfirm: 'account-change', previousEmail: 'other@example.test' });
    await expect(getPdfSyncStatus()).resolves.toMatchObject({ googleConnected: true, googleAccountEmail: 'other@example.test' });
  });

  it('connects another account without asking when this device has nothing to carry over', async () => {
    await connect();
    await disconnectPdfSyncGoogle();
    expect((await exportPdfSyncSnapshot()).docs).toEqual([]);
    google.state.session = { id: 'perm-other', email: 'other@example.test' };
    await expect(connectPdfSyncGoogle()).resolves.toMatchObject({ success: true, status: { googleAccountEmail: 'other@example.test' } });
    // A stale confirmation without a waiting sign-in signs in again and asks as usual.
    await setDocs([doc(DOC_A, 4, ago(20))]);
    await syncPdfNow();
    google.state.session = { id: 'perm-main', email: 'main@example.test' };
    await expect(connectPdfSyncGoogle({ confirmAccountChange: true })).resolves.toMatchObject({ needsConfirm: 'account-change' });
  });
});
