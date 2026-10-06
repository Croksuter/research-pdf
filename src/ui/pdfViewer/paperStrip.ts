// Paper strip: when the open PDF is a scholarly paper, a row under the toolbar
// shows venue / year, citation count (+ 5-year trend), the venue's 2-year mean
// citedness (the Impact-Factor definition, from OpenAlex), reference count,
// external links, and BibTeX / APA copy buttons.
//
// Detection: DOI or arXiv id from the source URL, the PDF metadata, or the
// first page's text; otherwise the largest-font text on page 1 is title-
// searched and accepted only above TITLE_MATCH_THRESHOLD and with the
// record's first author named on page 1 (shown as "matched by title"). Data
// comes from OpenAlex and Crossref, both of which answer with `Access-Control-
// Allow-Origin: *`, so no extra host permission is needed. Google Scholar has
// no API and is linked, not scraped. Results are cached for a week
// (paperCache.ts).

import type { PDFDocumentProxy } from 'pdfjs-dist';
import { debugError, debugLog } from '../../shared/debugLog';
import {
  type PaperMeta,
  bestCitationCount,
  bestReferenceCount,
  citationHistory,
  classifyPaperKind,
  formatApa,
  formatBibtex,
  formatCount,
  recentCitationSeries,
  recentTwoYearCitations,
  scholarLinks,
  tidyPaperMeta,
  titleMatchConfirmed,
} from '../../shared/paperIdentifiers';
import { byId, el } from './dom';
import { OPENALEX_BUDGET_REASON, openAlexBudgetSpent } from './openAlexAccess';
import { buildCitationChart } from './paperChart';
import { paperCacheKey, paperEvidence } from './paperEvidence';
import { ReferenceList } from './paperRefs';
import { dropCachedMeta, enrich, loadPaperSettings, readCachedMeta, resolvePrimary, s2Unavailable, writeCachedMeta } from './paperResolve';
import { crossrefBibtex, newLookup, s2Headers } from './paperSources';
import { pdfReferences } from './pdfText';
import { S } from './paper.strings';

// What other pages use (ui/pdfUpkeep.ts), from where it lives now.
export { paperCacheKey, paperEvidence, type PaperEvidence } from './paperEvidence';
export { cachedPaperMeta, loadPaperSettings, lookupPaperQuietly, normalizeMeta } from './paperResolve';

// Right after Chrome starts, requests from extension pages can stall for
// ~20 s (observed in fresh profiles); a lookup that failed only because of
// aborted/errored fetches is retried once after this delay.
const NETWORK_RETRY_DELAY_MS = 15_000;

const kindTitles = (): Record<string, string> => ({
  survey: S.kindSurvey,
  conference: S.kindConference,
  journal: S.kindJournal,
  technical: S.kindTechnical,
  preprint: S.kindPreprint,
});

// ─── UI ───

export class PaperStrip {
  private readonly root = byId<HTMLElement>('vocab-t-pdf-paper');
  private readonly body = byId<HTMLDivElement>('vt-paper-body');
  private readonly closeBtn = byId<HTMLButtonElement>('vt-paper-close');
  private readonly reparseBtn = byId<HTMLButtonElement>('vt-paper-reparse');
  private generation = 0;
  private current: { doc: PDFDocumentProxy; sourceUrl: string | null } | null = null;
  /** Documents (by fingerprint) whose strip the reader closed in this page. */
  private readonly dismissed = new Set<string>();
  private meta: PaperMeta | null = null;
  private bibtexCache: string | null = null;
  private readonly refs = new ReferenceList();

  /**
   * @param onLayoutChange called whenever the strip appears/disappears; the
   *   viewer container's top edge moves, so PDF.js must re-measure (the host
   *   dispatches its `resize` event, exactly as for the sidebar toggle).
   * @param onPaperMeta called with the resolved paper (its title names the
   *   document better than a file name like `2401.12345`).
   */
  constructor(private readonly onLayoutChange: () => void, private readonly onPaperMeta?: (meta: PaperMeta) => void) {
    this.closeBtn.addEventListener('click', () => this.dismiss());
    this.reparseBtn.addEventListener('click', () => {
      if (this.current) void this.show(this.current.doc, this.current.sourceUrl, { fresh: true });
    });
  }

  /** The resolved paper of the open document, if any. */
  get paperMeta(): PaperMeta | null {
    return this.meta;
  }

  /** × : the strip stays closed for this document, and a lookup still running stops. */
  dismiss(): void {
    this.generation += 1;
    const fingerprint = this.current?.doc.fingerprints[0];
    if (fingerprint) this.dismissed.add(fingerprint);
    this.hide();
  }

  hide(): void {
    const wasVisible = !this.root.hidden;
    this.root.hidden = true;
    document.body.classList.remove('vt-has-paper');
    this.refs.reset();
    if (wasVisible) this.onLayoutChange();
  }

  /** Kicks off the background reference lookup for a fully resolved meta. */
  private startReferences(meta: PaperMeta, key: string): void {
    void this.loadReferences(meta, key, this.generation);
  }

  /**
   * OpenAlex's list, else Semantic Scholar's (skipped when it was just rate
   * limited: the retries would only delay the next step), else the list
   * printed in the PDF.
   */
  private async loadReferences(meta: PaperMeta, key: string, gen: number): Promise<void> {
    // A database list far shorter than the paper's count (OpenAlex knowing 2
    // of 65) is replaced by the PDF's own list when that one is longer.
    const expected = bestReferenceCount(meta);
    const enough = () => this.refs.size > 0 && (expected === null || this.refs.size >= expected * 0.6);
    let loaded = false;
    if (meta.referencedWorks && meta.referencedWorks.length > 0) loaded = await this.refs.load(meta.referencedWorks, key);
    if (gen !== this.generation) return;
    const s2Limited = s2Unavailable.has(meta);
    if ((!loaded || !enough()) && meta.s2PaperId && !s2Limited) {
      const before = loaded ? this.refs.size : 0;
      const s2 = await this.refs.loadFromSemanticScholar(meta.s2PaperId, key, s2Headers());
      if (s2 && this.refs.size < before && meta.referencedWorks?.length) await this.refs.load(meta.referencedWorks, key);
      loaded = loaded || s2;
    }
    if (gen !== this.generation || !this.current) return;
    if (loaded && enough()) return;
    const refs = await pdfReferences(this.current.doc);
    if (gen !== this.generation) return;
    if (loaded && refs.length <= this.refs.size) return;
    const databases = openAlexBudgetSpent()
      ? S.refsBudgetSpent(s2Limited)
      : s2Limited
      ? S.refsS2Limited
      : meta.openalexId || meta.s2PaperId ? S.refsNoList : S.refsPaperNotFound;
    await this.refs.loadFromPdf(refs, key, S.refsNotInPdfEither(databases));
  }

  /**
   * Detects whether `doc` is a paper and renders the strip: the paper's data,
   * or a quiet "not a paper" note — reading never depends on it. `fresh`
   * (the 재파싱 button) skips and drops the cached lookup.
   */
  async show(doc: PDFDocumentProxy, sourceUrl: string | null, { fresh = false } = {}): Promise<void> {
    const gen = ++this.generation;
    this.current = { doc, sourceUrl };
    this.hide();
    this.meta = null;
    this.bibtexCache = null;
    if (this.dismissed.has(doc.fingerprints[0] ?? '')) return;
    try {
      if (!(await loadPaperSettings())) {
        debugLog('paper', 'paper info disabled by setting');
        return;
      }
      const { ids, titles, evidence } = await paperEvidence(doc, sourceUrl);
      if (gen !== this.generation) return;
      debugLog('paper', 'detection', () => ({ ids, titles, textSample: evidence.pageText.slice(0, 160) }));
      if (!ids.doi && !ids.arxivId && titles.length === 0) {
        this.renderStatus('none', S.notRecognized, S.notRecognizedNoIds);
        return;
      }
      const what = ids.doi ? S.whatDoi(ids.doi) : ids.arxivId ? S.whatArxiv(ids.arxivId) : S.whatTitle(titles[0].length > 60 ? `${titles[0].slice(0, 60).trimEnd()}…` : titles[0]);
      this.renderStatus('loading', S.lookingUp(what));

      const key = paperCacheKey(ids, titles) as string;
      if (fresh) await dropCachedMeta(key);
      // A title-only match is checked against this document again: another
      // document with the same title shares the key.
      const hit = fresh ? null : await readCachedMeta(key);
      const cached = hit && (hit.matchedBy !== 'title' || titleMatchConfirmed(hit, evidence.pageText)) ? hit : null;
      if (cached) {
        debugLog('paper', 'resolved (cache)', () => ({ key, meta: cached }));
        if (gen !== this.generation) return;
        this.meta = tidyPaperMeta(cached);
        this.render(this.meta);
        this.startReferences(this.meta, key);
        return;
      }
      const ctx = newLookup();
      let primary = await resolvePrimary(ctx, ids, titles, evidence);
      if (!primary && ctx.networkFailures > 0 && gen === this.generation) {
        debugLog('paper', `lookup hit ${ctx.networkFailures} network failure(s); retrying in ${NETWORK_RETRY_DELAY_MS}ms`);
        await new Promise((r) => setTimeout(r, NETWORK_RETRY_DELAY_MS));
        if (gen !== this.generation) return;
        primary = await resolvePrimary(ctx, ids, titles, evidence);
      }
      debugLog('paper', primary ? 'resolved (primary)' : 'no match', () => ({ key, meta: primary?.meta }));
      if (gen !== this.generation) return;
      if (!primary) {
        // A transient failure or a DOI/arXiv id nobody knows is worth a
        // warning; a title nobody knows most likely just isn't a paper.
        if (openAlexBudgetSpent()) {
          this.renderStatus('failed', `${what}: ${OPENALEX_BUDGET_REASON}`);
        } else if (ctx.networkFailures > 0) {
          this.renderStatus('failed', S.lookupFailedNetwork(what));
        } else if (ctx.limited.has('Semantic Scholar')) {
          this.renderStatus('failed', S.lookupFailedS2Limited(what));
        } else if (ctx.limited.size > 0) {
          this.renderStatus('failed', S.lookupFailedLimited(what, [...ctx.limited].join('·')));
        } else if (ids.doi || ids.arxivId) {
          this.renderStatus('failed', S.lookupFailedNotFound(what));
        } else {
          this.renderStatus('none', S.notRecognized, S.notRecognizedSearched(what));
        }
        return;
      }
      this.meta = tidyPaperMeta(primary.meta);
      this.render(this.meta);
      const raw = await enrich(ctx, primary);
      const enriched = tidyPaperMeta(raw);
      if (s2Unavailable.has(raw)) s2Unavailable.add(enriched);
      if (gen !== this.generation) return;
      debugLog('paper', 'enriched', () => ({ key, meta: enriched }));
      this.meta = enriched;
      this.bibtexCache = null;
      this.render(enriched);
      this.startReferences(enriched, key);
      // A lookup that Semantic Scholar rate-limited is incomplete: leave it
      // uncached so the next open tries again.
      if (!s2Unavailable.has(enriched) && !openAlexBudgetSpent()) void writeCachedMeta(key, enriched);
    } catch (error) {
      debugError('paper', 'paper strip failed', () => ({ error: error instanceof Error ? error.message : String(error) }));
      if (gen === this.generation) {
        this.renderStatus('failed', S.processingError(error instanceof Error ? error.message : String(error)));
      }
    }
  }

  /**
   * Strip with only the 논문정보 label and a status: 조회 중, ⚠︎ reason, or a
   * neutral "not a paper" note (`detail` on hover). Retrying is the 재파싱
   * button's job.
   */
  private renderStatus(kind: 'loading' | 'failed' | 'none', text: string, detail?: string): void {
    this.body.replaceChildren();
    const value = el('span', { className: 'vt-paper-value vt-paper-status', title: detail });
    if (kind === 'loading') {
      value.append(el('span', { className: 'vt-paper-spinner', 'aria-hidden': 'true' }), text);
    } else if (kind === 'failed') {
      value.append(el('span', { className: 'vt-warn-inline', textContent: '⚠︎ ' }), text);
    } else {
      value.append(text);
    }
    this.body.append(el('span', { className: 'vt-paper-seg' }, [el('span', { className: 'vt-paper-label', textContent: S.paperInfo }), value]));
    const wasHidden = this.root.hidden;
    this.root.hidden = false;
    document.body.classList.add('vt-has-paper');
    if (wasHidden) this.onLayoutChange();
  }

  private render(meta: PaperMeta): void {
    if (meta.title.trim()) this.onPaperMeta?.(meta);
    this.body.replaceChildren();
    const segment = (label: string, children: Array<Node | string>, title?: string) => el('span', { className: 'vt-paper-seg', title }, [
      el('span', { className: 'vt-paper-label', textContent: label }),
      el('span', { className: 'vt-paper-value' }, children),
    ]);
    // Missing data is never rendered as 0 or a default: a ⚠︎ with a one-line
    // reason on hover takes the value's place.
    const warn = (reason: string) => {
      const w = el('span', { className: 'vt-warn', tabindex: '0', role: 'img', 'aria-label': S.noInfo(reason) }, ['⚠︎']);
      w.append(el('span', { className: 'vt-warn-pop', textContent: reason }));
      return w;
    };
    const join = (parts: Array<Node | string | null>, sep = ' · ') => {
      const out: Array<Node | string> = [];
      for (const part of parts) { if (part === null) continue; if (out.length) out.push(sep); out.push(part); }
      return out;
    };

    // ── 논문정보: kind badge · venue · year, with a hover popover for details/links.
    const kind = classifyPaperKind(meta);
    const kindBadge = el('span', { className: `vt-kind vt-kind-${kind}`, textContent: kind, title: kindTitles()[kind] });
    const info = segment(S.paperInfo, join([
      kindBadge,
      meta.venue ?? (kind === 'preprint' ? null : warn(S.noVenue)),
      meta.year ? String(meta.year) : warn(S.noYear),
    ]));
    info.classList.add('vt-paper-info');
    info.setAttribute('tabindex', '0');
    info.append(this.buildPopover(meta));
    if (meta.matchedBy === 'title') {
      info.querySelector('.vt-paper-value')?.append(' ', el('span', { className: 'vt-paper-matched', textContent: S.matchedByTitle }));
    }
    this.body.append(info);

    // ── 2년/전체 인용수 + sparkline (hover → detailed chart)
    const total = bestCitationCount(meta);
    // The 2-year figure comes from OpenAlex's per-year counts. When OpenAlex
    // knows only a small share of the citations (an arXiv-only record of a
    // famous paper) it would sit next to another source's total as nonsense.
    const openAlexShare = total && typeof meta.citations.openalex === 'number' ? meta.citations.openalex / total : null;
    const partial = openAlexShare !== null && openAlexShare < 0.5;
    const recent = meta.year !== null && meta.year >= new Date().getFullYear() - 1;
    // A paper under two years old: every citation is a recent one.
    const twoYear = partial ? null : recentTwoYearCitations(meta) ?? (recent ? total : null);
    const twoYearWarning = openAlexBudgetSpent() ? OPENALEX_BUDGET_REASON
      : partial ? S.twoYearPartial(Math.round((openAlexShare ?? 0) * 100))
        : S.twoYearNoHistory;
    const history = citationHistory(meta);
    const sourcesDetail = [
      typeof meta.citations.semanticScholar === 'number' ? `Semantic Scholar ${formatCount(meta.citations.semanticScholar)}` : null,
      typeof meta.citations.openalex === 'number' ? `OpenAlex ${formatCount(meta.citations.openalex)}` : null,
      typeof meta.citations.crossref === 'number' ? `Crossref ${formatCount(meta.citations.crossref)}` : null,
    ].filter(Boolean).join(' · ');
    const cites = segment(S.citesLabel, [
      twoYear === null ? warn(twoYearWarning) : formatCount(twoYear),
      '/',
      total === null ? warn(S.noCitationCount) : formatCount(total),
      ...(s2Unavailable.has(meta) ? [' ', warn(S.s2RateLimited)] : []),
    ], total === null ? undefined : S.citesTooltip(sourcesDetail));
    if (history.some((p) => p.count > 0)) {
      const series = recentCitationSeries(meta);
      const max = Math.max(...series.map((p) => p.count));
      const spark = el('span', { className: 'vt-spark', tabindex: '0', 'aria-label': S.citationChartLabel });
      for (const p of series) {
        const bar = el('i');
        bar.style.height = `${Math.max(2, Math.round((p.count / Math.max(1, max)) * 16))}px`;
        spark.append(bar);
      }
      const chartPop = el('div', { className: 'vt-paper-pop vt-chart-pop', role: 'tooltip' }, [buildCitationChart(history)]);
      spark.append(chartPop);
      cites.append(spark);
    }
    this.body.append(cites);

    // ── 참고문헌 (hover → resolved reference list)
    const references = bestReferenceCount(meta);
    const refs = segment(S.referencesLabel, [references === null ? warn(S.noReferenceCount) : formatCount(references)]);
    // No database count: the PDF's own list gives it, once read.
    // No publisher count: the PDF's own list gives it, once read, when it is
    // more than the indexes know.
    this.refs.onPdfCount = meta.references.crossref ? null : (count) => {
      const value = refs.querySelector('.vt-paper-value');
      if (!value || this.meta !== meta || (references !== null && count <= references)) return;
      value.replaceChildren(formatCount(count));
      refs.title = S.referencesCountedFromPdf;
    };
    refs.classList.add('vt-paper-refs');
    refs.setAttribute('tabindex', '0');
    refs.append(this.refs.element);
    // Linking the PDF's own list by title costs a search per entry: done
    // when the reader looks at the list, a few at a time.
    const opened = () => this.refs.opened();
    refs.addEventListener('mouseenter', opened);
    refs.addEventListener('focusin', opened);
    this.body.append(refs);

    // ── right-aligned copy buttons
    const actions = el('span', { className: 'vt-paper-actions' });
    const copyBib = el('button', { type: 'button', className: 'vt-btn vt-btn-text vt-paper-copy', title: S.copyBibtex }, ['BibTeX']);
    copyBib.addEventListener('click', () => { void this.copy(copyBib, 'bibtex'); });
    const copyApa = el('button', { type: 'button', className: 'vt-btn vt-btn-text vt-paper-copy', title: S.copyApa }, ['APA']);
    copyApa.addEventListener('click', () => { void this.copy(copyApa, 'apa'); });
    actions.append(copyBib, copyApa);
    this.body.append(actions);

    const wasHidden = this.root.hidden;
    this.root.hidden = false;
    document.body.classList.add('vt-has-paper');
    if (wasHidden) this.onLayoutChange();
  }

  /** Floating panel under 논문정보: title, authors, links, venue 2-year citedness. */
  private buildPopover(meta: PaperMeta): HTMLElement {
    const pop = el('div', { className: 'vt-paper-pop', role: 'tooltip' });
    pop.append(el('div', { className: 'vt-paper-pop-title', textContent: meta.title }));
    if (meta.matchedBy === 'title') pop.append(el('div', { className: 'vt-paper-pop-fact vt-paper-matched-detail', textContent: S.matchedByTitleDetail }));
    if (meta.authors.length) {
      const shown = meta.authors.slice(0, 6).join(', ') + (meta.authors.length > 6 ? S.authorsMore(meta.authors.length - 6) : '');
      pop.append(el('div', { className: 'vt-paper-pop-authors', textContent: shown }));
    }
    const facts: string[] = [];
    if (meta.doi) facts.push(`DOI ${meta.doi}`);
    if (meta.arxivId) facts.push(`arXiv:${meta.arxivId}`);
    if (meta.venueType !== 'repository' && meta.workType !== 'preprint') {
      facts.push(meta.venueTwoYearMeanCitedness !== null
        ? S.venueMeanCitedness(meta.venueTwoYearMeanCitedness.toFixed(1))
        : S.noVenueMeanCitedness);
    }
    for (const f of facts) pop.append(el('div', { className: 'vt-paper-pop-fact', textContent: f }));
    const links = el('div', { className: 'vt-paper-links' });
    for (const link of scholarLinks(meta)) {
      links.append(el('a', { href: link.url, target: '_blank', rel: 'noopener noreferrer' }, [link.label]));
    }
    pop.append(links);
    return pop;
  }

  private async copy(button: HTMLButtonElement, kind: 'bibtex' | 'apa'): Promise<void> {
    const meta = this.meta;
    if (!meta) return;
    const original = button.textContent;
    button.disabled = true;
    try {
      let text: string;
      if (kind === 'apa') {
        text = formatApa(meta);
      } else {
        if (this.bibtexCache === null) {
          this.bibtexCache = (meta.doi ? await crossrefBibtex(meta.doi) : null) ?? formatBibtex(meta);
        }
        text = this.bibtexCache;
      }
      await navigator.clipboard.writeText(text);
      button.textContent = S.copied;
    } catch {
      button.textContent = S.copyFailed;
    } finally {
      setTimeout(() => { button.textContent = original; button.disabled = false; }, 1_500);
    }
  }
}
