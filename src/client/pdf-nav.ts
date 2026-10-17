/**
 * Outline + in-document search helpers for the scholar PDF readers.
 */

export type OutlineItem = { title: string; page: number; items?: OutlineItem[] };

export type SearchHit = { page: number; text: string; index: number };

type PdfDocLike = {
  numPages: number;
  getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: Array<{ str?: string }> }> }>;
  getOutline?: () => Promise<unknown[] | null>;
  getDestination?: (name: string) => Promise<unknown>;
  getPageIndex?: (ref: unknown) => Promise<number>;
};

/**
 * Build a shallow outline tree (depth ≤ 3) with resolved 1-based page numbers.
 * @param doc - pdf.js document
 */
export async function buildOutline(doc: PdfDocLike): Promise<OutlineItem[]> {
  if (!doc.getOutline) return [];
  const raw = await doc.getOutline();
  if (!raw?.length) return [];

  const resolvePage = async (dest: unknown): Promise<number> => {
    try {
      let d = dest;
      if (typeof d === 'string' && doc.getDestination) d = await doc.getDestination(d);
      if (!Array.isArray(d) || !d[0] || !doc.getPageIndex) return 1;
      const idx = await doc.getPageIndex(d[0]);
      return (idx ?? 0) + 1;
    } catch {
      return 1;
    }
  };

  const walk = async (nodes: unknown[], depth = 0): Promise<OutlineItem[]> => {
    const out: OutlineItem[] = [];
    for (const n of nodes) {
      const node = n as { title?: string; dest?: unknown; items?: unknown[] };
      const item: OutlineItem = {
        title: String(node.title || '…'),
        page: await resolvePage(node.dest),
      };
      if (node.items?.length && depth < 3) item.items = await walk(node.items, depth + 1);
      out.push(item);
    }
    return out;
  };
  return walk(raw);
}

/**
 * Full-document text search (case-insensitive), capped at `limit` hits.
 * @param doc - pdf.js document
 * @param query - non-empty query
 * @param limit - max hits
 */
export async function searchDocument(
  doc: PdfDocLike,
  query: string,
  limit = 80,
): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const hits: SearchHit[] = [];
  const lower = q.toLowerCase();
  for (let i = 1; i <= doc.numPages && hits.length < limit; i += 1) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const full = tc.items.map((it) => it.str || '').join('');
    let from = 0;
    let idx = full.toLowerCase().indexOf(lower, from);
    while (idx >= 0 && hits.length < limit) {
      const snippet = full
        .slice(Math.max(0, idx - 24), Math.min(full.length, idx + q.length + 48))
        .replace(/\s+/g, ' ');
      hits.push({ page: i, text: snippet, index: idx });
      from = idx + q.length;
      idx = full.toLowerCase().indexOf(lower, from);
    }
  }
  return hits;
}

const REF_TITLE = /references|bibliography|参考文献|引用文献|works\s+cited/i;

/**
 * Guess the first page of the bibliography from outline titles, else null.
 * @param outline - document outline
 */
export function findReferencesPage(outline: OutlineItem[]): number | null {
  const walk = (items: OutlineItem[]): number | null => {
    for (const it of items) {
      if (REF_TITLE.test(it.title)) return it.page;
      if (it.items?.length) {
        const nested = walk(it.items);
        if (nested != null) return nested;
      }
    }
    return null;
  };
  return walk(outline);
}

/**
 * Extract a citation index from a click target's nearby text (`[12]` / `[12, 13]` first).
 * @param text - surrounding text
 */
export function extractCitationIndex(text: string): number | null {
  const m = /\[(\d{1,3})\b/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

/**
 * Locate the page that lists citation `n` near/after the references start.
 * @param doc - pdf.js document
 * @param n - citation number
 * @param refsPage - optional outline-derived start page
 */
export async function findCitationTargetPage(
  doc: PdfDocLike,
  n: number,
  refsPage: number | null,
): Promise<number | null> {
  const patterns = [
    new RegExp(`\\[${n}\\]`),
    new RegExp(`(?:^|\\n)\\s*${n}[.)]\\s`),
    new RegExp(`\\b${n}\\.\\s+[A-Z]`),
  ];
  const start = refsPage != null ? Math.max(1, refsPage) : Math.max(1, Math.floor(doc.numPages * 0.55));
  for (let i = start; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const full = tc.items.map((it) => it.str || '').join('');
    if (patterns.some((re) => re.test(full))) return i;
  }
  // Fallback: scan earlier pages (some PDFs put refs mid-doc).
  for (let i = start - 1; i >= 1; i -= 1) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const full = tc.items.map((it) => it.str || '').join('');
    if (patterns.some((re) => re.test(full))) return i;
  }
  return null;
}
