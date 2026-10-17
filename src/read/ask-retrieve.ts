/**
 * 追问检索：页码锚定 + 关键词 top-k（无 LLM 依赖，可单测）。
 *
 * 页码锚定解决：问题点名「第 5–6 / 9–11 页」时，纯关键词 top-3 会漏掉图多词稀的方法页，
 * 模型因此误报「缺少原文」。
 */
/** 问题/文本 → 检索 token（ASCII 词 lowercase + 中文 bigram） */
export function qTokens(input: string): string[] {
  const out: string[] = []
  const ascii = input.toLowerCase().match(/[a-z][a-z0-9_-]{1,}/g) ?? []
  out.push(...ascii)
  const cjk = input.replace(/[^\p{Script=Han}]+/gu, ' ')
  for (const word of cjk.split(/\s+/).filter(Boolean)) {
    if (word.length === 1) out.push(word)
    for (let i = 0; i + 2 <= word.length; i++) out.push(word.slice(i, i + 2))
  }
  return [...new Set(out)]
}

/** 显式编号引用（table 3 / tab.3 / fig.2 / figure 2 / 图3 / 表3）——出现即强命中 */
function explicitRefs(input: string): string[] {
  const re = /\b(?:tab(?:le)?s?\.?|fig(?:ure)?s?\.?|图|表)\s*(\d+[a-zA-Z]?)|\b(\d+[a-zA-Z]?)\s*(?:表|图)/gi
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(input)) !== null) {
    const num = m[1] ?? m[2]
    if (num) out.push(num.toLowerCase())
  }
  return [...new Set(out)]
}

/** 从块文本提取 【第N页】 页码（升序去重）。 */
export function pageMarkersInChunk(text: string): number[] {
  const pages = [...text.matchAll(/【第\s*(\d+)\s*页】/g)].map((m) => Number(m[1])).filter((n) => n > 0)
  return [...new Set(pages)].sort((a, b) => a - b)
}

/**
 * 解析问题中的显式页码 / 页码区间。
 * 支持：第5页、第5–6页、第5到11页、第5、6、7页、p.5-6、pages 9-11。
 */
export function parseRequestedPages(question: string): number[] {
  const pages = new Set<number>()
  const addRange = (a: number, b: number) => {
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    // 单次请求最多扩 24 页，防止「第1到999页」撑爆上下文
    const end = Math.min(hi, lo + 23)
    for (let p = lo; p <= end; p++) pages.add(p)
  }

  const rangeRe = /(?:第\s*)?(\d{1,3})\s*[–—\-~～到至]\s*(\d{1,3})\s*页|(?:pages?|pp?\.?)\s*(\d{1,3})\s*[–—\-~～]\s*(\d{1,3})/gi
  let m: RegExpExecArray | null
  while ((m = rangeRe.exec(question)) !== null) {
    const a = Number(m[1] ?? m[3])
    const b = Number(m[2] ?? m[4])
    if (a > 0 && b > 0) addRange(a, b)
  }

  const listRe = /第\s*((?:\d{1,3}\s*[、，,]\s*)*\d{1,3})\s*页/g
  while ((m = listRe.exec(question)) !== null) {
    for (const part of m[1]!.split(/[、，,\s]+/)) {
      const n = Number(part)
      if (n > 0) pages.add(n)
    }
  }

  const singleRe = /第\s*(\d{1,3})\s*页|(?:^|[^\w])(?:p|page)\.?\s*(\d{1,3})(?!\s*[–—\-~～到至])/gi
  while ((m = singleRe.exec(question)) !== null) {
    const n = Number(m[1] ?? m[2])
    if (n > 0) pages.add(n)
  }

  return [...pages].sort((a, b) => a - b)
}

/** 是否像「按页/按段通讲」——应放宽 top-k，而不是只抽 3 块。 */
export function isSequentialWalkIntent(question: string): boolean {
  return /逐段|逐页|逐节|一段一段|一页一页|按段讲|按页讲|全文讲解|整篇讲解|每一段|每一页/.test(question)
}

/**
 * 找出覆盖目标页码的原文块下标。
 * 无页码标记的「续块」归入上一标记页与下一标记页之间（解决第 11 页落在无【第11页】标记的续块里）。
 */
export function chunksCoveringPages(chunks: string[], wanted: readonly number[]): number[] {
  if (wanted.length === 0 || chunks.length === 0) return []
  const wantedSet = new Set(wanted)
  const hit = new Set<number>()

  type Anchor = { page: number; chunk: number }
  const anchors: Anchor[] = []
  for (let i = 0; i < chunks.length; i++) {
    for (const page of pageMarkersInChunk(chunks[i]!)) anchors.push({ page, chunk: i })
  }
  anchors.sort((a, b) => a.page - b.page || a.chunk - b.chunk)

  for (let i = 0; i < chunks.length; i++) {
    for (const page of pageMarkersInChunk(chunks[i]!)) {
      if (wantedSet.has(page)) hit.add(i)
    }
  }

  if (anchors.length === 0) return [...hit].sort((a, b) => a - b)

  for (const p of wanted) {
    let lo = -1
    for (let i = 0; i < anchors.length; i++) {
      if (anchors[i]!.page <= p) lo = i
      else break
    }
    if (lo < 0) continue
    const startChunk = anchors[lo]!.chunk
    let nextChunk = chunks.length
    for (let i = lo + 1; i < anchors.length; i++) {
      if (anchors[i]!.page > p) {
        nextChunk = anchors[i]!.chunk
        break
      }
    }
    if (nextChunk === startChunk) hit.add(startChunk)
    else {
      for (let c = startChunk; c < nextChunk; c++) hit.add(c)
    }
  }

  return [...hit].sort((a, b) => a - b)
}

/** 关键词检索：返回与问题最相关的 top-k 章节块（原文顺序） */
export function retrieveChunks(chunks: string[], question: string, k = 3): number[] {
  const tokens = qTokens(question)
  const refs = explicitRefs(question)
  if (tokens.length === 0 && refs.length === 0) return chunks.map((_, i) => i).slice(0, k)
  const scored = chunks.map((text, i) => {
    const lower = text.toLowerCase()
    let score = 0
    for (const tk of tokens) {
      // 单 token 命中封顶 3 次：防高频词淹没区分度
      let hit = 0, idx = 0
      while (hit < 3) {
        const at = lower.indexOf(tk, idx)
        if (at < 0) break
        hit++; idx = at + tk.length
      }
      score += hit * (tk.length >= 4 ? 3 : tk.length >= 2 ? 2 : 1)
    }
    for (const num of refs) {
      if (new RegExp(`(?:tab(?:le)?s?\\.?|fig(?:ure)?s?\\.?)?\\s*${num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower)) score += 40
    }
    return { i, score }
  })
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => s.i)
    .sort((a, b) => a - b) // 恢复原文顺序，利于上下文连续
}

export const MAX_ASK_CHUNKS = 8
export const MAX_FRAG_CHARS = 7000

/**
 * 合并「页码强制块」与「关键词 top-k」：页码块优先保留，再补关键词块，总量封顶。
 */
export function selectAskChunks(chunks: string[], question: string): number[] {
  const pages = parseRequestedPages(question)
  const pageHits = chunksCoveringPages(chunks, pages)
  const walk = isSequentialWalkIntent(question)
  const k = pages.length > 0 ? Math.min(5, MAX_ASK_CHUNKS) : walk ? 6 : 3
  const scored = retrieveChunks(chunks, question, k)

  const merged: number[] = []
  const seen = new Set<number>()
  const push = (idx: number) => {
    if (seen.has(idx) || idx < 0 || idx >= chunks.length) return
    if (merged.length >= MAX_ASK_CHUNKS) return
    seen.add(idx)
    merged.push(idx)
  }

  for (const i of pageHits) push(i)
  for (const i of scored) push(i)

  if (merged.length === 0) {
    const n = Math.min(walk ? 4 : 2, chunks.length)
    for (let i = 0; i < n; i++) push(i)
  }

  return merged.sort((a, b) => a - b)
}
