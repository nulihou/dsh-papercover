/**
 * Cross-plugin bridge: scholar desk → dsh-md-notes `appendMarkdown`.
 * Browser-only; never value-imports md-notes. Opens notes via CustomEvent.
 * @module dsh-scholar/client/md-notes-bridge
 */

const MD_NOTES_API = '/plugins/md-notes'
export const OPEN_PAPER_EVENT = 'dsh-scholar:open-paper'
export const OPEN_NOTE_EVENT = 'dsh-md-notes:open-note'

/** HTTPS deep link that survives MarkdownText's protocol allowlist. */
const SCHOLAR_PAPER_HTTPS = 'https://dsh.local/scholar/paper/'
const SCHOLAR_PAPER_SCHEME = 'dsh-scholar://paper/'

export function scholarPaperHref(paperId: string): string {
  return `${SCHOLAR_PAPER_HTTPS}${encodeURIComponent(paperId.trim())}`
}

export interface AppendToPaperNoteInput {
  paperId: string
  paperTitle: string
  heading: string
  markdown: string
  sessionId?: string
}

export type AppendToPaperNoteResult =
  | { ok: true; name: string; created: boolean; workspaceId?: string }
  | { ok: false; code: string; error: string }

interface MdNotesListOk {
  ok: true
  workspaces: Array<{ workspaceId: string; name: string }>
  noWorkspaces?: boolean
}

interface MdNotesAppendOk {
  ok: true
  name: string
  created: boolean
}

interface MdNotesErr {
  ok: false
  error?: string
  code?: string
}

/** Build a markdown section body for one highlight (quote + optional note). */
export function formatHighlightMarkdown(
  paperId: string,
  paperTitle: string,
  h: { page: number; text: string; comment?: string },
): string {
  const quote = h.text.replace(/\n/g, ' ').trim()
  const note = h.comment?.trim() ? `\n\n> note: ${h.comment.trim()}` : ''
  return [
    `> ${quote}`,
    '',
    `p.${h.page}`,
    note,
    '',
    `[${paperTitle}](${scholarPaperHref(paperId)})`,
  ].filter((line, i, arr) => !(line === '' && arr[i - 1] === '')).join('\n').trim() + '\n'
}

/** Build markdown for the current PDF selection. */
export function formatSelectionMarkdown(
  paperId: string,
  paperTitle: string,
  text: string,
  page?: number,
): string {
  const quote = text.replace(/\n/g, ' ').trim()
  const pageLine = page != null && page > 0 ? `\n\np.${page}` : ''
  return `> ${quote}${pageLine}\n\n[${paperTitle}](${scholarPaperHref(paperId)})\n`
}

/** Build markdown for one folio card (mirrors copyMd shape + paper deep link). */
export function formatFolioMarkdown(
  paperId: string | undefined,
  paperTitle: string,
  card: {
    title: string
    insight: string
    notes?: string
    tags?: string[]
    statusLabel?: string
    categoryLabel?: string
    importance?: number
  },
): string {
  const lines: string[] = [`### ${card.title}`, '']
  const meta: string[] = []
  if (card.statusLabel) meta.push(card.statusLabel)
  if (card.categoryLabel) meta.push(card.categoryLabel)
  if (card.importance) meta.push('★'.repeat(card.importance))
  if (meta.length) lines.push(`- ${meta.join(' · ')}`)
  if (paperId) lines.push(`- ${paperTitle}`)
  lines.push('', card.insight)
  if (card.notes) lines.push('', `> ${card.notes.replace(/\n/g, '\n> ')}`)
  if (card.tags?.length) lines.push('', card.tags.map((x) => `#${x}`).join(' '))
  if (paperId) {
    lines.push('', `[${paperTitle}](${scholarPaperHref(paperId)})`)
  }
  return `${lines.join('\n').trim()}\n`
}

/** Resolve session id from the mounted sidebar when present. */
export function resolveSessionId(): string | undefined {
  try {
    // Lazy import avoided — rightbar owns the handle; callers may pass sessionId.
    const mod = (globalThis as { __dshScholarSessionId?: () => string | undefined }).__dshScholarSessionId
    const id = mod?.()?.trim()
    return id || undefined
  } catch {
    return undefined
  }
}

async function postMdNotes<T extends object>(body: Record<string, unknown>): Promise<T | MdNotesErr> {
  const res = await fetch(MD_NOTES_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  try {
    return (await res.json()) as T | MdNotesErr
  } catch {
    return { ok: false, code: 'http', error: `http ${res.status}` }
  }
}

/**
 * Append markdown into `{paperTitle}.md` via md-notes.
 * Picks the session workspace when `sessionId` resolves; else the first listed workspace.
 */
export async function appendToPaperNote(input: AppendToPaperNoteInput): Promise<AppendToPaperNoteResult> {
  const paperId = input.paperId.trim()
  const paperTitle = input.paperTitle.trim() || paperId || 'note'
  const markdown = input.markdown.trim()
  if (!markdown) return { ok: false, code: 'empty-markdown', error: 'empty markdown' }

  const sessionId = input.sessionId?.trim() || resolveSessionId()
  let listed = await postMdNotes<MdNotesListOk>({
    method: 'list',
    ...(sessionId ? { sessionId } : {}),
  })
  if (!listed.ok) {
    return {
      ok: false,
      code: listed.code ?? 'list-failed',
      error: listed.error ?? 'list notes failed',
    }
  }
  // Session may have no workspace — fall back to any available workspace.
  if ((!listed.workspaces.length || listed.noWorkspaces) && sessionId) {
    listed = await postMdNotes<MdNotesListOk>({ method: 'list' })
    if (!listed.ok) {
      return {
        ok: false,
        code: listed.code ?? 'list-failed',
        error: listed.error ?? 'list notes failed',
      }
    }
  }
  if (!listed.ok || !listed.workspaces.length || listed.noWorkspaces) {
    return { ok: false, code: 'no-workspace', error: 'no workspace' }
  }
  const workspaceId = listed.workspaces[0]!.workspaceId

  const appended = await postMdNotes<MdNotesAppendOk>({
    method: 'appendMarkdown',
    workspaceId,
    ...(sessionId ? { sessionId } : {}),
    noteName: paperTitle,
    markdown,
    heading: input.heading,
    ...(paperId ? { paperId, paperTitle } : { paperTitle }),
  })
  if (!appended.ok) {
    return {
      ok: false,
      code: appended.code ?? 'append-failed',
      error: appended.error ?? 'append failed',
    }
  }
  return {
    ok: true,
    name: appended.name,
    created: appended.created,
    workspaceId,
  }
}

/** Ask md-notes UI to open a note (manager). No-op if the plugin is absent. */
export function requestOpenNote(workspaceId: string, name: string): void {
  try {
    window.dispatchEvent(new CustomEvent(OPEN_NOTE_EVENT, {
      detail: { workspaceId, name },
    }))
  } catch {
    /* ignore */
  }
}

/** Ask scholar to open a paper PDF (notes preview deep link). */
export function requestOpenPaper(paperId: string): void {
  try {
    window.dispatchEvent(new CustomEvent(OPEN_PAPER_EVENT, {
      detail: { id: paperId },
    }))
  } catch {
    /* ignore */
  }
}

/** Parse `https://dsh.local/scholar/paper/<id>` (or legacy dsh-scholar://) from an anchor href. */
export function parseScholarPaperHref(href: string): string | undefined {
  const raw = String(href ?? '').trim()
  for (const prefix of [SCHOLAR_PAPER_HTTPS, SCHOLAR_PAPER_SCHEME]) {
    if (!raw.toLowerCase().startsWith(prefix.toLowerCase())) continue
    const rest = raw.slice(prefix.length).replace(/\/$/, '')
    if (rest === '') return undefined
    try {
      return decodeURIComponent(rest).trim() || undefined
    } catch {
      return rest.trim() || undefined
    }
  }
  return undefined
}
