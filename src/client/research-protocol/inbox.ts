/* dsh-papercover动态收件。 */
/**
 * Global Activity Inbox — process-wide feed shared by workbench plugins.
 *
 * Backed by globalThis[Symbol.for(...)] so separately bundled client halves
 * share one bus. Keep this file identical across the three plugins.
 */

import { type ResearchEntityRef, entityKey, normalizeRef } from './entity.js'

export type ActivitySeverity = 'info' | 'warn' | 'error' | 'success'
export type ActivitySource = 'scholar' | 'trajectory' | 'dashboard' | 'system'

export interface ActivityItem {
  id: string
  ts: number
  severity: ActivitySeverity
  title: string
  body?: string
  source: ActivitySource
  ref?: ResearchEntityRef
  read?: boolean
}

export type ActivityInput = Omit<ActivityItem, 'id' | 'ts' | 'read'> & {
  id?: string
  ts?: number
  read?: boolean
}

const BUS_KEY = Symbol.for('dsh.research.activityInbox.v1')
const MAX_ITEMS = 80

type InboxBus = {
  items: ActivityItem[]
  listeners: Set<() => void>
  upsert(input: ActivityInput): ActivityItem
  markRead(id: string): void
  markAllRead(): void
  clear(): void
  getSnapshot(): ActivityItem[]
  subscribe(listener: () => void): () => void
}

function makeId(input: ActivityInput): string {
  if (input.id?.trim()) return input.id.trim()
  if (input.ref) return `ref:${entityKey(input.ref)}:${input.severity}`
  return `evt:${input.source}:${input.title}:${input.ts ?? Date.now()}`
}

function createBus(): InboxBus {
  const bus: InboxBus = {
    items: [],
    listeners: new Set(),
    upsert(input) {
      const ts = input.ts ?? Date.now()
      const id = makeId({ ...input, ts })
      const item: ActivityItem = {
        id,
        ts,
        severity: input.severity,
        title: input.title,
        ...(input.body ? { body: input.body } : {}),
        source: input.source,
        ...(input.ref ? { ref: normalizeRef(input.ref) } : {}),
        read: input.read ?? false,
      }
      const idx = bus.items.findIndex((x) => x.id === id)
      if (idx >= 0) {
        const prev = bus.items[idx]!
        bus.items[idx] = { ...item, read: prev.read && item.read }
      } else {
        bus.items.unshift(item)
      }
      if (bus.items.length > MAX_ITEMS) bus.items.length = MAX_ITEMS
      for (const l of bus.listeners) l()
      return item
    },
    markRead(id) {
      const hit = bus.items.find((x) => x.id === id)
      if (!hit || hit.read) return
      hit.read = true
      for (const l of bus.listeners) l()
    },
    markAllRead() {
      let changed = false
      for (const it of bus.items) {
        if (!it.read) { it.read = true; changed = true }
      }
      if (changed) for (const l of bus.listeners) l()
    },
    clear() {
      if (bus.items.length === 0) return
      bus.items = []
      for (const l of bus.listeners) l()
    },
    getSnapshot() {
      return bus.items
    },
    subscribe(listener) {
      bus.listeners.add(listener)
      return () => { bus.listeners.delete(listener) }
    },
  }
  return bus
}

export function getActivityInbox(): InboxBus {
  const g = globalThis as Record<PropertyKey, unknown>
  if (!g[BUS_KEY]) g[BUS_KEY] = createBus()
  return g[BUS_KEY] as InboxBus
}

export function publishActivity(input: ActivityInput): ActivityItem {
  return getActivityInbox().upsert(input)
}
