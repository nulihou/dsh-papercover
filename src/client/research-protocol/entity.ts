/**
 * dsh-papercover文献实体引用。
 * URI：research://<kind>/<id>[?label=<encoded>]
 * kind：paper | card | project | node | host | job
 */

export type ResearchKind = 'paper' | 'card' | 'project' | 'node' | 'host' | 'job'

export type ResearchPlugin = 'scholar' | 'trajectory' | 'dashboard'

export interface ResearchEntityRef {
  kind: ResearchKind
  id: string
  /** Display label only — never use for identity. */
  label?: string
  /** Owning plugin hint; resolved from kind when omitted. */
  plugin?: ResearchPlugin
}

const KIND_PLUGIN: Record<ResearchKind, ResearchPlugin> = {
  paper: 'scholar',
  card: 'scholar',
  project: 'trajectory',
  node: 'trajectory',
  host: 'dashboard',
  job: 'dashboard',
}

export function pluginForKind(kind: ResearchKind): ResearchPlugin {
  return KIND_PLUGIN[kind]
}

export function normalizeRef(ref: ResearchEntityRef): ResearchEntityRef {
  const id = String(ref.id ?? '').trim()
  if (!id) throw new Error('research ref requires non-empty id')
  if (!KIND_PLUGIN[ref.kind]) throw new Error(`unknown research kind: ${ref.kind}`)
  return {
    kind: ref.kind,
    id,
    ...(ref.label?.trim() ? { label: ref.label.trim() } : {}),
    plugin: ref.plugin ?? KIND_PLUGIN[ref.kind],
  }
}

/** Stable string key for maps / inbox dedupe. */
export function entityKey(ref: Pick<ResearchEntityRef, 'kind' | 'id'>): string {
  return `${ref.kind}:${ref.id}`
}

export function formatEntityUri(ref: ResearchEntityRef): string {
  const n = normalizeRef(ref)
  const base = `research://${n.kind}/${encodeURIComponent(n.id)}`
  return n.label ? `${base}?label=${encodeURIComponent(n.label)}` : base
}

export function parseEntityUri(uri: string): ResearchEntityRef | null {
  const raw = String(uri ?? '').trim()
  if (!raw.startsWith('research://')) return null
  try {
    const u = new URL(raw)
    const kind = u.hostname as ResearchKind
    if (!KIND_PLUGIN[kind]) return null
    const id = decodeURIComponent((u.pathname || '/').replace(/^\//, ''))
    if (!id) return null
    const label = u.searchParams.get('label') ?? undefined
    return normalizeRef({ kind, id, label })
  } catch {
    return null
  }
}

export function refFromScholar(detail: { paperId?: string | null; cardId?: string | null }): ResearchEntityRef | null {
  if (detail.paperId) return normalizeRef({ kind: 'paper', id: detail.paperId })
  if (detail.cardId) return normalizeRef({ kind: 'card', id: detail.cardId })
  return null
}
