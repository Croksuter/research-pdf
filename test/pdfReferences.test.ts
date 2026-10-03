import { describe, expect, it } from 'vitest';

import { extractPdfReferences, joinEntryLines, linesFromTextItems, parseReferenceEntry, type TextLine } from '../src/shared/pdfReferences';

/** Lines of one column, top down, 12 pt apart; `indent` marks continuation lines. */
function column(page: number, texts: Array<string | [string, number]>, opts: { x?: number; top?: number; column?: number; h?: number } = {}): TextLine[] {
  const { x = 72, top = 700, column: col = 0, h = 9 } = opts;
  return texts.map((t, i) => {
    const [text, indent] = typeof t === 'string' ? [t, 0] : t;
    return { page, column: col, x: x + indent, y: top - i * 12, h, text };
  });
}

describe('PDF reference list', () => {
  it('splits a numbered list and stops at the appendix heading', () => {
    const lines = [
      ...column(1, ['Introduction text that mentions references in passing.']),
      { page: 9, column: 0, x: 72, y: 760, h: 12, text: 'References' },
      ...column(9, [
        '[1] K. He, X. Zhang, S. Ren, and J. Sun. Deep residual learning for image',
        ['recognition. In CVPR, 2016.', 10],
        '[2] A. Vaswani et al. Attention is all you need. In NeurIPS, 2017.',
        '[3] D. P. Kingma and J. Ba. Adam: A method for stochastic optimization.',
        ['arXiv preprint arXiv:1412.6980, 2014.', 10],
      ]),
      { page: 10, column: 0, x: 72, y: 760, h: 12, text: 'A Proofs' },
      ...column(10, ['[4] This is not a reference but appendix text with a number.']),
    ];
    const refs = extractPdfReferences(lines);
    expect(refs.map((r) => [r.index, r.title, r.year])).toEqual([
      [1, 'Deep residual learning for image recognition', 2016],
      [2, 'Attention is all you need', 2017],
      [3, 'Adam: A method for stochastic optimization', 2014],
    ]);
    expect(refs[2].arxivId).toBe('1412.6980');
    expect(refs[0].authors).toEqual(['K. He', 'X. Zhang', 'S. Ren', 'J. Sun']);
  });

  it('splits an author–year list by its hanging indent, across pages and columns', () => {
    const lines = [
      { page: 12, column: 0, x: 72, y: 720, h: 11, text: 'References' },
      ...column(12, [
        'Iz Beltagy, Matthew E. Peters, and Arman Cohan. Longformer: The long-document transformer.',
        ['In Findings of EMNLP, 2020. URL https:', 8],
        ['//arxiv.org/abs/2004.05150.', 8],
        'Tianle Cai, Yuhong Li, and Tri Dao. Medusa: Simple llm inference acceleration framework. arXiv',
        ['preprint arXiv:2401.10774, 2024.', 8],
      ], { top: 700 }),
      ...column(12, [
        'Mark Chen, Jerry Tworek, et al. Evaluating large language models trained on code, 2021.',
      ], { x: 320, column: 1 }),
      ...column(13, [
        'Yinmin Zhong and Hao Zhang. Distserve: Disaggregating prefill and decoding for goodput-opti-',
        ['mized large language model serving. In OSDI, 2024.', 8],
      ]),
    ];
    const refs = extractPdfReferences(lines);
    expect(refs.map((r) => r.title)).toEqual([
      'Longformer: The long-document transformer',
      'Medusa: Simple llm inference acceleration framework',
      'Evaluating large language models trained on code',
      'Distserve: Disaggregating prefill and decoding for goodput-optimized large language model serving',
    ]);
    // The arXiv id is not read as the year 2004; the broken URL is joined.
    expect(refs[0]).toMatchObject({ year: 2020, arxivId: '2004.05150' });
    expect(refs[0].raw).toContain('https://arxiv.org/abs/2004.05150');
  });

  it('returns nothing without a references heading, and ignores running heads', () => {
    expect(extractPdfReferences(column(1, ['Just a document.', 'With lines.']))).toEqual([]);
    const head = (page: number) => ({ page, column: 0, x: 72, y: 780, h: 8, text: 'Preprint. Under review.' });
    const refs = extractPdfReferences([
      head(1), head(2), head(3),
      { page: 3, column: 0, x: 72, y: 740, h: 11, text: 'Bibliography' },
      ...column(3, ['1. Smith J, Doe A (2019) A study of things. Nature 1: 1–2.', '2. Roe B (2020) Another study of things. Science 2: 3–4.']),
    ]);
    expect(refs.map((r) => r.title)).toEqual(['A study of things', 'Another study of things']);
  });

  it('reads titles in the usual citation styles', () => {
    expect(parseReferenceEntry('A. Author and B. Writer, "A quoted IEEE title," in Proc. ICRA, 2019, pp. 1–8.', 1)).toMatchObject({ title: 'A quoted IEEE title', year: 2019 });
    expect(parseReferenceEntry('Akbik, A., Blythe, D. (2018). Contextual string embeddings. In COLING.', 1)).toMatchObject({ title: 'Contextual string embeddings', year: 2018 });
    expect(parseReferenceEntry('Alan Akbik and Roland Vollgraf. 2018. Contextual string embeddings for sequence labeling. In COLING.', 1).title).toBe('Contextual string embeddings for sequence labeling');
    expect(parseReferenceEntry('Hinton, G.E. and Salakhutdinov, R.R. Reducing the dimensionality of data with neural networks. Science, 313:504–507, 2006.', 1))
      .toMatchObject({ title: 'Reducing the dimensionality of data with neural networks', authors: ['Hinton, G.E', 'Salakhutdinov, R.R'] });
    expect(parseReferenceEntry('W. L. Briggs, S. F. McCormick, et al. A Multigrid Tutorial. Siam, 2000.', 1).title).toBe('A Multigrid Tutorial');
    expect(parseReferenceEntry('(2003) Microarray policy. Nat Immunol 4: 93.', 1).title).toBe('Microarray policy');
    expect(parseReferenceEntry('J. Doe. Some paper. doi:10.1145/3600006.3613165.', 1).doi).toBe('10.1145/3600006.3613165');
    expect(joinEntryLines(['Mohammad Bavar-', 'ian and others.'])).toBe('Mohammad Bavarian and others.');
  });

  it('builds lines from text items, the left column first on a two-column page', () => {
    const item = (str: string, x: number, y: number) => ({ str, transform: [9, 0, 0, 9, x, y], width: str.length * 4, height: 9 });
    const lines = linesFromTextItems(1, [
      item('right one', 320, 700), item('left one', 72, 700), item('left', 72, 688), item('two', 92, 688),
      item('right two', 320, 688), item('left three', 72, 676), item('right three', 320, 676),
    ], 612);
    expect(lines.map((l) => [l.column, l.text])).toEqual([
      [0, 'left one'], [0, 'left two'], [0, 'left three'],
      [1, 'right one'], [1, 'right two'], [1, 'right three'],
    ]);
  });
});

describe('PDF reference list, more layouts', () => {
  it('reads a line-numbered manuscript and Science-style entries', () => {
    const lines = [
      ...column(1, ['1 Title of the manuscript', '2 Some introduction text', '3 more text'], { top: 700 }),
      ...column(9, ['255 Bibliography', '257 1. O. Sporns, G. Tononi, R. Kötter, The Human Connectome: A Structural Description of the',
        '258 Human Brain. PLoS Comput. Biol. 1, e42 (2005).', '259 2. J. Goni, et al., Resting-brain functional connectivity predicted by analytic measures.',
        '260 Proc. Natl. Acad. Sci. U. S. A. 111, 833–838 (2014).'], { top: 700 }),
    ];
    const refs = extractPdfReferences(lines);
    expect(refs.map((r) => [r.index, r.title, r.year])).toEqual([
      [1, 'The Human Connectome: A Structural Description of the Human Brain', 2005],
      [2, 'Resting-brain functional connectivity predicted by analytic measures', 2014],
    ]);
    expect(refs[0].authors).toEqual(['O. Sporns', 'G. Tononi', 'R. Kötter']);
  });
});
