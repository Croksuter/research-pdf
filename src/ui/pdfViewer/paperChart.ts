// Detailed citation chart shown when the sparkline in the paper strip is
// hovered: one bar per year (gap-free), year ticks with labels at both ends
// and the middle, a dashed line at the maximum, and a floating readout with
// the hovered year's citations and the cumulative count through that year.

import type { CitationHistoryPoint } from '../../shared/paperIdentifiers';
import { formatCount } from '../../shared/paperIdentifiers';
import { el } from './dom';

const SVG_NS = 'http://www.w3.org/2000/svg';
const W = 440;
const H = 170;
const PAD = { left: 52, right: 14, top: 22, bottom: 30 };

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** Label every year when few; otherwise both ends, the middle, and evenly spaced in between. */
function labelledYears(years: number[]): Set<number> {
  const n = years.length;
  const set = new Set<number>();
  if (n === 0) return set;
  set.add(years[0]);
  set.add(years[n - 1]);
  if (n <= 6) years.forEach((y) => set.add(y));
  else {
    const step = Math.ceil((n - 1) / 4);
    for (let i = step; i < n - 1; i += step) set.add(years[i]);
  }
  return set;
}

export function buildCitationChart(history: CitationHistoryPoint[]): HTMLElement {
  const wrap = el('div', { className: 'vt-chart' });
  if (history.length === 0) {
    wrap.append(el('p', { className: 'vt-chart-empty', textContent: '연도별 인용 데이터가 없습니다.' }));
    return wrap;
  }
  const max = Math.max(1, ...history.map((p) => p.count));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const slot = plotW / history.length;
  const barW = Math.max(3, Math.min(28, slot * 0.62));
  const yOf = (count: number) => PAD.top + plotH - (count / max) * plotH;

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'vt-chart-svg', role: 'img', 'aria-label': '연도별 인용 수' });

  // Axes.
  root.append(svg('line', { x1: PAD.left, y1: PAD.top + plotH, x2: W - PAD.right, y2: PAD.top + plotH, class: 'vt-chart-axis' }));
  root.append(svg('line', { x1: PAD.left, y1: PAD.top, x2: PAD.left, y2: PAD.top + plotH, class: 'vt-chart-axis' }));

  // Max line (dashed) + label; half line as a light guide.
  root.append(svg('line', { x1: PAD.left, y1: yOf(max), x2: W - PAD.right, y2: yOf(max), class: 'vt-chart-max' }));
  const maxLabel = svg('text', { x: PAD.left - 6, y: yOf(max) + 4, class: 'vt-chart-ylabel', 'text-anchor': 'end' });
  maxLabel.textContent = formatCount(max);
  root.append(maxLabel);
  root.append(svg('line', { x1: PAD.left, y1: yOf(max / 2), x2: W - PAD.right, y2: yOf(max / 2), class: 'vt-chart-grid' }));
  const halfLabel = svg('text', { x: PAD.left - 6, y: yOf(max / 2) + 4, class: 'vt-chart-ylabel', 'text-anchor': 'end' });
  halfLabel.textContent = formatCount(Math.round(max / 2));
  root.append(halfLabel);
  const zeroLabel = svg('text', { x: PAD.left - 6, y: PAD.top + plotH + 4, class: 'vt-chart-ylabel', 'text-anchor': 'end' });
  zeroLabel.textContent = '0';
  root.append(zeroLabel);

  // Bars, ticks, labels.
  const years = history.map((p) => p.year);
  const labelled = labelledYears(years);
  const readout = el('div', { className: 'vt-chart-readout' });
  readout.hidden = true;
  history.forEach((point, i) => {
    const cx = PAD.left + slot * (i + 0.5);
    const bar = svg('rect', {
      x: cx - barW / 2, y: yOf(point.count), width: barW, height: Math.max(0, PAD.top + plotH - yOf(point.count)),
      rx: 1.5, class: 'vt-chart-bar',
    });
    // A transparent hit area covering the whole slot keeps hovering easy.
    const hit = svg('rect', { x: PAD.left + slot * i, y: PAD.top, width: slot, height: plotH, class: 'vt-chart-hit' });
    const show = () => {
      bar.classList.add('is-hover');
      readout.replaceChildren(
        el('b', { textContent: `${point.year}년` }),
        el('span', { textContent: ` 인용 ${formatCount(point.count)}회` }),
        el('span', { className: 'vt-chart-cum', textContent: point.cumulative === null ? '' : ` · 누적 ${formatCount(point.cumulative)}회` }),
      );
      readout.hidden = false;
      const leftPct = ((cx) / W) * 100;
      readout.style.left = `${Math.min(78, Math.max(8, leftPct))}%`;
    };
    const hide = () => { bar.classList.remove('is-hover'); readout.hidden = true; };
    for (const target of [bar, hit]) {
      target.addEventListener('mouseenter', show);
      target.addEventListener('mouseleave', hide);
    }
    root.append(hit, bar);
    const isMajor = labelled.has(point.year);
    root.append(svg('line', { x1: cx, y1: PAD.top + plotH, x2: cx, y2: PAD.top + plotH + (isMajor ? 6 : 3), class: isMajor ? 'vt-chart-tick' : 'vt-chart-subtick' }));
    if (isMajor) {
      const t = svg('text', { x: cx, y: PAD.top + plotH + 19, class: 'vt-chart-xlabel', 'text-anchor': 'middle' });
      t.textContent = String(point.year);
      root.append(t);
    }
  });

  wrap.append(root, readout);
  return wrap;
}
