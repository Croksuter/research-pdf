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
    expect(hubParts(url)).toEqual({ docs: [{ url: A, hash: '' }, { url: B, hash: '' }, { url: LOCAL, hash: '' }], active: 1 });
  });

  it('reads the single-document entry form, raw (declarativeNetRequest) or encoded, with its fragment', () => {
    expect(hubParts(buildPdfHubEntryUrl(`${B}#page=3`, HUB))).toEqual({ docs: [{ url: B, hash: '#page=3' }], active: 0 });
    // The redirect rule inserts the request URL verbatim.
    expect(parsePdfHubUrl(`?file=${B}`, '#page=2')).toEqual({ docs: [{ url: B, hash: '#page=2' }], active: 0 });
  });

  it('drops invalid, duplicate, and excess sources and clamps the active index', () => {
    const search = `?a=9&f=${encodeURIComponent(A)}&f=javascript%3Aalert(1)&f=${encodeURIComponent(A)}&f=${encodeURIComponent(`${B}#x`)}`;
    expect(parsePdfHubUrl(search, '')).toEqual({ docs: [{ url: A, hash: '' }, { url: B, hash: '' }], active: 0 });
    expect(parsePdfHubUrl('', '')).toEqual({ docs: [], active: 0 });
    const many = Array.from({ length: PDF_HUB_MAX_DOCS + 5 }, (_, i) => `https://a.org/${i}.pdf`);
    expect(hubParts(buildPdfHubUrl(many, 0, HUB)).docs).toHaveLength(PDF_HUB_MAX_DOCS);
    expect(buildPdfHubUrl([], 0, HUB)).toBe(HUB);
  });
});

describe('hub messages', () => {
  it('parses claims, state reports, and hand-overs by shape', () => {
    expect(parsePdfHubClaimRequest({ type: 'VOCAB_T_PDF_HUB_CLAIM', docs: [{ url: A, hash: '#page=2' }], canGoBack: true }))
      .toEqual({ type: 'VOCAB_T_PDF_HUB_CLAIM', docs: [{ url: A, hash: '#page=2' }], canGoBack: true });
    expect(parsePdfHubClaimRequest({ type: 'VOCAB_T_PDF_HUB_CLAIM', docs: [{ url: 'javascript:x' }], canGoBack: true })).toBeNull();
    expect(parsePdfHubClaimRequest({ type: 'VOCAB_T_PDF_HUB_CLAIM', docs: [], canGoBack: 'yes' })).toBeNull();
    expect(parsePdfHubClaimRequest({ type: 'VOCAB_T_PDF_HUB_CLAIM', docs: [{ url: A, hash: 'page=2 x' }], canGoBack: false })?.docs)
      .toEqual([{ url: A, hash: '' }]);
    expect(parsePdfHubStateRequest({ type: 'VOCAB_T_PDF_HUB_STATE', urls: [A, LOCAL], active: 1 }))
      .toEqual({ type: 'VOCAB_T_PDF_HUB_STATE', urls: [A, LOCAL], active: 1 });
    expect(parsePdfHubStateRequest({ type: 'VOCAB_T_PDF_HUB_STATE', urls: ['chrome://x'], active: 0 })).toBeNull();
    expect(parsePdfHubOpenMessage({ type: 'VOCAB_T_PDF_HUB_OPEN', tabId: 4, docs: [{ url: A, hash: '' }], activate: false }))
      .toEqual({ type: 'VOCAB_T_PDF_HUB_OPEN', tabId: 4, docs: [{ url: A, hash: '' }], activate: false });
    expect(parsePdfHubOpenMessage({ type: 'VOCAB_T_PDF_HUB_OPEN', tabId: '4', docs: [], activate: false })).toBeNull();
  });

  it('parses frame messages and never trusts untagged or malformed ones', () => {
    const file = new File([new Uint8Array([1])], 'x.pdf', { type: 'application/pdf' });
    expect(parseViewerToHubMessage({ tag: HUB_MESSAGE_TAG, kind: 'doc', title: 'T' })).toEqual({ tag: HUB_MESSAGE_TAG, kind: 'doc', title: 'T' });
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
    expect(key('ArrowLeft', { altKey: true })).toBeNull(); // Alt+← is the browser's Back
    expect(key('KeyW', { ctrlKey: true })).toBeNull();
    expect(hubDocumentTitle('Attention', 3, 'ResearchPDF')).toBe('(3) Attention · ResearchPDF');
    expect(hubDocumentTitle('  ', 1, 'ResearchPDF')).toBe('PDF · ResearchPDF');
  });
});

// ─── Claim policy against a fake Chrome ───

interface FakeTab { id: number; windowId: number; index: number; active: boolean; url: string }

function createFakeChrome() {
  const tabs = new Map<number, FakeTab>();
  const session: Record<string, unknown> = {};
  let nextId = 100;
  // Hub pages that answer the background's hand-over broadcast.
  const hubInboxes = new Map<number, Array<{ docs: Array<{ url: string; hash: string }>; activate: boolean }>>();
  const listener = () => ({ addListener: vi.fn() });
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
    storage: {
      session: {
        get: vi.fn(async (key: string) => (key in session ? { [key]: structuredClone(session[key]) } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(session, structuredClone(items)); }),
      },
    },
    tabs: {
      get: vi.fn(async (id: number) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        return { ...tab };
      }),
      create: vi.fn(async (props: { windowId: number; index: number; active: boolean; url: string }) => {
        const tab = { id: nextId++, windowId: props.windowId, index: props.index, active: props.active, url: props.url };
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
      onDetached: listener(),
      onAttached: listener(),
    },
  };
  return {
    chrome,
    tabs,
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

  it('makes a fresh PDF tab the hub and hands later PDFs to it, closing their tabs', async () => {
    fake.addTab({ id: 1, windowId: 7, index: 0, active: true });
    expect(await hub.claimPdfHub({ docs: [doc(A)], canGoBack: false }, fake.sender(1))).toEqual({ success: true, role: 'hub', docs: [] });
    fake.hubInboxes.set(1, []);

    fake.addTab({ id: 2, windowId: 7, index: 1, active: true });
    expect(await hub.claimPdfHub({ docs: [doc(B, '#page=2')], canGoBack: false }, fake.sender(2)))
      .toEqual({ success: true, role: 'forwarded', dispose: 'close' });
    expect(fake.hubInboxes.get(1)).toEqual([{ docs: [doc(B, '#page=2')], activate: true }]);
    expect(fake.tabs.get(1)?.active).toBe(true);

    // A background-opened PDF joins quietly; the hub is not brought forward.
    fake.tabs.get(1)!.active = false;
    fake.addTab({ id: 3, windowId: 7, index: 2, active: false });
    expect(await hub.claimPdfHub({ docs: [doc(LOCAL)], canGoBack: true }, fake.sender(3)))
      .toEqual({ success: true, role: 'forwarded', dispose: 'back' });
    expect(fake.hubInboxes.get(1)?.[1]).toEqual({ docs: [doc(LOCAL)], activate: false });
    expect(fake.tabs.get(1)?.active).toBe(false);
  });

  it('keeps a web tab a web tab: the first PDF opened over a page gets a clean hub tab next to it', async () => {
    fake.addTab({ id: 1, windowId: 7, index: 4, active: true });
    expect(await hub.claimPdfHub({ docs: [doc(A, '#page=3')], canGoBack: true }, fake.sender(1)))
      .toEqual({ success: true, role: 'forwarded', dispose: 'back' });
    const created = [...fake.tabs.values()].find((t) => t.id !== 1)!;
    expect(created).toMatchObject({ windowId: 7, index: 5, active: true });
    expect(hubParts(created.url)).toEqual({ docs: [doc(A, '#page=3')], active: 0 });

    // Another PDF arrives before the new hub page has loaded: it is queued...
    fake.addTab({ id: 2, windowId: 7, index: 6, active: false });
    expect(await hub.claimPdfHub({ docs: [doc(B)], canGoBack: false }, fake.sender(2)))
      .toEqual({ success: true, role: 'forwarded', dispose: 'close' });
    // ...and handed over when the hub claims.
    expect(await hub.claimPdfHub({ docs: [doc(A, '#page=3')], canGoBack: false }, fake.sender(created.id)))
      .toEqual({ success: true, role: 'hub', docs: [doc(B)] });
  });

  it('elects exactly one hub when several PDFs open at once', async () => {
    for (const id of [1, 2, 3, 4]) fake.addTab({ id, windowId: 7, index: id, active: id === 4 });
    const results = await Promise.all([1, 2, 3, 4].map((id) =>
      hub.claimPdfHub({ docs: [doc(`https://a.org/${id}.pdf`)], canGoBack: false }, fake.sender(id)).then((result) => {
        if (result.success && result.role === 'hub') fake.hubInboxes.set(id, []);
        return result;
      })));
    expect(results.filter((r) => r.success && r.role === 'hub')).toHaveLength(1);
    expect(results.filter((r) => r.success && r.role === 'forwarded')).toHaveLength(3);
    const [hubId] = [...fake.hubInboxes.keys()];
    expect(fake.hubInboxes.get(hubId)?.flatMap((m) => m.docs.map((d) => d.url))).toHaveLength(3);
  });

  it('keeps one hub per window and replaces a hub that stopped answering', async () => {
    fake.addTab({ id: 1, windowId: 7, index: 0, active: true });
    fake.addTab({ id: 2, windowId: 8, index: 0, active: true });
    expect((await hub.claimPdfHub({ docs: [doc(A)], canGoBack: false }, fake.sender(1)))).toMatchObject({ role: 'hub' });
    expect((await hub.claimPdfHub({ docs: [doc(B)], canGoBack: false }, fake.sender(2)))).toMatchObject({ role: 'hub' });

    // Tab 1 is still open but its hub page is gone (no inbox): tab 3 takes over.
    fake.addTab({ id: 3, windowId: 7, index: 1, active: true });
    expect((await hub.claimPdfHub({ docs: [doc(LOCAL)], canGoBack: false }, fake.sender(3)))).toMatchObject({ role: 'hub' });

    // A closed hub is forgotten too.
    fake.tabs.delete(2);
    fake.addTab({ id: 4, windowId: 8, index: 0, active: true });
    expect((await hub.claimPdfHub({ docs: [doc(A)], canGoBack: false }, fake.sender(4)))).toMatchObject({ role: 'hub' });
  });

  it('refuses claims from frames and tab-less senders', async () => {
    fake.addTab({ id: 1, windowId: 7, index: 0, active: true });
    const framed = { ...fake.sender(1), frameId: 3 } as chrome.runtime.MessageSender;
    expect(await hub.claimPdfHub({ docs: [doc(A)], canGoBack: false }, framed)).toMatchObject({ success: false });
    expect(await hub.claimPdfHub({ docs: [doc(A)], canGoBack: false }, { id: 'abc' })).toMatchObject({ success: false });
  });
});
