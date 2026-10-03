# Grading figure/table detection — brief

Each page `pgNNN` has three images in `img/`:
- `pgNNN-plain.png` — the page as printed.
- `pgNNN-A.png`, `pgNNN-B.png` — the same page with boxes drawn by two different detectors
  (you are not told which is which; judge each on its own). Each box has a tag `#k Figure N`,
  `#k Table N` or `#k no name`. Blue = figure, green = table, red = no name.

The goal of a detector: one box per figure and per table on the page — tightly around the whole
figure (all its sub-panels, axis labels, legends) or the whole table — **without its caption text**,
named with the number from its caption (Figure 3 / Table 2) when the page shows a caption.
Equations, algorithms/code listings, logos, headers and plain text are NOT figures.

## For every page in your list
1. Look at `-plain.png` and write down the true objects: each figure and table on the page (kind,
   number if captioned). A figure made of several panels (a, b, c) with one caption is ONE figure.
2. For A and then B, classify **each box**:
   - `correct` — encloses exactly one true object, whole, edges reasonably tight (it may include up
     to a small margin or a sliver of caption);
   - `partial` — the right object but cut off (a panel, an axis, part of a table missing) or clearly
     too large (includes paragraphs or another object);
   - `merged` — one box spans two or more separate true objects;
   - `false` — not a figure/table at all (text, equation, logo, header…), or a duplicate;
   and judge its **name**: `ok` (matches the caption), `wrong` (other number/kind), `missing`
   ("no name" although the page shows its caption number), `n/a` (no caption on the page).
3. Count true objects with **no** box at all as `missed`.

Use the Read tool to view the PNGs (zoom by reading again if needed). Be strict and consistent.

## Output
Write `results-<your list name>.json` in this directory:
```json
[{"page":"pg001","truth":["Figure 1","Table 2"],
  "A":{"boxes":[{"k":1,"verdict":"correct","name":"ok"}],"missed":0,"note":""},
  "B":{"boxes":[...],"missed":1,"note":"..."}}]
```
Final answer to the lead: totals for A and B separately are NOT needed (the lead will compute
them); just report the file path, how many pages you graded, and any systematic failure patterns
you noticed in A or in B (with example page ids).
