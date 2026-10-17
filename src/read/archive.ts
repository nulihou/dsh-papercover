/**
 * 精读结果归档：渲染五段式报告 html 落 reports/ + summary 回填论文。
 * paper_read 工具与 /scholar/read/run 路由共用。
 * 图表写入独立文件（-figN.jpg/png），报告用绝对路径引用，避免 HTML 内嵌 base64。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Paper } from '../shared/types.js';
import type { PaperStore } from '../store.js';
import { safeName } from '../store.js';
import { applyPaperPatch } from '../domain.js';
import { advanceLifecycle } from '../lifecycle.js';
import { renderReportHtml, extractSummary } from './render.js';
import { saveSessionAfterRead } from './session.js';
import { writeTextCache } from '../textcache.js';
import type { PaperOutcome, QuickOutcome } from './engine.js';

export interface ArchiveInfo {
  file: string | null
  summary: string
  mode: 'paper' | 'quick'
  summaryUpdated: boolean
}

/** 报告头部的副标题行：作者 ≤3 + venue/年 + 模式 + 日期 */
function headerSub(p: Paper, mode: 'paper' | 'quick', focusNote: string): string {
  const authors = p.authors.length > 3
    ? p.authors.slice(0, 3).join(', ') + ', et al.'
    : p.authors.join(', ');
  const bits = [authors, [p.venue, p.year].filter(Boolean).join(' '), p.arxivId ? 'arXiv:' + p.arxivId : '']
    .filter(Boolean).join(' · ');
  return bits + ' · ' + (mode === 'paper' ? '学术论文精读' : '速读') + ' · ' + new Date().toISOString().slice(0, 10)
    + (focusNote ? ' · ' + focusNote : '');
}

/** 把 VLM 解读过的图写成磁盘文件，返回可嵌入报告的 URL 列表。 */
async function materializeFigures(
  dir: string,
  paperId: string,
  base: string,
  outcome: PaperOutcome,
): Promise<string[]> {
  const imgs = outcome.meta.figuresImgs ?? [];
  const descs = outcome.meta.figureDescriptions ?? [];
  if (imgs.length === 0 || descs.length === 0) return [];
  const n = Math.min(imgs.length, descs.length);
  const srcs: string[] = [];
  for (let i = 0; i < n; i++) {
    const im = imgs[i]!;
    const ext = im.mime === 'image/jpeg' ? 'jpg' : 'png';
    const fname = `${base}-fig${i}.${ext}`;
    await writeFile(join(dir, fname), Buffer.from(im.b64, 'base64'));
    srcs.push(`/scholar/papers/${encodeURIComponent(paperId)}/reports/${encodeURIComponent(fname)}`);
  }
  return srcs;
}

export async function archiveReadResult(
  store: PaperStore,
  paper: Paper,
  outcome: PaperOutcome | QuickOutcome,
  opts: { focusNote?: string; updateSummary?: boolean } = {},
): Promise<ArchiveInfo> {
  const dir = join(store.dir, 'reports');
  const summary = extractSummary(outcome);
  const update = opts.updateSummary !== false && outcome.meta.synth !== 'assembled' && summary !== '';
  const archived = await store.commitPaperArtifacts([paper], async () => {
    await mkdir(dir, { recursive: true });
    const ts = Date.now();
    const base = `${safeName(paper.id)}-${ts}`;
    const file = `${base}.html`;

    // 先落图再渲染：报告引用外链，HTML 不再内嵌多 MB base64
    if (outcome.kind === 'paper') {
      try {
        const srcs = await materializeFigures(dir, paper.id, base, outcome);
        if (srcs.length > 0) outcome.meta.figureSrcs = srcs;
      } catch { /* 写图失败仍归档文字报告 */ }
      // 渲染后丢掉内存里的 base64，避免 sidecar / 后续链路再携带
      delete outcome.meta.figuresImgs;
    }

    const html = renderReportHtml(outcome, {
      title: outcome.kind === 'paper' && outcome.title !== '未命名论文' ? outcome.title : paper.title,
      sub: headerSub(paper, outcome.meta.mode, opts.focusNote ?? ''),
      paperId: paper.id,
    });
    await writeFile(join(dir, file), html, 'utf8');
    // sidecar：对比原料（"直接对比已有成果"路径的数据源，免去重读）
    if (outcome.kind === 'paper') {
      try {
        const { sidecarOf } = await import('./compare.js');
        await writeFile(join(dir, `${base}.json`), JSON.stringify(sidecarOf(outcome, paper.title)), 'utf8');
      } catch { /* sidecar 失败不影响归档 */ }
    }
    // 拼装档（综合彻底失败的兜底）的 summary 是分段摘要机械拼接——不覆盖
    // 论文已有 summary：读失败不该污染原有数据，页脚 ⚠ 标记已提示重读
    // 交互式精读的原料：保存章节块（保留历史问答）
    if ((outcome.meta.chunksText ?? []).length > 0) {
      await saveSessionAfterRead(store.dir, paper.id, outcome.meta.chunksText ?? [])
      try { await writeTextCache(store.dir, paper.id, (outcome.meta.chunksText ?? []).join('\n\n')) } catch { /* 正文索引失败不影响归档 */ }
    }
    return { file, summary, mode: outcome.meta.mode, summaryUpdated: update };
  }, {
    id: paper.id,
    apply: (cur) => {
      let next = update ? applyPaperPatch(cur, { summary }) : cur;
      // 精读成功：至少推进到 read；有可用 summary 则 distilled
      next = advanceLifecycle(next, update && summary ? 'distilled' : 'read');
      // 若当前仍低于 reading（罕见），先标 reading 再前进——advance 是前向的
      return next;
    },
  });
  return archived ?? { file: null, summary: '', mode: outcome.meta.mode, summaryUpdated: false };
}
