# Architecture

ResearchPDF is a Chrome extension: the bundled PDF.js viewer, drawings and
highlights that come back when the same paper is reopened, remembered reading
position, the paper strip (venue, citations, references), viewer-tab restore,
and Google Drive sync of the drawings and positions. No content script, no
server, no account of its own.

| | |
|---|---|
| build | `npm run build` → `dist/`, `npm run zip` for the store |
| background | `src/background.ts` + `src/background/*` |
| popup | `src/ui/popup.*` |
| viewer | `src/ui/pdf-viewer.html`, `pdfViewer.ts`, `pdfViewer/*` |
| sync engine | `src/background/pdfSyncService.ts`, `src/shared/pdfSync.ts` |
| storage | IndexedDB `ResearchPDF` (settings, pdf_annotations) + `chrome.storage.local` (reading positions, viewer tabs) |

## Modules

- `src/background/pdfRouting.ts`: file:// and opt-in web-PDF routing to the
  viewer, viewer-tab records and restore, and their message handlers.
- `src/background/messageDispatcher.ts`: the `onMessage` dispatcher and the
  extension-page sender check.
- `googleAuth.ts`, `googleDriveStore.ts`, `googleDriveAccount.ts`: sign-in,
  the Drive appDataFolder byte store, account pinning.
- `src/shared/threeWayMerge.ts`: record-level 3-way merge.

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
  as the load starts and waits (bounded, 8 s) for the pull before it reads the
  position and drawings, so another device's work is what comes back. When
  nothing changed on either side this is one metadata request.
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
