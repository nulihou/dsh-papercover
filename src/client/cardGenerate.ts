/**
 * Prompt builders: ask the live agent to think over the paper library and
 * file Idea cards via idea_card_create (same path as 「从报告建札记」).
 */
import type { IdeaCard, Paper } from '../shared/types';

export type GenerateCardsScope = 'missing' | 'reading' | 'recent';

export function papersForCardGeneration(
  papers: Paper[],
  cards: IdeaCard[],
  scope: GenerateCardsScope,
  limit: number,
): Paper[] {
  const linked = new Set(cards.map((c) => c.paperId).filter(Boolean) as string[]);
  let pool = [...papers];
  if (scope === 'missing') {
    pool = pool.filter((p) => !linked.has(p.id));
  } else if (scope === 'reading') {
    pool = pool.filter((p) => (p.readStatus ?? 'want') === 'reading' || (p.readStatus ?? 'want') === 'done');
    pool = pool.filter((p) => !linked.has(p.id) || cards.filter((c) => c.paperId === p.id).length < 2);
  } else {
    pool.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  pool.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0) || b.updatedAt - a.updatedAt);
  return pool.slice(0, Math.max(1, Math.min(limit, 12)));
}

/** Multi-paper library pass → composer prompt. */
export function buildLibraryGenerateCardsPrompt(opts: {
  papers: Paper[];
  researchFocus?: string;
  existingCardTitles?: string[];
}): string {
  const lines = opts.papers.map((p, i) => {
    const bits = [
      `${i + 1}. id=${p.id}`,
      `「${p.title}」`,
      p.year ? String(p.year) : '',
      p.venue ?? '',
      (p.authors ?? []).slice(0, 3).join(', '),
      p.abstract ? `摘要：${p.abstract.slice(0, 220)}${p.abstract.length > 220 ? '…' : ''}` : '',
      p.summary ? `库内摘要：${p.summary.slice(0, 160)}` : '',
    ].filter(Boolean);
    return bits.join(' · ');
  });
  const focus = (opts.researchFocus ?? '').trim();
  const existing = (opts.existingCardTitles ?? []).slice(0, 20);
  return [
    '请根据我的dsh-papercover论文库内容，思考并生成 Idea 札记（folio cards）。',
    '',
    focus ? `【我的研究方向】\n${focus}\n` : '',
    '【本批候选论文】（优先处理；可 paper_get / paper_read 深挖）',
    ...lines,
    '',
    existing.length ? `【库内已有札记标题·避免重复】\n- ${existing.join('\n- ')}\n` : '',
    '【要求】',
    '1. 先 idea_card_search 查重；与已有卡高度相似则跳过或 idea_card_update，不要重复建。',
    '2. 对每篇值得建卡的论文：提炼 1–2 条「对我方向可迁移」的创新点（方法/理论/数据/评测/工程），不是复述摘要。',
    '3. 用 idea_card_create 落库：必须填 title、insight、paperId；尽量填 plain、evidence（引用摘要/章节）、category、importance、tags。',
    '4. 无 PDF 时依据标题/摘要/库内 summary 仍可建「待验证」卡，并在 notes 标明证据不足。',
    '5. 全部完成后用几句话汇报：新建/跳过各几张、最值得跟进的 1 条。',
    '现在开始执行。',
  ].filter(Boolean).join('\n');
}

/** Single-paper generate → composer prompt. */
export function buildPaperGenerateCardsPrompt(opts: {
  paper: Paper;
  researchFocus?: string;
  relatedCardTitles?: string[];
}): string {
  const p = opts.paper;
  const focus = (opts.researchFocus ?? '').trim();
  const related = (opts.relatedCardTitles ?? []).slice(0, 15);
  return [
    `请针对论文库中的这篇论文思考并生成 Idea 札记：`,
    `id=${p.id}`,
    `标题：${p.title}`,
    p.year || p.venue ? `出处：${[p.year, p.venue].filter(Boolean).join(' · ')}` : '',
    (p.authors ?? []).length ? `作者：${p.authors.slice(0, 8).join(', ')}` : '',
    p.abstract ? `摘要：${p.abstract.slice(0, 600)}` : '',
    p.summary ? `库内摘要：${p.summary}` : '',
    '',
    focus ? `【我的研究方向】\n${focus}\n` : '',
    related.length ? `【该文已有札记·避免重复】\n- ${related.join('\n- ')}\n` : '',
    '步骤：',
    '1. idea_card_search（可按 paperId / 关键词）确认是否已有同类卡。',
    '2. 若有 PDF：可用 paper_read（quick）抓方法与结论；否则基于元数据与摘要。',
    '3. idea_card_create 1–3 张：可迁移洞察 + evidence；paperId 必须是上面的 id。',
    '4. 简短汇报新建结果。',
  ].filter(Boolean).join('\n');
}
