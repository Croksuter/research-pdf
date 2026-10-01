import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchPdf, resolvePdfUrl } from '../src/ui/pdfFileFetch';

const LINK = 'http://www.ctan.org/tex-archive/macros/latex/contrib/IEEEtran/IEEEtran_HOWTO.pdf';
const GOOD_MIRROR = 'https://mirror.kakao.com/CTAN/macros/latex/contrib/IEEEtran/IEEEtran_HOWTO.pdf';
const CHALLENGED_MIRROR = 'https://kr.mirrors.cicku.me/ctan/macros/latex/contrib/IEEEtran/IEEEtran_HOWTO.pdf';
const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\n…');

/** A response as `fetch` returns it after following redirects to `finalUrl`. */
function reply(finalUrl: string, status: number, body: BodyInit | null = null, headers: Record<string, string> = {}): Response {
  const response = new Response(body, { status, headers });
  Object.defineProperty(response, 'url', { value: finalUrl });
  Object.defineProperty(response, 'redirected', { value: finalUrl !== LINK });
  return response;
}

function stubFetch(...responses: Array<Response | Error>) {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolvePdfUrl', () => {
  it('returns the final URL and its validators', async () => {
    const fetchMock = stubFetch(reply(GOOD_MIRROR, 200, null, { etag: '"abc"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' }));
    expect(await resolvePdfUrl(LINK)).toEqual({ finalUrl: GOOD_MIRROR, etag: '"abc"', lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' });
    expect(fetchMock).toHaveBeenCalledWith(LINK, expect.objectContaining({ method: 'HEAD', redirect: 'follow' }));
  });

  it('resolves again when a redirect lands on a server that refuses', async () => {
    const fetchMock = stubFetch(reply(CHALLENGED_MIRROR, 403), reply(GOOD_MIRROR, 200));
    expect((await resolvePdfUrl(LINK)).finalUrl).toBe(GOOD_MIRROR);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retries and falls back to the link itself', async () => {
    const fetchMock = stubFetch(reply(CHALLENGED_MIRROR, 403), reply(CHALLENGED_MIRROR, 403), reply(CHALLENGED_MIRROR, 403));
    expect(await resolvePdfUrl(LINK)).toEqual({ finalUrl: LINK, etag: null, lastModified: null });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry an error that came without a redirect (e.g. HEAD not supported)', async () => {
    const fetchMock = stubFetch(reply(LINK, 405));
    expect((await resolvePdfUrl(LINK)).finalUrl).toBe(LINK);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the link when the request is blocked (no host access)', async () => {
    const fetchMock = stubFetch(new TypeError('Failed to fetch'));
    expect((await resolvePdfUrl(LINK)).finalUrl).toBe(LINK);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('fetchPdf', () => {
  it('retries a redirect that ended in an error', async () => {
    const fetchMock = stubFetch(reply(CHALLENGED_MIRROR, 403, 'challenge'), reply(GOOD_MIRROR, 200, PDF_BYTES));
    const fetched = await fetchPdf(LINK);
    expect(fetched.status).toBe('ok');
    expect(fetched.status === 'ok' && fetched.finalUrl).toBe(GOOD_MIRROR);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a not-modified answer', async () => {
    const fetchMock = stubFetch(reply(GOOD_MIRROR, 304));
    expect((await fetchPdf(LINK, { etag: '"abc"', lastModified: null })).status).toBe('not-modified');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails without retrying an error that came without a redirect', async () => {
    const fetchMock = stubFetch(reply(LINK, 404, 'missing'));
    expect((await fetchPdf(LINK)).status).toBe('failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
