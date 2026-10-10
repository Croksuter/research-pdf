// ─── Formula recognition: token pieces → LaTeX to paste (pure) ───
//
// The formula model (ui/pdfViewer/formulaOcr.ts) writes byte-level BPE
// tokens, and the text they spell has a space between every token and every
// letter (`\mathrm { s o f t m a x }`). Math mode ignores those spaces, so
// they go — except one ending a control word before a letter (`\cdot x`) and
// a control space (`\ `). Then what the model adds that a person would not:
// empty scripts (`p_{\theta}^{}`), a one-row `aligned` block around a plain
// formula, and `\operatorname{log}` for `\log`.

/** Token ids below this are <pad> <s> </s> <unk> <mask>. */
export const FORMULA_SPECIAL_IDS = 5;

let bytesOf: Map<string, number> | null = null;

/** GPT-2's byte → printable character table, inverted. */
function byteDecoder(): Map<string, number> {
  if (bytesOf) return bytesOf;
  const bs: number[] = [];
  for (let b = 33; b <= 126; b += 1) bs.push(b);
  for (let b = 161; b <= 172; b += 1) bs.push(b);
  for (let b = 174; b <= 255; b += 1) bs.push(b);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b += 1) {
    if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n += 1; }
  }
  bytesOf = new Map(bs.map((b, i) => [String.fromCodePoint(cs[i]), b]));
  return bytesOf;
}

/** The text a run of byte-level BPE token pieces spells (`Ġ` is a space). */
export function decodeTokens(pieces: readonly string[]): string {
  const table = byteDecoder();
  const bytes: number[] = [];
  for (const ch of pieces.join('')) {
    const b = table.get(ch);
    if (b !== undefined) bytes.push(b);
  }
  return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
}

// Operators LaTeX has a command for: `\operatorname{log}` reads as `\log`.
const OPERATORS = new Set(['arccos', 'arcsin', 'arctan', 'arg', 'cos', 'cosh', 'cot', 'coth', 'csc', 'deg', 'det', 'dim', 'exp', 'gcd', 'hom', 'inf', 'ker', 'lg', 'lim', 'liminf', 'limsup', 'ln', 'log', 'max', 'min', 'Pr', 'sec', 'sin', 'sinh', 'sup', 'tan', 'tanh']);

/** Spaces math mode ignores, out: kept after a control word before a letter, and as a control space. */
function compact(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (!/\s/u.test(c)) { out += c; continue; }
    while (i + 1 < text.length && /\s/u.test(text[i + 1])) i += 1;
    const next = text[i + 1] ?? '';
    // An odd number of backslashes before the letters: a control word (`\\x` is a line break and an x).
    const controlWord = /(^|[^\\])(\\\\)*\\[a-zA-Z]+$/u.test(out);
    const controlSpace = /(^|[^\\])(\\\\)*\\$/u.test(out);
    if ((controlWord && /[a-zA-Z]/u.test(next)) || controlSpace) out += ' ';
  }
  return out;
}

/** Recognised LaTeX, tidied for pasting into a document. */
export function tidyLatex(raw: string): string {
  let t = compact(raw.trim());
  // Empty scripts and accents.
  for (let i = 0; i < 5; i += 1) {
    const next = t.replace(/(?<!\\)[_^]\{\}/gu, '').replace(/\\(?:hat|tilde|bar|vec|dot|ddot|overline|widehat|widetilde|text|mathrm)\{\}/gu, '');
    if (next === t) break;
    t = next;
  }
  // `\operatorname{log}` → `\log` (a space after it when a letter follows).
  t = t.replace(/\\operatorname(\*?)\{([a-zA-Z]+)\}(?=(.?))/gu, (whole, _star: string, name: string, next: string) => {
    if (!OPERATORS.has(name)) return whole;
    return `\\${name}${/[a-zA-Z]/u.test(next) ? ' ' : ''}`;
  });
  // A one-row `aligned` with no alignment point is the formula itself.
  const row = /^\\begin\{aligned\}\{(.*)\}\\\\\\end\{aligned\}$/u.exec(t);
  if (row && !row[1].includes('&') && !row[1].includes('\\\\') && balanced(row[1])) t = row[1];
  return t;
}

/** Braces pair up (so unwrapping `{…}` takes the right ones). */
function balanced(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\') { i += 1; continue; }
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}' && --depth < 0) return false;
  }
  return depth === 0;
}
