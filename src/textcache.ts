/**
 * PDF 正文检索缓存。上传和精读归档时写入 textcache/<id>.txt，
 * 论文库搜索和 paper_search 在标题/摘要之外再查这里。
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { safeName } from './store.js'

const memory = new Map<string, { id: string; text: string }>()
let loadedDir = ''

export async function writeTextCache(dir: string, paperId: string, text: string): Promise<void> {
  const body = text.replace(/\s+/g, ' ').trim().slice(0, 120_000)
  if (body.length < 40) return
  const folder = join(dir, 'textcache')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, `${safeName(paperId)}.txt`), `${paperId}\n${body}`, 'utf8')
  memory.set(safeName(paperId), { id: paperId, text: body.toLowerCase() })
  loadedDir = dir
}

export async function indexPdfFile(dir: string, paperId: string, absPath: string): Promise<void> {
  const buf = await readFile(absPath)
  const { extractPdfPlainText } = await import('./read/pdf-text.js')
  const text = await extractPdfPlainText(buf)
  await writeTextCache(dir, paperId, text)
}

export async function bodyMatchIds(dir: string, q: string): Promise<Set<string>> {
  const needle = q.trim().toLowerCase()
  const hits = new Set<string>()
  if (needle.length < 2) return hits
  if (loadedDir !== dir || memory.size === 0) {
    memory.clear()
    loadedDir = dir
    let names: string[] = []
    try { names = await readdir(join(dir, 'textcache')) } catch { return hits }
    for (const name of names) {
      if (!name.endsWith('.txt')) continue
      try {
        const raw = await readFile(join(dir, 'textcache', name), 'utf8')
        const nl = raw.indexOf('\n')
        const id = nl > 0 ? raw.slice(0, nl).trim() : ''
        const body = (nl > 0 ? raw.slice(nl + 1) : raw).toLowerCase()
        if (id) memory.set(name, { id, text: body })
      } catch { /* 坏缓存跳过 */ }
    }
  }
  for (const entry of memory.values()) {
    if (entry.text.includes(needle)) hits.add(entry.id)
  }
  return hits
}
