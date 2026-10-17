/**
 * OpenAlex keyword / title search for literature discovery.
 */
import { getText } from './metadata.js';
import { arxivFromWork, parseOpenalexWork, type RelatedWork } from './related.js';

const OA = 'https://api.openalex.org';
const TIMEOUT = 15_000;

export interface SearchHit extends RelatedWork {
  abstract?: string;
  url?: string;
}

export async function searchOpenAlex(opts: {
  q: string;
  proxy?: string;
  email?: string;
  perPage?: number;
}): Promise<{ query: string; results: SearchHit[]; note?: string }> {
  const q = opts.q.trim();
  if (!q) return { query: q, results: [], note: 'empty query' };
  if (q.length > 200) throw new Error('检索词过长（≤200）');

  const per = Math.min(25, Math.max(5, opts.perPage ?? 12));
  const mail = opts.email?.trim()
    ? `&mailto=${encodeURIComponent(opts.email.trim())}`
    : '';
  const url =
    `${OA}/works?search=${encodeURIComponent(q)}` +
    `&per_page=${per}&sort=relevance_score:desc` +
    `&select=id,display_name,publication_year,cited_by_count,doi,authorships,primary_location,abstract_inverted_index${mail}`;

  const text = await getText(url, TIMEOUT, opts.proxy);
  const data = JSON.parse(text) as { results?: unknown[]; meta?: { count?: number } };
  const raw = Array.isArray(data.results) ? data.results : [];
  const results: SearchHit[] = [];

  for (const item of raw) {
    const w = item as Parameters<typeof parseOpenalexWork>[0] & {
      abstract_inverted_index?: Record<string, number[]>;
      primary_location?: { landing_page_url?: string };
    };
    const base = parseOpenalexWork(w);
    if (!base) continue;
    results.push({
      ...base,
      arxivId: base.arxivId ?? arxivFromWork(w),
      abstract: invertAbstract(w.abstract_inverted_index),
      url: w.primary_location?.landing_page_url || (base.doi ? `https://doi.org/${base.doi}` : undefined),
    });
  }

  return {
    query: q,
    results,
    note: results.length ? undefined : 'OpenAlex 无结果，可换关键词或检查网络/代理',
  };
}

function invertAbstract(idx?: Record<string, number[]>): string | undefined {
  if (!idx || typeof idx !== 'object') return undefined;
  const slots: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(idx)) {
    for (const p of positions) slots.push([p, word]);
  }
  if (!slots.length) return undefined;
  slots.sort((a, b) => a[0] - b[0]);
  return slots.map((s) => s[1]).join(' ').slice(0, 1200);
}
