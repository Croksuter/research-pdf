import { describe, expect, it } from 'vitest';
import {
  PDF_CONTENT_TYPE_PATTERNS,
  PDF_FILENAME_DISPOSITION_PATTERNS,
  WEB_PDF_NATIVE_EXEMPT_RULE_IDS,
  WEB_PDF_REDIRECT_RULE_IDS,
  buildPdfViewerUrl,
  buildWebPdfNativeExemptRules,
  buildWebPdfRedirectRules,
  isLocalPdfUrl,
  isPdfViewerSourceUrl,
  isWebPdfSourceUrl,
  isWebPdfSuffixUrl,
  parsePdfViewerFile,
  pdfDisplayName,
} from '../src/shared/localPdf';

const VIEWER = 'chrome-extension://abc/pdf-viewer.html';
const HUB = 'chrome-extension://abc/pdf-hub.html';

describe('isLocalPdfUrl', () => {
  it('accepts file: URLs whose path ends in .pdf regardless of case, query, or fragment', () => {
    expect(isLocalPdfUrl('file:///home/me/paper.pdf')).toBe(true);
    expect(isLocalPdfUrl('file:///C:/Docs/Paper.PDF')).toBe(true);
    expect(isLocalPdfUrl('file:///home/me/paper.pdf#page=3')).toBe(true);
    expect(isLocalPdfUrl('file:///home/me/a%20b.pdf?x=1')).toBe(true);
  });

  it('rejects non-file schemes, non-PDF paths, and garbage', () => {
    expect(isLocalPdfUrl('https://example.com/paper.pdf')).toBe(false);
    expect(isLocalPdfUrl('chrome-extension://abc/pdf-viewer.html?file=file:///x.pdf')).toBe(false);
    expect(isLocalPdfUrl('file:///home/me/')).toBe(false);
    expect(isLocalPdfUrl('file:///home/me/notes.pdf.html')).toBe(false);
    expect(isLocalPdfUrl('file:///home/me/paper.pdfx')).toBe(false);
    expect(isLocalPdfUrl('')).toBe(false);
    expect(isLocalPdfUrl('not a url')).toBe(false);
    expect(isLocalPdfUrl(`file:///${'a'.repeat(5000)}.pdf`)).toBe(false);
  });
});

describe('isWebPdfSuffixUrl', () => {
  it('accepts http(s) URLs whose path ends in .pdf and nothing else', () => {
    expect(isWebPdfSuffixUrl('https://example.com/paper.pdf')).toBe(true);
    expect(isWebPdfSuffixUrl('http://intranet/Report.PDF?dl=1#page=2')).toBe(true);
    expect(isWebPdfSuffixUrl('https://arxiv.org/pdf/2401.12345')).toBe(false);
    expect(isWebPdfSuffixUrl('https://example.com/get?file=x.pdf')).toBe(false);
    expect(isWebPdfSuffixUrl('file:///home/me/paper.pdf')).toBe(false);
  });
});

describe('isWebPdfSourceUrl / isPdfViewerSourceUrl', () => {
  it('accepts any http(s) URL (the content type, not the suffix, decides)', () => {
    expect(isWebPdfSourceUrl('https://arxiv.org/pdf/2401.12345')).toBe(true);
    expect(isWebPdfSourceUrl('http://intranet.local/report?id=7&v=2')).toBe(true);
    expect(isPdfViewerSourceUrl('https://example.com/x.pdf')).toBe(true);
    expect(isPdfViewerSourceUrl('file:///home/me/paper.pdf')).toBe(true);
  });

  it('rejects other schemes', () => {
    expect(isWebPdfSourceUrl('file:///home/me/paper.pdf')).toBe(false);
    expect(isWebPdfSourceUrl('chrome-extension://abc/pdf-viewer.html')).toBe(false);
    expect(isWebPdfSourceUrl('javascript:alert(1)')).toBe(false);
    expect(isPdfViewerSourceUrl('file:///etc/passwd')).toBe(false);
    expect(isPdfViewerSourceUrl('ftp://host/x.pdf')).toBe(false);
  });
});

describe('buildPdfViewerUrl / parsePdfViewerFile', () => {
  it('round-trips a local file through the viewer query string and keeps the PDF fragment', () => {
    const viewerUrl = buildPdfViewerUrl('file:///home/me/a%20b.pdf#page=3', VIEWER);
    expect(viewerUrl).toBe(`${VIEWER}?file=file%3A%2F%2F%2Fhome%2Fme%2Fa%2520b.pdf#page=3`);
    const url = new URL(viewerUrl);
    expect(parsePdfViewerFile(url.search)).toBe('file:///home/me/a%20b.pdf');
  });

  it('round-trips a web URL with its query string intact', () => {
    const source = 'https://example.com/get?id=7&format=pdf';
    const viewerUrl = buildPdfViewerUrl(`${source}#zoom=200`, VIEWER);
    expect(new URL(viewerUrl).hash).toBe('#zoom=200');
    expect(parsePdfViewerFile(new URL(viewerUrl).search)).toBe(source);
  });

  it('accepts the raw (unencoded) URL the declarativeNetRequest substitution inserts', () => {
    // `regexSubstitution` pastes the matched URL verbatim, so `&` must not split it.
    expect(parsePdfViewerFile('?file=https://example.com/get?id=7&format=pdf'))
      .toBe('https://example.com/get?id=7&format=pdf');
    expect(parsePdfViewerFile('?file=http://127.0.0.1:8080/paper')).toBe('http://127.0.0.1:8080/paper');
  });

  it('refuses unsupported schemes, non-PDF local paths, malformed encodings, and other params', () => {
    expect(parsePdfViewerFile('?file=file%3A%2F%2F%2Fetc%2Fpasswd')).toBeNull();
    expect(parsePdfViewerFile('?file=chrome-extension%3A%2F%2Fabc%2Fpopup.html')).toBeNull();
    expect(parsePdfViewerFile('?file=javascript%3Aalert(1)')).toBeNull();
    expect(parsePdfViewerFile('?file=%E0%A4%A')).toBeNull();
    expect(parsePdfViewerFile('?file=')).toBeNull();
    expect(parsePdfViewerFile('?other=1&file=https%3A%2F%2Fexample.com%2Fx.pdf')).toBeNull();
    expect(parsePdfViewerFile('')).toBeNull();
  });
});

describe('pdfDisplayName', () => {
  it('returns the decoded last path segment, or the host for bare origins', () => {
    expect(pdfDisplayName('file:///home/me/my%20paper.pdf')).toBe('my paper.pdf');
    expect(pdfDisplayName('file:///C:/Docs/Paper.PDF')).toBe('Paper.PDF');
    expect(pdfDisplayName('https://arxiv.org/pdf/2401.12345')).toBe('2401.12345');
    expect(pdfDisplayName('https://example.com/')).toBe('example.com');
  });

  it('falls back to a generic label', () => {
    expect(pdfDisplayName('nonsense')).toBe('PDF');
  });
});

describe('buildWebPdfRedirectRules', () => {
  it('covers PDF content types, octet-stream .pdf URLs, and inline .pdf dispositions', () => {
    const rules = buildWebPdfRedirectRules(VIEWER, HUB);
    expect(rules.map((r) => r.id)).toEqual([...WEB_PDF_REDIRECT_RULE_IDS]);
    for (const rule of rules) {
      expect(rule.condition.excludedRequestMethods).toEqual(['post']);
      expect(rule.condition.isUrlFilterCaseSensitive).toBe(false);
      expect(rule.condition.excludedResponseHeaders).toContainEqual({ header: 'content-disposition', values: ['attachment*'] });
    }
    const [byType, byOctetSuffix, byDisposition] = rules;
    expect(byType.condition.regexFilter).toBe('^https?://.*');
    expect(byType.condition.responseHeaders).toEqual([{ header: 'content-type', values: PDF_CONTENT_TYPE_PATTERNS }]);
    expect(PDF_CONTENT_TYPE_PATTERNS).toEqual(expect.arrayContaining(['application/pdf*', 'application/x-pdf*', 'text/pdf*']));

    const suffix = new RegExp(byOctetSuffix.condition.regexFilter, 'iu');
    expect(suffix.test('https://a.org/files/paper.pdf')).toBe(true);
    expect(suffix.test('https://a.org/files/paper.PDF?dl=1#p=2')).toBe(true);
    expect(suffix.test('https://a.org/files/paper.pdf.html')).toBe(false);
    expect(suffix.test('https://a.org/get?name=x.pdf')).toBe(false);
    expect(byOctetSuffix.condition.responseHeaders?.[0].values).toContain('application/octet-stream*');

    expect(byDisposition.condition.responseHeaders).toEqual([
      { header: 'content-disposition', values: PDF_FILENAME_DISPOSITION_PATTERNS },
    ]);
    expect(byDisposition.condition.excludedResponseHeaders).toContainEqual(
      expect.objectContaining({ header: 'content-type', values: expect.arrayContaining(['text/*', 'image/*']) }),
    );
  });

  it('matches a .pdf file name in Content-Disposition only at the end of the name', () => {
    // Chrome's header value patterns: the whole value, case-insensitive, `*` any run, `?` zero or one character.
    const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*').replace(/\?/gu, '.?')}$`, 'iu');
    const matches = (value: string) => PDF_FILENAME_DISPOSITION_PATTERNS.some((p) => glob(p).test(value));
    for (const value of ['inline; filename=paper.pdf', 'inline; filename="paper.PDF"', 'inline; filename="a b.pdf"; size=3',
      "inline; filename*=UTF-8''%EB%85%BC%EB%AC%B8.pdf", 'inline;filename=paper.pdf;foo=bar', 'inline; filename="x.pdf" ; creation-date=1']) {
      expect(matches(value), value).toBe(true);
    }
    for (const value of ['inline; filename=paper.pdf.zip', 'inline; filename="paper.pdf.html"', 'inline; filename=paper.pdfx', 'inline']) {
      expect(matches(value), value).toBe(false);
    }
  });

  it('sends top-level PDFs to the hub and embedded ones to the inline viewer, with identical conditions', () => {
    const rules = buildWebPdfRedirectRules(VIEWER, HUB);
    const topLevel = rules.slice(0, 3);
    const embedded = rules.slice(3);
    for (const rule of topLevel) {
      expect(rule.action).toEqual({ type: 'redirect', redirect: { regexSubstitution: `${HUB}?file=\\0` } });
      expect(rule.condition.resourceTypes).toEqual(['main_frame']);
    }
    for (const rule of embedded) {
      expect(rule.action).toEqual({ type: 'redirect', redirect: { regexSubstitution: `${VIEWER}?file=\\0` } });
      expect(rule.condition.resourceTypes).toEqual(['sub_frame', 'object']);
    }
    const strip = ({ id: _id, action: _action, condition: { resourceTypes: _types, ...rest } }: typeof rules[number]) => rest;
    expect(embedded.map(strip)).toEqual(topLevel.map(strip));
  });
});

describe('native-viewer exemption', () => {
  it('allows only the named tabs\' top-level navigations, above the redirect rules', () => {
    expect(buildWebPdfNativeExemptRules([])).toEqual([]);
    const rules = buildWebPdfNativeExemptRules([7, 9]);
    expect(rules.map((r) => r.id)).toEqual([...WEB_PDF_NATIVE_EXEMPT_RULE_IDS]);
    const redirectPriority = Math.max(...buildWebPdfRedirectRules(VIEWER, HUB).map((r) => r.priority));
    for (const rule of rules) {
      expect(rule.action).toEqual({ type: 'allow' });
      expect(rule.priority).toBeGreaterThan(redirectPriority);
      expect(rule.condition.tabIds).toEqual([7, 9]);
      expect(rule.condition.resourceTypes).toEqual(['main_frame']);
    }
    // One decided before the request, one where the redirect rules decide: on the response headers.
    expect(rules[0].condition.responseHeaders).toBeUndefined();
    expect(rules[1].condition.responseHeaders).toEqual([{ header: 'content-type' }]);
    expect(WEB_PDF_NATIVE_EXEMPT_RULE_IDS.some((id) => (WEB_PDF_REDIRECT_RULE_IDS as readonly number[]).includes(id))).toBe(false);
  });
});
