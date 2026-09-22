// ─── PDF viewer routing (pure) ───
//
// Chrome renders PDFs inside its own privileged viewer (a MimeHandlerView
// guest) where content scripts can never run, even with "Allow access to file
// URLs" enabled. ResearchPDF therefore re-points PDF navigations at its bundled
// PDF.js page (`pdf-viewer.html`), which can keep drawings and reading position.
//
// Two sources reach the viewer:
//   • local files  — `file:///…pdf`; the background's webNavigation listener
//     redirects by URL suffix (requires the file-URL access toggle).
//   • web PDFs     — `http(s)://…`; a declarativeNetRequest rule redirects any
//     main-frame response whose `content-type` is `application/pdf`, so
//     extension-less URLs (arXiv, journal download links) are covered too.
//     Requires the opt-in web-PDF setting AND granted optional host access,
//     because the viewer page must fetch the bytes cross-origin.
//
// Everything here is DOM- and chrome-API-free so the routing decisions are
// unit-testable. The background service worker owns the actual listeners.

export const PDF_VIEWER_PAGE = 'pdf-viewer.html';
export const PDF_VIEWER_FILE_PARAM = 'file';

// Optional host patterns the web-PDF route needs (the viewer fetches the PDF
// bytes from an extension page, which is CORS-exempt only with host access).
export const WEB_PDF_HOST_ORIGINS = ['https://*/*', 'http://*/*'] as const;

// Dynamic declarativeNetRequest rule ids for the web-PDF redirect (see
// buildWebPdfRedirectRules). Fixed so sync can always remove-then-add.
export const WEB_PDF_REDIRECT_RULE_IDS = [1, 2, 3] as const;

// Viewer URL length guard: the source URL travels inside a query string.
const PDF_SOURCE_URL_MAX_CHARS = 4_096;

function parseUrl(candidate: string): URL | null {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > PDF_SOURCE_URL_MAX_CHARS) {
    return null;
  }
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

/**
 * True for a top-level `file:` URL whose path ends in `.pdf` (case-insensitive,
 * fragment/query ignored). Directory listings, HTML files, and non-file schemes
 * are never candidates.
 */
export function isLocalPdfUrl(candidate: string): boolean {
  const parsed = parseUrl(candidate);
  return !!parsed && parsed.protocol === 'file:' && /\.pdf$/iu.test(parsed.pathname);
}

/**
 * True for an `http:`/`https:` URL whose path ends in `.pdf`. This is the
 * fast webNavigation fallback: Chrome only starts honoring response-header
 * *value* conditions in declarativeNetRequest rules ~20 s after startup, so
 * suffix-obvious PDFs are routed immediately by URL instead.
 */
export function isWebPdfSuffixUrl(candidate: string): boolean {
  const parsed = parseUrl(candidate);
  return !!parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:') && /\.pdf$/iu.test(parsed.pathname);
}

/** True for an `http:`/`https:` URL (any path — content type decides, not the suffix). */
export function isWebPdfSourceUrl(candidate: string): boolean {
  const parsed = parseUrl(candidate);
  return !!parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
}

/** A URL the viewer page may load: local PDF or any http(s) URL. */
export function isPdfViewerSourceUrl(candidate: string): boolean {
  return isLocalPdfUrl(candidate) || isWebPdfSourceUrl(candidate);
}

/**
 * Builds the viewer page URL for a PDF source. The source's own fragment (e.g.
 * `#page=3`) is preserved on the viewer URL so PDF.js can honor it.
 */
export function buildPdfViewerUrl(sourceUrl: string, viewerBaseUrl: string): string {
  const parsed = new URL(sourceUrl);
  const hash = parsed.hash;
  parsed.hash = '';
  const params = new URLSearchParams();
  params.set(PDF_VIEWER_FILE_PARAM, parsed.href);
  return `${viewerBaseUrl}?${params.toString()}${hash}`;
}

/**
 * Reads the `file` query parameter of a viewer page URL and returns the PDF
 * source URL, or null when the parameter is missing or not an allowed scheme.
 *
 * The value may be percent-encoded (our own `buildPdfViewerUrl`) or raw (the
 * declarativeNetRequest `regexSubstitution` inserts the matched URL verbatim,
 * `&`/`?` included), so the parameter is read as "everything after `?file=`",
 * never via URLSearchParams — a raw `https://a/b?x=1&y=2` must survive intact.
 */
export function parsePdfViewerFile(search: string): string | null {
  const prefix = `?${PDF_VIEWER_FILE_PARAM}=`;
  if (typeof search !== 'string' || !search.startsWith(prefix)) return null;
  const raw = search.slice(prefix.length);
  if (!raw) return null;
  let candidate = raw;
  if (!/^(?:file|https?):/iu.test(raw)) {
    try {
      candidate = decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  if (!isPdfViewerSourceUrl(candidate)) return null;
  const parsed = new URL(candidate);
  parsed.hash = '';
  return parsed.href;
}

/** Human-readable name for titles/badges: last path segment (decoded) or the host. */
export function pdfDisplayName(sourceUrl: string): string {
  const parsed = parseUrl(sourceUrl);
  if (!parsed) return 'PDF';
  const last = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
  let decoded = '';
  try {
    decoded = decodeURIComponent(last);
  } catch {
    decoded = last;
  }
  return decoded || parsed.host || 'PDF';
}

/**
 * If `url` is our own viewer page carrying an http(s) source, returns that
 * source URL; otherwise null. Used by the sender trust boundary so a web PDF
 * read through the viewer still records its real origin as the source.
 */
export function extractWebPdfSourceFromViewerUrl(url: string): string | null {
  const parsed = parseUrl(url);
  if (!parsed || parsed.protocol !== 'chrome-extension:' || parsed.pathname !== `/${PDF_VIEWER_PAGE}`) return null;
  const source = parsePdfViewerFile(parsed.search);
  return source && isWebPdfSourceUrl(source) ? source : null;
}

// ─── declarativeNetRequest rules (Chrome ≥ 128 for response-header matching) ───

export interface WebPdfRedirectRule {
  id: number;
  priority: number;
  action: { type: 'redirect'; redirect: { regexSubstitution: string } };
  condition: {
    regexFilter: string;
    isUrlFilterCaseSensitive: false;
    resourceTypes: Array<'main_frame' | 'sub_frame' | 'object'>;
    excludedRequestMethods: ['post'];
    responseHeaders?: Array<{ header: string; values: string[] }>;
    excludedResponseHeaders: Array<{ header: string; values: string[] }>;
  };
}

// Every frame kind Chrome would hand to its PDF plugin: top-level tabs,
// iframes, and <embed>/<object> (which happily display an HTML document, so
// the redirected viewer renders inline where the PDF was embedded).
const PDF_RESOURCE_TYPES: WebPdfRedirectRule['condition']['resourceTypes'] = ['main_frame', 'sub_frame', 'object'];

// Content types Chrome's viewer (or common servers) label PDFs with. Header
// value patterns are glob-like (`*`) and case-insensitive.
export const PDF_CONTENT_TYPE_PATTERNS = [
  'application/pdf*',
  'application/x-pdf*',
  'application/acrobat*',
  'application/vnd.pdf*',
  'applications/vnd.pdf*',
  'text/pdf*',
  'text/x-pdf*',
];

// Explicit downloads stay downloads.
const NOT_ATTACHMENT = { header: 'content-disposition', values: ['attachment*'] };

/**
 * Redirects any http(s) PDF response to the viewer, mirroring the cases
 * Chrome itself would route to its PDF plugin plus the two "obviously a PDF"
 * shapes it would otherwise download:
 *   1. a PDF content type (any URL);
 *   2. `application/octet-stream` whose URL path ends in `.pdf`;
 *   3. `Content-Disposition: inline; filename=…pdf` with a non-text/media type.
 * POST results are never redirected (the viewer could not replay them) and
 * attachments keep Chrome's download behavior. Host access is enforced by
 * Chrome: with `declarativeNetRequestWithHostAccess` the rules only fire on
 * origins the user granted.
 */
export function buildWebPdfRedirectRules(viewerBaseUrl: string): WebPdfRedirectRule[] {
  const action: WebPdfRedirectRule['action'] = {
    type: 'redirect',
    // `\0` is the whole matched request URL, inserted verbatim.
    redirect: { regexSubstitution: `${viewerBaseUrl}?${PDF_VIEWER_FILE_PARAM}=\\0` },
  };
  const base = {
    isUrlFilterCaseSensitive: false as const,
    resourceTypes: PDF_RESOURCE_TYPES,
    excludedRequestMethods: ['post'] as ['post'],
  };
  return [
    {
      id: WEB_PDF_REDIRECT_RULE_IDS[0],
      priority: 1,
      action,
      condition: {
        ...base,
        regexFilter: '^https?://.*',
        responseHeaders: [{ header: 'content-type', values: PDF_CONTENT_TYPE_PATTERNS }],
        excludedResponseHeaders: [NOT_ATTACHMENT],
      },
    },
    {
      id: WEB_PDF_REDIRECT_RULE_IDS[1],
      priority: 1,
      action,
      condition: {
        ...base,
        regexFilter: '^https?://[^?#]*\\.pdf([?#].*)?$',
        responseHeaders: [{ header: 'content-type', values: ['application/octet-stream*', 'binary/octet-stream*'] }],
        excludedResponseHeaders: [NOT_ATTACHMENT],
      },
    },
    {
      id: WEB_PDF_REDIRECT_RULE_IDS[2],
      priority: 1,
      action,
      condition: {
        ...base,
        regexFilter: '^https?://.*',
        responseHeaders: [{ header: 'content-disposition', values: ['*filename=*.pdf*', '*filename*=*.pdf*'] }],
        excludedResponseHeaders: [
          NOT_ATTACHMENT,
          { header: 'content-type', values: ['text/*', 'image/*', 'video/*', 'audio/*', 'application/json*', 'application/javascript*', 'application/xml*', 'application/xhtml*'] },
        ],
      },
    },
  ];
}
