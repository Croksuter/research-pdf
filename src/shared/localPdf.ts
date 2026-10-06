// ─── PDF viewer routing (pure) ───
//
// Chrome renders PDFs inside its own privileged viewer (a MimeHandlerView
// guest) where content scripts can never run, even with "Allow access to file
// URLs" enabled. ResearchPDF therefore re-points PDF navigations at its bundled
// PDF.js page (`pdf-viewer.html`), which can keep drawings and reading position.
//
// Two sources reach the viewer (top-level ones via the PDF hub, see
// PDF_HUB_PAGE below):
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
// One tab per window that collects every top-level PDF (see ui/pdfHub.ts).
export const PDF_HUB_PAGE = 'pdf-hub.html';

// Optional host patterns the web-PDF route needs (the viewer fetches the PDF
// bytes from an extension page, which is CORS-exempt only with host access).
export const WEB_PDF_HOST_ORIGINS = ['https://*/*', 'http://*/*'] as const;

// Dynamic declarativeNetRequest rule ids for the web-PDF redirect (see
// buildWebPdfRedirectRules). Fixed so sync can always remove-then-add.
// Ids 1–3 send top-level PDFs to the hub, 4–6 embedded ones to the viewer.
export const WEB_PDF_REDIRECT_RULE_IDS = [1, 2, 3, 4, 5, 6] as const;

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

// ─── PDF hub URL ───
//
// The hub page's own URL is the durable list of its documents, so Chrome's
// session restore, a reload, and the extension-reload restore all bring back
// every document. Two shapes:
//   • `?file=<url>#<hash>` — one document, exactly like the viewer (the
//     routing redirect and the declarativeNetRequest rule produce this);
//   • `?a=<active>&f=<url>&f=<url>…` — the canonical multi-document form the
//     hub rewrites itself to with history.replaceState. `s=home` or
//     `s=<url>` says the home page or a pinned document (whose tabs come
//     from the project, not from this list) was in front instead, and
//     `p=<id>` names the project the hub holds (shared/pdfProjects.ts); a
//     hub URL without one is routed to a project by the background.

export interface PdfHubDoc {
  url: string;
  /** Source fragment such as `#page=3`, or ''. Only meaningful on first open. */
  hash: string;
}

export const PDF_HUB_MAX_DOCS = 50;
const PDF_HUB_ACTIVE_PARAM = 'a';
const PDF_HUB_FILES_PARAM = 'f';
const PDF_HUB_SHOW_PARAM = 's';
const PDF_HUB_PROJECT_PARAM = 'p';
const PROJECT_PARAM_PATTERN = /^[a-z0-9_-]{1,40}$/u;
export const PDF_HUB_SHOW_HOME = 'home';
/** The hub's settings page in front (`s=settings`). */
export const PDF_HUB_SHOW_SETTINGS = 'settings';
const isHubPage = (value: unknown): value is string => value === PDF_HUB_SHOW_HOME || value === PDF_HUB_SHOW_SETTINGS;

function sourceOnly(candidate: string): string | null {
  if (!isPdfViewerSourceUrl(candidate)) return null;
  const parsed = new URL(candidate);
  parsed.hash = '';
  return parsed.href;
}

/** Hub URL for a single entering document (keeps the source fragment). */
export function buildPdfHubEntryUrl(sourceUrl: string, hubBaseUrl: string): string {
  return buildPdfViewerUrl(sourceUrl, hubBaseUrl);
}

/**
 * Canonical hub URL for a document list; fragments are not persisted. `show`
 * is `PDF_HUB_SHOW_HOME`, `PDF_HUB_SHOW_SETTINGS`, or the source URL of a
 * pinned document in front.
 */
export function buildPdfHubUrl(urls: readonly string[], active: number, hubBaseUrl: string, show: string | null = null, project: string | null = null): string {
  const files = urls.map(sourceOnly).filter((url): url is string => url !== null).slice(0, PDF_HUB_MAX_DOCS);
  const shown = isHubPage(show) ? show : show ? sourceOnly(show) : null;
  const projectId = project && PROJECT_PARAM_PATTERN.test(project) ? project : null;
  if (files.length === 0 && (shown === null || shown === PDF_HUB_SHOW_HOME) && !projectId) return hubBaseUrl;
  const params = new URLSearchParams();
  if (projectId) params.set(PDF_HUB_PROJECT_PARAM, projectId);
  if (files.length) params.set(PDF_HUB_ACTIVE_PARAM, String(Math.min(Math.max(0, Math.trunc(active) || 0), files.length - 1)));
  if (shown) params.set(PDF_HUB_SHOW_PARAM, shown);
  for (const file of files) params.append(PDF_HUB_FILES_PARAM, file);
  return `${hubBaseUrl}?${params.toString()}`;
}

/** Reads a hub page's `location.search` + `location.hash` back into documents. */
export function parsePdfHubUrl(search: string, hash: string): { docs: PdfHubDoc[]; active: number; show: string | null; project: string | null } {
  const entry = parsePdfViewerFile(search);
  if (entry) return { docs: [{ url: entry, hash: typeof hash === 'string' && hash.startsWith('#') ? hash : '' }], active: 0, show: null, project: null };
  if (typeof search !== 'string' || !search.startsWith('?')) return { docs: [], active: 0, show: null, project: null };
  const params = new URLSearchParams(search);
  const seen = new Set<string>();
  const docs: PdfHubDoc[] = [];
  for (const raw of params.getAll(PDF_HUB_FILES_PARAM)) {
    const url = sourceOnly(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    docs.push({ url, hash: '' });
    if (docs.length >= PDF_HUB_MAX_DOCS) break;
  }
  const active = Number.parseInt(params.get(PDF_HUB_ACTIVE_PARAM) ?? '0', 10);
  const rawShow = params.get(PDF_HUB_SHOW_PARAM);
  const show = isHubPage(rawShow) ? rawShow : rawShow ? sourceOnly(rawShow) : null;
  const rawProject = params.get(PDF_HUB_PROJECT_PARAM);
  const project = rawProject && PROJECT_PARAM_PATTERN.test(rawProject) ? rawProject : null;
  return { docs, active: Number.isInteger(active) && active >= 0 && active < docs.length ? active : 0, show, project };
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

// Top-level PDFs go to the hub (one tab per window); iframes and
// <embed>/<object> (which happily display an HTML document) get the viewer
// inline where the PDF was embedded.
const TOP_LEVEL_TYPES: WebPdfRedirectRule['condition']['resourceTypes'] = ['main_frame'];
const EMBEDDED_TYPES: WebPdfRedirectRule['condition']['resourceTypes'] = ['sub_frame', 'object'];

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
export function buildWebPdfRedirectRules(viewerBaseUrl: string, hubBaseUrl: string): WebPdfRedirectRule[] {
  return [
    ...pdfRedirectRuleSet(hubBaseUrl, TOP_LEVEL_TYPES, WEB_PDF_REDIRECT_RULE_IDS.slice(0, 3)),
    ...pdfRedirectRuleSet(viewerBaseUrl, EMBEDDED_TYPES, WEB_PDF_REDIRECT_RULE_IDS.slice(3, 6)),
  ];
}

function pdfRedirectRuleSet(
  targetBaseUrl: string,
  resourceTypes: WebPdfRedirectRule['condition']['resourceTypes'],
  ids: readonly number[],
): WebPdfRedirectRule[] {
  const action: WebPdfRedirectRule['action'] = {
    type: 'redirect',
    // `\0` is the whole matched request URL, inserted verbatim.
    redirect: { regexSubstitution: `${targetBaseUrl}?${PDF_VIEWER_FILE_PARAM}=\\0` },
  };
  const base = {
    isUrlFilterCaseSensitive: false as const,
    resourceTypes,
    excludedRequestMethods: ['post'] as ['post'],
  };
  return [
    {
      id: ids[0],
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
      id: ids[1],
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
      id: ids[2],
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
