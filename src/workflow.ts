/**
 * Workflow helpers: Obsidian sync, OpenAlex ingest, BibTeX import, arXiv PDF attach.
 */
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Paper, PaperHighlight, ScholarConfig } from './shared/types.js';
import { createPaper, findDuplicate } from './domain.js';
import { fetchPdf } from './metadata.js';
import { writeObsidianNote } from './obsidian.js';
import { parseBibtex } from './bibtexImport.js';
import type { SearchHit } from './search.js';
import type { PaperStore } from './store.js';
import { safeName } from './store.js';

/** Attach an arXiv PDF to a paper (best-effort; throws on hard failure). */
export async function attachArxivPdf(
  paper: Paper,
  store: PaperStore,
  proxy?: string,
): Promise<Paper> {
  if (!paper.arxivId) throw new Error('仅 arXiv 论文支持自动下载 PDF');
  const buf = await fetchPdf(`https://arxiv.org/pdf/${paper.arxivId}`, 60_000, proxy);
  if (buf.length === 0 || buf.subarray(0, 4).toString('latin1') !== '%PDF') {
    throw new Error('下载内容不是有效的 PDF');
  }
  if (buf.length > 50 * 1024 * 1024) throw new Error('PDF 超过 50MB 附件上限');
  const file = join(store.dir, 'attachments', `${safeName(paper.id)}.pdf`);
  const saved = await store.commitPaperArtifacts([paper], async () => {
    await mkdir(join(store.dir, 'attachments'), { recursive: true });
    const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, buf);
    await rename(tmp, file).catch(async (err: unknown) => {
      await unlink(tmp).catch(() => { /* abandon tmp */ });
      throw err;
    });
    return true;
  }, { id: paper.id, apply: (cur) => ({ ...cur, pdfPath: `attachments/${safeName(paper.id)}.pdf`, updatedAt: Date.now() }) });
  if (!saved) throw new Error('论文已删除，下载结果未保存');
  return { ...paper, pdfPath: `attachments/${safeName(paper.id)}.pdf`, updatedAt: Date.now() };
}

export async function syncPaperToObsidian(
  store: PaperStore,
  paper: Paper,
  cfg: ScholarConfig,
): Promise<string | null> {
  const vault = cfg.obsidianVault?.trim();
  if (!vault) return null;
  const ann = await store.getAnnotations(paper.id);
  return writeObsidianNote({
    vault,
    paper,
    highlights: ann.highlights as PaperHighlight[],
    docNote: paper.notes,
    subdir: cfg.obsidianSubdir || 'Scholar',
  });
}

export async function syncAllToObsidian(
  store: PaperStore,
  cfg: ScholarConfig,
): Promise<{ written: number; skipped: number; errors: string[]; paths: string[] }> {
  const vault = cfg.obsidianVault?.trim();
  if (!vault) return { written: 0, skipped: 0, errors: ['未配置 Obsidian vault 路径'], paths: [] };
  let written = 0;
  let skipped = 0;
  const errors: string[] = [];
  const paths: string[] = [];
  for (const paper of store.papers.values()) {
    try {
      const p = await syncPaperToObsidian(store, paper, cfg);
      if (p) {
        written += 1;
        paths.push(p);
      } else {
        skipped += 1;
      }
    } catch (e) {
      errors.push(`${paper.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { written, skipped, errors, paths };
}

export async function ingestSearchHit(
  store: PaperStore,
  cfg: ScholarConfig,
  hit: Pick<SearchHit, 'title' | 'authors' | 'year' | 'venue' | 'doi' | 'arxivId' | 'url' | 'abstract'>,
  opts?: { fetchPdf?: boolean },
): Promise<{ created: boolean; duplicate: boolean; paper: Paper; pdfWarning?: string }> {
  const dup = findDuplicate(store.papers.values(), {
    title: hit.title,
    arxivId: hit.arxivId,
    doi: hit.doi,
  });
  if (dup) return { created: false, duplicate: true, paper: dup };

  const tags = [...new Set([...(cfg.defaultTags ?? []), 'openalex'])];
  let paper = createPaper({
    title: hit.title,
    authors: hit.authors ?? [],
    year: hit.year,
    venue: hit.venue,
    doi: hit.doi,
    arxivId: hit.arxivId,
    url: hit.url,
    abstract: hit.abstract,
    tags,
    importance: 3,
    readStatus: 'want',
    source: 'manual',
  });
  await store.upsertPaper(paper);

  let pdfWarning: string | undefined;
  if (opts?.fetchPdf !== false && paper.arxivId) {
    try {
      paper = await attachArxivPdf(paper, store, cfg.fetchProxy);
    } catch (e) {
      pdfWarning = e instanceof Error ? e.message : String(e);
    }
  }

  try {
    await syncPaperToObsidian(store, paper, cfg);
  } catch {
    /* Obsidian write is best-effort */
  }

  return { created: true, duplicate: false, paper, pdfWarning };
}

export async function importBibtexBlob(
  store: PaperStore,
  cfg: ScholarConfig,
  raw: string,
): Promise<{ imported: number; skipped: number; duplicates: number; errors: string[]; papers: Paper[] }> {
  const parsed = parseBibtex(raw);
  let imported = 0;
  let duplicates = 0;
  const papers: Paper[] = [];
  const errors = [...parsed.errors];

  for (const draft of parsed.papers) {
    const dup = findDuplicate(store.papers.values(), draft);
    if (dup) {
      duplicates += 1;
      papers.push(dup);
      continue;
    }
    const tags = [...new Set([...(cfg.defaultTags ?? []), ...(draft.tags ?? [])])];
    const paper = createPaper({ ...draft, tags, source: 'manual' });
    await store.upsertPaper(paper);
    papers.push(paper);
    imported += 1;
    try {
      await syncPaperToObsidian(store, paper, cfg);
    } catch {
      /* best-effort */
    }
  }

  return {
    imported,
    skipped: parsed.skipped,
    duplicates,
    errors,
    papers,
  };
}
