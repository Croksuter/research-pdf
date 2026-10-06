// ─── What a PDF says about itself: identifiers, titles, first-page text ───
//
// DOI / arXiv id from the source URL, the metadata (Info and XMP) and the
// first page's text; titles from the metadata (placeholders ignored) and the
// largest text near the top of page 1. The page text is also what looked-up
// records are checked against.

import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  type PaperIdentifiers,
  identifiersFromText,
  identifiersFromUrl,
  isGenericTitle,
  mergeIdentifiers,
  normalizeTitle,
} from '../../shared/paperIdentifiers';

// Whole first page: the arXiv margin stamp is rotated text and comes last in
// the item order, so a short cap used to miss it.
const FIRST_PAGE_TEXT_LIMIT = 20_000;

/** What the PDF itself says, to check looked-up records against. */
export interface DocumentEvidence { titles: string[]; pageText: string }

interface TextItemLike { str: string; height: number; transform: number[] }

async function firstPageText(doc: PDFDocumentProxy): Promise<{ text: string; bigTitle: string | null }> {
  try {
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const items = (content.items as unknown as Array<Partial<TextItemLike>>)
      .filter((it): it is TextItemLike => typeof it.str === 'string' && typeof it.height === 'number' && Array.isArray(it.transform));
    const text = items.map((it) => it.str).join(' ').slice(0, FIRST_PAGE_TEXT_LIMIT);
    // Title heuristic: the tallest glyph runs near the top of the page.
    const viewport = page.getViewport({ scale: 1 });
    const maxHeight = Math.max(0, ...items.map((it) => it.height));
    const topBand = viewport.height * 0.55;
    const big = items
      .filter((it) => it.height >= maxHeight * 0.85 && it.str.trim() && (viewport.height - it.transform[5]) <= topBand)
      .map((it) => it.str.trim());
    const bigTitle = big.join(' ').replace(/\s+/gu, ' ').trim();
    return { text, bigTitle: bigTitle.length >= 12 && bigTitle.length <= 300 ? bigTitle : null };
  } catch {
    return { text: '', bigTitle: null };
  }
}

async function metadataIdentifiers(doc: PDFDocumentProxy): Promise<{ ids: PaperIdentifiers; title: string | null }> {
  try {
    const { info, metadata } = await doc.getMetadata();
    const rec = (info ?? {}) as Record<string, unknown>;
    const fields = ['Subject', 'Keywords', 'Title', 'doi', 'DOI'].map((k) => String(rec[k] ?? '')).join(' ');
    let xmp = '';
    try {
      const md = metadata as { getAll?: () => Record<string, unknown> } | null;
      const all = md?.getAll?.() ?? {};
      xmp = Object.values(all).map((v) => (typeof v === 'string' ? v : '')).join(' ');
    } catch {
      /* no XMP */
    }
    const title = typeof rec.Title === 'string' && rec.Title.trim().length >= 12 && !/\.pdf$/iu.test(rec.Title.trim())
      ? rec.Title.trim()
      : null;
    return { ids: identifiersFromText(`${fields} ${xmp}`), title };
  } catch {
    return { ids: {}, title: null };
  }
}

/** What a document says about itself, and the cache key a lookup goes under. */
export interface PaperEvidence {
  ids: PaperIdentifiers;
  titles: string[];
  evidence: DocumentEvidence;
  key: string | null;
  /** The PDF's own Title metadata, when it names something. */
  docTitle: string | null;
}

export function paperCacheKey(ids: PaperIdentifiers, titles: readonly string[]): string | null {
  return ids.doi ?? (ids.arxivId ? `arxiv:${ids.arxivId}` : titles[0] ? `title:${normalizeTitle(titles[0])}` : null);
}

export async function paperEvidence(doc: PDFDocumentProxy, sourceUrl: string | null): Promise<PaperEvidence> {
  const [fromMeta, page] = await Promise.all([metadataIdentifiers(doc), firstPageText(doc)]);
  const ids = mergeIdentifiers(sourceUrl ? identifiersFromUrl(sourceUrl) : {}, fromMeta.ids, identifiersFromText(page.text));
  const titles = [fromMeta.title, page.bigTitle].filter((t): t is string => !!t && !isGenericTitle(t));
  const docTitle = fromMeta.title && !isGenericTitle(fromMeta.title) ? fromMeta.title : null;
  return { ids, titles, evidence: { titles, pageText: page.text }, key: paperCacheKey(ids, titles), docTitle };
}
