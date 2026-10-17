/**
 * dsh-papercover PDF 正文抽取。走 pdf.js 的文字层，按物理页标【第N页】。
 * 双栏页先读左栏再读右栏；没有文字层的页记在开头说明里。
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const nodeRequire = createRequire(import.meta.url)

export interface PdfTextProgress {
  done: number
  total: number
}

interface TextRun {
  text: string
  x: number
  y: number
}

interface PdfDocument {
  numPages: number
  getPage(pageNumber: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>
  destroy(): Promise<void>
}

interface PdfJsModule {
  getDocument(src: Record<string, unknown>): { promise: Promise<PdfDocument> }
  GlobalWorkerOptions: { workerSrc: string }
}

let loader: Promise<PdfJsModule> | null = null

function pdfjsRoot(): string {
  return dirname(nodeRequire.resolve('pdfjs-dist/package.json'))
}

function dirUrl(folder: string): string {
  const href = pathToFileURL(join(pdfjsRoot(), folder)).href
  return href.endsWith('/') ? href : href + '/'
}

async function readFileUrl(url: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(fileURLToPath(url)))
}

/** pdf.js 在 Node 里用 fetch 读 file:// 会失败。改从磁盘读 CMap 和标准字体。 */
class NodeCMapReaderFactory {
  baseUrl: string
  isCompressed: boolean
  constructor(opts: { baseUrl?: string; isCompressed?: boolean } = {}) {
    this.baseUrl = opts.baseUrl ?? ''
    this.isCompressed = opts.isCompressed !== false
  }
  async fetch(query: { name: string }): Promise<{ cMapData: Uint8Array; isCompressed: boolean }> {
    const suffix = this.isCompressed ? '.bcmap' : ''
    return { cMapData: await readFileUrl(this.baseUrl + query.name + suffix), isCompressed: this.isCompressed }
  }
}

class NodeStandardFontFactory {
  baseUrl: string
  constructor(opts: { baseUrl?: string } = {}) {
    this.baseUrl = opts.baseUrl ?? ''
  }
  async fetch(query: { filename: string }): Promise<Uint8Array> {
    return readFileUrl(this.baseUrl + query.filename)
  }
}

function loadPdfJs(): Promise<PdfJsModule> {
  if (!loader) {
    loader = (async () => {
      const root = pdfjsRoot()
      const pdfjs = await import(pathToFileURL(join(root, 'legacy/build/pdf.mjs')).href) as PdfJsModule
      pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(join(root, 'legacy/build/pdf.worker.mjs')).href
      return pdfjs
    })()
  }
  return loader
}

function runsFromItems(items: unknown[]): TextRun[] {
  const runs: TextRun[] = []
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue
    const rec = item as { str?: unknown; transform?: unknown }
    const text = typeof rec.str === 'string' ? rec.str : ''
    if (text.trim() === '') continue
    const transform = Array.isArray(rec.transform) ? rec.transform : []
    const x = typeof transform[4] === 'number' ? transform[4] : 0
    const y = typeof transform[5] === 'number' ? transform[5] : 0
    runs.push({ text, x, y })
  }
  return runs
}

function lineOf(row: TextRun[]): string {
  return row.map((run) => run.text).join(' ').replace(/[ \t]{2,}/g, ' ').trim()
}

/** 按基线分行。左右栏起点拉开时先读完左栏，再读右栏。 */
function readingOrder(runs: TextRun[]): string {
  if (runs.length === 0) return ''
  const rows: TextRun[][] = []
  const ordered = [...runs].sort((a, b) => b.y - a.y || a.x - b.x)
  for (const run of ordered) {
    const row = rows[rows.length - 1]
    const anchor = row?.[0]
    if (row && anchor && Math.abs(anchor.y - run.y) <= 2.5) row.push(run)
    else rows.push([run])
  }
  for (const row of rows) row.sort((a, b) => a.x - b.x)
  const edges = rows.map((row) => row[0]!.x).sort((a, b) => a - b)
  let widest = 0
  let at = -1
  for (let i = 1; i < edges.length; i++) {
    const gap = edges[i]! - edges[i - 1]!
    if (gap > widest) {
      widest = gap
      at = i
    }
  }
  const lines = (group: TextRun[][]) => group.map(lineOf).filter((line) => line !== '').join('\n')
  if (widest >= 90 && at > 0 && rows.length >= 10) {
    const mid = (edges[at - 1]! + edges[at]!) / 2
    const left = rows.filter((row) => row[0]!.x < mid)
    const right = rows.filter((row) => row[0]!.x >= mid)
    if (left.length >= 4 && right.length >= 4) {
      return [lines(left), lines(right)].filter((col) => col !== '').join('\n\n')
    }
  }
  return lines(rows)
}

function symbolNote(runs: TextRun[]): string {
  if (runs.length < 30) return ''
  const tiny = runs.filter((run) => run.text.trim().length <= 1).length
  if (tiny / runs.length < 0.5) return ''
  return '\n【本页符号被拆成单字，公式和数字请对照 PDF】'
}

/**
 * 抽出带物理页码的纯文本。扫描页留在说明里，不把后面的页码往前挪。
 * @param data - PDF 字节
 */
export async function extractPdfPlainText(
  data: Uint8Array,
  onProgress?: (info: PdfTextProgress) => void,
): Promise<string> {
  const pdfjs = await loadPdfJs()
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(data),
    cMapUrl: dirUrl('cmaps'),
    cMapPacked: true,
    CMapReaderFactory: NodeCMapReaderFactory,
    standardFontDataUrl: dirUrl('standard_fonts'),
    StandardFontDataFactory: NodeStandardFontFactory,
    useWorkerFetch: false,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise
  try {
    const total = doc.numPages
    onProgress?.({ done: 0, total })
    const pages: Array<{ page: number; text: string }> = []
    for (let n = 1; n <= total; n++) {
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      const runs = runsFromItems(content.items)
      const text = (readingOrder(runs).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + symbolNote(runs)).trim()
      if (text !== '') pages.push({ page: n, text })
      if (n === total || n % 4 === 0) onProgress?.({ done: n, total })
    }
    if (pages.length === 0) return ''
    const empty = total - pages.length
    const note = empty > 0
      ? `【抽取说明】共 ${total} 页，其中 ${empty} 页没有文字层（扫描页或纯图片）。【第N页】是 PDF 物理页码。\n\n`
      : ''
    return note + pages.map((page) => `【第${page.page}页】\n${page.text}`).join('\n\n')
  } finally {
    await doc.destroy().catch(() => undefined)
  }
}
