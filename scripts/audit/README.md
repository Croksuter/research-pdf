# Paper-strip audit harness

Loads the built extension in headless Chromium (with access to every site, as
after granting web-PDF access), opens PDFs in the hub, waits for the paper
strip and its reference list, and dumps what they show plus what the lookup
resolved (from the debug log) as JSON.

```bash
npm run build
node scripts/audit/audit.cjs https://arxiv.org/pdf/2603.03251            # JSON on stdout
node scripts/audit/audit.cjs --list scripts/audit/urls/arxiv.txt --out /tmp/arxiv.jsonl
python3 scripts/audit/summarize.py < /tmp/arxiv.jsonl                    # one block per paper
```

Environment:

| variable | effect |
|---|---|
| `EXT` | an extension directory to load instead of a copy of `dist/` |
| `PLAYWRIGHT_CORE` | path of a `playwright-core` package |
| `AUDIT_TIMEOUT_MS` | per-paper limit (default 120000) |
| `BLOCK_S2=1` | Semantic Scholar answers 429 (reproduce rate limiting) |
| `S2_FIXTURE=file.json` | Semantic Scholar paper lookups answer with this body |
| `OA_FIXTURES=file.json` | `[{ "match": "<decoded URL substring>", "body": {…} }]` for OpenAlex |
| `NETLOG=1` | log every non-API network response |

Without keys, OpenAlex counts every request against a free daily budget shared
by the network (resets at midnight UTC) and Semantic Scholar is often 429:
run lists in small chunks, and check `log` for `fetch 429` before judging a
result. `BRIEF.md` is the brief given to auditors; `urls/` the collected PDFs
(conference list not yet run); `findings-2026-10-03/` the first run's findings
(about half of them were cut short by the OpenAlex budget).
