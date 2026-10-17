/**
 * 交互式追问（"带着问题反复翻"的引擎侧）：检索章节块 → 基于片段的带引证回答。
 * 检索算法见 ask-retrieve.ts（页码锚定 + 关键词 top-k）。
 */
import { createLlmRuntime, type PreferredModelFn } from './llm.js'
import type { AbortLike, HostContext } from './types.js'
import {
  MAX_FRAG_CHARS,
  parseRequestedPages,
  selectAskChunks,
} from './ask-retrieve.js'

export {
  chunksCoveringPages,
  isSequentialWalkIntent,
  pageMarkersInChunk,
  parseRequestedPages,
  qTokens,
  retrieveChunks,
  selectAskChunks,
} from './ask-retrieve.js'

export interface AskAnswer {
  answer: string
  pages: string[]
  confidence: string
  sufficient: boolean
}

/** 基于检索片段回答：严格引证【第N页】；片段不足以回答时明说（sufficient=false） */
export function createAsker(ctx: HostContext, preferredModel?: PreferredModelFn, preferFallback?: boolean | (() => boolean)) {
  const { callModelJson, pickConfig } = createLlmRuntime({
    ctx: ctx as never,
    estimateTokens: (t) => Math.ceil(t.length * 0.6),
    llmCallStats: { calls: 0, ms: 0 },
    recordCalibration: (() => undefined) as never,
    preferredModel,
    preferFallback,
  })

  return async function ask(
    chunks: string[],
    question: string,
    history?: { q: string; a: string }[],
    signal?: AbortLike | null,
    notes?: string | null,
  ): Promise<AskAnswer> {
    const use = selectAskChunks(chunks, question)
    const requested = parseRequestedPages(question)
    // 每块上限略放宽；页码锚定时优先保证目标页进上下文
    const frag = use.map((i) => `【片段 ${i + 1}】\n${chunks[i]!.slice(0, MAX_FRAG_CHARS)}`).join('\n\n')
    const hist = (history ?? []).slice(-2).map((h) => `问：${h.q}\n答：${h.a.slice(0, 160)}`).join('\n')
    const pageHint = requested.length > 0
      ? `\n读者点名要看的页码：${requested.map((p) => `第${p}页`).join('、')}——若片段已含对应【第N页】标记，必须基于这些页作答，不得声称缺少这些页的原文。`
      : ''
    const cfg = await pickConfig()
    const parsed = await callModelJson(cfg,
      '你是论文精读助答。基于给出的原文片段回答读者的问题，严格只输出一个 JSON 对象（不要任何解释或 Markdown 代码块）：\n'
      + '{\n  "answer": "直接回答。出处写成【第N页】。需要时写出数值和表号",\n  "pages": ["第3页"],\n  "confidence": "原文陈述|实验数字|读者推断|材料不足",\n  "sufficient": true\n}\n'
      + '只根据片段回答，不补外部知识。片段不够时 sufficient=false，并说明缺哪一部分。'
      + '问题点了页码，而且片段里已有对应【第N页】时，sufficient 必须为 true，除非这一页被截断到无法回答。'
      + '不是原文直接写出的内容标成读者推断。没有的数字不要编。读者批注可以引用，但要写明是读者标注。\n输出语言：简体中文。',
      (hist ? '先前的问答记录（供衔接）：\n' + hist + '\n\n' : '')
      + '读者的新问题：' + question + pageHint
      + ((notes ?? '').trim() ? '\n\n读者在 PDF 上的高亮与批注：\n' + (notes ?? '').trim().slice(0, 2500) : '')
      + '\n\n相关原文片段：\n\n' + frag,
      1800,
      signal)
    const o = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
    const pages = Array.isArray(o.pages) ? o.pages.map(String).filter(Boolean).slice(0, 12) : []
    return {
      answer: String(o.answer ?? '未能生成回答'),
      pages,
      confidence: String(o.confidence ?? '无法确认'),
      sufficient: o.sufficient !== false,
    }
  }
}
