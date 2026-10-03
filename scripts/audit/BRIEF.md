# ResearchPDF paper-strip audit — brief for each auditor

ResearchPDF is a Chrome extension PDF viewer. When a PDF is a paper, a "paper strip"
(논문 헤더바) above the document shows what it found online:

- **논문정보**: a kind badge (`survey` / `conference` / `journal` / `technical` / `preprint`),
  venue (journal / conference name), year. Hover popover: title, authors, facts (volume,
  pages, DOI, arXiv id…), links (DOI, OpenAlex, arXiv, Semantic Scholar, Google Scholar…).
- **2년/전체 인용수**: citations in the last two years / total.
- **참고문헌**: reference count, and a hover list of the references (title, authors, year,
  venue, citation count) loaded from OpenAlex or Semantic Scholar.
- **BibTeX / APA** copy buttons.
- `⚠︎` marks a value it could not find (the hover reason is in `warnings`).

It detects the paper from the PDF (DOI / arXiv id in the URL, metadata, or first-page text;
otherwise the first page's big title) and looks it up in OpenAlex, Crossref and Semantic
Scholar. Code (read-only for you): `/home/hoyeong-choi/development/research-pdf/src/ui/pdfViewer/paperStrip.ts`,
`paperRefs.ts`, `src/shared/paperIdentifiers.ts`.

## Your job

1. **Collect ~25 papers** for your slice (given in your prompt). Each must be a **direct,
   openly downloadable PDF URL** (the URL itself returns the PDF, no login/paywall).
   Check with `curl -sIL -m 20 <url> | grep -i content-type` → `application/pdf`. Prefer
   variety inside your slice (fields, years from the 1990s to 2026, publishers, URL shapes).
   Write them to `<workdir>/urls.txt`, one per line.
2. **Run the harness** in chunks of at most 5 URLs per command (each paper takes 20–120 s):
   ```bash
   cd /tmp/claude-1000/-home-hoyeong-choi-development-Vocab-T/659f17b2-8d19-4818-8575-f5ba4fb06e52/scratchpad/audit
   node audit.cjs --list <workdir>/chunk1.txt --out <workdir>/results.jsonl
   ```
   Use a Bash timeout of 600000 ms. Each line of `results.jsonl` is one paper:
   `stripText` (what the strip shows), `kindBadge`, `warnings`, `popover` (title, authors,
   facts, links), `refsHeader`, `refCount`, `refs` (first 12), `copies` (`{"BibTeX": …,
   "APA": …}` — the copied texts), `detection` (ids and titles found in the PDF), `meta`
   (what the lookup resolved), `log` (the lookup's network log), `firstPageText`,
   `message` (viewer error), `error`, `timedOut`.
3. **Establish the truth for every paper yourself**: read the paper (e.g.
   `curl -sL -m 60 -o p.pdf <url> && pdftotext -l 2 p.pdf - | head -80` for the title,
   authors, venue line, DOI/arXiv stamp; `pdftotext p.pdf - | tail -…` and count the
   reference list) and, where useful, its landing page (arXiv abs page, DOI landing page,
   publisher page) with WebFetch. Decide the correct: title, authors, venue, year, kind
   (preprint / conference / journal / survey / technical report), DOI / arXiv id, and the
   approximate number of references in the PDF.
4. **Compare** the strip against the truth and record every discrepancy. Things to look
   for (not exhaustive):
   - not recognised as a paper / wrong paper matched (title of a different work)
   - wrong or missing title, authors (missing, duplicated, mangled, wrong order), venue,
     year (e.g. latest arXiv version year instead of first), kind badge
   - wrong DOI / arXiv id detected; published version not linked
   - reference count far from the PDF's own list; reference list empty or unavailable
     although the paper has references; misleading ⚠︎ reason text
   - citation numbers absurd (e.g. 0 for a famous paper), "2년" chart missing when it
     should exist
   - broken / wrong links in the popover
   - APA / BibTeX wrong (names, year, venue, pages, escaping, duplicate authors)
   - PDF failed to load, harness timeout, viewer error message
   - Korean UI text that is wrong or confusing
   Semantic Scholar often answers HTTP 429 (rate limited, no API key). That is known —
   still record what it breaks for that paper (e.g. no references), with `cause: "s2-429"`.
5. **Write findings** to `<workdir>/findings.json`:
   ```json
   [{ "url": "...", "paper": "short title", "field": "references|title|authors|venue|year|kind|doi|citations|links|apa|bibtex|detection|load|other",
      "expected": "...", "got": "...", "severity": "high|medium|low", "cause": "your best guess (e.g. s2-429, openalex-missing, title-mismatch, parser)",
      "evidence": "how you know (pdftotext line, landing page)" }]
   ```
   Also list papers that were fully correct in `<workdir>/ok.txt`.

## Your final answer (returned to the lead)

Group the findings by **root cause / problem type**. For each group: a one-line
description, the count, ONE best reproduction URL (the clearest single case), the other
URLs, and what exactly is wrong (expected vs got) for the representative case. Then the
total papers audited, how many fully correct, and the path of `findings.json`.
Do NOT modify any file in the research-pdf repository. Work only in your workdir.
