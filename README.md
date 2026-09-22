# ResearchPDF

Chrome extension for reading papers. Drawings, highlights and your reading
position follow you across every Chrome profile and device through your own
Google Drive.

- Opens local files and web PDFs in a bundled PDF.js viewer with pen,
  highlight, text and stamp annotations.
- Remembers drawings and the last page/zoom per document, identified by the
  file's own content rather than its name or path.
- Shows venue, citation trend, references and links for papers it recognises
  (DOI / arXiv), via Semantic Scholar, OpenAlex and Crossref.
- Optional Google Drive sync (`drive.appdata` only): one gzip document in the
  app's hidden folder, merged per document and per drawing. PDFs themselves are
  never uploaded. No server, no account, no telemetry.

Site and privacy policy: https://croksuter.github.io/research-pdf/

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
