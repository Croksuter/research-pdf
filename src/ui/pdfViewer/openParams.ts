// ─── The viewer URL's fragment: a place in the document, or only how to show it ───
//
// PDF open parameters (`#page=3`, `#nameddest=…`, `#zoom=150`, `#view=FitH`,
// `#toolbar=0&navpanes=0`, a bare destination `#section.2`) mix two kinds:
// those that name a place, which win over the remembered reading position,
// and those that only say how to show the document, which apply on top of
// it. Pure, so it can be tested.

export type ViewerHashPlan =
  /** Nothing the viewer acts on: the remembered position applies as is. */
  | { kind: 'none' }
  /** A place in the document; handed to PDF.js's link service as is. */
  | { kind: 'position'; hash: string }
  /**
   * How to show it, applied after the remembered page: `scale` for the
   * viewer's scale value, `linkHash` for what PDF.js's link service reads
   * (a zoom with coordinates or a Fit mode, search, page mode). `setsZoom`:
   * the remembered zoom is not applied.
   */
  | { kind: 'view'; scale: string | null; linkHash: string | null; setsZoom: boolean };

// `view=` (Adobe's open parameter) → the viewer's scale values.
const VIEW_SCALES: Record<string, string> = {
  fit: 'page-fit',
  fitb: 'page-fit',
  fitv: 'page-fit',
  fitbv: 'page-fit',
  fith: 'page-width',
  fitbh: 'page-width',
};
// What PDF.js's link service understands besides a place.
const LINK_VIEW_KEYS = new Set(['zoom', 'search', 'phrase', 'pagemode']);

export function classifyViewerHash(rawHash: string): ViewerHashPlan {
  const hash = rawHash.replace(/^#/u, '');
  if (!hash) return { kind: 'none' };
  // No parameters at all: a named or explicit destination.
  if (!hash.includes('=')) return { kind: 'position', hash };
  const params = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(hash)) params.set(key.toLowerCase(), value);
  if (params.has('page') || params.has('nameddest')) return { kind: 'position', hash };
  let scale: string | null = null;
  const link: string[] = [];
  const zoom = params.get('zoom');
  if (zoom !== undefined && /^\d+(?:\.\d+)?$/u.test(zoom) && Number(zoom) > 0) {
    // A plain percentage (a PDF gathered from Chrome's viewer).
    scale = String(Number(zoom) / 100);
  } else if (zoom) {
    link.push(`zoom=${zoom}`);
  }
  const view = VIEW_SCALES[(params.get('view') ?? '').split(',')[0].toLowerCase()];
  if (view && scale === null && link.length === 0) scale = view;
  for (const [key, value] of params) {
    if (key !== 'zoom' && LINK_VIEW_KEYS.has(key)) link.push(`${key}=${encodeURIComponent(value)}`);
  }
  if (scale === null && link.length === 0) return { kind: 'none' };
  return { kind: 'view', scale, linkHash: link.length ? link.join('&') : null, setsZoom: scale !== null || !!zoom };
}
