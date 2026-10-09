# Architecture

ResearchPDF is a Chrome extension: the bundled PDF.js viewer, drawings and
highlights that come back when the same paper is reopened, remembered reading
position, the paper strip (venue, citations, references), the PDF hub (one tab
per project holding its open PDFs, with a library of every PDF it showed and
pinned documents), projects, and Google Drive sync of the drawings, positions,
library and projects. No content script, no server, no account of its own.

| | |
|---|---|
| build | `npm run build` → `dist/`, `npm run zip` for the store |
| background | `src/background.ts` + `src/background/*` |
| popup | `src/ui/popup.*`: open the PDF tab, sync at a glance, a nudge when web PDFs are off |
| settings page | `src/ui/settings.*`: shown inside the hub like home (⚙ in the strip, `s=settings`; the popup's 설정 and Chrome's extension options bring a hub forward with it, `VOCAB_T_PDF_SHOW_SETTINGS`), framed and styled with the hub's palette; every setting on one page of cards, with Chrome's site / file-URL access shown next to the switches that need it, API key checks (OpenAlex's remaining daily budget from its `X-RateLimit-*` headers, `shared/apiStatus.ts`), storage use and the shortcuts. The hub keeps the frame, so it refreshes when the hub shows it again (`SETTINGS_SHOWN_MESSAGE`), on visibility/focus, on library/project changes, and polls while a sync runs. Disconnect and clearing saved PDFs ask first; a key is removed only with Remove. Helpers shared with the welcome page and popup are in `ui/pageKit.ts`; the shortcut table is `shared/shortcuts.ts` (README carries the same) |
| hub | `src/ui/pdf-hub.html`, `pdfHub.ts` (entry) + `src/ui/hub/*` (store, tab strip, frames, session, local files, home, panels) + `src/background/pdfHub.ts` |
| viewer | `src/ui/pdf-viewer.html`, `pdfViewer.ts`, `pdfViewer/*` |
| sync engine | `src/background/pdfSyncService.ts`, `src/shared/pdfSync.ts` |
| storage | IndexedDB `ResearchPDF` (settings, pdf_annotations, pdf_files / pdf_file_bytes / pdf_urls) + IndexedDB `ResearchPDF-papers` (paper-lookup cache, `pdfViewer/paperCache.ts`: a week, 600 entries LRU) + `chrome.storage.local` (reading positions, library, projects, hub tabs) + `chrome.storage.session` (hub registry) |

## Modules

- `src/background/pdfRouting.ts`: file:// and opt-in web-PDF routing (top-level
  PDFs to the hub, embedded ones to the viewer inline), hub-tab records and
  restore after an extension update, and their message handlers. Web PDFs
  are routed by the declarativeNetRequest rules (content type, not POST, not
  attachments); a `.pdf` URL is also routed by URL, but only in the first
  minute after the browser starts or the rules are turned on, while Chrome
  does not yet honor the rules' response-header conditions. "Open in
  Chrome's viewer" exempts just that tab with a session `allow` rule
  (`tabIds`, above the redirect rules' priority) until it commits, instead of
  removing the redirect rules.
- `src/background/pdfHub.ts`: which tab is each project's hub, opening a
  project, moving a document (see below). The claim policy, including what a
  closed, discarded or frozen hub means, is the pure `decideHubClaim`.
- `src/background/pdfProjectStore.ts`, `pdfLibraryStore.ts`,
  `pdfDocStateStore.ts`: the only writers of the projects, the library and
  the reading positions, each one read-modify-write at a time
  (`serialQueue.ts`).
- `src/background/messageDispatcher.ts`: the `onMessage` dispatcher and the
  extension-page sender check.
- `googleAuth.ts`, `googleDriveStore.ts`, `googleDriveAccount.ts`: sign-in,
  the Drive appDataFolder byte store, account pinning.
- `src/shared/threeWayMerge.ts`: record-level 3-way merge.

## PDF hub

Every top-level PDF lands in `pdf-hub.html`, and each open project keeps one
such tab: an in-page tab strip over one viewer iframe per document, so papers
no longer scatter across tabs that look like web pages.

- Routing sends the PDF to the hub page **in the tab where it opened**. The
  page claims with the background (`VOCAB_T_PDF_HUB_CLAIM`, with the project
  its URL names or none), which decides serially per project: a PDF entering
  from the web goes to an open project it is registered to, otherwise the
  default project; no hub for that project and no history → this tab is the
  hub; no hub but the tab came from a web page → a clean hub tab is created
  next to it; a hub exists (in any window) → the documents are handed to it
  (`VOCAB_T_PDF_HUB_OPEN` broadcast, or queued while a new hub is still
  loading, discarded by Chrome, or frozen in the background and not answering
  yet — a frozen hub gets the message when it wakes, and the queue covers
  Chrome discarding it first). A tab that handed its documents over goes
  back to its page, or closes if it has none. The hub (and its window) is brought forward only
  when the PDF opened in the foreground. The registry is project → tab, so a
  hub dragged to another window stays that project's hub.
- An embedded PDF gets the viewer inline, unless its frame fills the tab
  (≥ 85 % wide, ≥ 70 % high): a publisher page that only wraps the PDF in an
  iframe (IEEE's stamp.jsp). Then the viewer asks the background
  (`VOCAB_T_PDF_EMBED_PROMOTE`), which navigates the tab to the hub; that
  hub claims in place instead of going back to the wrapper. Each tab promotes
  a given PDF once, so going back to the wrapper shows it inline.
- The hub's own URL (`?p=<project>&a=<active>&f=<url>&f=…`, via
  `history.replaceState`) is its document list, so reload and Chrome session
  restore bring every document back; `VOCAB_T_PDF_HUB_STATE` records the same
  list for recreating hubs after an extension reload, and as the project's
  saved layout. Local files opened from disk have no address: their bytes are
  kept in IndexedDB for the hub tab's session (named per project in
  sessionStorage, dropped when no tab or recently-closed entry refers to
  them), so a reload, a new language, an in-place project switch and
  Chrome's session restore bring them back. Iframes are created the first
  time a document is shown.
- Viewer ↔ hub talk over same-origin `postMessage` (`shared/pdfHubProtocol.ts`):
  document title and identity, Alt+Shift+←/→, Alt+W and Alt+Shift+T (not
  while typing in a text field), local
  files opened inside a viewer (they become new hub tabs), the sleep
  handshake. "Open in Chrome's viewer" from the hub opens a separate tab so
  the hub's other documents stay.
- **Home** (house button left of the tabs, and what an emptied hub shows):
  the project's pinned documents, this hub's recently closed tabs and the
  project's documents (the default project: every document no other project
  has; another project: its documents with −, then the rest of the library
  with + to add), most recent first, with reading progress, a drawings mark
  and search over the whole library. `s=home` in the hub URL keeps it in
  front across a reload.
- **Home tools**: filter chips (kinds, with drawings, reading, unread, with counts; the active one is always shown) and a sort (recent, title, year, progress), remembered per device; rows have a checkbox and "⋯" (open, pin, add to another project, move, remove, kind, copy URL), and a selection — always only rows on screen — gets a bar with the same actions in bulk. Removing from a project is undone with its pin, pin place and open tab.
- **Pins** belong to a project, so a pinned document is a narrow tab at the
  left of that project's hub on every device (loaded only when shown;
  `s=<url>` remembers one in front). Pin/unpin from the tab's context menu,
  the pinned tab's pin button (on hover or focus) or home. Their order is a per-member order key (`pinOrder`, sync v5), set by
  dragging pinned rows on home or pinned tabs in the strip. A pinned tab has an unpin button where others have close; unpinning one this hub never loaded
  because another device unpinned it removes the tab.
- **Recently closed**: a per-hub stack (sessionStorage, 20) with a 5 s undo
  toast and Alt+Shift+T (Ctrl+Shift+T is Chrome's); closing several at once
  ("close other tabs") is one toast whose undo reopens them all. Local files
  reopen too.
- **Same document** (`shared/hubTabs.ts`): an incoming URL goes to the tab
  already showing it — same URL, the same arXiv paper when no version is
  asked for (or exactly the version asked), or the document the library last
  opened from that URL. After loading, a tab whose identity another tab
  already has is merged into it. Two versions of one arXiv paper stay apart
  with `v1` / `최신` badges.
- **Sleep**: at most 6 loaded frames, and none unseen for 30 min. The hub asks
  the frame first (`sleep` → drawings and position stored → `sleep-reply`;
  presenting, printing or a password prompt refuse for 5 min), then removes
  it; the tab stays and reloads from the local file cache when shown. A
  closed tab leaves the strip at once, and its frame goes after the same
  handshake.
- **Overflow**: tabs shrink to 112 px, then scroll (wheel works, edges fade);
  the ▾ button lists every tab and the recently closed ones, with search.
- A top-level `pdf-viewer.html` (old tabs, bookmarks) redirects into the hub;
  a hub framed by a web page acts as the plain viewer.

## First run

`background/onboarding.ts` opens `welcome.html` (`ui/welcome.ts`) on a fresh
install, never on updates; the settings page links to it again. Six steps,
each skippable: hello; open PDFs here (web access request, file-URL access
status with a link to Chrome's page); gather the PDFs already open in Chrome's
viewer (tabs whose address looks like a PDF — visible once site access is
granted) into one PDF tab, closing the originals; Google Drive (optional);
a tour with a demo paper; done. The demo paper is LaTeX about the extension
itself (`assets/demo/`, Korean and English), published on the site
(`docs/demo/`) so it opens as an ordinary web PDF.

Turning on file-URL access on Chrome's extension page reloads the extension,
which closes the guide. So "Turn on in Chrome" first leaves a marker
(`rpdfWelcomeResume` in `chrome.storage.local`: step and time,
`shared/welcomeResume.ts`); every service-worker start (that reload is one)
reopens `welcome.html#<step>` when the marker is under 10 minutes old and no
guide is open, and drops it. Reaching "done" (or skipping) drops it too.

## Gathering PDFs open in Chrome's viewer

`ui/openPdfTabs.ts`: tabs whose address looks like a PDF (visible to the
extension once site access is granted; local files with file-URL access).
Home shows a banner when there are some ("Gather into this project" /
"이 프로젝트로 모으기"), the settings page has a button, the welcome page a
step; gathered documents join this PDF tab. From home and from settings
inside a PDF tab, the hub gathers: each original tab closes once its document
has loaded here (in the background) and only if it still shows it. One that
does not load (an expired link, a sign-in page) or does not fit (50 open per
project) stays open where it was; the toast says how many, and the settings
frame, which asked with `GATHER_MESSAGE`, shows the hub's answer
(`GATHER_RESULT_MESSAGE`: gathered, kept open). The welcome page (and
settings opened on its own) open each as a web PDF entering and close an
original tab only once its document landed (`ui/pageKit.ts`): a viewer in a
PDF tab recorded opening it (a library row stamped since the gather began),
or a PDF tab lists it and its bytes are in the local file cache — and only if
the tab still shows it. What has not landed after 45 s stays open, and the
page says so. Chrome's viewer keeps its zoom as the tab's zoom, so
`chrome.tabs.getZoom` carries it over as `#zoom=N` (the viewer then still
restores the remembered page; a gathered tab put to sleep before anyone
looked keeps it). Its scroll position and page are inside
Chrome's own viewer frame, which no extension can read.

## Languages

Korean and English (`src/shared/i18n.ts`). Each module keeps its strings in a
sibling `*.strings.ts` (`messages({ ko, en })`, same keys enforced by the
types; functions for interpolation); static HTML carries `data-i18n*`
attributes filled by `localizeDocument`. The language is the user's choice on
the settings page (auto = the browser's), kept in localStorage for pages and
mirrored to `chrome.storage.local` for the service worker; open PDF tabs
reload when it changes. The worker starts in the browser's language until
that read resolves; `languageReady()` (what `followStoredLanguage` returns)
is what to await before building user-visible text there. The manifest description comes from `_locales/`
(`default_locale: en`). Stored data stays as written — the default project's
stored name is shown in the page's language until the user renames it.

## Projects

`shared/pdfProjects.ts`, `chrome.storage.local` key `rpdfProjects`, written by
the background only (`background/pdfProjectStore.ts`). A project has a name,
its members (`docId` → registered, pinned, changed at), the tabs it was
last open with (layout: URLs, active, what was in front), its look (an icon
from the set in `pdf-hub.html`, an emoji, or none = its first letter, on one
of ten colors) and its place in the list (folder + order key). Folders are
`rpdfProjectFolders`: a name and a place, nothing else.

- **Default project** (`default`, "기본"): implicit membership — every library
  document no other project has. A PDF opened for the first time is there
  with no write; it cannot be deleted. Its rows carry only pins. Before a
  device's first write the record reads as the default project seeded with
  the pins the library had before projects existed.
- **List and folders**: the default project on top, then folders (one level,
  projects only) and projects in the user's order. Order keys
  (`shared/orderKey.ts`) are base-62 fractions: moving an item gives it a key
  between its new neighbours and changes nothing else, so two devices
  reordering never overwrite each other (a level with unkeyed items, from
  before keys existed, is keyed whole on its first move). Rows drag to
  reorder, onto a folder to go in; Alt+↑/↓ moves the focused row; "⋯" or a
  right click has look, rename, folder and delete. Deleting a folder lets
  its projects out where it stood. Collapsed folders are per device
  (localStorage).
- **Looks**: the project's badge is shown in the strip, the lists and its
  home, and drawn (canvas → PNG data URL) as the hub tab's favicon, so hubs
  of different projects tell apart in Chrome's tab strip. The default
  project, unstyled, keeps the app icon.
- **Switcher** (left of the home button): choosing a project switches this
  tab to it — the viewers store everything, this project's layout is saved,
  and the page loads the other project's hub URL with its saved layout
  (`VOCAB_T_PDF_PROJECT_OPEN` with `inPlace`). A project already open in
  another tab is brought forward instead. The row's ↗ opens it in a new tab
  next to this one. Also create (switches to it), rename, delete — all in the
  list itself (deleting a project asks there, naming the pins and saved tabs
  it loses; deleting a folder has an undo). Recently closed tabs are kept per
  project.
- **Move** ("프로젝트로 이동", right side, and the tab menu): moves the
  document out of its project and into another (`VOCAB_T_PDF_PROJECT_MOVE`);
  its tab goes to that project's hub when open (queued like a claim's when
  the hub is loading, discarded or frozen), otherwise into the layout it
  opens with; a hub that turns out to be gone is forgotten and the layout
  gets it, so a moved document never vanishes. "+" registers it there too and leaves it here. A document a
  project hub shows is registered to that project; the default hub shows a
  document of a closed project as a guest without registering it. A local
  file is handed over: its bytes go to the hub-files store under
  `handoff:<project>`, and that project's hub takes them in (at once over the
  `rpdf-hub-handoff` BroadcastChannel if it is open, else when it boots).
  From home only the documents open here travel as tabs. Afterwards the hub
  stays (the toast undoes — membership, pin and its place, the tab where it
  stood — or goes there) or follows (`afterMove` in the display prefs): a
  note in `chrome.storage.session` (`rpdfMoveNotice`, read within 20 s)
  tells the destination's hub, in this tab after the in-place switch or in
  its own, to bring the documents forward and offer undo and the way back.
  A non-default hub drops the tabs whose documents left its project
  elsewhere (another hub or device, an undone move).
- **Caps**: 200 projects, 100 folders. Creating one at the cap is refused
  (`VOCAB_T_PDF_PROJECT_UPDATE` answers `{success:false, code:'project-limit'
  | 'folder-limit', limit, error}`). Live projects, folders and registered
  documents are never dropped to meet a cap — two devices merging may go over
  it and keep everything; only deleted projects/folders (a year) and removed
  members are capped.
- **Order keys** are at most 80 characters. A move whose key would be longer
  (hundreds of moves to one spot), or a folder deleted between two close
  keys, re-keys that whole level evenly in the same update; a stored key that
  is bad anyway is read as no key, never as a reason to drop the project.
- **Deleting** a project is a tombstone. Its open hub hands its tabs to the
  default project's hub (or becomes it) and its documents fall back to the
  default project.
- Documents a project refers to are never pruned from the library.
- **Document kinds**: the library row keeps what the paper strip classified
  the document as (`paperKind`: journal, conference, preprint, survey,
  technical) and the user's override (`userKind`, also "일반 PDF"; latest
  choice wins a merge). Tabs and home rows draw it as the document's icon;
  the tab menu and a right click on a home row change it.
- **Upkeep** (`shared/pdfUpkeep.ts`, `ui/pdfUpkeep.ts`): rows an older build
  left without what opening now derives (today: the kind) are revisited once
  per upkeep version, from a hidden frame a hub loads 20 s after it settled,
  and only when such rows exist. Cheapest source first: the paper-lookup
  cache, then the PDF from the local file cache or a local file (never
  downloaded again), then the databases as the strip asks them, 3 s apart and
  only with paper info on; a rate limit or network failure ends the run. Done
  rows are recorded per device (`rpdfUpkeep`, not synced); one hub runs it at
  a time (Web Lock `rpdf-upkeep`).

## Paper strip

`ui/pdfViewer/paperStrip.ts` (lookup), `paperRefs.ts` (reference list),
`shared/paperIdentifiers.ts` (pure rules), `shared/pdfReferences.ts`.

- **Detection**: DOI / arXiv id from the URL (bioRxiv versions and `.pdf` tails
  dropped), metadata and first page (a DOI broken at a line end rejoined,
  `arXiv:submit/…` stamps ignored); titles from metadata (placeholders such
  as "PowerPoint Presentation" ignored) and the first page's largest text.
- **Primary record**: by DOI (Crossref + OpenAlex), by arXiv id (OpenAlex,
  then arXiv's own API), Semantic Scholar by id, then by title. A record
  found by id must be this document — its title matches the PDF's, or its
  words are on the first page — and not a whole volume (a proceedings DOI);
  OpenAlex's arXiv records are dated by the arXiv id and their non-arXiv DOI
  is only a candidate. A record found by title alone needs its first author's
  surname on the first page; the strip marks it "matched by title". A cached
  one is trusted again (strip, library row) only against a first page that
  names that author.
- **Published version**: DOI candidates (from that record, Semantic Scholar,
  a Crossref title search) are adopted only when the record is an article
  with the same title and first author, dated from a year before to five
  after the preprint; then its venue and year replace the preprint's.
- **Citations**: total = the largest source; "2년" from OpenAlex's per-year
  counts only when OpenAlex knows at least half of them (under two years old:
  the total).
- **References**: OpenAlex's list, Semantic Scholar's, else the list printed
  in the PDF (section after the last References heading, numbered or
  author–year, margin line numbers dropped), linked to OpenAlex by DOI or arXiv
  id in batches, and by title (one search each) only while the list is open,
  20 per opening; what was linked is cached, also partway. A database list
  under 60 % of the paper's count is replaced by a longer PDF list. Count: Crossref's (the publisher's) when present.
- **Limits**: OpenAlex without a key counts against a daily budget shared by
  the network; once spent (429 "budget") the strip says so and stops asking
  OpenAlex until reload, and the paper record is not cached. A 429 is
  reported against the source that sent it. Semantic Scholar without a key
  is often 429. Both keys are optional settings (settings page, which can check them).

## Selectable text

PDF.js's hidden text layer is what a drag selects and what gets copied; the
page itself is a canvas. Three steps make the two agree to the character:

1. **Fonts** (`pdfViewer/textLayerFonts.ts`): runs are laid out in the PDF's
   own fonts (the FontFaces PDF.js registered to draw the canvas, named by
   `loadedName`) instead of a generic family. A font whose runs need large or
   scattered stretching (glyphs that do not map from Unicode) goes back to
   the generic family.
2. **Positions** (`scripts/pdfjs-worker-patch.cjs` +
   `pdfViewer/textLayerPositions.ts`): the worker, patched at build time,
   adds `charStarts` — where every character of a run starts, from the same
   glyph walk that computes the run's width (TJ gaps, word spacing, kerning).
   The viewer pins every word and gap (and every 24 characters of a run
   without gaps) absolutely at its start, so the browser's own layout can
   never drift along a line, and gives kerned characters inside a word exact
   letter-spacing — all in em, so it holds at any zoom. The patch fails the build if a PDF.js upgrade moved its anchors
   (`test/textLayerPositions.test.ts` checks it against the installed PDF.js).
   While the find bar highlights a match in a run, that run falls back to
   PDF.js's stretch.
3. **Selection ink** (`pdfViewer.css`): PDF.js paints the selection as its
   own layer over the canvas; a duotone backdrop filter turns the ink under it
   blue under a faint tint. With 2, a boundary letter is either fully blue
   (selected, copied) or not at all.

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
   Any opened file carrying arXiv's watermark (`arXiv:IDvN [cat] date` on
   page 1, `arxivStampAliases`) is also stored under `arxiv:IDvN` and, unless
   a different file already holds it, `arxiv:ID` (re-checked on first web
   use) — so a paper opened from disk opens instantly from its arXiv URL.
   Local files are otherwise not cached: a local open always reads the file.
   Never synced.
2. **Local state**: reading position (`chrome.storage.local`, written only by
   the background: the viewer sends `VOCAB_T_PDF_DOC_STATE_SAVE`) and
   drawings (`pdf_annotations`), applied at first render.
3. **Drive sync**: the open pull runs alongside rendering and answers with
   the document ids it changed (`changedPdfDocIds`). Only if the open
   document is among them does the viewer reopen it in place from the bytes
   in memory — silently if the reader has not touched it yet, otherwise
   after asking. An open within 60 s of a successful sync skips Drive. The
   viewer saves a position only after the reader moves, so a restored
   position is never re-stamped "now" and outranks another device's newer one.

## Library

`shared/pdfLibrary.ts`, `chrome.storage.local` key `rpdfLibrary`: one row per
document identity opened in a hub (embedded PDFs are not recorded) — up to 5
source URLs, file name, the PDF's Title, the detected paper title/venue/year,
page count, last opened, kind. Positions and drawings are joined in by
`docId` on the home page, not copied. Viewer frames and the hub send
`VOCAB_T_PDF_LIBRARY_UPDATE` (`opened` / `meta` / `user-kind`); the
background is the only writer (`background/pdfLibraryStore.ts`, one
serialized read-modify-write), and the sync applies its merge through the
same queue. A row's `pinned` is what builds before projects stored (pins live
in projects now); it is kept and merged to seed the first project record.
Bounded to 1,000 rows (rows a project refers to and old pins kept first;
others 365 days).

## Sync document

`researchpdf-sync-v1.json` (gzip) in the account's Drive appDataFolder,
shape in `src/shared/pdfSync.ts` (snapshot version 5; an older build's
version 1–4 document reads with what it lacks empty, and older builds
refuse a newer version instead of writing it back without it):

- `docs`: `PdfDocRecord[]`, reading position + zoom per document identity.
  Newest `updatedAt` wins per document.
- `annotations`: `PdfAnnotationCache[]`, the drawings PDF.js re-creates.
  Merged per document **and per drawing** (`mergeAnnotationCaches`): both
  devices' strokes on one paper survive; a stroke erased on one side is
  removed everywhere once a base exists; a stroke edited on both sides keeps
  the local copy. Presence of a document's cache is decided 3-way too, so
  erasing everything on one device wins over an unchanged peer.
- `projects` (version 3): `PdfProject[]`, joined: the latest rename names a
  project, a deletion is final (kept as a bare tombstone for a year), per
  member the latest change wins, the latest saved layout wins.
- `library`: `PdfLibraryEntry[]`, joined per field (`mergePdfLibraryEntries`):
  the latest open names the row, the latest pin change wins the pin, URLs are
  unioned. No deletions, so the join can be applied over local rows at any
  time without losing a concurrent write. A library change never reloads an
  open document (`changedPdfDocIds` looks at positions and drawings only).
- The merged set is bounded exactly like local storage (300 documents /
  180 days for positions; drawings never — a document with drawings is kept
  however many there are), so every device converges on the same set. A
  position outside the bounds is pruned locally by the sync too. Known edge:
  beyond those bounds a device's pruning is indistinguishable from a
  deletion.
- **Errors** are stored in the sync state as a code (+ detail, e.g. an HTTP
  status), `shared/syncErrors.ts`, and worded by the page that shows them,
  in its language. A state an older build stored keeps its sentence.

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
- A sync asked for while one runs gets one more run right after it (shared
  by every ask made meanwhile); an open's pull just joins the running one.
- **Writes only what is new to Drive:** when the merge equals what the file
  already holds, nothing is uploaded and the remote revision becomes the
  base. Two devices that agree therefore stop at one metadata request each,
  instead of rewriting the file for each other on every alarm.
- **Another account**: connecting a Google account other than the one this
  device last synced with (kept after a disconnect), while the device has
  data, does not connect yet: the background answers `needsConfirm:
  'account-change'`, the settings / welcome page asks, and only a second
  `VOCAB_T_CONNECT_GOOGLE_SYNC` with `confirmAccountChange: true` (reusing
  the sign-in, kept for the browser session) connects and merges this
  device's data into that account.

## Concurrency

- Reading positions: every viewer frame's save and the sync's apply go
  through one queue in the background (`pdfDocStateStore.ts`), so none
  overwrites another's row in the shared map.
- The background applies the merged snapshot per record and only where the
  local record is still the one it exported; a record the viewer changed
  meanwhile is skipped and reported as pending, with the stored base for that
  record set to the pre-merge row so the next merge has the right ancestor.
  Annotation rows and sync state commit in one IndexedDB transaction.
- The viewer's `AnnotationCache.snapshot()` re-reads the stored cache before
  writing. If sync changed it since the page last touched it, the page merges
  3-way against what it last saw and keeps the outside drawings as "foreign"
  entries carried by every later snapshot, so the editor's ignorance of them
  is never read as the user erasing them. Drawings another device synced
  become visible on the next open of that document, not live.
- **The same document in two viewers** (hubs of different projects): every
  stored snapshot is announced on the `rpdf-annotations` BroadcastChannel.
  The other viewers of that document store their own pending drawings first
  (the merge above), then show what was added and remove what was erased —
  matched by the content-derived drawing key — in place, without reloading.

## Setup and store

Google Cloud setup is in `docs/google-drive-sync.md`. `docs/` is also the
public site (homepage, privacy policy, terms; each page English then Korean,
`#en` / `#ko`) served by GitHub Pages; the OAuth consent screen and the Web
Store listings link to it. Production builds carry no source maps (the
store zip leaves them out); `npm run dev` keeps them.
