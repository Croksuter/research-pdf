import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PDF_HUB_MAX_DOCS,
  buildPdfHubEntryUrl,
  buildPdfHubUrl,
  parsePdfHubUrl,
} from '../src/shared/localPdf';
import {
  parsePdfHubClaimRequest,
  parsePdfHubOpenMessage,
  parsePdfHubStateRequest,
} from '../src/shared/messages';
import {
  HUB_MESSAGE_TAG,
  hubDocumentTitle,
  hubKeyAction,
  parseHubToViewerMessage,
  parseViewerToHubMessage,
  sameTitle,
} from '../src/shared/pdfHubProtocol';

const HUB = 'chrome-extension://abc/pdf-hub.html';
const A = 'https://arxiv.org/pdf/2401.00001';
const B = 'https://a.org/get?id=1&v=2';
const LOCAL = 'file:///home/me/paper.pdf';

function hubParts(url: string) {
  const parsed = new URL(url);
  return parsePdfHubUrl(parsed.search, parsed.hash);
}

describe('hub URL', () => {
  it('round-trips a document list and the active index through the canonical form', () => {
    const url = buildPdfHubUrl([A, B, LOCAL], 1, HUB);
    expect(url.startsWith(`${HUB}?a=1&f=`)).toBe(true);
    expect(hubParts(url)).toEqual({ docs: [{ url: A, hash: '' }, { url: B, hash: '' }, { url: LOCAL, hash: '' }], active: 1, show: null, project: null });
  });

  it('remembers the home page or a pinned document in front', () => {
    expect(buildPdfHubUrl([], 0, HUB, 'home')).toBe(HUB);
    expect(hubParts(buildPdfHubUrl([A], 0, HUB, 'home'))).toEqual({ docs: [{ url: A, hash: '' }], active: 0, show: 'home', project: null });
    expect(hubParts(buildPdfHubUrl([], 0, HUB, `${B}#page=2`))).toEqual({ docs: [], active: 0, show: B, project: null });
    expect(hubParts(buildPdfHubUrl([A], 0, HUB, 'javascript:alert(1)')).show).toBeNull();
  });

  it('names the project the hub holds', () => {
    expect(buildPdfHubUrl([], 0, HUB, null, 'default')).toBe(`${HUB}?p=default`);
    expect(hubParts(buildPdfHubUrl([A, B], 1, HUB, 'home', 'p1x')))
      .toEqual({ docs: [{ url: A, hash: '' }, { url: B, hash: '' }], active: 1, show: 'home', project: 'p1x' });
    expect(hubParts(buildPdfHubUrl([A], 0, HUB, null, 'Bad Id!')).project).toBeNull();
    expect(parsePdfHubUrl('?p=%3Cx%3E', '').project).toBeNull();
  });

  it('reads the single-document entry form, raw (declarativeNetRequest) or encoded, with its fragment', () => {
    expect(hubParts(buildPdfHubEntryUrl(`${B}#page=3`, HUB))).toEqual({ docs: [{ url: B, hash: '#page=3' }], active: 0, show: null, project: null });
    // The redirect rule inserts the request URL verbatim.
    expect(parsePdfHubUrl(`?file=${B}`, '#page=2')).toEqual({ docs: [{ url: B, hash: '#page=2' }], active: 0, show: null, project: null });
  });

  it('drops invalid, duplicate, and excess sources and clamps the active index', () => {
    const search = `?a=9&f=${encodeURIComponent(A)}&f=javascript%3Aalert(1)&f=${encodeURIComponent(A)}&f=${encodeURIComponent(`${B}#x`)}`;
    expect(parsePdfHubUrl(search, '')).toEqual({ docs: [{ url: A, hash: '' }, { url: B, hash: '' }], active: 0, show: null, project: null });
    expect(parsePdfHubUrl('', '')).toEqual({ docs: [], active: 0, show: null, project: null });
    const many = Array.from({ length: PDF_HUB_MAX_DOCS + 5 }, (_, i) => `https://a.org/${i}.pdf`);
    expect(hubParts(buildPdfHubUrl(many, 0, HUB)).docs).toHaveLength(PDF_HUB_MAX_DOCS);
    expect(buildPdfHubUrl([], 0, HUB)).toBe(HUB);
  });
});

describe('hub messages', () => {
  it('parses claims, state reports, and hand-overs by shape', () => {
    expect(parsePdfHubClaimRequest({ type: 'VOCAB_T_PDF_HUB_CLAIM', docs: [{ url: A, hash: '#page=2' }], canGoBack: true }))
      .toEqual({ type: 'VOCAB_T_PDF_HUB_CLAIM', docs: [{ url: A, hash: '#page=2' }], canGoBack: true, project: null });
    expect(parsePdfHubClaimRequest({ type: 'VOCAB_T_PDF_HUB_CLAIM', docs: [], canGoBack: false, project: 'p1x' })?.project).toBe('p1x');
    expect(parsePdfHubClaimRequest({ type: 'VOCAB_T_PDF_HUB_CLAIM', docs: [], canGoBack: false, project: '../x' })).toBeNull();
    expect(parsePdfHubClaimRequest({ type: 'VOCAB_T_PDF_HUB_CLAIM', docs: [{ url: 'javascript:x' }], canGoBack: true })).toBeNull();
    expect(parsePdfHubClaimRequest({ type: 'VOCAB_T_PDF_HUB_CLAIM', docs: [], canGoBack: 'yes' })).toBeNull();
    expect(parsePdfHubClaimRequest({ type: 'VOCAB_T_PDF_HUB_CLAIM', docs: [{ url: A, hash: 'page=2 x' }], canGoBack: false })?.docs)
      .toEqual([{ url: A, hash: '' }]);
    expect(parsePdfHubStateRequest({ type: 'VOCAB_T_PDF_HUB_STATE', urls: [A, LOCAL], active: 1, project: 'default', show: null }))
      .toEqual({ type: 'VOCAB_T_PDF_HUB_STATE', urls: [A, LOCAL], active: 1, project: 'default', show: null });
    expect(parsePdfHubStateRequest({ type: 'VOCAB_T_PDF_HUB_STATE', urls: [A], active: 0, project: 'p1x', show: 'home' })?.show).toBe('home');
    expect(parsePdfHubStateRequest({ type: 'VOCAB_T_PDF_HUB_STATE', urls: [A], active: 0, project: 'p1x', show: 'javascript:x' })).toBeNull();
    expect(parsePdfHubStateRequest({ type: 'VOCAB_T_PDF_HUB_STATE', urls: [A], active: 0 })).toBeNull();
    expect(parsePdfHubStateRequest({ type: 'VOCAB_T_PDF_HUB_STATE', urls: ['chrome://x'], active: 0, project: 'default', show: null })).toBeNull();
    expect(parsePdfHubOpenMessage({ type: 'VOCAB_T_PDF_HUB_OPEN', tabId: 4, docs: [{ url: A, hash: '' }], activate: false }))
      .toEqual({ type: 'VOCAB_T_PDF_HUB_OPEN', tabId: 4, docs: [{ url: A, hash: '' }], activate: false });
    expect(parsePdfHubOpenMessage({ type: 'VOCAB_T_PDF_HUB_OPEN', tabId: '4', docs: [], activate: false })).toBeNull();
  });

  it('parses frame messages and never trusts untagged or malformed ones', () => {
    const file = new File([new Uint8Array([1])], 'x.pdf', { type: 'application/pdf' });
    expect(parseViewerToHubMessage({ tag: HUB_MESSAGE_TAG, kind: 'doc', title: '1706.03762', paperTitle: ' Attention Is All You Need ' }))
      .toEqual({ tag: HUB_MESSAGE_TAG, kind: 'doc', title: '1706.03762', paperTitle: 'Attention Is All You Need', docId: null });
    expect(parseViewerToHubMessage({ tag: HUB_MESSAGE_TAG, kind: 'doc', title: 'T', paperTitle: null, docId: 'fp:abc:3' }))
      .toMatchObject({ docId: 'fp:abc:3' });
    expect(parseViewerToHubMessage({ tag: HUB_MESSAGE_TAG, kind: 'doc', title: 'T', paperTitle: null, docId: 'x'.repeat(500) }))
      .toMatchObject({ docId: null });
    expect(parseViewerToHubMessage({ tag: HUB_MESSAGE_TAG, kind: 'sleep-reply', id: 3, ok: true, hash: '#page=7' }))
      .toEqual({ tag: HUB_MESSAGE_TAG, kind: 'sleep-reply', id: 3, ok: true, hash: '#page=7' });
    expect(parseViewerToHubMessage({ tag: HUB_MESSAGE_TAG, kind: 'sleep-reply', id: 3, ok: true, hash: 'javascript:x' }))
      .toMatchObject({ hash: '' });
    expect(parseViewerToHubMessage({ tag: HUB_MESSAGE_TAG, kind: 'sleep-reply', id: 'a', ok: true, hash: '' })).toBeNull();
    expect(parseHubToViewerMessage({ tag: HUB_MESSAGE_TAG, kind: 'sleep', id: 4 })).toEqual({ tag: HUB_MESSAGE_TAG, kind: 'sleep', id: 4 });
    expect(parseViewerToHubMessage({ tag: HUB_MESSAGE_TAG, kind: 'doc', title: 'T', paperTitle: null })?.kind).toBe('doc');
    expect(parseViewerToHubMessage({ tag: HUB_MESSAGE_TAG, kind: 'doc', title: 'T', paperTitle: 3 })).toBeNull();
    expect(parseViewerToHubMessage({ tag: HUB_MESSAGE_TAG, kind: 'key', action: 'next' })?.kind).toBe('key');
    expect(parseViewerToHubMessage({ tag: HUB_MESSAGE_TAG, kind: 'key', action: 'reload' })).toBeNull();
    expect(parseViewerToHubMessage({ tag: HUB_MESSAGE_TAG, kind: 'open-files', files: [file] })?.kind).toBe('open-files');
    expect(parseViewerToHubMessage({ tag: HUB_MESSAGE_TAG, kind: 'open-files', files: ['x.pdf'] })).toBeNull();
    expect(parseViewerToHubMessage({ kind: 'doc', title: 'T' })).toBeNull();
    expect(parseHubToViewerMessage({ tag: HUB_MESSAGE_TAG, kind: 'open-file', file })?.kind).toBe('open-file');
    expect(parseHubToViewerMessage({ tag: HUB_MESSAGE_TAG, kind: 'hash', hash: '#page=4' })).toEqual({ tag: HUB_MESSAGE_TAG, kind: 'hash', hash: '#page=4' });
    expect(parseHubToViewerMessage({ tag: HUB_MESSAGE_TAG, kind: 'hash', hash: 'page=4' })).toBeNull();
  });

  it('maps only the hub keys Chrome leaves free, and titles the tab by count and document', () => {
    const key = (code: string, mods: Partial<{ altKey: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }>) =>
      hubKeyAction({ altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, code, ...mods });
    expect(key('ArrowRight', { altKey: true, shiftKey: true })).toBe('next');
    expect(key('ArrowLeft', { altKey: true, shiftKey: true })).toBe('prev');
    expect(key('KeyW', { altKey: true })).toBe('close');
    expect(key('KeyT', { altKey: true, shiftKey: true })).toBe('reopen');
    expect(key('KeyT', { ctrlKey: true, shiftKey: true })).toBeNull(); // Chrome's own reopen
    expect(key('ArrowLeft', { altKey: true })).toBeNull(); // Alt+← is the browser's Back
    expect(key('KeyW', { ctrlKey: true })).toBeNull();
    expect(sameTitle('Attention Is All You Need', 'attention is all you need.')).toBe(true);
    expect(sameTitle('1706.03762', 'Attention Is All You Need')).toBe(false);
    expect(hubDocumentTitle('Attention', 3, 'ResearchPDF')).toBe('(3) Attention · ResearchPDF');
    expect(hubDocumentTitle('  ', 1, 'ResearchPDF')).toBe('PDF · ResearchPDF');
  });
});

// ─── Claim policy against a fake Chrome ───

interface FakeTab { id: number; windowId: number; index: number; active: boolean; url: string }

function createFakeChrome() {
  const tabs = new Map<number, FakeTab>();
  const session: Record<string, unknown> = {};
  const local: Record<string, unknown> = {};
  const focusedWindows: number[] = [];
  let nextId = 100;
  // Hub pages that answer the background's hand-over broadcast.
  const hubInboxes = new Map<number, Array<{ docs: Array<{ url: string; hash: string }>; activate: boolean }>>();
  const listener = () => ({ addListener: vi.fn() });
  const area = (store: Record<string, unknown>) => ({
    get: vi.fn(async (keys: string | string[]) => {
      const out: Record<string, unknown> = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) if (key in store) out[key] = structuredClone(store[key]);
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(store, structuredClone(items)); }),
  });
  const chrome = {
    runtime: {
      id: 'abc',
      getURL: (path: string) => `chrome-extension://abc/${path}`,
      sendMessage: vi.fn(async (message: { tabId: number; docs: Array<{ url: string; hash: string }>; activate: boolean }) => {
        const inbox = hubInboxes.get(message.tabId);
        if (!inbox) throw new Error('Could not establish connection. Receiving end does not exist.');
        inbox.push({ docs: message.docs, activate: message.activate });
        return { ok: true };
      }),
    },
    storage: { session: area(session), local: area(local) },
    windows: {
      update: vi.fn(async (windowId: number) => { focusedWindows.push(windowId); return {}; }),
    },
    tabs: {
      get: vi.fn(async (id: number) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        return { ...tab };
      }),
      create: vi.fn(async (props: { windowId?: number; index?: number; active: boolean; url: string }) => {
        const tab = { id: nextId++, windowId: props.windowId ?? 1, index: props.index ?? 0, active: props.active, url: props.url };
        tabs.set(tab.id, tab);
        return { ...tab };
      }),
      update: vi.fn(async (id: number, props: { active?: boolean }) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        if (props.active) for (const t of tabs.values()) if (t.windowId === tab.windowId) t.active = t.id === id;
        return { ...tab };
      }),
      onRemoved: listener(),
    },
  };
  return {
    chrome,
    tabs,
    local,
    focusedWindows,
    hubInboxes,
    addTab(tab: Omit<FakeTab, 'url'>) { tabs.set(tab.id, { ...tab, url: '' }); },
    sender(id: number) {
      const tab = tabs.get(id);
      if (!tab) throw new Error('no tab');
      return { id: 'abc', frameId: 0, url: `chrome-extension://abc/pdf-hub.html`, tab: { ...tab } } as unknown as chrome.runtime.MessageSender;
    },
  };
}

describe('hub claims', () => {
  let fake: ReturnType<typeof createFakeChrome>;
  let hub: typeof import('../src/background/pdfHub');

  beforeAll(async () => {
    fake = createFakeChrome();
    vi.stubGlobal('chrome', fake.chrome);
    hub = await import('../src/background/pdfHub');
  });

  beforeEach(() => {
    const next = createFakeChrome();
    // Keep the module's listener registrations; swap the state behind them.
    Object.assign(fake, next);
    vi.stubGlobal('chrome', next.chrome);
  });

  const doc = (url: string, hash = '') => ({ url, hash });
  const claim = (docs: Array<{ url: string; hash: string }>, canGoBack: boolean, tabId: number, project: string | null = null) =>
    hub.claimPdfHub({ docs, canGoBack, project }, fake.sender(tabId));

  /** Stores a project `id` holding the library document opened from `url`. */
  function storeProject(id: string, url: string, docId = `doc-${id}`): void {
    fake.local.rpdfLibrary = {
      ...(fake.local.rpdfLibrary as object ?? {}),
      [docId]: { docId, urls: [url], fileName: null, docTitle: null, title: null, venue: null, year: null, numPages: 3, openedAt: 1, pinned: false, pinChangedAt: 0 },
    };
    const layout = { urls: [], active: 0, show: null, savedAt: 0 };
    fake.local.rpdfProjects = {
      ...(fake.local.rpdfProjects as object ?? {}),
      default: { id: 'default', name: '기본', createdAt: 0, renamedAt: 0, deletedAt: 0, members: [], layout },
      [id]: { id, name: id, createdAt: 1, renamedAt: 1, deletedAt: 0, members: [{ docId, member: true, pinned: false, changedAt: 1 }], layout },
    };
  }

  it('decides purely from the registry entry, the claimer, and its history', () => {
    const pending = [doc(A)];
    expect(hub.decideHubClaim({ entry: { tabId: 1, ready: false, pending }, claimerTabId: 1, canGoBack: true, hasDocs: true }))
      .toEqual({ kind: 'become-hub', pending });
    expect(hub.decideHubClaim({ entry: { tabId: 1, ready: true, pending: [] }, claimerTabId: 2, canGoBack: false, hasDocs: true }))
      .toEqual({ kind: 'forward-live', hubTabId: 1 });
    expect(hub.decideHubClaim({ entry: { tabId: 1, ready: false, pending: [] }, claimerTabId: 2, canGoBack: false, hasDocs: true }))
      .toEqual({ kind: 'forward-pending', hubTabId: 1 });
    expect(hub.decideHubClaim({ entry: null, claimerTabId: 2, canGoBack: true, hasDocs: true })).toEqual({ kind: 'spawn-hub' });
    expect(hub.decideHubClaim({ entry: null, claimerTabId: 2, canGoBack: true, hasDocs: false })).toEqual({ kind: 'become-hub', pending: [] });
    expect(hub.decideHubClaim({ entry: null, claimerTabId: 2, canGoBack: false, hasDocs: true })).toEqual({ kind: 'become-hub', pending: [] });
    expect(hub.mergeHubDocs([doc(A), doc(B, '#page=1')], [doc(B, '#page=9'), doc(LOCAL)]))
      .toEqual([doc(A), doc(B, '#page=9'), doc(LOCAL)]);
  });

  it('makes a fresh PDF tab the default project\'s hub and hands later PDFs to it, closing their tabs', async () => {
    fake.addTab({ id: 1, windowId: 7, index: 0, active: true });
    expect(await claim([doc(A)], false, 1)).toEqual({ success: true, role: 'hub', project: 'default', docs: [] });
    fake.hubInboxes.set(1, []);

    fake.addTab({ id: 2, windowId: 7, index: 1, active: true });
    expect(await claim([doc(B, '#page=2')], false, 2)).toEqual({ success: true, role: 'forwarded', dispose: 'close' });
    expect(fake.hubInboxes.get(1)).toEqual([{ docs: [doc(B, '#page=2')], activate: true }]);
    expect(fake.tabs.get(1)?.active).toBe(true);

    // A background-opened PDF joins quietly; the hub is not brought forward.
    fake.tabs.get(1)!.active = false;
    fake.addTab({ id: 3, windowId: 7, index: 2, active: false });
    expect(await claim([doc(LOCAL)], true, 3)).toEqual({ success: true, role: 'forwarded', dispose: 'back' });
    expect(fake.hubInboxes.get(1)?.[1]).toEqual({ docs: [doc(LOCAL)], activate: false });
    expect(fake.tabs.get(1)?.active).toBe(false);
  });

  it('keeps a web tab a web tab: the first PDF opened over a page gets a clean hub tab next to it', async () => {
    fake.addTab({ id: 1, windowId: 7, index: 4, active: true });
    expect(await claim([doc(A, '#page=3')], true, 1)).toEqual({ success: true, role: 'forwarded', dispose: 'back' });
    const created = [...fake.tabs.values()].find((t) => t.id !== 1)!;
    expect(created).toMatchObject({ windowId: 7, index: 5, active: true });
    expect(hubParts(created.url)).toEqual({ docs: [doc(A, '#page=3')], active: 0, show: null, project: null });

    // Another PDF arrives before the new hub page has loaded: it is queued...
    fake.addTab({ id: 2, windowId: 7, index: 6, active: false });
    expect(await claim([doc(B)], false, 2)).toEqual({ success: true, role: 'forwarded', dispose: 'close' });
    // ...and handed over when the hub claims.
    expect(await claim([doc(A, '#page=3')], false, created.id))
      .toEqual({ success: true, role: 'hub', project: 'default', docs: [doc(B)] });
  });

  it('elects exactly one hub when several PDFs open at once', async () => {
    for (const id of [1, 2, 3, 4]) fake.addTab({ id, windowId: 7, index: id, active: id === 4 });
    const results = await Promise.all([1, 2, 3, 4].map((id) =>
      claim([doc(`https://a.org/${id}.pdf`)], false, id).then((result) => {
        if (result.success && result.role === 'hub') fake.hubInboxes.set(id, []);
        return result;
      })));
    expect(results.filter((r) => r.success && r.role === 'hub')).toHaveLength(1);
    expect(results.filter((r) => r.success && r.role === 'forwarded')).toHaveLength(3);
    const [hubId] = [...fake.hubInboxes.keys()];
    expect(fake.hubInboxes.get(hubId)?.flatMap((m) => m.docs.map((d) => d.url))).toHaveLength(3);
  });

  it('keeps one hub per project across windows, and replaces a hub that stopped answering', async () => {
    fake.addTab({ id: 1, windowId: 7, index: 0, active: true });
    fake.addTab({ id: 2, windowId: 8, index: 0, active: true });
    expect(await claim([doc(A)], false, 1)).toMatchObject({ role: 'hub' });
    fake.hubInboxes.set(1, []);
    // A PDF opened in another window goes to that hub, which comes forward with its window.
    expect(await claim([doc(B)], false, 2)).toMatchObject({ role: 'forwarded' });
    expect(fake.hubInboxes.get(1)).toEqual([{ docs: [doc(B)], activate: true }]);
    expect(fake.focusedWindows).toEqual([7]);

    // Tab 1 is still open but its hub page is gone (no inbox): tab 3 takes over.
    fake.hubInboxes.delete(1);
    fake.addTab({ id: 3, windowId: 8, index: 1, active: true });
    expect(await claim([doc(LOCAL)], false, 3)).toMatchObject({ role: 'hub', project: 'default' });

    // A closed hub is forgotten too.
    fake.tabs.delete(3);
    fake.addTab({ id: 4, windowId: 8, index: 0, active: true });
    expect(await claim([doc(A)], false, 4)).toMatchObject({ role: 'hub' });
  });

  it('gives each project its own hub, and sends a document to an open project it belongs to', async () => {
    storeProject('p1x', A);
    fake.addTab({ id: 1, windowId: 7, index: 0, active: true });
    fake.addTab({ id: 2, windowId: 7, index: 1, active: true });
    expect(await claim([], false, 1)).toMatchObject({ role: 'hub', project: 'default' });
    expect(await claim([], false, 2, 'p1x')).toMatchObject({ role: 'hub', project: 'p1x' });
    fake.hubInboxes.set(1, []);
    fake.hubInboxes.set(2, []);

    // A's document is registered to the open project p1x; B is in no project.
    fake.addTab({ id: 3, windowId: 7, index: 2, active: true });
    expect(await claim([doc(A, '#page=4')], true, 3)).toMatchObject({ role: 'forwarded', dispose: 'back' });
    expect(fake.hubInboxes.get(2)).toEqual([{ docs: [doc(A, '#page=4')], activate: true }]);
    fake.addTab({ id: 4, windowId: 7, index: 3, active: true });
    expect(await claim([doc(B)], true, 4)).toMatchObject({ role: 'forwarded' });
    expect(fake.hubInboxes.get(1)).toEqual([{ docs: [doc(B)], activate: true }]);

    // A second tab for an open project hands over to it instead of becoming another hub.
    fake.addTab({ id: 5, windowId: 9, index: 0, active: true });
    expect(await claim([doc(LOCAL)], false, 5, 'p1x')).toMatchObject({ role: 'forwarded', dispose: 'close' });
    expect(fake.hubInboxes.get(2)?.[1]).toEqual({ docs: [doc(LOCAL)], activate: true });
  });

  it('opens a document of a closed project in the default project, and a deleted project\'s tab as the default one', async () => {
    storeProject('p1x', A);
    fake.addTab({ id: 1, windowId: 7, index: 0, active: true });
    expect(await claim([doc(A)], false, 1)).toMatchObject({ role: 'hub', project: 'default' });
    fake.hubInboxes.set(1, []);
    const projects = fake.local.rpdfProjects as Record<string, { deletedAt: number }>;
    projects.p1x.deletedAt = 5;
    fake.addTab({ id: 2, windowId: 8, index: 0, active: true });
    expect(await claim([doc(B)], false, 2, 'p1x')).toMatchObject({ role: 'forwarded' });
    expect(fake.hubInboxes.get(1)).toEqual([{ docs: [doc(B)], activate: true }]);
  });

  it('opens a closed project with its saved tabs, and shows an open one', async () => {
    storeProject('p1x', A);
    (fake.local.rpdfProjects as Record<string, { layout: unknown }>).p1x.layout = { urls: [A, B], active: 1, show: null, savedAt: 9 };
    fake.addTab({ id: 1, windowId: 7, index: 3, active: true });
    expect(await hub.openPdfProject('p1x', fake.sender(1))).toEqual({ success: true });
    const created = [...fake.tabs.values()].find((t) => t.id !== 1)!;
    expect(created).toMatchObject({ windowId: 7, index: 4, active: true });
    expect(hubParts(created.url)).toEqual({ docs: [doc(A), doc(B)], active: 1, show: null, project: 'p1x' });
    // The new tab is that project's hub once it claims.
    expect(await claim([doc(A), doc(B)], false, created.id, 'p1x')).toMatchObject({ role: 'hub', project: 'p1x' });
    // Asked again, it is only brought forward.
    fake.tabs.get(created.id)!.active = false;
    expect(await hub.openPdfProject('p1x', fake.sender(1))).toEqual({ success: true });
    expect(fake.tabs.size).toBe(2);
    expect(fake.tabs.get(created.id)?.active).toBe(true);
    expect(await hub.openPdfProject('nope', fake.sender(1))).toMatchObject({ success: false });
  });

  it('switches a hub to a closed project in place: the URL to load, and a claim that keeps the tab', async () => {
    storeProject('p1x', A);
    (fake.local.rpdfProjects as Record<string, { layout: unknown }>).p1x.layout = { urls: [A], active: 0, show: 'home', savedAt: 9 };
    fake.addTab({ id: 1, windowId: 7, index: 0, active: true });
    expect(await claim([doc(B)], false, 1)).toMatchObject({ role: 'hub', project: 'default' });
    const answer = await hub.openPdfProject('p1x', fake.sender(1), true);
    expect(answer.success).toBe(true);
    expect(hubParts(answer.url!)).toEqual({ docs: [doc(A)], active: 0, show: 'home', project: 'p1x' });
    expect(fake.tabs.size).toBe(1);
    // The page loads that URL and claims; having history does not send it back to a web page.
    expect(await claim([doc(A)], true, 1, 'p1x')).toEqual({ success: true, role: 'hub', project: 'p1x', docs: [] });
    expect(fake.tabs.size).toBe(1);
    // Switching to a project open elsewhere brings that tab forward instead.
    fake.addTab({ id: 2, windowId: 8, index: 0, active: true });
    expect(await claim([], false, 2)).toMatchObject({ role: 'hub', project: 'default' });
    fake.tabs.get(1)!.active = false;
    expect(await hub.openPdfProject('p1x', fake.sender(2), true)).toEqual({ success: true });
    expect(fake.tabs.get(1)?.active).toBe(true);
  });

  it('moves a document: to an open project\'s hub, or into a closed one\'s saved tabs', async () => {
    storeProject('p1x', A, 'docA');
    storeProject('p2y', LOCAL, 'docL');
    fake.addTab({ id: 1, windowId: 7, index: 0, active: true });
    fake.addTab({ id: 2, windowId: 7, index: 1, active: true });
    expect(await claim([], false, 1)).toMatchObject({ project: 'default' });
    expect(await claim([], false, 2, 'p1x')).toMatchObject({ project: 'p1x' });
    fake.hubInboxes.set(2, []);

    expect(await hub.movePdfToProject({ docId: 'docB', url: B, from: 'default', to: 'p1x', keep: false })).toEqual({ success: true, open: true });
    expect(fake.hubInboxes.get(2)).toEqual([{ docs: [doc(B)], activate: false }]);
    expect(await hub.movePdfToProject({ docId: 'docA', url: A, from: 'p1x', to: 'p2y', keep: false })).toEqual({ success: true, open: false });
    const projects = fake.local.rpdfProjects as Record<string, { members: Array<{ docId: string; member: boolean }>; layout: { urls: string[] } }>;
    expect(projects.p1x.members).toEqual([
      expect.objectContaining({ docId: 'docA', member: false }),
      expect.objectContaining({ docId: 'docB', member: true }),
    ]);
    expect(projects.p2y.members.filter((m) => m.member).map((m) => m.docId)).toEqual(['docA', 'docL']);
    expect(projects.p2y.layout.urls).toEqual([A]);
    // `keep` registers it there too and moves no tab.
    expect(await hub.movePdfToProject({ docId: 'docL', url: LOCAL, from: 'p2y', to: 'p1x', keep: true })).toEqual({ success: true, open: true });
    expect(fake.hubInboxes.get(2)).toHaveLength(1);
    expect(projects.p2y.members.some((m) => m.docId === 'docL' && m.member)).toBe(true);
  });

  it('takes an embedded PDF for the whole page only when its frame fills the tab', () => {
    expect(hub.fillsTab({ width: 1300, height: 860 }, { width: 1300, height: 900 })).toBe(true); // IEEE stamp.jsp: header + iframe
    expect(hub.fillsTab({ width: 320, height: 240 }, { width: 1300, height: 900 })).toBe(false); // a PDF in a blog post
    expect(hub.fillsTab({ width: 1300, height: 400 }, { width: 1300, height: 900 })).toBe(false);
    expect(hub.fillsTab({ width: 1300, height: 860 }, {})).toBe(false);
  });

  it('refuses claims from frames and tab-less senders', async () => {
    fake.addTab({ id: 1, windowId: 7, index: 0, active: true });
    const framed = { ...fake.sender(1), frameId: 3 } as chrome.runtime.MessageSender;
    expect(await hub.claimPdfHub({ docs: [doc(A)], canGoBack: false, project: null }, framed)).toMatchObject({ success: false });
    expect(await hub.claimPdfHub({ docs: [doc(A)], canGoBack: false, project: null }, { id: 'abc' })).toMatchObject({ success: false });
  });
});
