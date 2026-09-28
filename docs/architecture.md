# Architecture

ResearchPDF is a Chrome extension: the bundled PDF.js viewer, drawings and
highlights that come back when the same paper is reopened, remembered reading
position, the paper strip (venue, citations, references), the PDF hub (one tab
per window holding every open PDF), and Google Drive sync of the drawings and positions. No content script, no
server, no account of its own.

| | |
|---|---|
| build | `npm run build` → `dist/`, `npm run zip` for the store |
| background | `src/background.ts` + `src/background/*` |
| popup | `src/ui/popup.*` |
| hub | `src/ui/pdf-hub.html`, `pdfHub.ts` + `src/background/pdfHub.ts` |
| viewer | `src/ui/pdf-viewer.html`, `pdfViewer.ts`, `pdfViewer/*` |
| sync engine | `src/background/pdfSyncService.ts`, `src/shared/pdfSync.ts` |
| storage | IndexedDB `ResearchPDF` (settings, pdf_annotations, pdf_files / pdf_file_bytes / pdf_urls) + `chrome.storage.local` (reading positions, hub tabs) + `chrome.storage.session` (hub registry) |

## Modules

- `src/background/pdfRouting.ts`: file:// and opt-in web-PDF routing (top-level
  PDFs to the hub, embedded ones to the viewer inline), hub-tab records and
  restore after an extension reload, and their message handlers.
- `src/background/pdfHub.ts`: which tab is each window's hub (see below).
- `src/background/messageDispatcher.ts`: the `onMessage` dispatcher and the
  extension-page sender check.
- `googleAuth.ts`, `googleDriveStore.ts`, `googleDriveAccount.ts`: sign-in,
  the Drive appDataFolder byte store, account pinning.
- `src/shared/threeWayMerge.ts`: record-level 3-way merge.

## PDF hub

Every top-level PDF lands in `pdf-hub.html`, and each window keeps one such
tab: an in-page tab strip over one viewer iframe per document, so papers no
longer scatter across tabs that look like web pages.

- Routing sends the PDF to the hub page **in the tab where it opened**. The
  page claims with the background (`VOCAB_T_PDF_HUB_CLAIM`), which decides
  serially per window: no hub and no history → this tab is the hub; no hub
  but the tab came from a web page → a clean hub tab is created next to it;
  a hub exists → the documents are handed to it (`VOCAB_T_PDF_HUB_OPEN`
  broadcast, or queued while a new hub is still loading). A tab that handed
  its documents over goes back to its page, or closes if it has none. The hub
  is brought forward only when the PDF opened in the foreground.
- The hub's own URL (`?a=<active>&f=<url>&f=…`, via `history.replaceState`)
  is its document list, so reload and Chrome session restore bring every
  document back; `VOCAB_T_PDF_HUB_STATE` records the same list for recreating
  hubs after an extension reload. Local files opened from disk are not
  restorable. Iframes are created the first time a document is shown.
- Viewer ↔ hub talk over same-origin `postMessage` (`shared/pdfHubProtocol.ts`):
  document title, Alt+Shift+←/→ and Alt+W, local files opened inside a
  viewer (they become new hub tabs). "Open in Chrome's viewer" from the hub
  opens a separate tab so the hub's other documents stay.
- A top-level `pdf-viewer.html` (old tabs, bookmarks) redirects into the hub;
  a hub framed by a web page acts as the plain viewer.

## Storage layers

Opening a document reads the nearest layer first and never waits for the
next one:

1. **Local file cache** (`db/pdfFileCache.ts`, policy in
   `shared/pdfCachePolicy.ts`). The bytes of every web PDF this device opened,
   stored once by SHA-256, reached through aliases: each URL (fragment
   dropped) and, for arXiv, the paper id — `arxiv:ID` for versionless URLs
   (all hosts and `.pdf` forms meet there) and `arxiv:IDvN` for versioned
   ones, which never change. A hit renders with no network request. Copies
   are re-checked in the background (conditional GET every 6 h with
   ETag/Last-Modified, a full compare weekly without them, never for
   versioned arXiv); a changed file is stored and the viewer offers the new
   version. A first open streams through PDF.js as before and is stored once
   fully downloaded (one HEAD for validators and the redirect target, which
   becomes another alias). Budget 1 GiB / 400 files, LRU; files over 150 MB
   are not kept. The hub prefetches documents behind other tabs while idle.
   Local `file://` PDFs are not cached. Never synced.
2. **Local state**: reading position (`chrome.storage.local`) and drawings
   (`pdf_annotations`), applied at first render.
3. **Drive sync**: the open pull runs alongside rendering and answers with
   the document ids it changed (`changedPdfDocIds`). Only if the open
   document is among them does the viewer reopen it in place from the bytes
   in memory — silently if the reader has not touched it yet, otherwise
   after asking. An open within 60 s of a successful sync skips Drive. The
   viewer saves a position only after the reader moves, so a restored
   position is never re-stamped "now" and outranks another device's newer one.

## Sync document

`researchpdf-sync-v1.json` (gzip) in the account's Drive appDataFolder,
shape in `src/shared/pdfSync.ts`:

- `docs`: `PdfDocRecord[]`, reading position + zoom per document identity.
  Newest `updatedAt` wins per document.
- `annotations`: `PdfAnnotationCache[]`, the drawings PDF.js re-creates.
  Merged per document **and per drawing** (`mergeAnnotationCaches`): both
  devices' strokes on one paper survive; a stroke erased on one side is
  removed everywhere once a base exists; a stroke edited on both sides keeps
  the local copy. Presence of a document's cache is decided 3-way too, so
  erasing everything on one device wins over an unchanged peer.
- The merged set is bounded exactly like local storage (300 documents /
  180 days for positions, 200 documents for drawings), so every device
  converges on the same set. Known edge: beyond those bounds a device's
  pruning is indistinguishable from a deletion.

The PDF files themselves are never uploaded. Paper-strip lookups and settings
stay on the device.

## When it syncs

- Alarm every 15 minutes (`researchpdf-sync`) and at browser start.
- **Opening a document:** the viewer sends `VOCAB_T_PDF_SYNC_HINT {reason:'open'}`
  as the load starts and renders without waiting; see "Storage layers" for
  how a pull that changed the document is applied. When nothing changed on
  either side this is one metadata request, and none within 60 s of a sync.
- **After a stored edit:** `{reason:'edit'}` schedules one coalesced push 30 s
  later (`researchpdf-sync-soon`).

## Concurrency

- The background applies the merged snapshot per record and only where the
  local record is still the one it exported; a record the viewer changed
  meanwhile is skipped and reported as pending, with the stored base for that
  record set to the pre-merge row so the next merge has the right ancestor.
  Annotation rows and sync state commit in one IndexedDB transaction.
- The viewer's `AnnotationCache.snapshot()` re-reads the stored cache before
  writing. If sync changed it since the page last touched it, the page merges
  3-way against what it last saw and keeps the outside drawings as "foreign"
  entries carried by every later snapshot, so the editor's ignorance of them
  is never read as the user erasing them. Outside drawings become visible on
  the next open of that document, not live.

## Setup and store

Google Cloud setup is in `docs/google-drive-sync.md`. `docs/` is also the
public site (homepage, privacy policy, terms) served by GitHub Pages; the OAuth
consent screen and the Web Store listing link to it.
