# ResearchPDF

Chrome extension for reading papers. Drawings, highlights and your reading
position follow you across every Chrome profile and device through your own
Google Drive.

- Opens local files and web PDFs in a bundled PDF.js viewer with pen,
  highlight, text and stamp annotations.
- Collects PDFs into one tab per project with its own tab strip, so papers
  stop scattering among your web tabs (Alt+Shift+←/→ to switch, Alt+W to
  close one, Alt+Shift+T to reopen it). The same paper opened again goes to
  its existing tab; tabs you have not looked at for a while are unloaded.
- Projects: every new PDF starts in the default project; move it to a named
  one ("프로젝트로 이동"). Close a project's tab and reopen it later with the
  same tabs; its other papers stay one click away. A paper open in two
  projects shows drawings made in either one live.
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
- Copies a figure or table as a sharp image for slides: drag a region (⌘+Shift+X /
  Ctrl+Shift+X, `S`, the toolbar button, or Alt+drag), and it is rendered again at 150–600 dpi, with
  or without your drawings, next to a ready source line (`Source: Hao et al.
  (2024). Title. arXiv. Fig. 2.`) read from the caption beside it.
- Optional Google Drive sync (`drive.appdata` only): one gzip document in the
  app's hidden folder, merged per document and per drawing. PDFs themselves are
  never uploaded. No server, no account, no telemetry.

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
