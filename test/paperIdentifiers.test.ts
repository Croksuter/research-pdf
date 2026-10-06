import { describe, expect, it } from 'vitest';
import {
  type PaperMeta,
  arxivIdFromDoi,
  arxivIdYear,
  bestCitationCount,
  cleanMetaText,
  doiFromUrlPath,
  isGenericTitle,
  normalizeAuthorName,
  recordMatchesDocument,
  tidyPaperMeta,
  bestReferenceCount,
  citationHistory,
  classifyPaperKind,
  dedupeAuthors,
  formatApa,
  formatBibtex,
  identifiersFromText,
  identifiersFromUrl,
  mergeIdentifiers,
  normalizeArxivId,
  normalizeDoi,
  recentCitationSeries,
  recentTwoYearCitations,
  scholarLinks,
  titleMatchConfirmed,
  titleSimilarity,
} from '../src/shared/paperIdentifiers';

describe('identifiersFromUrl', () => {
  it('reads arXiv ids from abs/pdf URLs with or without versions', () => {
    expect(identifiersFromUrl('https://arxiv.org/pdf/2503.02881')).toEqual({ arxivId: '2503.02881' });
    expect(identifiersFromUrl('https://arxiv.org/abs/2503.02881v3')).toEqual({ arxivId: '2503.02881' });
    expect(identifiersFromUrl('https://arxiv.org/pdf/cs/0601001v2')).toEqual({ arxivId: 'cs/0601001' });
  });

  it('reads DOIs from doi.org and publisher URLs, ignoring arXiv DataCite DOIs', () => {
    expect(identifiersFromUrl('https://doi.org/10.1109/TPAMI.2016.2577031')).toEqual({ doi: '10.1109/tpami.2016.2577031' });
    expect(identifiersFromUrl('https://onlinelibrary.wiley.com/doi/pdf/10.1002/anie.202000001?download=true'))
      .toEqual({ doi: '10.1002/anie.202000001' });
    expect(identifiersFromUrl('https://www.nature.com/articles/s41586-020-2649-2.pdf')).toEqual({});
    expect(identifiersFromUrl('https://doi.org/10.48550/arXiv.2503.02881')).toEqual({});
    expect(identifiersFromUrl('file:///home/me/paper.pdf')).toEqual({});
  });
});

describe('identifiersFromText', () => {
  it('finds the arXiv stamp and DOI mentions on a first page', () => {
    const text = 'arXiv:2503.02881v3 [cs.RO] 23 Apr 2025 Reactive Diffusion Policy … https://doi.org/10.1109/TPAMI.2016.2577031. Abstract';
    expect(identifiersFromText(text)).toEqual({ arxivId: '2503.02881', doi: '10.1109/tpami.2016.2577031' });
  });

  it('trims trailing punctuation and prefers explicit doi: mentions', () => {
    expect(identifiersFromText('see 10.1000/xyz123). Later doi:10.5555/abc.def;')).toEqual({ doi: '10.5555/abc.def' });
    expect(identifiersFromText('DOI: 10.1038/s41586-020-2649-2.')).toEqual({ doi: '10.1038/s41586-020-2649-2' });
  });

  it('returns nothing for ordinary prose', () => {
    expect(identifiersFromText('The committee will deliberate on the proposal.')).toEqual({});
  });
});

describe('normalizeDoi / normalizeArxivId / arxivIdFromDoi / mergeIdentifiers', () => {
  it('normalizes forms', () => {
    expect(normalizeDoi('https://dx.doi.org/10.1000/ABC')).toBe('10.1000/abc');
    expect(normalizeDoi('doi: 10.1000/abc.')).toBe('10.1000/abc');
    expect(normalizeDoi('nope')).toBeNull();
    expect(normalizeArxivId('arXiv:2503.02881v2')).toBe('2503.02881');
    expect(normalizeArxivId('hep-th/9901001v1')).toBe('hep-th/9901001');
    expect(normalizeArxivId('12345')).toBeNull();
    expect(arxivIdFromDoi('10.48550/arxiv.2503.02881')).toBe('2503.02881');
    expect(arxivIdFromDoi('10.1109/x')).toBeNull();
  });

  it('merges with first-wins precedence', () => {
    expect(mergeIdentifiers({ doi: 'a' }, { doi: 'b', arxivId: 'x' })).toEqual({ doi: 'a', arxivId: 'x' });
  });
});

describe('titleSimilarity', () => {
  it('is tolerant to case, punctuation and diacritics but not to different papers', () => {
    expect(titleSimilarity('Faster R-CNN: Towards Real-Time Object Detection', 'faster r cnn towards real time object detection')).toBe(1);
    expect(titleSimilarity('Attention Is All You Need', 'Attention is all you need')).toBe(1);
    expect(titleSimilarity('Attention Is All You Need', 'Deep Residual Learning for Image Recognition')).toBeLessThan(0.3);
    expect(titleSimilarity('', 'x')).toBe(0);
  });
});

const META: PaperMeta = {
  title: 'Faster R-CNN: Towards Real-Time Object Detection with Region Proposal Networks',
  year: 2016,
  authors: ['Shaoqing Ren', 'Kaiming He', 'Ross Girshick', 'Jian Sun'],
  venue: 'IEEE Transactions on Pattern Analysis and Machine Intelligence',
  venueType: 'journal',
  workType: 'article',
  doi: '10.1109/tpami.2016.2577031',
  arxivId: null,
  openalexId: 'W639708223',
  citations: { openalex: 55724, crossref: 34998, semanticScholar: 75398 },
  citationsByYear: [{ year: 2026, count: 3661 }, { year: 2025, count: 7769 }, { year: 2024, count: 7551 }],
  references: { openalex: 60, crossref: 40, semanticScholar: 47 },
  venueTwoYearMeanCitedness: 12.3,
  volume: '39',
  issue: '6',
  firstPage: '1137',
  lastPage: '1149',
  landingUrl: 'https://doi.org/10.1109/tpami.2016.2577031',
};

const meta = (): PaperMeta => structuredClone(META);

describe('classifyPaperKind', () => {
  it('maps resolved metadata to the five reader-facing kinds', () => {
    expect(classifyPaperKind(META)).toBe('journal');
    expect(classifyPaperKind({ ...META, title: 'A survey of robotic manipulation' })).toBe('survey');
    expect(classifyPaperKind({ ...META, title: 'Tactile Robotics: An Outlook' })).toBe('survey');
    expect(classifyPaperKind({ ...META, workType: 'review', title: 'Anything' })).toBe('survey');
    expect(classifyPaperKind({ ...META, venue: 'Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition', venueType: 'conference' })).toBe('conference');
    expect(classifyPaperKind({ ...META, venue: 'NeurIPS 2023', venueType: null, workType: 'article' })).toBe('conference');
    expect(classifyPaperKind({ ...META, venue: 'Robotics: Science and Systems', venueType: null, workType: 'article' })).toBe('conference');
    expect(classifyPaperKind({ ...META, venue: 'MIT Technical Report TR-2020-01', venueType: null, workType: 'report' })).toBe('technical');
    expect(classifyPaperKind({ ...META, venue: null, venueType: null, workType: null, doi: null, arxivId: null })).toBe('technical');
    expect(classifyPaperKind({ ...META, venue: null, venueType: null, workType: null, arxivId: null })).toBe('journal');
    expect(classifyPaperKind({ ...META, venue: null, venueType: null, workType: 'dissertation' })).toBe('technical');
    expect(classifyPaperKind({ ...META, venue: 'arXiv (Cornell University)', venueType: 'repository', workType: 'preprint', doi: null, arxivId: '2503.02881' })).toBe('preprint');
    expect(classifyPaperKind({ ...META, venue: null, venueType: null, workType: null, doi: null, arxivId: '2503.02881' })).toBe('preprint');
    expect(classifyPaperKind({ ...META, venue: 'Nature', venueType: null, workType: null })).toBe('journal');
  });
});

describe('citation formatting', () => {
  it('formats APA for a journal article', () => {
    expect(formatApa(META)).toBe(
      'Ren, S., He, K., Girshick, R., & Sun, J. (2016). Faster R-CNN: Towards Real-Time Object Detection with Region Proposal Networks. '
      + 'IEEE Transactions on Pattern Analysis and Machine Intelligence, 39(6), 1137–1149. https://doi.org/10.1109/tpami.2016.2577031',
    );
  });

  it('drops repeated author names in APA and BibTeX', () => {
    const dup = { ...META, authors: ['Kai Peng', 'Kai  Peng', 'Qing Li', 'Xiaojiang Peng'] };
    expect(dedupeAuthors(dup.authors)).toEqual(['Kai Peng', 'Qing Li', 'Xiaojiang Peng']);
    expect(formatApa(dup)).toContain('Peng, K., Li, Q., & Peng, X. (2016).');
    expect(formatBibtex(dup)).toContain('author = {Kai Peng and Qing Li and Xiaojiang Peng},');
  });

  it('formats APA and BibTeX for an arXiv preprint', () => {
    const preprint: PaperMeta = {
      ...META,
      title: 'Reactive Diffusion Policy',
      year: 2025,
      authors: ['Han Xue', 'Jieji Ren'],
      venue: 'arXiv (Cornell University)',
      venueType: 'repository',
      workType: 'preprint',
      doi: null,
      arxivId: '2503.02881',
      volume: null, issue: null, firstPage: null, lastPage: null,
    };
    expect(formatApa(preprint)).toBe('Xue, H., & Ren, J. (2025). Reactive Diffusion Policy. arXiv. https://doi.org/10.48550/arXiv.2503.02881');
    const bib = formatBibtex(preprint);
    expect(bib).toContain('@misc{Xue2025reactive,');
    expect(bib).toContain('eprint = {2503.02881},');
    expect(bib).toContain('archivePrefix = {arXiv},');
    expect(bib.trimEnd().endsWith('}')).toBe(true);
    expect(bib).not.toMatch(/,\n\}$/u);
  });

  it('formats BibTeX for a journal article', () => {
    const bib = formatBibtex(META);
    expect(bib.startsWith('@article{Ren2016faster,')).toBe(true);
    expect(bib).toContain('author = {Shaoqing Ren and Kaiming He and Ross Girshick and Jian Sun},');
    expect(bib).toContain('journal = {IEEE Transactions on Pattern Analysis and Machine Intelligence},');
    expect(bib).toContain('pages = {1137--1149},');
    expect(bib).toContain('doi = {10.1109/tpami.2016.2577031},');
  });
});

describe('derived values', () => {
  it('picks the largest citation count across sources and the publisher\'s reference count', () => {
    expect(bestCitationCount(META)).toBe(75398);
    expect(bestCitationCount({ ...META, citations: { openalex: 0, crossref: null, semanticScholar: 195 } })).toBe(195);
    expect(bestReferenceCount(META)).toBe(40); // the publisher's own count
    expect(bestReferenceCount({ ...META, references: { openalex: 0, crossref: null, semanticScholar: 72 } })).toBe(72);
    expect(bestCitationCount({ ...META, citations: { openalex: null, crossref: null, semanticScholar: null } })).toBeNull();
    expect(bestReferenceCount({ ...META, references: { openalex: 0, crossref: null, semanticScholar: null } })).toBeNull();
  });

  it('builds a zero-padded 5-year citation series', () => {
    const series = recentCitationSeries(META, 5, new Date(2026, 8, 1));
    expect(series.map((s) => s.year)).toEqual([2022, 2023, 2024, 2025, 2026]);
    expect(series.map((s) => s.count)).toEqual([0, 0, 7551, 7769, 3661]);
  });

  it('builds a gap-free citation history with cumulative totals derived from the overall count', () => {
    const history = citationHistory(META, new Date(2026, 8, 1));
    expect(history.map((p) => p.year)).toEqual([2024, 2025, 2026]);
    expect(history.map((p) => p.count)).toEqual([7551, 7769, 3661]);
    // Total = max across sources (Semantic Scholar 75,398): through 2026 = 75,398; 2025 = − 3,661; 2024 = − 7,769.
    expect(history.map((p) => p.cumulative)).toEqual([75398 - 3661 - 7769, 75398 - 3661, 75398]);
    expect(citationHistory({ ...META, citationsByYear: [{ year: 2020, count: 5 }, { year: 2022, count: 1 }] }, new Date(2023, 0, 1)).map((p) => [p.year, p.count]))
      .toEqual([[2020, 5], [2021, 0], [2022, 1], [2023, 0]]);
    expect(citationHistory({ ...META, citationsByYear: [] })).toEqual([]);
    expect(citationHistory({ ...META, citations: { openalex: null, crossref: null, semanticScholar: null } }, new Date(2026, 0, 1))[0].cumulative).toBeNull();
  });

  it('sums the current and previous year citations', () => {
    expect(recentTwoYearCitations(META, new Date(2026, 8, 1))).toBe(7769 + 3661);
    expect(recentTwoYearCitations(META, new Date(2030, 0, 1))).toBe(0);
    expect(recentTwoYearCitations({ ...META, citationsByYear: [] })).toBeNull();
  });

  it('lists external links in a stable order', () => {
    expect(scholarLinks(META).map((l) => l.label)).toEqual(['OpenAlex', 'Semantic Scholar', 'DOI', 'Google Scholar']);
    expect(scholarLinks({ ...META, arxivId: '2503.02881', doi: null }).map((l) => l.label))
      .toEqual(['OpenAlex', 'arXiv', 'Semantic Scholar', 'Google Scholar']);
  });
});

describe('paper strip audit fixes', () => {
  it('detects identifiers the way papers actually print them', () => {
    // An unannounced submission stamp is not an arXiv id.
    expect(identifiersFromText('arXiv:submit/4812508 [cs.CL] 27 Mar 2023').arxivId).toBeUndefined();
    expect(identifiersFromUrl('https://arxiv.org/abs/submit/4812508').arxivId).toBeUndefined();
    // bioRxiv/medRxiv URLs carry the version and file after the DOI.
    expect(identifiersFromUrl('https://www.biorxiv.org/content/10.1101/2020.11.25.393017v7.full.pdf').doi).toBe('10.1101/2020.11.25.393017');
    expect(identifiersFromUrl('https://link.springer.com/content/pdf/10.1007/s11263-015-0816-y.pdf').doi).toBe('10.1007/s11263-015-0816-y');
    expect(identifiersFromUrl('https://onlinelibrary.wiley.com/doi/pdf/10.1002/anie.201915678').doi).toBe('10.1002/anie.201915678');
    expect(doiFromUrlPath('10.1371/journal.pone.0130140')).toBe('10.1371/journal.pone.0130140');
    // A DOI broken at a line end.
    expect(identifiersFromText('https://doi.org/10.1145/3788646. 3789535 Permission to make').doi).toBe('10.1145/3788646.3789535');
    expect(identifiersFromText('doi:10.1000/182. 2019 was a year').doi).toBe('10.1000/182');
    expect(arxivIdYear('1706.03762')).toBe(2017);
    expect(arxivIdYear('hep-th/9711200')).toBe(1997);
    expect(arxivIdYear('math/0211159')).toBe(2002);
  });

  it('ignores placeholder metadata titles', () => {
    for (const t of ['PowerPoint Presentation', 'Microsoft Word - final_v3.docx', 'Untitled', 'main.tex', 'Slide 1']) expect(isGenericTitle(t)).toBe(true);
    expect(isGenericTitle('Metrics for Improved Reanalyses in Polar Regions')).toBe(false);
  });

  it('tells whether a looked-up record is the open document', () => {
    const page = 'The entropy formula for the Ricci flow and its geometric applications Grisha Perelman We present a monotonic expression';
    expect(recordMatchesDocument('The entropy formula for the Ricci flow and its geometric applications', [], page)).toBe(true);
    expect(recordMatchesDocument('Análisis Comparativo y Refutación Determinista de la Incertidumbre Cuántica', [], page)).toBe(false);
    expect(recordMatchesDocument('Dark Matter as a Topological Vacuum Condensate', ['Planck 2018 results. VI. Cosmological parameters'], 'Planck 2018 results. VI. Cosmological parameters Planck Collaboration')).toBe(false);
  });

  it('cleans metadata text and names', () => {
    expect(cleanMetaText('Journal of Business &amp; Economic Statistics')).toBe('Journal of Business & Economic Statistics');
    expect(cleanMetaText('The Large $N$ Limit of <i>Superconformal</i> Field Theories')).toBe('The Large N Limit of Superconformal Field Theories');
    expect(normalizeAuthorName('JUAN M. MALDACENA')).toBe('Juan M. Maldacena');
    expect(normalizeAuthorName('Aidan N.Gomez')).toBe('Aidan N. Gomez');
    expect(normalizeAuthorName('Ruslan Salakhutdinov')).toBe('Ruslan Salakhutdinov');
    const tidy = tidyPaperMeta({ ...meta(), venue: 'arXiv (Cornell University)', authors: ['Yushuo Chen', 'Peiyu Liu', 'Yushuo  Chen'] });
    expect(tidy.venue).toBe('arXiv');
    expect(tidy.authors).toEqual(['Yushuo Chen', 'Peiyu Liu']);
  });

  it('formats names, groups and conference papers in APA / BibTeX', () => {
    const m = { ...meta(), authors: ['Neil P. Chue Hong', 'Klaus-Robert Müller', 'Planck Collaboration'], authorFamilies: ['Chue Hong', 'Müller', null] };
    expect(formatApa(m)).toMatch(/^Chue Hong, N\. P\., Müller, K\.-R\., & Planck Collaboration \(/u);
    const conf = formatBibtex({ ...meta(), arxivId: null, doi: null, venue: 'Neural Information Processing Systems', venueType: 'conference' });
    expect(conf).toMatch(/^@inproceedings\{/u);
    expect(conf).toContain('booktitle = {Neural Information Processing Systems}');
  });

  it('prefers the publisher\'s reference count', () => {
    expect(bestReferenceCount({ ...meta(), references: { crossref: 46, openalex: 50, semanticScholar: 61 } })).toBe(46);
    expect(bestReferenceCount({ ...meta(), references: { crossref: null, openalex: 2, semanticScholar: 46 } })).toBe(46);
  });
});

describe('title-only matches', () => {
  const lecun = { authors: ['Yann LeCun', 'Yoshua Bengio', 'Geoffrey Hinton'] };

  it('a talk called "Deep Learning" is not LeCun et al.\'s review, though the titles are equal', () => {
    expect(titleSimilarity('Deep Learning', 'Deep learning')).toBe(1);
    const slides = 'Deep Learning Lecture 1: Introduction Prof. Minsu Kim Department of Computer Science Spring 2024';
    expect(titleMatchConfirmed(lecun, slides)).toBe(false);
  });

  it('the review itself names its first author on page 1', () => {
    const page = 'REVIEW doi:10.1038/nature14539 Deep learning Yann LeCun 1,2 , Yoshua Bengio 3 & Geoffrey Hinton 4,5 Deep learning allows';
    expect(titleMatchConfirmed(lecun, page)).toBe(true);
    expect(titleMatchConfirmed(lecun, page.toUpperCase())).toBe(true);
  });

  it('the surname must be a whole word, and the source\'s own surname is used', () => {
    expect(titleMatchConfirmed({ authors: ['A. Li'] }, 'Linear models for lists')).toBe(false);
    expect(titleMatchConfirmed({ authors: ['A. Li'] }, 'Anna Li, MIT')).toBe(true);
    expect(titleMatchConfirmed({ authors: ['Neil P. Chue Hong'], authorFamilies: ['Chue Hong'] }, 'by Neil Chue Hong and others')).toBe(true);
    expect(titleMatchConfirmed({ authors: ['Neil P. Chue Hong'], authorFamilies: ['Chue Hong'] }, 'Hong Kong University')).toBe(false);
  });

  it('CJK names match as a whole name, spaces or not', () => {
    expect(titleMatchConfirmed({ authors: ['홍길동'] }, '딥러닝 개론 홍길동, 김철수 한국대학교')).toBe(true);
    expect(titleMatchConfirmed({ authors: ['홍 길동'] }, '딥러닝 개론 홍길동')).toBe(true);
    expect(titleMatchConfirmed({ authors: ['홍길동'] }, '딥러닝 개론 김철수')).toBe(false);
  });

  it('cannot confirm without a first author or page text', () => {
    expect(titleMatchConfirmed({ authors: [] }, 'anything at all')).toBe(false);
    expect(titleMatchConfirmed(lecun, '')).toBe(false);
  });
});
