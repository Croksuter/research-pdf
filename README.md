# ResearchPDF

Chrome extension for reading papers. Drawings, highlights and your reading
position follow you across every Chrome profile and device through your own
Google Drive.

- Opens local files and web PDFs in a bundled PDF.js viewer with pen,
  highlight, text and stamp annotations; the tool, colors, thickness and
  opacity last used come back in every document.
- Collects PDFs into one tab per project with its own tab strip, so papers
  stop scattering among your web tabs (Alt+Shift+←/→ to switch, Alt+W to
  close one, Alt+Shift+T to reopen it). The same paper opened again goes to
  its existing tab; tabs you have not looked at for a while are unloaded.
- Split view: two papers side by side in one PDF tab, or the same paper
  twice (text beside its references) — drag a tab onto either half of the
  page, use the split button, or Alt+Shift+S. Drawings show in both halves
  as you make them.
- Works with several windows: by default a PDF joins the PDF tab of the
  window it was opened in and never pulls another window forward; for
  browsers where you switch spaces in one window (Arc), choose one PDF tab
  for the whole browser in settings. Any paper can move to a window of its
  own ("Move to new window", or drag its tab out of the window).
- Projects: every new PDF starts in the default project; move it to a named
  one ("Move to project" / "프로젝트로 이동"), local files included. After a
  move you stay or go along (a setting); the notice can undo the move or take
  you the other way. Close a project's tab and reopen it later with the
  same tabs; its other papers stay one click away. A paper open in two
  projects shows drawings made in either one live. Give a project an icon,
  an emoji or a color (its tab in Chrome shows it), and order projects or
  group them in folders by dragging.
- Papers are told apart from other PDFs at a glance: journal, conference,
  preprint, survey and report icons, which you can correct.
- A home page lists the project's PDFs and every PDF you have opened, with
  reading progress and search. Pinned PDFs sit at the left of their project's
  tab.
- Remembers drawings and the last page/zoom per document, identified by the
  file's own content rather than its name or path.
- Shows venue, citation trend, references and links for papers it recognises
  (DOI / arXiv / title), via OpenAlex, Crossref, arXiv and Semantic Scholar; the
  reference list falls back to the one printed in the PDF. Optional API keys
  for Semantic Scholar and OpenAlex (OpenAlex's keyless use is a daily budget
  shared per network).
- Copies a figure or table as a sharp image for slides. The capture key (`S`,
  ⌘+Shift+X / Ctrl+Shift+X or the toolbar button) turns capture mode on: the
  page's figures and tables are outlined as they are found, a click copies
  one, and a drag anywhere selects an area instead (the outlines step aside
  while you drag); Alt+drag works anytime. What a capture puts on the
  clipboard is a setting: nothing, the image, the image with its source, or
  the source alone. Detection runs a small layout model on the page, on the
  device (PP-DocLayout-S, Apache-2.0, via ONNX Runtime Web; loaded on first
  use), and names and trims what it finds with the PDF's own captions and
  graphics. The region is rendered again at 150–600 dpi, with
  or without your drawings, next to a ready source line (`Source: Hao et al.
  (2024). Title. arXiv. Fig. 2.`) read from the caption beside it.
- Gathers the PDFs already open in Chrome's own viewer into the PDF tab
  (from home, the settings page or the welcome guide), with their zoom; an
  original tab closes only once its PDF is there.
- Optional Google Drive sync (`drive.appdata` only): one gzip document in the
  app's hidden folder, merged per document and per drawing. PDFs themselves are
  never uploaded. No server, no account, no telemetry.
- In Korean and English: the settings page has a language choice (automatic
  follows the browser).
- A welcome guide on install walks through opening PDFs here (web and file
  access), gathering open PDFs, sync and a demo paper; settings → About shows
  it again.
- One settings page, inside the PDF tab (⚙, or the popup's Settings): sync,
  opening PDFs with the Chrome access each switch needs, display, where a
  move leaves you, figure capture (clipboard, source, resolution, detection,
  continuous capture), paper-info API keys with a check of what they allow,
  storage and shortcuts.

## Keyboard shortcuts

On a Mac, Alt is ⌥, Shift ⇧ and Ctrl ⌘. The settings page lists the same
table (`src/shared/shortcuts.ts`; `test/shortcuts.test.ts` keeps the two in
step).

| Keys | Action |
|---|---|
| Alt+Shift+← / Alt+Shift+→ | Previous / next PDF tab |
| Alt+W | Close this PDF tab |
| Alt+Shift+T | Reopen closed tab |
| Alt+Shift+S | Split view on / off (two documents side by side) |
| Alt+Shift+O | Go to the other half of the split view |
| Alt+↑ / Alt+↓ | Reorder in the project list |
| Ctrl+F | Find in document |
| Ctrl+G / Ctrl+Shift+G | Next / previous match |
| Ctrl++ / Ctrl+- | Zoom in / out |
| Ctrl+0 | Fit automatically |
| Ctrl+[ / Ctrl+] | Rotate left / right |
| Home / End | First / last page |
| Ctrl+P | Print |
| Ctrl+S | Download (with annotations) |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| S / Ctrl+Shift+X | Capture on/off: click a figure or table, or drag an area |
| Esc | Close capture, find, and annotation tools |

Site and privacy policy: https://research-pdf.croksuter.com/

## Develop

```bash
npm install
npm run dev        # rspack --watch → dist/
npm test           # tsc + vitest
npm run test:bundle
npm run zip        # research-pdf.zip for the Web Store
```

Load `dist/` as an unpacked extension. Docs: `docs/architecture.md`,
`docs/google-drive-sync.md`.

## License

MIT
