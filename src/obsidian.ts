/**
 * Obsidian vault writer — dumps paper notes / highlights as Markdown notes.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { Paper, PaperHighlight } from './shared/types.js';

export function buildPaperMarkdown(opts: {
  paper: Paper;
  highlights?: PaperHighlight[];
  docNote?: string;
}): string {
  const p = opts.paper;
  const lines: string[] = [
    '---',
    `title: ${yamlEscape(p.title)}`,
    `paper_id: ${p.id}`,
    p.year ? `year: ${p.year}` : '',
    p.doi ? `doi: ${p.doi}` : '',
    p.arxivId ? `arxiv: ${p.arxivId}` : '',
    p.tags?.length ? `tags: [${p.tags.map((t) => yamlEscape(t)).join(', ')}]` : '',
    'source: dsh-scholar',
    '---',
    '',
    `# ${p.title}`,
    '',
  ].filter((l, i, arr) => !(l === '' && arr[i - 1] === ''));

  if (p.authors?.length) lines.push(`**Authors:** ${p.authors.join(', ')}`, '');
  if (p.venue) lines.push(`**Venue:** ${p.venue}`, '');
  if (p.summary) lines.push('## Summary', '', p.summary, '');
  if (p.abstract) lines.push('## Abstract', '', p.abstract, '');
  if (p.notes?.trim()) lines.push('## Notes', '', p.notes.trim(), '');
  if (opts.docNote?.trim()) lines.push('## Reader notes', '', opts.docNote.trim(), '');

  const hls = opts.highlights || [];
  if (hls.length) {
    lines.push('## Highlights', '');
    for (const h of [...hls].sort((a, b) => a.page - b.page)) {
      lines.push(`### p.${h.page}`, '');
      lines.push(`> ${h.text.replace(/\n/g, '\n> ')}`, '');
      if (h.comment?.trim()) lines.push(h.comment.trim(), '');
    }
  }

  if (p.arxivId) lines.push(`- [arXiv](https://arxiv.org/abs/${p.arxivId})`);
  if (p.doi) lines.push(`- [DOI](https://doi.org/${p.doi})`);
  lines.push('', `*Synced ${new Date().toISOString().slice(0, 19)}*`, '');
  return lines.join('\n');
}

export async function writeObsidianNote(opts: {
  vault: string;
  paper: Paper;
  highlights?: PaperHighlight[];
  docNote?: string;
  subdir?: string;
}): Promise<string | null> {
  const vault = opts.vault.trim();
  if (!vault) return null;
  const folder = path.join(vault, opts.subdir || 'Scholar');
  await fsp.mkdir(folder, { recursive: true });
  const safe = opts.paper.id.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80);
  const dest = path.join(folder, `${safe}.md`);
  const md = buildPaperMarkdown(opts);
  const tmp = `${dest}.tmp`;
  await fsp.writeFile(tmp, md, 'utf8');
  await fsp.rename(tmp, dest);
  return dest;
}

function yamlEscape(s: string): string {
  if (/[:#{}[\],&*?|>!%@`]/.test(s) || s.includes('\n')) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}
