import { describe, expect, it } from 'vitest';
import {
  PDF_CONTENT_TYPE_PATTERNS,
  WEB_PDF_REDIRECT_RULE_IDS,
  buildPdfViewerUrl,
  buildWebPdfRedirectRules,
  extractWebPdfSourceFromViewerUrl,
  isLocalPdfUrl,
  isPdfViewerSourceUrl,
  isWebPdfSourceUrl,
  isWebPdfSuffixUrl,
  parsePdfViewerFile,
  pdfDisplayName,
} from '../src/shared/localPdf';

const VIEWER = 'chrome-extension://abc/pdf-viewer.html';

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

describe('extractWebPdfSourceFromViewerUrl', () => {
  it('returns the http(s) source carried by our own viewer page URL', () => {
    expect(extractWebPdfSourceFromViewerUrl('chrome-extension://abc/pdf-viewer.html?file=https://a.org/p.pdf#page=2'))
      .toBe('https://a.org/p.pdf');
    expect(extractWebPdfSourceFromViewerUrl(`${VIEWER}?file=https%3A%2F%2Fa.org%2Fget%3Fid%3D1%26v%3D2`))
      .toBe('https://a.org/get?id=1&v=2');
  });

  it('returns null for local sources, other extension pages, and web pages', () => {
    expect(extractWebPdfSourceFromViewerUrl(`${VIEWER}?file=file%3A%2F%2F%2Fhome%2Fme%2Fp.pdf`)).toBeNull();
    expect(extractWebPdfSourceFromViewerUrl('chrome-extension://abc/popup.html?file=https://a.org/p.pdf')).toBeNull();
    expect(extractWebPdfSourceFromViewerUrl('https://a.org/pdf-viewer.html?file=https://b.org/p.pdf')).toBeNull();
    expect(extractWebPdfSourceFromViewerUrl('')).toBeNull();
  });
});

describe('buildWebPdfRedirectRules', () => {
  it('covers PDF content types, octet-stream .pdf URLs, and inline .pdf dispositions in every frame kind', () => {
    const rules = buildWebPdfRedirectRules(VIEWER);
    expect(rules.map((r) => r.id)).toEqual([...WEB_PDF_REDIRECT_RULE_IDS]);
    for (const rule of rules) {
      expect(rule.action).toEqual({ type: 'redirect', redirect: { regexSubstitution: `${VIEWER}?file=\\0` } });
      expect(rule.condition.resourceTypes).toEqual(['main_frame', 'sub_frame', 'object']);
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
      { header: 'content-disposition', values: ['*filename=*.pdf*', '*filename*=*.pdf*'] },
    ]);
    expect(byDisposition.condition.excludedResponseHeaders).toContainEqual(
      expect.objectContaining({ header: 'content-type', values: expect.arrayContaining(['text/*', 'image/*']) }),
    );
  });
});
