/* dsh-papercover抽屉占位。同一时刻只留一个主抽屉铺开。 */
/**
 * Workbench shell coordinator — one primary docked drawer at a time.
 * Plugins publish open/width on window.__dshDock; this helper collapses
 * siblings when one opens (chrome unification without merging React trees).
 */

export type DockId = 'dsh-scholar' | 'dsh-trajectory' | 'server-dashboard' | string

export type DockFootprint = { open: boolean; width: number }

declare global {
  interface Window {
    __dshDock?: Record<string, DockFootprint>
    __dshWorkbenchShell?: {
      primary: DockId | null
      setPrimary: (id: DockId | null) => void
    }
  }
}

const EVENT = 'dsh-dock-change'
const PRIMARY_EVENT = 'dsh-workbench-primary'

export function publishDock(id: DockId, footprint: DockFootprint): void {
  // Idle docks still install the coordinator. The inspector treats a missing
  // object as failure; standby (no primary drawer) is a healthy state.
  ensureShell()
  const w = window
  w.__dshDock = { ...(w.__dshDock ?? {}), [id]: footprint }
  w.dispatchEvent(new CustomEvent(EVENT))
}

export function readDock(): Record<string, DockFootprint> {
  return { ...(window.__dshDock ?? {}) }
}

/**
 * When a drawer opens, ask siblings to collapse to rail/closed via event.
 * Each plugin listens and applies its own panelBus policy.
 */
export function claimPrimary(id: DockId): void {
  const shell = ensureShell()
  shell.setPrimary(id)
  window.dispatchEvent(new CustomEvent(PRIMARY_EVENT, { detail: { id } }))
}

export function onPrimaryClaim(handler: (id: DockId) => void): () => void {
  const fn = (ev: Event) => {
    const id = (ev as CustomEvent<{ id: DockId }>).detail?.id
    if (id) handler(id)
  }
  window.addEventListener(PRIMARY_EVENT, fn)
  return () => window.removeEventListener(PRIMARY_EVENT, fn)
}

function ensureShell() {
  if (!window.__dshWorkbenchShell) {
    let primary: DockId | null = null
    window.__dshWorkbenchShell = {
      get primary() { return primary },
      setPrimary(id) { primary = id },
    }
  }
  return window.__dshWorkbenchShell
}
