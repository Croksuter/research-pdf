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
  parsePdfTearOffRequest,
  parsePdfWindowsRequest,
} from '../src/shared/messages';
import {
  HUB_MESSAGE_TAG,
  hubDocumentTitle,
  hubKeyAction,
  isEditableTarget,
  parseHubToViewerMessage,
  parseViewerToHubMessage,
  sameTitle,
} from '../src/shared/pdfHubProtocol';
import { DEFAULT_HUB_SCOPE, parseHubScope, pickHub } from '../src/shared/hubScope';

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

  it('remembers the settings page in front, even with no documents', () => {
    expect(buildPdfHubUrl([], 0, HUB, 'settings')).toBe(`${HUB}?s=settings`);
    expect(hubParts(buildPdfHubUrl([A], 0, HUB, 'settings', 'p1x'))).toEqual({ docs: [{ url: A, hash: '' }], active: 0, show: 'settings', project: 'p1x' });
    expect(parsePdfHubOpenMessage({ type: 'VOCAB_T_PDF_HUB_OPEN', tabId: 3, docs: [], activate: true, show: 'settings' }))
      .toEqual({ type: 'VOCAB_T_PDF_HUB_OPEN', tabId: 3, docs: [], activate: true, show: 'settings' });
    expect(parsePdfHubOpenMessage({ type: 'VOCAB_T_PDF_HUB_OPEN', tabId: 3, docs: [], activate: true, show: 'home' })).toBeNull();
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

  it('parses a tear-off by shape: a project, a document address, and on-screen-sized bounds or none', () => {
    const bounds = { left: -1200, top: 40, width: 900, height: 700 };
    expect(parsePdfTearOffRequest({ type: 'VOCAB_T_PDF_TEAR_OFF', project: 'p1x', url: A, bounds }))
      .toEqual({ type: 'VOCAB_T_PDF_TEAR_OFF', project: 'p1x', url: A, bounds, target: null, arrival: null });
    // A window by id or under a point, a file from disk (no address), and what the new hub's notice sends back.
    expect(parsePdfTearOffRequest({ type: 'VOCAB_T_PDF_TEAR_OFF', project: 'p1x', url: null, bounds: null, target: { windowId: 8 }, arrival: { key: 3, title: 'T' } }))
      .toEqual({ type: 'VOCAB_T_PDF_TEAR_OFF', project: 'p1x', url: null, bounds: null, target: { windowId: 8 }, arrival: { key: 3, title: 'T' } });
    expect(parsePdfTearOffRequest({ type: 'VOCAB_T_PDF_TEAR_OFF', project: 'p1x', url: A, bounds: null, target: { x: -1500, y: 20 } })?.target).toEqual({ x: -1500, y: 20 });
    expect(parsePdfTearOffRequest({ type: 'VOCAB_T_PDF_TEAR_OFF', project: 'p1x', url: A, bounds: null, target: { x: 1.5, y: 2 } })).toBeNull();
    expect(parsePdfTearOffRequest({ type: 'VOCAB_T_PDF_TEAR_OFF', project: 'p1x', url: A, bounds: null, target: { windowId: 'w' } })).toBeNull();
    expect(parsePdfTearOffRequest({ type: 'VOCAB_T_PDF_TEAR_OFF', project: 'p1x', url: A, bounds: null, arrival: { key: 'k', title: 'T' } })).toBeNull();
    expect(parsePdfWindowsRequest({ type: 'VOCAB_T_PDF_WINDOWS', project: 'p1x' })).toEqual({ type: 'VOCAB_T_PDF_WINDOWS', project: 'p1x' });
    expect(parsePdfWindowsRequest({ type: 'VOCAB_T_PDF_WINDOWS', project: '../x' })).toBeNull();
    expect(parsePdfTearOffRequest({ type: 'VOCAB_T_PDF_TEAR_OFF', project: 'default', url: LOCAL, bounds: null })?.bounds).toBeNull();
    expect(parsePdfTearOffRequest({ type: 'VOCAB_T_PDF_TEAR_OFF', project: 'default', url: LOCAL })?.bounds).toBeNull();
    expect(parsePdfTearOffRequest({ type: 'VOCAB_T_PDF_TEAR_OFF', project: '../x', url: A, bounds: null })).toBeNull();
    expect(parsePdfTearOffRequest({ type: 'VOCAB_T_PDF_TEAR_OFF', project: 'p1x', url: 'javascript:x', bounds: null })).toBeNull();
    expect(parsePdfTearOffRequest({ type: 'VOCAB_T_PDF_TEAR_OFF', project: 'p1x', url: A, bounds: { ...bounds, width: 20 } })).toBeNull();
    expect(parsePdfTearOffRequest({ type: 'VOCAB_T_PDF_TEAR_OFF', project: 'p1x', url: A, bounds: { ...bounds, left: 1.5 } })).toBeNull();
    expect(parsePdfTearOffRequest({ type: 'VOCAB_T_PDF_TEAR_OFF', project: 'p1x', url: A, bounds: 'top' })).toBeNull();
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
    // Split view: a viewer pressed in, a second view made the tab's own.
    expect(parseViewerToHubMessage({ tag: HUB_MESSAGE_TAG, kind: 'focus' })).toEqual({ tag: HUB_MESSAGE_TAG, kind: 'focus' });
    expect(parseHubToViewerMessage({ tag: HUB_MESSAGE_TAG, kind: 'active' })).toEqual({ tag: HUB_MESSAGE_TAG, kind: 'active' });
    expect(parseViewerToHubMessage({ tag: HUB_MESSAGE_TAG, kind: 'drag' })).toEqual({ tag: HUB_MESSAGE_TAG, kind: 'drag' });
    expect(parseHubToViewerMessage({ tag: HUB_MESSAGE_TAG, kind: 'primary' })).toBeNull();
    expect(parseViewerToHubMessage({ tag: HUB_MESSAGE_TAG, kind: 'key', action: 'split' })?.kind).toBe('key');
  });

  it('maps only the hub keys Chrome leaves free, and titles the tab by count and document', () => {
    const key = (code: string, mods: Partial<{ altKey: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }>) =>
      hubKeyAction({ altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, code, ...mods });
    expect(key('ArrowRight', { altKey: true, shiftKey: true })).toBe('next');
    expect(key('ArrowLeft', { altKey: true, shiftKey: true })).toBe('prev');
    expect(key('KeyW', { altKey: true })).toBe('close');
    expect(key('KeyT', { altKey: true, shiftKey: true })).toBe('reopen');
    expect(key('KeyS', { altKey: true, shiftKey: true })).toBe('split');
    expect(key('KeyO', { altKey: true, shiftKey: true })).toBe('pane');
    expect(key('KeyS', { altKey: true })).toBeNull();
    expect(key('KeyT', { ctrlKey: true, shiftKey: true })).toBeNull(); // Chrome's own reopen
    expect(key('ArrowLeft', { altKey: true })).toBeNull(); // Alt+← is the browser's Back
    expect(key('KeyW', { ctrlKey: true })).toBeNull();
    // Typing: macOS Option+Shift+← selects a word, Option+W types a character.
    const inField = (code: string, target: unknown, shiftKey = true) => hubKeyAction({ altKey: true, shiftKey, ctrlKey: false, metaKey: false, code, target });
    expect(inField('ArrowLeft', { tagName: 'INPUT', type: 'search' })).toBeNull();
    expect(inField('ArrowRight', { tagName: 'TEXTAREA' })).toBeNull();
    expect(inField('KeyW', { tagName: 'DIV', isContentEditable: true }, false)).toBeNull();
    expect(inField('ArrowRight', { tagName: 'SELECT' })).toBeNull();
    expect(inField('ArrowRight', { tagName: 'INPUT', type: 'checkbox' })).toBe('next');
    expect(inField('ArrowRight', { tagName: 'BUTTON', isContentEditable: false })).toBe('next');
    expect(isEditableTarget({ tagName: 'input' })).toBe(true);
    expect(isEditableTarget(null)).toBe(false);
    expect(sameTitle('Attention Is All You Need', 'attention is all you need.')).toBe(true);
    expect(sameTitle('1706.03762', 'Attention Is All You Need')).toBe(false);
    expect(hubDocumentTitle('Attention', 3, 'ResearchPDF')).toBe('(3) Attention · ResearchPDF');
    expect(hubDocumentTitle('  ', 1, 'ResearchPDF')).toBe('PDF · ResearchPDF');
  });
});

// ─── Claim policy against a fake Chrome ───

interface FakeTab { id: number; windowId: number; index: number; active: boolean; url: string; discarded?: boolean }

function createFakeChrome() {
  const tabs = new Map<number, FakeTab>();
  const session: Record<string, unknown> = {};
  const local: Record<string, unknown> = {};
  const focusedWindows: number[] = [];
  const createdWindows: Array<{ url: string; left?: number }> = [];
  const windowBoxes = new Map<number, { left: number; top: number; width: number; height: number }>();
  let nextId = 100;
  let nextWindow = 50;
  // Hub pages that answer the background's hand-over broadcast.
  const hubInboxes = new Map<number, Array<{ docs: Array<{ url: string; hash: string }>; activate: boolean }>>();
  // Hub pages Chrome froze: they take a message only when woken.
  const asleep = new Map<number, Array<() => void>>();
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
        const sleeping = asleep.get(message.tabId);
        if (sleeping) await new Promise<void>((resolve) => { sleeping.push(resolve); });
        const inbox = hubInboxes.get(message.tabId);
        if (!inbox) throw new Error('Could not establish connection. Receiving end does not exist.');
        inbox.push({ docs: message.docs, activate: message.activate });
        return { ok: true };
      }),
    },
    storage: { session: area(session), local: area(local) },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: listener(),
      getAll: vi.fn(async () => [...windowBoxes.entries()].map(([id, box]) => ({
        id, ...box, state: 'normal', tabs: [...tabs.values()].filter((t) => t.windowId === id).map((t) => ({ ...t })),
      }))),
      update: vi.fn(async (windowId: number) => { focusedWindows.push(windowId); return {}; }),
      create: vi.fn(async (props: { url: string; left?: number }) => {
        if (props.left !== undefined && props.left < -5000) throw new Error('Invalid value for bounds.');
        const windowId = nextWindow++;
        const tab = { id: nextId++, windowId, index: 0, active: true, url: props.url };
        tabs.set(tab.id, tab);
        createdWindows.push(props);
        return { id: windowId, tabs: [{ ...tab }] };
      }),
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
      query: vi.fn(async (q: { windowId?: number }) => [...tabs.values()].filter((t) => q.windowId === undefined || t.windowId === q.windowId).map((t) => ({ ...t }))),
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
    session,
    focusedWindows,
    createdWindows,
    windowBoxes,
    hubInboxes,
    asleep,
    /** The frozen hub wakes and takes what was sent to it meanwhile. */
    wake(tabId: number) { const waiting = asleep.get(tabId) ?? []; asleep.delete(tabId); waiting.forEach((resolve) => resolve()); },
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
    const decide = (input: Omit<Parameters<typeof hub.decideHubClaim>[0], 'liveness'> & { liveness?: 'present' | 'discarded' | 'gone' }) =>
      hub.decideHubClaim({ liveness: 'present', ...input });
    expect(decide({ entry: { tabId: 1, ready: false, pending }, claimerTabId: 1, canGoBack: true, hasDocs: true }))
      .toEqual({ kind: 'become-hub', pending });
    expect(decide({ entry: { tabId: 1, ready: true, pending: [] }, claimerTabId: 2, canGoBack: false, hasDocs: true }))
      .toEqual({ kind: 'forward-live', hubTabId: 1 });
    expect(decide({ entry: { tabId: 1, ready: false, pending: [] }, claimerTabId: 2, canGoBack: false, hasDocs: true }))
      .toEqual({ kind: 'queue', hubTabId: 1, ready: false });
    expect(decide({ entry: null, claimerTabId: 2, canGoBack: true, hasDocs: true })).toEqual({ kind: 'spawn-hub' });
    expect(decide({ entry: null, claimerTabId: 2, canGoBack: true, hasDocs: false })).toEqual({ kind: 'become-hub', pending: [] });
    expect(decide({ entry: null, claimerTabId: 2, canGoBack: false, hasDocs: true })).toEqual({ kind: 'become-hub', pending: [] });
    expect(hub.mergeHubDocs([doc(A), doc(B, '#page=1')], [doc(B, '#page=9'), doc(LOCAL)]))
      .toEqual([doc(A), doc(B, '#page=9'), doc(LOCAL)]);
  });

  it('decides on the hub\'s liveness and on how a hand-over went, purely', () => {
    const live = { tabId: 1, ready: true, pending: [] };
    const base = { claimerTabId: 2, canGoBack: false, hasDocs: true };
    // Closed: forgotten, and the claim proceeds as if there were none.
    expect(hub.decideHubClaim({ ...base, entry: live, liveness: 'gone' })).toEqual({ kind: 'become-hub', pending: [], forget: true });
    expect(hub.decideHubClaim({ ...base, canGoBack: true, entry: live, liveness: 'gone' })).toEqual({ kind: 'spawn-hub', forget: true });
    // Discarded: it reloads and claims when shown, so the documents wait for that, and it is not ready until then.
    expect(hub.decideHubClaim({ ...base, entry: live, liveness: 'discarded' })).toEqual({ kind: 'queue', hubTabId: 1, ready: false });
    // After a hand-over: taken; asleep (also queued, in case Chrome discards it before it wakes); no page answered.
    expect(hub.decideHubClaim({ ...base, entry: live, liveness: 'present', delivery: 'taken' })).toEqual({ kind: 'handed-over', hubTabId: 1 });
    expect(hub.decideHubClaim({ ...base, entry: live, liveness: 'present', delivery: 'asleep' })).toEqual({ kind: 'queue', hubTabId: 1, ready: true });
    expect(hub.decideHubClaim({ ...base, entry: live, liveness: 'present', delivery: 'gone' })).toEqual({ kind: 'become-hub', pending: [], forget: true });
    // Without an entry, liveness means nothing.
    expect(hub.decideHubClaim({ ...base, entry: null, liveness: 'gone' })).toEqual({ kind: 'become-hub', pending: [] });
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

  it('closes a tab that hands the same PDF over again right after going back (a page that forwards to it by itself)', async () => {
    // The project's PDF tab in window 7; window 8 opens one of its PDFs over a page (browser scope: it goes to window 7).
    fake.local.rpdfHubScope = 'browser';
    fake.addTab({ id: 1, windowId: 7, index: 0, active: true });
    expect(await claim([doc(A)], false, 1)).toMatchObject({ role: 'hub' });
    fake.hubInboxes.set(1, []);
    fake.addTab({ id: 2, windowId: 8, index: 0, active: true });
    expect(await claim([doc(B)], true, 2)).toEqual({ success: true, role: 'forwarded', dispose: 'back' });
    expect(fake.hubInboxes.get(1)?.[0]).toEqual({ docs: [doc(B)], activate: true });
    // Back on its page, which sends it to the PDF again: it closes, and the PDF tab is not brought forward.
    fake.tabs.get(1)!.active = false;
    expect(await claim([doc(B, '#page=2')], true, 2)).toEqual({ success: true, role: 'forwarded', dispose: 'close' });
    expect(fake.hubInboxes.get(1)?.[1]).toEqual({ docs: [doc(B, '#page=2')], activate: false });
    expect(fake.tabs.get(1)?.active).toBe(false);
    // Another PDF from the same tab is a hand-over like any other.
    fake.addTab({ id: 3, windowId: 8, index: 1, active: true });
    expect(await claim([doc(A)], true, 3)).toEqual({ success: true, role: 'forwarded', dispose: 'back' });
    expect(await claim([doc(LOCAL)], true, 3)).toEqual({ success: true, role: 'forwarded', dispose: 'back' });
  });

  it('tells a hand-over repeated moments after going back from a later one, purely', () => {
    const key = hub.handOverKey([doc(B, '#page=2'), doc(A)]);
    expect(key).toBe(hub.handOverKey([doc(A), doc(B)]));
    expect(hub.handsOverAgain(undefined, key, 1_000)).toBe(false);
    expect(hub.handsOverAgain({ docs: key, at: 1_000 }, key, 1_000 + hub.HANDED_BACK_MS - 1)).toBe(true);
    expect(hub.handsOverAgain({ docs: key, at: 1_000 }, key, 1_000 + hub.HANDED_BACK_MS)).toBe(false);
    expect(hub.handsOverAgain({ docs: key, at: 1_000 }, hub.handOverKey([doc(A)]), 1_500)).toBe(false);
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

  it('keeps one hub per project across windows with the browser scope, and replaces a hub that stopped answering', async () => {
    fake.local.rpdfHubScope = 'browser';
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
    fake.local.rpdfHubScope = 'browser';
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
    fake.local.rpdfHubScope = 'browser';
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
    fake.local.rpdfHubScope = 'browser';
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

  it('moves a document into the saved tabs when the target hub page is gone, and forgets that hub', async () => {
    storeProject('p1x', A, 'docA');
    fake.addTab({ id: 2, windowId: 7, index: 1, active: true });
    expect(await claim([], false, 2, 'p1x')).toMatchObject({ project: 'p1x' });
    // Tab 2 navigated away without Chrome telling us: no hub page answers there.
    expect(await hub.movePdfToProject({ docId: 'docB', url: B, from: 'default', to: 'p1x', keep: false })).toEqual({ success: true, open: false });
    const projects = fake.local.rpdfProjects as Record<string, { layout: { urls: string[] } }>;
    expect(projects.p1x.layout.urls).toEqual([B]);
    // The stale hub is forgotten: the next tab for p1x becomes its hub.
    fake.addTab({ id: 3, windowId: 7, index: 2, active: true });
    expect(await claim([], false, 3, 'p1x')).toMatchObject({ role: 'hub', project: 'p1x' });
    // A discarded hub gets it when it reloads and claims.
    fake.tabs.get(3)!.discarded = true;
    expect(await hub.movePdfToProject({ docId: 'docL', url: LOCAL, from: 'default', to: 'p1x', keep: false })).toEqual({ success: true, open: true });
    fake.tabs.get(3)!.discarded = false;
    expect(await claim([], false, 3, 'p1x')).toEqual({ success: true, role: 'hub', project: 'p1x', docs: [doc(LOCAL)] });
  });

  it('keeps what it hands to an asleep hub queued until the hub takes it', async () => {
    storeProject('p1x', A, 'docA');
    fake.addTab({ id: 2, windowId: 7, index: 1, active: false });
    expect(await claim([], false, 2, 'p1x')).toMatchObject({ project: 'p1x' });
    fake.hubInboxes.set(2, []);
    fake.asleep.set(2, []);
    expect(await hub.movePdfToProject({ docId: 'docB', url: B, from: 'default', to: 'p1x', keep: false })).toEqual({ success: true, open: true });
    // Chrome discards it before it wakes: the reloaded hub still gets the document.
    expect(await claim([], false, 2, 'p1x')).toEqual({ success: true, role: 'hub', project: 'p1x', docs: [doc(B)] });

    // A claim handed to an asleep hub is queued too; once the hub wakes and takes it, the queue lets it go.
    fake.asleep.set(2, []);
    fake.addTab({ id: 3, windowId: 7, index: 2, active: false });
    storeProject('p1x', A, 'docA');
    expect(await claim([doc(LOCAL)], false, 3, 'p1x')).toEqual({ success: true, role: 'forwarded', dispose: 'close' });
    fake.wake(2);
    await vi.waitFor(() => expect(fake.hubInboxes.get(2)?.flatMap((m) => m.docs)).toEqual([doc(LOCAL)]));
    await vi.waitFor(async () => expect(await claim([], false, 2, 'p1x')).toEqual({ success: true, role: 'hub', project: 'p1x', docs: [] }));
  }, 10_000);

  it('picks the hub of the claimer\'s window, the one in front there first, and with the browser scope any', () => {
    const hubs = [
      { tabId: 1, windowId: 7, active: false },
      { tabId: 2, windowId: 8, active: false },
      { tabId: 3, windowId: 8, active: true },
    ];
    expect(pickHub(hubs, 8, 'window')?.tabId).toBe(3);
    expect(pickHub(hubs.slice(0, 2), 8, 'window')?.tabId).toBe(2);
    expect(pickHub(hubs, 9, 'window')).toBeNull();
    expect(pickHub(hubs, 9, 'browser')?.tabId).toBe(1);
    expect(pickHub(hubs, null, 'browser')?.tabId).toBe(1);
    expect(pickHub([], 7, 'browser')).toBeNull();
    expect(parseHubScope('browser')).toBe('browser');
    expect(parseHubScope(undefined)).toBe(DEFAULT_HUB_SCOPE);
    expect(parseHubScope('space')).toBe(DEFAULT_HUB_SCOPE);
  });

  it('with the window scope keeps a PDF in its window: a hub there, never another window brought forward', async () => {
    fake.addTab({ id: 1, windowId: 7, index: 0, active: true });
    expect(await claim([doc(A)], false, 1)).toMatchObject({ role: 'hub', project: 'default' });
    fake.hubInboxes.set(1, []);
    // Window 8 has no hub: the PDF's own tab becomes one there.
    fake.addTab({ id: 2, windowId: 8, index: 0, active: true });
    expect(await claim([doc(B)], false, 2)).toEqual({ success: true, role: 'hub', project: 'default', docs: [] });
    fake.hubInboxes.set(2, []);
    expect(fake.focusedWindows).toEqual([]);
    // Later PDFs go to their own window's hub.
    fake.addTab({ id: 3, windowId: 8, index: 1, active: true });
    expect(await claim([doc(LOCAL)], false, 3)).toMatchObject({ role: 'forwarded', dispose: 'close' });
    expect(fake.hubInboxes.get(2)).toEqual([{ docs: [doc(LOCAL)], activate: true }]);
    expect(fake.hubInboxes.get(1)).toEqual([]);
    expect(fake.focusedWindows).toEqual([8]);
    // A project's tab opened in a window without its hub becomes a second hub of it there.
    storeProject('p1x', A);
    fake.addTab({ id: 4, windowId: 7, index: 1, active: true });
    expect(await claim([], false, 4, 'p1x')).toMatchObject({ role: 'hub', project: 'p1x' });
    fake.addTab({ id: 5, windowId: 8, index: 2, active: true });
    expect(await claim([], false, 5, 'p1x')).toMatchObject({ role: 'hub', project: 'p1x' });
    expect(fake.session.rpdfProjectHubs).toMatchObject({ default: [{ tabId: 1 }, { tabId: 2 }], p1x: [{ tabId: 4 }, { tabId: 5 }] });
    // A document registered to p1x goes to p1x's hub in its own window.
    fake.hubInboxes.set(4, []);
    fake.hubInboxes.set(5, []);
    fake.addTab({ id: 6, windowId: 8, index: 3, active: false });
    expect(await claim([doc(A)], true, 6)).toMatchObject({ role: 'forwarded', dispose: 'back' });
    expect(fake.hubInboxes.get(5)).toEqual([{ docs: [doc(A)], activate: false }]);
    expect(fake.hubInboxes.get(4)).toEqual([]);
  });

  it('with the window scope opens a project here even when it is open in another window', async () => {
    storeProject('p1x', A);
    fake.addTab({ id: 1, windowId: 7, index: 0, active: true });
    expect(await claim([], false, 1, 'p1x')).toMatchObject({ role: 'hub', project: 'p1x' });
    fake.addTab({ id: 2, windowId: 8, index: 0, active: true });
    expect(await claim([], false, 2)).toMatchObject({ role: 'hub', project: 'default' });
    const answer = await hub.openPdfProject('p1x', fake.sender(2), true);
    expect(hubParts(answer.url!)).toMatchObject({ project: 'p1x' });
    expect(fake.focusedWindows).toEqual([]);
    // The same request from window 7 shows the hub there.
    fake.addTab({ id: 3, windowId: 7, index: 1, active: true });
    expect(await hub.openPdfProject('p1x', fake.sender(3), true)).toEqual({ success: true });
    expect(fake.tabs.get(1)?.active).toBe(true);
  });

  it('moves a document to the target project\'s hub in the sender\'s window first', async () => {
    storeProject('p1x', A, 'docA');
    fake.addTab({ id: 1, windowId: 7, index: 0, active: true });
    fake.addTab({ id: 2, windowId: 8, index: 0, active: true });
    expect(await claim([], false, 1, 'p1x')).toMatchObject({ role: 'hub' });
    expect(await claim([], false, 2, 'p1x')).toMatchObject({ role: 'hub' });
    fake.hubInboxes.set(1, []);
    fake.hubInboxes.set(2, []);
    expect(await hub.movePdfToProject({ docId: 'docB', url: B, from: 'default', to: 'p1x', keep: false }, 8)).toEqual({ success: true, open: true });
    expect(fake.hubInboxes.get(2)).toEqual([{ docs: [doc(B)], activate: false }]);
    // From a window without one: any open hub of it (the oldest).
    expect(await hub.movePdfToProject({ docId: 'docL', url: LOCAL, from: 'default', to: 'p1x', keep: false }, 9)).toEqual({ success: true, open: true });
    expect(fake.hubInboxes.get(1)).toEqual([{ docs: [doc(LOCAL)], activate: false }]);
  });

  it('tears a document off into a hub of its own in a new window, which never hands it back', async () => {
    fake.local.rpdfHubScope = 'browser';
    storeProject('p1x', A);
    fake.addTab({ id: 1, windowId: 7, index: 0, active: true });
    expect(await claim([doc(A), doc(B)], false, 1, 'p1x')).toMatchObject({ role: 'hub', project: 'p1x' });
    fake.hubInboxes.set(1, []);
    expect(await hub.tearOffPdfDoc({ project: 'p1x', url: B, bounds: { left: 40, top: 30, width: 900, height: 700 } })).toMatchObject({ success: true, created: true });
    expect(fake.createdWindows).toHaveLength(1);
    expect(fake.createdWindows[0]).toMatchObject({ left: 40, top: 30, width: 900, height: 700 });
    const created = [...fake.tabs.values()].find((t) => t.id !== 1)!;
    expect(hubParts(created.url)).toEqual({ docs: [doc(B)], active: 0, show: null, project: 'p1x' });
    // Its page claims: it is a hub of p1x too, even with the browser scope.
    expect(await claim([doc(B)], false, created.id, 'p1x')).toEqual({ success: true, role: 'hub', project: 'p1x', docs: [] });
    expect(fake.hubInboxes.get(1)).toEqual([]);
    // Only the oldest hub's tabs are the project's saved layout.
    expect(await hub.isLayoutHub('p1x', 1)).toBe(true);
    expect(await hub.isLayoutHub('p1x', created.id)).toBe(false);
    expect(await hub.isLayoutHub('default', created.id)).toBe(true);
    fake.tabs.delete(1);
    expect(await hub.isLayoutHub('p1x', created.id)).toBe(true);
    // Bounds Chrome refuses: the window opens wherever Chrome puts it.
    expect(await hub.tearOffPdfDoc({ project: 'gone', url: A, bounds: { left: -9000, top: 0, width: 900, height: 700 } })).toMatchObject({ success: true, created: true });
    expect(fake.createdWindows[fake.createdWindows.length - 1]).not.toHaveProperty('left');
    expect(hubParts(fake.createdWindows[fake.createdWindows.length - 1].url).project).toBe('default');
  });

  it('sends a document to another window: into its hub of the project, or a new hub tab beside its front tab, noting where it came from', async () => {
    storeProject('p1x', A);
    fake.windowBoxes.set(7, { left: 0, top: 0, width: 1000, height: 800 });
    fake.windowBoxes.set(8, { left: 1000, top: 0, width: 1000, height: 800 });
    fake.windowBoxes.set(9, { left: 500, top: 100, width: 1000, height: 800 });
    fake.addTab({ id: 1, windowId: 7, index: 0, active: true });
    expect(await claim([doc(A), doc(B)], false, 1, 'p1x')).toMatchObject({ role: 'hub', project: 'p1x' });
    fake.addTab({ id: 20, windowId: 8, index: 0, active: false });
    fake.addTab({ id: 21, windowId: 8, index: 1, active: true });
    fake.addTab({ id: 22, windowId: 8, index: 2, active: false });

    // Window 8 has no hub of p1x: one is made beside its front tab, holding just this document.
    const sent = await hub.tearOffPdfDoc({ project: 'p1x', url: B, bounds: null, target: { windowId: 8 }, arrival: { key: 3, title: 'B paper' } }, fake.sender(1));
    expect(sent).toMatchObject({ success: true, created: true });
    const made = fake.tabs.get((sent as { hubTabId: number }).hubTabId)!;
    expect(made).toMatchObject({ windowId: 8, index: 2, active: true });
    expect(hubParts(made.url)).toEqual({ docs: [doc(B)], active: 0, show: null, project: 'p1x' });
    expect(fake.focusedWindows).toContain(8);
    expect((fake.session.rpdfArrivals as Record<string, unknown>)[String(made.id)]).toMatchObject({ from: 1, key: 3, title: 'B paper' });
    expect(await claim([doc(B)], false, made.id, 'p1x')).toEqual({ success: true, role: 'hub', project: 'p1x', docs: [] });
    // Sent there again: that hub gets it (and asks), nothing new is made.
    expect(await hub.tearOffPdfDoc({ project: 'p1x', url: A, bounds: null, target: { windowId: 8 } }, fake.sender(1)))
      .toEqual({ success: true, hubTabId: made.id, created: false });

    // A point over windows 8 and 9: the one focused last.
    fake.session.rpdfWindowFocus = [9, 8];
    const onNine = await hub.tearOffPdfDoc({ project: 'p1x', url: A, bounds: null, target: { x: 1200, y: 400 } }, fake.sender(1));
    expect(fake.tabs.get((onNine as { hubTabId: number }).hubTabId)?.windowId).toBe(9);
    fake.session.rpdfWindowFocus = [8, 9];
    expect(await hub.tearOffPdfDoc({ project: 'p1x', url: A, bounds: null, target: { x: 1200, y: 400 } }, fake.sender(1)))
      .toEqual({ success: true, hubTabId: made.id, created: false });
    // Over the sender's own window only, or over nothing: a new window.
    const windowsBefore = fake.createdWindows.length;
    expect(await hub.tearOffPdfDoc({ project: 'p1x', url: A, bounds: null, target: { x: 100, y: 100 } }, fake.sender(1))).toMatchObject({ created: true });
    expect(await hub.tearOffPdfDoc({ project: 'p1x', url: A, bounds: null, target: { x: 5000, y: 5000 } }, fake.sender(1))).toMatchObject({ created: true });
    expect(fake.createdWindows.length).toBe(windowsBefore + 2);
    // A file from disk: an empty hub of the project, which the file is handed to.
    const local = await hub.tearOffPdfDoc({ project: 'p1x', url: null, bounds: null, target: null }, fake.sender(1));
    expect(hubParts(fake.tabs.get((local as { hubTabId: number }).hubTabId)!.url)).toMatchObject({ docs: [], project: 'p1x' });
  });

  it('lists the other windows for "send to another window", numbered among all, with whether a hub of the project is there', async () => {
    storeProject('p1x', A);
    for (const id of [7, 8, 9]) fake.windowBoxes.set(id, { left: 0, top: 0, width: 800, height: 600 });
    fake.addTab({ id: 1, windowId: 7, index: 0, active: true });
    fake.addTab({ id: 2, windowId: 9, index: 0, active: true });
    fake.addTab({ id: 3, windowId: 9, index: 1, active: false });
    expect(await claim([], false, 2, 'p1x')).toMatchObject({ role: 'hub' });
    expect(await hub.listPdfWindows('p1x', fake.sender(1))).toEqual({
      success: true,
      windows: [{ windowId: 8, number: 2, tabs: 0, hasHub: false }, { windowId: 9, number: 3, tabs: 2, hasHub: true }],
    });
  });

  it('reads a registry from the build with one hub per project', async () => {
    fake.addTab({ id: 1, windowId: 7, index: 0, active: true });
    fake.session.rpdfProjectHubs = { default: { tabId: 1, ready: true, pending: [] } };
    fake.hubInboxes.set(1, []);
    fake.addTab({ id: 2, windowId: 7, index: 1, active: true });
    expect(await claim([doc(B)], false, 2)).toMatchObject({ role: 'forwarded' });
    expect(fake.hubInboxes.get(1)).toEqual([{ docs: [doc(B)], activate: true }]);
    // Written back in the new form with the next change.
    storeProject('p1x', A);
    fake.addTab({ id: 3, windowId: 7, index: 2, active: true });
    expect(await claim([], false, 3, 'p1x')).toMatchObject({ role: 'hub' });
    expect(fake.session.rpdfProjectHubs).toEqual({ default: [{ tabId: 1, ready: true, pending: [] }], p1x: [{ tabId: 3, ready: true, pending: [] }] });
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
