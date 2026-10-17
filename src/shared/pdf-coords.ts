/**
 * PDF annotation geometry: Zotero stores PDF user-space rects (origin bottom-left);
 * the in-app reader paints viewport rects (origin top-left) at scale=1.
 */

/** How {@link PaperHighlight.rects} `[x,y,w,h]` are interpreted. */
export type HighlightCoordSpace = 'viewport' | 'pdf';

/**
 * Flip a PDF-user-space `[x, y, w, h]` box into viewport top-left space.
 * @param rect - box with y measured upward from the page bottom
 * @param pageHeight - page height in the same PDF units (MediaBox / pdf.js scale=1)
 */
export function pdfRectToViewport(rect: number[], pageHeight: number): number[] | null {
  if (!Array.isArray(rect) || rect.length < 4 || !(pageHeight > 0)) return null;
  const [x, y, w, h] = rect.map(Number);
  if (![x, y, w, h].every((v) => Number.isFinite(v)) || w <= 0 || h <= 0) return null;
  const top = pageHeight - y - h;
  return [x, top, w, h];
}

/**
 * Convert many PDF-space boxes. Drops invalid entries.
 * @param rects - PDF user-space boxes
 * @param pageHeight - page height in PDF units
 */
export function pdfRectsToViewport(rects: number[][], pageHeight: number): number[][] {
  const out: number[][] = [];
  for (const r of rects) {
    const next = pdfRectToViewport(r, pageHeight);
    if (next) out.push(next);
  }
  return out;
}

/**
 * Resolve paint-ready viewport boxes for one highlight.
 * @param rects - stored boxes
 * @param coordSpace - `pdf` needs a y-flip; missing defaults to viewport unless `preferPdf`
 * @param pageHeightAtScale1 - CSS/page height at scale=1 (`wrapHeight / scale`)
 * @param preferPdf - treat as PDF space (Zotero key without explicit space)
 */
export function resolveHighlightRects(opts: {
  rects: number[][];
  coordSpace?: HighlightCoordSpace;
  pageHeightAtScale1: number;
  preferPdf?: boolean;
}): number[][] {
  const space = opts.coordSpace ?? (opts.preferPdf ? 'pdf' : 'viewport');
  if (space !== 'pdf') return opts.rects.filter((r) => Array.isArray(r) && r.length >= 4);
  return pdfRectsToViewport(opts.rects, opts.pageHeightAtScale1);
}

/**
 * Parse Zotero `annotationPosition` JSON into pageIndex + `[x,y,w,h]` PDF-space boxes
 * (y still bottom-left; caller flips with {@link pdfRectsToViewport}).
 */
export function parseZoteroPositionJson(raw: string): { rects?: number[][]; pageIndex: number } {
  if (!raw) return { pageIndex: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { pageIndex: 0 };
  }
  if (!parsed || typeof parsed !== 'object') return { pageIndex: 0 };
  const o = parsed as { rects?: unknown; pageIndex?: unknown };
  const pageIndex = Number(o.pageIndex);
  const rects: number[][] = [];
  if (Array.isArray(o.rects)) {
    for (const r of o.rects) {
      if (!Array.isArray(r) || r.length < 4) continue;
      const n = r.slice(0, 4).map((v) => Number(v));
      if (!n.every((v) => Number.isFinite(v))) continue;
      const [x1, y1, x2, y2] = n as [number, number, number, number];
      const x = Math.min(x1, x2);
      const y = Math.min(y1, y2);
      const w = Math.abs(x2 - x1);
      const h = Math.abs(y2 - y1);
      if (w > 0 && h > 0) rects.push([x, y, w, h]);
    }
  }
  return { rects: rects.length ? rects : undefined, pageIndex: Number.isFinite(pageIndex) ? pageIndex : 0 };
}
