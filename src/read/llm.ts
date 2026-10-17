import { randomUUID } from 'node:crypto'
import type { AbortLike, HostContext, ModelSelection } from './types.js'
import { errorMessage, isLlmCatalogService, isLlmStreamService, isRecord } from './types.js'
import { providerSignal, throwIfCancelled } from './cancel.js'
import { isPreferExhaustionError } from '../jev-prefer.js'

/** Harness Message shape: adapters and llm/stream invariants read `source.kind`. */
export function pluginUserMessage(text: string, content?: Array<Record<string, unknown>>) {
  return {
    id: randomUUID(),
    role: 'user' as const,
    content: content ?? [{ type: 'text' as const, text }],
    source: { kind: 'plugin' as const, plugin: 'dsh-scholar' },
  }
}

export function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback
}

export function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
}

export function arr(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (typeof v === 'string' && v.trim() !== '') return [v.trim()]
  return []
}

/** 模型常在 JSON 外包一层说明或代码围栏。取最外层对象，并去掉尾逗号后再解析。 */
export function parseJson(text: string): unknown {
  const fenced = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  const start = fenced.indexOf('{')
  const end = fenced.lastIndexOf('}')
  const body = start >= 0 && end > start ? fenced.slice(start, end + 1) : fenced
  const loosened = body.replace(/,\s*([}\]])/g, '$1')
  for (const candidate of [body, loosened]) {
    try { return JSON.parse(candidate) } catch { /* 再试下一份 */ }
  }
  return null
}

function clipAtSentence(text: string, size: number): string {
  if (text.length <= size) return text
  const window = text.slice(0, size)
  const marks = ['\n\n', '。', '！', '？', '；', '. ', '; ']
  let cut = Math.floor(size * 0.55)
  for (const mark of marks) {
    const at = window.lastIndexOf(mark)
    if (at >= cut) cut = at + mark.length
  }
  return text.slice(0, Math.max(1, cut))
}

/** 按空行分段，超长段再在句末切开。 */
export function splitChunks(text: string, size: number): string[] {
  const paras = text.split(/\n{2,}/).map((para) => para.trim()).filter((para) => para !== '')
  const chunks: string[] = []
  let current = ''
  const push = (piece: string) => {
    const trimmed = piece.trim()
    if (trimmed !== '') chunks.push(trimmed)
  }
  for (const para of paras) {
    if (para.length > size) {
      push(current)
      current = ''
      let rest = para
      while (rest.length > size) {
        const piece = clipAtSentence(rest, size)
        push(piece)
        rest = rest.slice(piece.length).trim()
      }
      current = rest
    } else if (current !== '' && current.length + 2 + para.length > size) {
      push(current)
      current = para
    } else {
      current = current === '' ? para : current + '\n\n' + para
    }
  }
  push(current)
  return chunks
}


// 论文章节标题识别：编号标题（1. / 2.1 / 1）或常见章节名（英文/中文，含变体）
const PAPER_HEADING_RE = /^(?:\d+(?:\.\d+)*[.、)]?\s+\S.{0,70}|(?:abstract|introduction|related works?|preliminaries?|background|method(?:s|ology)?|approach|proposed (?:method|approach|framework|model)|model|architecture|experiment(?:s|al (?:setup|results))?|evaluation|results?(?: and discussion)?|ablation(?: studies?)?|discussion|conclusions?|limitations|future work|acknowledgements?|references|appendix|摘要|引言|前言|相关工作|研究背景|背景|预备知识|方法|模型|网络结构|模型结构|实验|实验设置|实验结果|结果与分析|结果|消融实验|消融|讨论|结论|总结|局限|不足|附录|参考文献)[.。:：]?\s*)$/i

/**
 * 论文专用章节感知分段（paper 模式）：先按章节标题切，再把相邻小节合并到 size
 * 预算内；超长单节回落到通用 splitChunks。比字符硬切保留完整的「方法/实验」语义单元。
 */
export function splitChunksPaper(text: string, size: number): string[] {
  const isHeading = (line: string): boolean => {
    const t = line.trim()
    if (t === '' || t.length > 90) return false
    return PAPER_HEADING_RE.test(t)
  }
  const lines = text.split(/\r?\n/)
  const sections: string[] = []
  let cur: string[] = []
  for (const line of lines) {
    const curText = cur.join('\n')
    if (isHeading(line) && curText.trim() !== '') {
      sections.push(curText)
      cur = [line]
    } else {
      cur.push(line)
    }
  }
  const lastText = cur.join('\n')
  if (lastText.trim() !== '') sections.push(lastText)
  const chunks: string[] = []
  let buf = ''
  for (const sec of sections) {
    if (sec.length > size) {
      if (buf.trim() !== '') { chunks.push(buf.trim()); buf = '' }
      chunks.push(...splitChunks(sec, size))
    } else if ((buf === '' ? 0 : buf.length + 2) + sec.length > size) {
      chunks.push(buf.trim())
      buf = sec
    } else {
      buf = buf === '' ? sec : buf + '\n\n' + sec
    }
  }
  if (buf.trim() !== '') chunks.push(buf.trim())
  return chunks
}

/** Request fields an adapter and the caller both own; stripping one cannot produce
 *  a valid request, so a provider naming one is a real failure, not a knob to drop. */
const REQUIRED_FIELDS = new Set(['provider', 'model', 'messages', 'system', 'signal'])

/**
 * 从 Provider 报错里读出被拒绝的请求字段名。官方接口形如
 * `{"detail":"Unsupported parameter: temperature"}`，部分网关写作
 * `unknown parameter "top_p"`。读不出就返回 null，交给调用方按普通错误处理。
 */
export function unsupportedFieldName(message: string): string | null {
  const quoted = /(?:unsupported|unknown|unrecognized|unexpected)\s+(?:parameter|field|argument)s?[:\s]+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/i.exec(message)
  return quoted === null ? null : quoted[1]!
}

/**
 * 把 Provider 点名的字段解析成本次请求里真实存在的键，可摘除时返回该键，否则 null。
 * Provider 常按线路协议用 snake_case 报字段（`max_tokens`），而请求对象是
 * camelCase（`maxTokens`），因此两种写法都要认。必需字段永不可摘。
 */
export function strippableField(message: string, options: Record<string, unknown>): string | null {
  const named = unsupportedFieldName(message)
  if (named === null || REQUIRED_FIELDS.has(named)) return null
  const camel = named.replace(/_([a-z0-9])/g, (_match, ch: string) => ch.toUpperCase())
  if (Object.prototype.hasOwnProperty.call(options, named)) return named
  if (Object.prototype.hasOwnProperty.call(options, camel)) return camel
  return null
}

interface LlmRuntimeDependencies {
  ctx: HostContext
  estimateTokens(text: string): number
  llmCallStats: { calls: number; ms: number }
  recordCalibration(rateTokPerSec: number, latencyMs: number): void
  /** Scholar settings override; return null/empty to fall through to agent default. */
  preferredModel?: () => { provider?: string; model?: string } | null | undefined
  /** Sticky-fall back when preferred model hits quota/auth/unavailable. Default true. */
  preferFallback?: boolean | (() => boolean)
}

/** Optional override from Scholar settings (`llmProvider` + `llmModel`). */
export type PreferredModelFn = () => { provider?: string; model?: string } | null | undefined

export function createLlmRuntime(deps: LlmRuntimeDependencies) {
  const { ctx, estimateTokens, llmCallStats, recordCalibration } = deps
  const preferFallbackOn = (): boolean => {
    const v = deps.preferFallback
    if (typeof v === 'function') return v() !== false
    return v !== false
  }
  let preferExhausted = false
  let preferRef: { provider: string; model: string } | null = null

  function refreshPrefer(): void {
    const pref = deps.preferredModel?.()
    if (pref && typeof pref.provider === 'string' && pref.provider.trim()
      && typeof pref.model === 'string' && pref.model.trim()) {
      preferRef = { provider: pref.provider.trim(), model: pref.model.trim() }
    } else {
      preferRef = null
    }
  }

  function agentDefault(): ModelSelection | null {
    const sel = ctx.get('agentDefaultModel')
    if (sel !== undefined && typeof sel.currentSelection === 'function') {
      const s = sel.currentSelection()
      if (isRecord(s) && typeof s.provider === 'string' && typeof s.model === 'string') {
        return { provider: s.provider, model: s.model, reasoningEffort: s.reasoningEffort }
      }
    }
    return null
  }

  function selectedModel(): ModelSelection | null {
    refreshPrefer()
    if (preferRef !== null && !preferExhausted) return { ...preferRef }
    return agentDefault()
  }

  function isPreferSelection(cfg: ModelSelection): boolean {
    return preferRef !== null && cfg.provider === preferRef.provider && cfg.model === preferRef.model
  }

async function pickConfig(): Promise<ModelSelection> {
  const cfg = selectedModel()
  if (cfg !== null) return cfg
  if (!isLlmCatalogService(ctx.llm)) {
    throw new Error('没有可用的模型 Provider，无法执行精读分析')
  }
  const providers = ctx.llm.listProviders()
  if (!Array.isArray(providers)) {
    throw new Error('没有可用的模型 Provider，无法执行精读分析')
  }
  const first = providers.find((provider: unknown) => typeof provider === 'string' || (isRecord(provider) && typeof provider.id === 'string'))
  const providerId = typeof first === 'string' ? first : (isRecord(first) && typeof first.id === 'string' ? first.id : null)
  if (providerId === null) {
    throw new Error('没有可用的模型 Provider，无法执行精读分析')
  }
  const models = await ctx.llm.listModels(providerId)
  if (!Array.isArray(models)) {
    throw new Error('Provider "' + providerId + '" 下没有可用模型')
  }
  const firstModel = models.find((model: unknown) => typeof model === 'string' || (isRecord(model) && typeof model.id === 'string'))
  const modelId = typeof firstModel === 'string' ? firstModel : (isRecord(firstModel) && typeof firstModel.id === 'string' ? firstModel.id : null)
  if (modelId === null) {
    throw new Error('Provider "' + providerId + '" 下没有可用模型')
  }
  return { provider: providerId, model: modelId }
}

/** 结构化 JSON 提取：默认关推理——思考档会吃光输出预算导致「空结果」。
 *  空结果重试仍保持 off 并加大预算；Provider 不支持时自动摘除该字段。 */
type Effort = 'low' | 'off' | undefined

async function callModel(cfg: ModelSelection, system: string, userText: string, maxTokens: number, signal?: AbortLike | null, effort: Effort = 'off'): Promise<string> {
  // Sampling controls are intentionally omitted: some selected models (for example
  // reasoning/Responses endpoints) reject `temperature` outright. The optional
  // GenerateOptions field lets each provider apply its own compatible default.
  const base = {
    provider: cfg.provider,
    model: cfg.model,
    system,
    messages: [pluginUserMessage(userText)],
    maxTokens,
  }
  let options: Record<string, unknown> = { ...base, reasoningEffort: effort }
  for (let tryIdx = 0; ; tryIdx++) {
    try {
      return await streamOnce(options, signal)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Provider 不认这个档位（UNSUPPORTED_REASONING_EFFORT 等）：摘掉字段用 Provider 默认重试一次
      if (tryIdx === 0 && effort !== undefined && /UNSUPPORTED_REASONING_EFFORT|reasoning effort/i.test(msg)) {
        options = { ...base }
        continue
      }
      // 其余「不支持该参数」的拒绝：只摘掉被点名的那一个字段再试，而不是把
      // 4 次重试全花在同一个注定失败的请求上。每轮至少删掉一个自有字段，
      // 因此循环必然收敛；必需字段永不摘除，真错误照旧抛出。
      const field = strippableField(msg, options)
      if (field !== null) {
        const next = { ...options }
        delete next[field]
        options = next
        console.warn('[dsh-scholar] Provider 拒绝参数 "' + field + '"，已摘除该字段重试：' + msg.slice(0, 160))
        continue
      }
      throw err
    }
  }
}

async function streamOnce(options: Record<string, unknown>, signal?: AbortLike | null): Promise<string> {
  let text = ''
  let failure: string | null = null
  if (!isLlmStreamService(ctx.llm)) throw new Error('模型服务不支持流式调用')
  // R08:把 AbortLike 桥接成真 AbortSignal 注入 provider 选项——宿主/供应商
  // 支持时取消即刻中断(含等待首块),不再依赖下一块到达后才检查标志
  throwIfCancelled(signal)
  const bridge = providerSignal(signal)
  if (bridge.signal) options = { ...options, signal: bridge.signal }
  try {
    for await (const chunk of ctx.llm.stream(options)) {
      if (signal !== undefined && signal !== null && signal.aborted) throw new Error('任务已取消')
      if (!isRecord(chunk)) continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
      } else if (chunk.type === 'block-end' && isRecord(chunk.block) && chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
        // 部分适配器只在 block-end 给出完整文本；若已累计 delta 则勿重复拼接
        if (text.trim() === '') text = chunk.block.text
      } else if (chunk.type === 'finish') {
        const reason = chunk.reason
        if (isRecord(reason) && (reason.kind === 'error' || reason.kind === 'aborted')) {
          const f = reason.failure
          failure = isRecord(f) ? str(f.message, str(f.code, '模型调用失败')) : '模型调用失败'
        }
      }
    }
    if (failure !== null) throw new Error('模型调用失败：' + failure)
    if (text.trim() === '') throw new Error('模型返回了空结果')
    return text
  } finally {
    // R08:轮询清理(bridge abort 后 provider 流自然终止)
    bridge.dispose()
  }
}

// 判定输出是否被 token 预算截断：JSON 解析失败且文本未正常闭合（对象/数组中途断开）。
function looksTruncated(text: string): boolean {
  const t = String(text).trim()
  if (t === '') return false
  const last = t[t.length - 1]
  return last !== '}' && last !== ']'
}

// 带重试的 JSON 调用：按失败类型分类重试。推理档位默认 low（防高推理吃光预算），
// 空结果时下一次直接 off（彻底关思考）并加大输出预算（×2）；截断 ×1.5（硬顶 16000）；
// 纯格式问题用校正提示同预算重试；底层错误重试前退避等待。最终失败时保留每个
// attempt 的真实原因，不做无信息的吞没。
const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
async function callModelJson(initialCfg: ModelSelection, system: string, userText: string, maxTokens: number, signal?: AbortLike | null): Promise<unknown> {
  const MAX_BUDGET = 32768; // 供应商默认 256k，这只留应急余量；上限≠成本（按实际产出计费）
  const ATTEMPTS = 4;
  let cfg = initialCfg;
  let prompt = userText;
  let budget = maxTokens;
  let effort: Effort = 'off';
  const history: Array<{ text: string; error: string | null }> = [];
  const callStarted = Date.now();
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0 && signal !== undefined && signal !== null && signal.aborted) throw new Error('任务已取消');
    let text = '';
    let error = null;
    const t0 = Date.now();
    try {
      text = await callModel(cfg, system, prompt, budget, signal, effort);
      // 运行时自校准：实测吞吐与首字延迟（估计），仅对成功调用采样。
      const elapsedMs = Math.max(1, Date.now() - t0);
      const tokens = estimateTokens(text);
      const seconds = elapsedMs / 1000;
      if (text.trim() !== '' && tokens > 0) {
        const rateTokPerSec = tokens / seconds;
        const generationMs = rateTokPerSec > 0 ? (tokens / rateTokPerSec) * 1000 : elapsedMs;
        recordCalibration(rateTokPerSec, elapsedMs - generationMs);
      }
    } catch (err) {
      error = errorMessage(err);
      if (preferFallbackOn() && !preferExhausted && isPreferSelection(cfg) && isPreferExhaustionError(error)) {
        preferExhausted = true;
        cfg = await pickConfig();
        attempt--;
        continue;
      }
    }
    const parsed = error === null ? parseJson(text) : null;
    history.push({ text, error });
    if (parsed !== null) {
      llmCallStats.calls++;
      llmCallStats.ms += Date.now() - callStarted;
      return parsed;
    }
    const truncated = error === null && looksTruncated(text);
    if (error !== null) {
      // 底层错误重试前退避：attempt 1→1.5s, 2→3s, 3→4.5s（瞬时机型抖动冷却）
      await sleep(1500 * attempt);
      const empty = error.includes('空结果');
      if (empty) {
        // 空结果=思考阶段吃光了预算：下一次彻底关推理 + 预算翻倍
        effort = 'off';
        budget = Math.min(Math.ceil(budget * 2), MAX_BUDGET);
      } else {
        budget = Math.min(Math.ceil(budget * 1.5), MAX_BUDGET);
      }
    } else if (truncated) {
      budget = Math.min(Math.ceil(budget * 1.5), MAX_BUDGET);
    }
    if (error !== null) {
      prompt = userText + '\n\n[系统校正] 上一次调用失败（' + error + '），已加大输出预算。请重新只输出一个合法的 JSON 对象：不要任何解释或额外文字。';
    } else if (truncated) {
      prompt = userText + '\n\n[系统校正] 你上一次的输出在 JSON 中途被截断（输出预算不足）。请大幅压缩篇幅——arguments 最多 6 条、quotes 最多 4 条、concepts 最多 5 条、questions 最多 4 条，每条只写一句话——并输出完整闭合的 JSON 对象，末尾以 } 结束。';
    } else {
      prompt = userText + '\n\n[系统校正] 你上一次的输出无法解析为 JSON（可能混入了解释文字、Markdown 围栏、尾随逗号，或字符串内直接换行）。请重新只输出一个合法的 JSON 对象：不要任何解释或额外文字，字符串内不要直接换行（多行文本用 \\n 转义），引号正确转义，末尾不要有逗号。';
    }
  }
  llmCallStats.calls++;
  llmCallStats.ms += Date.now() - callStarted;
  const kinds = history.map((h) => {
    if (h.error !== null) return '底层错误（' + h.error + '）';
    if (looksTruncated(h.text)) return '输出被截断';
    if (String(h.text).trim() === '') return '空输出';
    return 'JSON 解析失败';
  });
  const tail = String(history[history.length - 1]?.text ?? '').trim();
  const shown = tail.length > 160 ? tail.slice(-160) : tail;
  throw new Error(`模型输出 ${ATTEMPTS} 次均未得到合法 JSON：` + kinds.join('；') + (shown === '' ? '' : '。末次输出尾部：' + shown));
}


  return { callModel, callModelJson, pickConfig, selectedModel }
}
