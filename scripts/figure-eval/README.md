# Figure-detection evaluation

Compares the rule-based detector (`src/shared/figureDetect.ts`) with the
model + PDF hybrid (`src/shared/layoutDetect.ts`) on a folder of PDFs, exactly
as the viewer runs them (PDF.js text and operator list, the bundled
PP-DocLayout-S through ONNX Runtime Web).

```bash
EVAL_DIR=/path/to/pdfs npx vitest run --config scripts/figure-eval/vitest.config.ts
python3 scripts/figure-eval/draw.py out.png file.pdf:3 other.pdf:5   # run from EVAL_DIR's parent; draws both
```

`compare.eval.ts` writes `$EVAL_DIR/compare.json` (per page: captions,
`ruleBased`, `hybrid`, the model's raw detections, its time). Grading: render
each page's boxes (blinded A/B), and have graders follow
`GRADING-BRIEF.md`; tally correct / partial / merged / false / missed and the
name verdicts per method.

First run, 2026-10-03, 107 pages with figures or tables from 20 PDFs (CVPR,
NeurIPS, arXiv, Nature family, PLOS, Copernicus, JMLR, theses, bioRxiv,
Japanese and Korean journals):

| | correct | partial | false | missed | names wrong | names missing |
|---|---|---|---|---|---|---|
| rule-based | 92/120 (77%) | 33 | 8 | 7 | 17 | 30 |
| hybrid, first cut | 99/120 (82%) | 24 | 6 | 0 | 19 | 12 |
| hybrid, shipped | 99/118 (84%) | 16 | 6 | 3 | 1 | 5 |

Pages changed between versions were re-graded with the same brief. Of the
shipped version's 6 false boxes, 3 are code listings captioned "Table N" and
one a report's cover photo; the 3 misses are tables in a Japanese journal the
model does not see and a continuation table. One PDF with a broken text layer
("Figure" and its number stored apart) stays unnamed.
