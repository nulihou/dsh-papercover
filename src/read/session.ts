/**
 * Reading session for interactive ask: reads/<safeId>.json
 * - chunks: chapter blocks from deep-read (retrieval corpus; refreshed on re-read)
 * - qa: Q&A history (kept across re-reads)
 */
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { safeName } from '../store.js';

export interface QAEntry {
  q: string
  a: string
  pages: string[]
  confidence: string
  sufficient: boolean
  at: number
}

export interface ReadingSession {
  paperId: string
  chunks: string[]
  qa: QAEntry[]
  updatedAt: number
}

/** Serialize writes to the same session file. */
const sessionLocks = new Map<string, Promise<void>>()
let tmpSeq = 0
async function withSessionLock<T>(dir: string, paperId: string, fn: () => Promise<T>): Promise<T> {
  const key = dir + '\u0000' + paperId
  const prev = sessionLocks.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  sessionLocks.set(key, run.then(() => undefined, () => undefined))
  return run
}
function uniqueTmp(file: string): string {
  return file + '.' + process.pid.toString(36) + '.' + Date.now().toString(36) + '-' + String(tmpSeq++) + '.tmp'
}
export function sessionPath(dir: string, paperId: string): string {
  return join(dir, 'reads', safeName(paperId) + '.json')
}

export async function loadSession(dir: string, paperId: string): Promise<ReadingSession | null> {
  try {
    const raw = JSON.parse(await readFile(sessionPath(dir, paperId), 'utf8')) as ReadingSession
    if (!raw || !Array.isArray(raw.chunks) || raw.chunks.length === 0) return null
    return { ...raw, qa: Array.isArray(raw.qa) ? raw.qa : [] }
  } catch {
    return null
  }
}

async function writeSessionAtomic(file: string, session: ReadingSession): Promise<void> {
  const tmp = uniqueTmp(file)
  await writeFile(tmp, JSON.stringify(session), 'utf8')
  await rename(tmp, file)
}

/** Refresh chunks after deep-read; keep prior Q&A. */
export async function saveSessionAfterRead(dir: string, paperId: string, chunks: string[]): Promise<void> {
  await withSessionLock(dir, paperId, async () => {
    const prev = await loadSession(dir, paperId)
    const session: ReadingSession = {
      paperId,
      chunks,
      qa: prev?.qa ?? [],
      updatedAt: Date.now(),
    }
    await mkdir(join(dir, 'reads'), { recursive: true })
    await writeSessionAtomic(sessionPath(dir, paperId), session)
  })
}

export async function appendQA(dir: string, paperId: string, entry: QAEntry): Promise<void> {
  await withSessionLock(dir, paperId, async () => {
    const s = await loadSession(dir, paperId)
    if (!s) throw new Error('这篇论文还没有精读会话（先精读一次才能追问）')
    s.qa.push(entry)
    s.updatedAt = Date.now()
    await mkdir(join(dir, 'reads'), { recursive: true })
    await writeSessionAtomic(sessionPath(dir, paperId), s)
  })
}
