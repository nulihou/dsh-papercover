/**
 * 从已抽出的正文里收集论文图号，并把读者高亮收成可塞进精读/追问的短文本。
 * 图号来自「Figure/Fig./图 N」图注，页码是 PDF 物理页，和抽出位图的顺序不是同一套编号。
 */

export interface FigureCatalogEntry {
  n: number
  page: number
  caption: string
}

export function extractFigureCatalog(text: string): FigureCatalogEntry[] {
  const parts = text.split(/【第(\d+)页】/)
  const out: FigureCatalogEntry[] = []
  const seen = new Set<number>()
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const page = Number(parts[i])
    const body = parts[i + 1] ?? ''
    const re = /(?:^|\n)\s*(?:Figure|Fig\.?|图)\s*(\d{1,2})\s*[.．:：]?\s*([^\n]{12,220})/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(body)) !== null) {
      const n = Number(m[1])
      if (!n || seen.has(n)) continue
      const caption = (m[2] ?? '').replace(/\s+/g, ' ').trim()
      if (caption.length < 12) continue
      seen.add(n)
      out.push({ n, page, caption: caption.slice(0, 180) })
      if (out.length >= 16) return out.sort((a, b) => a.n - b.n)
    }
  }
  return out.sort((a, b) => a.n - b.n)
}

/** 视觉解读若对上图注，模型被要求用这一行起头。对不上则返回 null。 */
export function parseFigTag(text: string): { n: number; page: number; rest: string } | null {
  const m = /^\s*FIG\s+(\d{1,2})\s+PAGE\s+(\d{1,4})\s*/i.exec(text)
  if (!m) return null
  const n = Number(m[1])
  const page = Number(m[2])
  if (!n || !page) return null
  return { n, page, rest: text.slice(m[0].length).replace(/^\s+/, '') }
}

export function formatReaderNotes(highlights: Array<{ page: number; text: string; comment?: string }>): string {
  return highlights.slice(0, 40).map((h) => {
    const t = h.text.replace(/\s+/g, ' ').trim().slice(0, 180)
    const c = (h.comment ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
    if (!t && !c) return ''
    return `第${h.page}页 ${t}${c ? ' ｜批注：' + c : ''}`
  }).filter(Boolean).join('\n')
}
