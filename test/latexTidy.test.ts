import { describe, expect, it } from 'vitest';
import { decodeTokens, tidyLatex } from '../src/shared/latexTidy';

// Raw outputs of the bundled formula model (pix2text-mfr-1.5, int8) on
// rendered formulas and crops of "Attention Is All You Need".
describe('tidyLatex', () => {
  it('drops the spaces math mode ignores', () => {
    expect(tidyLatex('E = m c ^ { 2 }')).toBe('E=mc^{2}');
    expect(tidyLatex('\\frac { - b \\pm \\sqrt { b ^ { 2 } - 4 a c } } { 2 a }')).toBe('\\frac{-b\\pm\\sqrt{b^{2}-4ac}}{2a}');
    expect(tidyLatex('\\mathrm { s o f t m a x } ( Q K ^ { \\top } / \\sqrt { d _ { k } } ) V')).toBe('\\mathrm{softmax}(QK^{\\top}/\\sqrt{d_{k}})V');
  });

  it('keeps a space ending a control word before a letter, and control spaces', () => {
    expect(tidyLatex('s t e p \\cdot w a r m u p')).toBe('step\\cdot warmup');
    expect(tidyLatex('a \\ b')).toBe('a\\ b');
    // `\\` is a line break: the x after it needs no space.
    expect(tidyLatex('a \\\\ x')).toBe('a\\\\x');
  });

  it('unwraps a one-row aligned block, and keeps real alignment', () => {
    expect(tidyLatex('\\begin{aligned} { \\int _ { 0 } ^ { \\infty } e ^ { - x ^ { 2 } } \\, d x = \\frac { \\sqrt { \\pi } } { 2 } } \\\\ \\end{aligned}'))
      .toBe('\\int_{0}^{\\infty}e^{-x^{2}}\\,dx=\\frac{\\sqrt{\\pi}}{2}');
    const two = tidyLatex('\\begin{aligned} { a } & { { } = b } \\\\ { c } & { { } = d } \\\\ \\end{aligned}');
    expect(two).toBe('\\begin{aligned}{a}&{{}=b}\\\\{c}&{{}=d}\\\\\\end{aligned}');
    // Two brace groups side by side are not one: not unwrapped.
    expect(tidyLatex('\\begin{aligned} { a } { b } \\\\ \\end{aligned}')).toBe('\\begin{aligned}{a}{b}\\\\\\end{aligned}');
  });

  it('drops empty scripts and names operators', () => {
    expect(tidyLatex('\\begin{aligned} { \\mathcal { L } ( \\theta ) = - \\sum _ { i = 1 } ^ { N } \\ \\operatorname { l o g } p _ { \\theta } ^ { } ( y _ { i } ^ { } \\mid x _ { i } ^ { } ) } \\\\ \\end{aligned}'))
      .toBe('\\mathcal{L}(\\theta)=-\\sum_{i=1}^{N}\\ \\log p_{\\theta}(y_{i}\\mid x_{i})');
    expect(tidyLatex('\\mathrm { F F N } ( x ) = \\operatorname* { m a x } ( 0 , x W _ { 1 } + b _ { 1 } )')).toBe('\\mathrm{FFN}(x)=\\max(0,xW_{1}+b_{1})');
    expect(tidyLatex('\\operatorname { s o f t p l u s } ( x )')).toBe('\\operatorname{softplus}(x)');
    // An escaped caret or underscore is text, not a script.
    expect(tidyLatex('a \\_ { } b')).toBe('a\\_{}b');
  });
});

describe('decodeTokens', () => {
  it('reads byte-level BPE pieces, Ġ as a space', () => {
    expect(decodeTokens(['\\frac', 'Ġ{', 'Ġ1', 'Ġ}'])).toBe('\\frac { 1 }');
    // Multi-byte UTF-8 split over pieces.
    expect(decodeTokens(['Ã', '©'])).toBe('é');
  });
});
