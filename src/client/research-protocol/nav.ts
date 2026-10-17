/* dsh-papercover内部导航。 */
/**
 * Cross-plugin navigation protocol.
 *
 * Preferred event: `dsh-research-nav` with ResearchNavDetail.
 * Legacy: `dsh-scholar-nav` { paperId, cardId } still emitted for old listeners.
 *
 * Keep identical across the three workbench plugins.
 */

import {
  type ResearchEntityRef,
  normalizeRef,
  parseEntityUri,
  refFromScholar,
} from './entity.js'

export const RESEARCH_NAV_EVENT = 'dsh-research-nav'
/** @deprecated Prefer RESEARCH_NAV_EVENT; kept for older trajectory builds. */
export const LEGACY_SCHOLAR_NAV_EVENT = 'dsh-scholar-nav'

export interface ResearchNavDetail {
  target: ResearchEntityRef
  /** Optional caller tag for diagnostics (e.g. "inbox", "traj-graph"). */
  source?: string
}

export function navigateResearch(input: ResearchEntityRef | ResearchNavDetail | string): void {
  let detail: ResearchNavDetail
  if (typeof input === 'string') {
    const ref = parseEntityUri(input)
    if (!ref) return
    detail = { target: ref, source: 'uri' }
  } else if ('target' in input) {
    detail = { ...input, target: normalizeRef(input.target) }
  } else {
    detail = { target: normalizeRef(input) }
  }

  window.dispatchEvent(new CustomEvent(RESEARCH_NAV_EVENT, { detail }))

  // Legacy bridge so older scholar builds still open papers/cards.
  const { kind, id } = detail.target
  if (kind === 'paper' || kind === 'card') {
    window.dispatchEvent(new CustomEvent(LEGACY_SCHOLAR_NAV_EVENT, {
      detail: kind === 'paper'
        ? { paperId: id, cardId: null, __fromNav: true }
        : { paperId: null, cardId: id, __fromNav: true },
    }))
  }
}

export function onResearchNav(handler: (detail: ResearchNavDetail) => void): () => void {
  const onNav = (ev: Event) => {
    try {
      const d = (ev as CustomEvent<ResearchNavDetail>).detail
      if (!d?.target?.kind || !d.target.id) return
      handler({ ...d, target: normalizeRef(d.target) })
    } catch { /* never crash shell */ }
  }
  /** Legacy-only path: older emitters that never fire RESEARCH_NAV_EVENT. */
  const onLegacy = (ev: Event) => {
    try {
      // Ignore synthetic legacy echoes from navigateResearch (same tick as research-nav).
      const raw = (ev as CustomEvent<{ paperId?: string | null; cardId?: string | null; __fromNav?: boolean }>).detail ?? {}
      if (raw.__fromNav) return
      const ref = refFromScholar(raw)
      if (!ref) return
      handler({ target: ref, source: 'legacy-scholar-nav' })
    } catch { /* */ }
  }
  window.addEventListener(RESEARCH_NAV_EVENT, onNav)
  window.addEventListener(LEGACY_SCHOLAR_NAV_EVENT, onLegacy)
  return () => {
    window.removeEventListener(RESEARCH_NAV_EVENT, onNav)
    window.removeEventListener(LEGACY_SCHOLAR_NAV_EVENT, onLegacy)
  }
}
