// ─── The reference list printed in the PDF itself (pure) ───
//
// The paper strip's last resort for "참고문헌" when neither OpenAlex nor
// Semantic Scholar has a list (new preprints, rate limits, conference PDFs
// nobody indexed): read the References section of the document.
//
// Input is the document's text as positioned lines (ui/pdfViewer/pdfText.ts
// builds them from PDF.js text items, columns already in reading order).
// The section starts at the last "References" / "Bibliography" / "참고문헌"
// heading and ends at the next heading-sized line (an appendix). Entries are
// split by their numbering ([1], 1.) or, for author–year lists, by the hanging
// indent or the gap between entries. Each entry yields a best-effort title,
// authors, year, DOI and arXiv id.

export interface TextLine {
  page: number;
  /** Column on the page (0 = left / single). */
  column: number;
  x: number;
  /** Baseline, PDF units (larger = higher on the page). */
  y: number;
  /** Font height. */
  h: number;
  text: string;
}

export interface PdfReference {
  /** The entry's number in a numbered list, else its position (1-based). */
  index: number;
  raw: string;
  title: string | null;
  authors: string[];
  year: number | null;
  doi: string | null;
  arxivId: string | null;
}

const HEADING = /^(?:[0-9]{1,2}\.?|[IVX]{1,4}\.)?\s*(?:references?(?:\s+(?:and|&)\s+notes)?|bibliography|literature\s+cited|works\s+cited|cited\s+literature|reference\s+list|참\s*고\s*문\s*헌|参\s*考\s*文\s*献|literaturverzeichnis|literatur|références|bibliographie)\s*:?$/iu;
const BRACKET = /^\[(\d{1,4})\]\s*/u;
const APPENDIX = /^(?:appendix|appendices|supplementary\s+material|부\s*록)(?=\s|$|[.:])/iu;
const DOTTED = /^(\d{1,4})\.\s+(?=\S)/u;
const MAX_REFERENCES = 500;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Lines repeated on several pages at the same height: running heads and feet. */
function runningLines(lines: readonly TextLine[]): Set<string> {
  const seen = new Map<string, Set<number>>();
  for (const line of lines) {
    const key = `${Math.round(line.y / 4)}|${line.text.replace(/\d+/gu, '#').trim().toLowerCase()}`;
    const pages = seen.get(key) ?? new Set<number>();
    pages.add(line.page);
    seen.set(key, pages);
  }
  return new Set([...seen].filter(([, pages]) => pages.size >= 3).map(([key]) => key));
}

function isRunning(line: TextLine, running: Set<string>): boolean {
  return running.has(`${Math.round(line.y / 4)}|${line.text.replace(/\d+/gu, '#').trim().toLowerCase()}`);
}

/** Joins an entry's lines, undoing hyphenation and URLs broken at the line end. */
export function joinEntryLines(lines: readonly string[]): string {
  let out = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!out) { out = line; continue; }
    if (/[a-z]-$/u.test(out) && /^[a-z]/u.test(line)) out = out.slice(0, -1) + line;
    else if (/(?:https?:|\/|\.|_|-)$/u.test(out) && /^(?:\/\/|[\w./?=&%#-]*\/)/u.test(line) && /https?:\S*$/u.test(out)) out += line;
    else out += ` ${line}`;
  }
  return out.replace(/\s+/gu, ' ').trim();
}

// Author lists end at a sentence break that is not an initial ("A.") or a
// usual abbreviation.
// ("et al." is not one of them: "…, et al. Title" ends the authors.)
const ABBREVIATIONS = new Set(['eds', 'ed', 'jr', 'sr', 'vs', 'no', 'vol', 'pp', 'proc', 'conf', 'int', 'trans', 'dept', 'univ', 'inc', 'ltd', 'co', 'st', 'mr', 'dr', 'prof', 'phys', 'rev', 'lett', 'j', 'jpn', 'natl', 'acad', 'sci', 'eng', 'comput', 'assoc', 'mach', 'intell', 'syst', 'appl', 'math']);

function sentenceBreaks(text: string): number[] {
  const breaks: number[] = [];
  // A sentence break before a capital, a quote, a digit, or a venue/locator
  // word that may start in lower case ("arXiv preprint", "abs/…").
  const re = /([^\s.]*)\.\s+(?=["“A-Z0-9\p{Lu}]|arxiv|abs\/|https?:|doi:|in\s)/giu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const word = m[1];
    const after = text.slice(m.index + m[0].length);
    const initial = word.length <= 1 || /^(?:\p{Lu}\.?-?){1,3}$/u.test(word);
    // An initial ends the authors only when a sentence follows it ("R.R.
    // Reducing the …"), not a surname ("R. Fergus").
    const sentenceFollows = /^\p{Lu}\p{Ll}+\s+(?!and\b|et\b|van\b|von\b|de\b|der\b|den\b|da\b|di\b|du\b|le\b|la\b|del\b|dos\b|y\b|e\b)\p{Ll}/u.test(after);
    if ((initial && !sentenceFollows) || ABBREVIATIONS.has(word.toLowerCase())) continue;
    breaks.push(m.index + m[0].length);
  }
  return breaks;
}

function cleanTitle(value: string): string | null {
  const title = value
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.,]\s*(?:arxiv\s+preprint|preprint|corr|in\s+proc|url\s|https?:|doi:).*$/iu, '')
    .replace(/,\s*(?:19|20)\d{2}[a-z]?\s*\.?$/u, '')
    .replace(/^[\s,.:;"“”']+|[\s,.:;"“”']+$/gu, '')
    .trim();
  if (title.length < 8 || title.length > 400) return null;
  if (/^(?:in|proceedings|proc\.|arxiv|url|doi|pp\.|vol\.)\b/iu.test(title)) return null;
  return title;
}

function splitAuthors(block: string): string[] {
  return block
    .replace(/\(\s*(?:19|20)\d{2}[a-z]?\s*\)\.?$/u, '')
    .replace(/\bet al\.?/giu, '')
    .split(/\s*(?:,\s*(?:and\s+|&\s*)?|\s+and\s+|\s*&\s*|;\s*)/u)
    .map((a) => a.replace(/[.,\s]+$/u, '').trim())
    .filter((a) => a.length > 1 && /\p{L}/u.test(a))
    // "Smith, J." splits into "Smith" and "J": put initials back on the name.
    .reduce<string[]>((names, part) => {
      if (/^(?:\p{Lu}\.?\s?-?){1,3}$/u.test(part) && names.length) names[names.length - 1] = `${names[names.length - 1]}, ${part}`;
      else names.push(part);
      return names;
    }, [])
    .slice(0, 50);
}

/** Title, authors, year and ids of one entry (numbering already removed). */
export function parseReferenceEntry(raw: string, index: number): PdfReference {
  const text = raw.replace(/\s+/gu, ' ').trim();
  const doi = /\b(10\.\d{4,9}\/[^\s"<>]+)/u.exec(text)?.[1].replace(/[.,;)\]]+$/u, '') ?? null;
  const arxiv = /arxiv(?:\.org\/(?:abs|pdf)\/|\s*(?:preprint\s+)?(?:arxiv)?\s*[:\s]\s*)((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(v\d+)?/iu.exec(text);
  // Not the "2004" of an arXiv id 2004.05150 or of a DOI.
  const years = [...text.replace(/\b10\.\d{4,9}\/\S+/gu, ' ').matchAll(/(?<![\d./])((?:19|20)\d{2})[a-z]?(?!\d|\.\d)/gu)].map((m) => Number(m[1])).filter((y) => y <= new Date().getFullYear() + 1);
  let title: string | null = null;
  let authorBlock = '';
  const quoted = /[“"]([^”"]{8,400})[”"]/u.exec(text);
  if (quoted) {
    title = cleanTitle(quoted[1]);
    authorBlock = text.slice(0, quoted.index);
  }
  if (!title) {
    // APA: "Authors (2020). Title. Venue." — or no authors: "(2003) Title."
    const apa = /^(.{0,600}?)\(\s*((?:19|20)\d{2}[a-z]?|n\.d\.|in press)\s*\)\.?\s+(.+)$/u.exec(text);
    if (apa) {
      authorBlock = apa[1];
      const rest = apa[3];
      const end = sentenceBreaks(rest)[0];
      title = cleanTitle(end ? rest.slice(0, end) : rest);
    }
  }
  if (!title) {
    const breaks = sentenceBreaks(text);
    // Science / PNAS style: "O. Sporns, G. Tononi, R. Kötter, The title. Journal 1, e42 (2005)."
    const first = breaks.length ? text.slice(0, breaks[0]) : text;
    const science = /^((?:(?:\p{Lu}\.\s?-?\s?)+[\p{L}'’-]+(?:\s(?:van|von|de|der|da|di|du|le|la|del)?\s?[\p{L}'’-]+)?,\s+)+(?:(?:and|&)\s+(?:\p{Lu}\.\s?)+[\p{L}'’-]+,\s+)?(?:et al\.,\s+)?)(\S.{14,})$/u.exec(first);
    // The rest must read as a title, not as more names ("S. Ren, and J. Sun.").
    if (science && !/^(?:\p{Lu}\.\s?-?\s?)+\p{Lu}|\bet al\b|^(?:and|&)\s/u.test(science[2])) {
      authorBlock = science[1];
      title = cleanTitle(science[2]);
    }
  }
  if (!title) {
    const breaks = sentenceBreaks(text);
    if (breaks.length >= 1) {
      authorBlock = text.slice(0, breaks[0]);
      let from = breaks[0];
      // ACL / natbib: "Authors. 2018. Title. Venue."
      const year = /^(?:19|20)\d{2}[a-z]?\.\s+/u.exec(text.slice(from));
      if (year) from += year[0].length;
      const next = breaks.find((b) => b > from + 8);
      title = cleanTitle(text.slice(from, next ?? text.length));
      if (title && /^(?:19|20)\d{2}[a-z]?$/u.test(title)) title = null;
    }
  }
  return {
    index,
    raw: text,
    title,
    authors: authorBlock ? splitAuthors(authorBlock) : [],
    year: years.length ? years[years.length - 1] : null,
    doi,
    arxivId: arxiv ? arxiv[1] : null,
  };
}

function lastLine(entries: readonly string[][]): string {
  const entry = entries[entries.length - 1];
  return entry ? entry[entry.length - 1] : '.';
}

/** The reference section's entries, or [] when the document has none that can be found. */
/**
 * Manuscripts under review (bioRxiv, journal submissions) number every line
 * in the margin; those numbers are dropped when most lines carry one.
 */
function withoutLineNumbers(lines: readonly TextLine[]): TextLine[] {
  const numbered = lines.filter((l) => /^\d{1,5}\s+\S/u.test(l.text) || /^\d{1,5}$/u.test(l.text.trim())).length;
  if (numbered < lines.length * 0.4) return [...lines];
  return lines
    .map((l) => ({ ...l, text: l.text.replace(/^\d{1,5}\s+(?=\S)/u, '') }))
    .filter((l) => !/^\d{1,5}$/u.test(l.text.trim()));
}

export function extractPdfReferences(input: readonly TextLine[]): PdfReference[] {
  const allLines = withoutLineNumbers(input);
  const running = runningLines(allLines);
  const lines = allLines.filter((l) => l.text.trim() && !isRunning(l, running) && !/^\d{1,4}$/u.test(l.text.trim()));
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (HEADING.test(lines[i].text.trim())) { start = i; break; }
  }
  if (start < 0) return [];
  const headingH = lines[start].h;
  const body = lines.slice(start + 1, start + 1 + 6_000);
  if (body.length === 0) return [];
  const bodyH = median(body.slice(0, 40).map((l) => l.h)) || headingH;
  // The section ends at the next heading: a larger line, short, starting a block.
  let end = body.length;
  for (let i = 0; i < body.length; i += 1) {
    const l = body[i];
    const text = l.text.trim();
    // (\p{Lo}: headings in scripts without case — 부록, 附录.)
    if (l.h > bodyH * 1.18 && text.length < 80 && /^[\p{Lu}\p{Lo}0-9]/u.test(text) && !BRACKET.test(text)) { end = i; break; }
    // A lookahead, not \b: \b never matches after Hangul in a /u regex.
    if (APPENDIX.test(text) && text.length < 60) { end = i; break; }
  }
  const section = body.slice(0, end);
  if (section.length === 0) return [];

  const entries: string[][] = [];
  const numbers: number[] = [];
  const firstText = section[0].text.trim();
  const numbered = BRACKET.test(firstText) ? BRACKET : DOTTED.test(firstText) && /^1\./u.test(firstText) ? DOTTED : null;
  if (numbered) {
    let expected = Number(numbered.exec(firstText)?.[1] ?? 1);
    for (const line of section) {
      const text = line.text.trim();
      const m = numbered.exec(text);
      if (m && Number(m[1]) === expected) {
        entries.push([text.slice(m[0].length)]);
        numbers.push(expected);
        expected += 1;
      } else if (entries.length) {
        entries[entries.length - 1].push(text);
      }
      if (entries.length >= MAX_REFERENCES) break;
    }
  } else {
    // Author–year: per page column, the leftmost x starts an entry when the
    // list uses a hanging indent; otherwise a wider gap than the line spacing does.
    const groups = new Map<string, TextLine[]>();
    for (const line of section) {
      const key = `${line.page}|${line.column}`;
      groups.set(key, [...(groups.get(key) ?? []), line]);
    }
    const margin = new Map<string, number>();
    const indented = new Map<string, boolean>();
    for (const [key, group] of groups) {
      const left = Math.min(...group.map((l) => l.x));
      margin.set(key, left);
      const deeper = group.filter((l) => l.x > left + bodyH * 0.6 && l.x < left + bodyH * 4).length;
      indented.set(key, deeper >= Math.max(1, group.length * 0.15));
    }
    const spacing = median(section.slice(1).map((l, i) => (l.page === section[i].page && l.column === section[i].column ? section[i].y - l.y : 0)).filter((d) => d > 0));
    let prev: TextLine | null = null;
    for (const line of section) {
      const key = `${line.page}|${line.column}`;
      const left = margin.get(key) ?? line.x;
      const sameBlock = prev && prev.page === line.page && prev.column === line.column;
      const gap = sameBlock && prev ? prev.y - line.y : 0;
      const startsHere = indented.get(key)
        ? line.x <= left + bodyH * 0.35
        : !sameBlock ? /[.)]\s*$/u.test(lastLine(entries)) : gap > spacing * 1.35;
      if (startsHere || entries.length === 0) entries.push([line.text]);
      else entries[entries.length - 1].push(line.text);
      prev = line;
      if (entries.length >= MAX_REFERENCES) break;
    }
  }
  return entries
    .map((lines, i) => parseReferenceEntry(joinEntryLines(lines), numbers[i] ?? i + 1))
    .filter((r) => r.raw.length >= 15);
}

// ─── Lines from PDF.js text items ───

export interface PdfTextItem {
  str: string;
  /** PDF.js transform: [a, b, c, d, x, y]. */
  transform: number[];
  width: number;
  height: number;
}

/**
 * One page's text items as lines in reading order. A page whose text sits in
 * two halves with little crossing the middle is read left column first.
 */
export function linesFromTextItems(page: number, items: readonly PdfTextItem[], pageWidth: number): TextLine[] {
  const usable = items
    .filter((it) => it.str.trim() && Array.isArray(it.transform) && it.transform.length >= 6)
    .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: Math.abs(it.height || it.transform[3]) || 1 }));
  if (usable.length === 0) return [];
  const mid = pageWidth / 2;
  const left = usable.filter((it) => it.x + it.w <= mid + 4).length;
  const right = usable.filter((it) => it.x >= mid - 4).length;
  const crossing = usable.filter((it) => it.x < mid - 10 && it.x + it.w > mid + 10).length;
  const twoColumns = left > usable.length * 0.25 && right > usable.length * 0.25 && crossing < usable.length * 0.08;
  const columnOf = (it: { x: number }) => (twoColumns && it.x >= mid - 4 ? 1 : 0);
  const sorted = [...usable].sort((a, b) => columnOf(a) - columnOf(b) || b.y - a.y || a.x - b.x);
  const lines: Array<{ column: number; y: number; h: number; parts: typeof usable }> = [];
  for (const it of sorted) {
    const column = columnOf(it);
    const line = lines.length ? lines[lines.length - 1] : null;
    if (line && line.column === column && Math.abs(line.y - it.y) <= Math.max(line.h, it.h) * 0.5) {
      line.parts.push(it);
      line.h = Math.max(line.h, it.h);
    } else {
      lines.push({ column, y: it.y, h: it.h, parts: [it] });
    }
  }
  return lines.map((line) => {
    const parts = [...line.parts].sort((a, b) => a.x - b.x);
    let text = '';
    let end = -Infinity;
    for (const p of parts) {
      if (text && p.x - end > line.h * 0.15 && !text.endsWith(' ') && !p.str.startsWith(' ')) text += ' ';
      text += p.str;
      end = p.x + p.w;
    }
    return { page, column: line.column, x: parts[0].x, y: line.y, h: line.h, text: text.replace(/\s+/gu, ' ').trim() };
  }).filter((l) => l.text);
}
