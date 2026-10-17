/**
 * Minimal BibTeX importer → Paper[] drafts (no file I/O).
 */
import type { Paper } from './shared/types.js';
import { paperIdFor } from './store.js';

export interface BibImportResult {
  papers: Paper[];
  skipped: number;
  errors: string[];
}

/** Split a .bib blob into entry bodies `{...}` with type + key. */
export function parseBibtex(raw: string): BibImportResult {
  const papers: Paper[] = [];
  const errors: string[] = [];
  let skipped = 0;
  const src = String(raw || '');
  const re = /@(\w+)\s*\{\s*([^,\s]+)\s*,([\s\S]*?)\n\s*\}/g;
  let m: RegExpExecArray | null;
  const now = Date.now();

  while ((m = re.exec(src)) !== null) {
    const type = m[1]!.toLowerCase();
    if (type === 'string' || type === 'preamble' || type === 'comment') {
      skipped += 1;
      continue;
    }
    const fields = parseFields(m[3] || '');
    const title = clean(fields.title || fields.booktitle || '');
    if (!title) {
      skipped += 1;
      errors.push(`跳过无标题条目：${m[2]}`);
      continue;
    }
    const authors = splitAuthors(fields.author || '');
    const year = parseYear(fields.year);
    const doi = clean(fields.doi || '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '') || undefined;
    const arxivId = extractArxiv(fields) || undefined;
    const venue = clean(fields.journal || fields.booktitle || fields.publisher || '') || undefined;
    const url = clean(fields.url || '') || (doi ? `https://doi.org/${doi}` : undefined);
    const abstract = clean(fields.abstract || '') || undefined;
    const id = paperIdFor(title, arxivId);
    papers.push({
      id,
      title,
      authors,
      year,
      venue,
      doi,
      arxivId,
      url,
      abstract,
      tags: ['bibtex-import'],
      source: 'manual',
      createdAt: now,
      updatedAt: now,
    });
  }

  if (!papers.length && !errors.length && src.trim()) {
    errors.push('未能解析任何 BibTeX 条目（请确认是标准 @article{...} 格式）');
  }
  return { papers, skipped, errors };
}

function parseFields(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  // field = {…} or field = "…"
  const re = /(\w+)\s*=\s*(?:\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}|"([^"]*)")/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out[m[1]!.toLowerCase()] = (m[2] ?? m[3] ?? '').trim();
  }
  return out;
}

function clean(s: string): string {
  return s
    .replace(/\{\{|\}\}/g, '')
    .replace(/[{}]/g, '')
    .replace(/\\&/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitAuthors(author: string): string[] {
  return author
    .split(/\s+and\s+/i)
    .map((a) => {
      const t = clean(a);
      if (t.includes(',')) {
        const [last, first] = t.split(',').map((x) => x.trim());
        return [first, last].filter(Boolean).join(' ');
      }
      return t;
    })
    .filter(Boolean);
}

function parseYear(y?: string): number | undefined {
  const m = /(\d{4})/.exec(y || '');
  return m ? Number(m[1]) : undefined;
}

function extractArxiv(fields: Record<string, string>): string | undefined {
  const blob = `${fields.journal || ''} ${fields.eprint || ''} ${fields.url || ''} ${fields.doi || ''}`;
  const m = /(?:arxiv(?:\.org\/abs\/|:|\s)?)(\d{4}\.\d{4,5})/i.exec(blob)
    || /10\.48550\/arxiv\.(\d{4}\.\d{4,5})/i.exec(blob);
  return m ? m[1]!.toLowerCase() : undefined;
}
