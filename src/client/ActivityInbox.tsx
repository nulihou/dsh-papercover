/**
 * Global Activity Inbox — sidebar footer entry + popover feed.
 * Jumps via research-nav protocol (Entity Reference).
 *
 * The panel is portaled to document.body with position:fixed so a narrow
 * left rail (overflow:hidden) cannot clip its 320px card; width also clamps
 * to the remaining viewport.
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  getActivityInbox,
  navigateResearch,
  type ActivityItem,
  type ActivitySeverity,
} from './research-protocol/index.js'

type TFunc = (key: string, params?: Record<string, unknown>) => string

const PANEL_W = 320
const PANEL_MAX_H = 420
const GAP = 8
const EDGE = 12

function useInbox(): ActivityItem[] {
  const bus = getActivityInbox()
  return useSyncExternalStore(bus.subscribe, bus.getSnapshot)
}

function severityColor(s: ActivitySeverity): string {
  if (s === 'error') return 'var(--dsw-alias-state-error-primary, #e5484d)'
  if (s === 'warn') return 'var(--dsw-alias-state-warn-primary, #f5a524)'
  if (s === 'success') return 'var(--dsw-alias-state-success-primary, #30a46c)'
  return 'var(--dsw-alias-state-business-primary, #4d6bfe)'
}

function sourceLabel(t: TFunc, source: ActivityItem['source']): string {
  if (source === 'scholar') return t('inbox.srcScholar')
  if (source === 'trajectory') return t('inbox.srcTraj')
  if (source === 'dashboard') return t('inbox.srcDash')
  return t('inbox.srcSystem')
}

function relTime(ts: number, t: TFunc): string {
  const d = Date.now() - ts
  if (d < 60_000) return t('inbox.justNow')
  if (d < 3_600_000) return t('inbox.minsAgo', { n: Math.floor(d / 60_000) })
  if (d < 86_400_000) return t('inbox.hoursAgo', { n: Math.floor(d / 3_600_000) })
  return t('inbox.daysAgo', { n: Math.floor(d / 86_400_000) })
}

type PanelGeom = { left: number; bottom: number; width: number; maxHeight: number }

function placePanel(anchor: DOMRect): PanelGeom {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = Math.max(200, Math.min(PANEL_W, vw - EDGE * 2))
  // Prefer aligning to the trigger's left; if that overflows the right edge,
  // shift left so the card stays on-screen.
  let left = anchor.left
  if (left + width > vw - EDGE) left = Math.max(EDGE, vw - EDGE - width)
  if (left < EDGE) left = EDGE
  const bottom = Math.max(EDGE, vh - anchor.top + GAP)
  const maxHeight = Math.max(160, Math.min(PANEL_MAX_H, anchor.top - EDGE - GAP))
  return { left, bottom, width, maxHeight }
}

export function ActivityInboxTrigger({ t, wide }: { t: TFunc; wide?: boolean }) {
  const items = useInbox()
  const unread = items.filter((x) => !x.read).length
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [geom, setGeom] = useState<PanelGeom | null>(null)

  const syncGeom = useCallback(() => {
    const el = rootRef.current
    if (!el) return
    setGeom(placePanel(el.getBoundingClientRect()))
  }, [])

  useLayoutEffect(() => {
    if (!open) {
      setGeom(null)
      return
    }
    syncGeom()
  }, [open, syncGeom])

  useEffect(() => {
    if (!open) return
    const onDoc = (ev: MouseEvent) => {
      const t = ev.target as Node
      if (rootRef.current?.contains(t)) return
      if (panelRef.current?.contains(t)) return
      setOpen(false)
    }
    const onReposition = () => syncGeom()
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('resize', onReposition)
    // Sidebar drag-resize often scrolls/layouts without a window resize event.
    window.addEventListener('scroll', onReposition, true)
    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => syncGeom())
      : null
    const rail = rootRef.current?.closest('aside, nav, [class*="sidebar"], [data-slot]') ?? null
    if (ro && rail) ro.observe(rail)
    if (ro && rootRef.current) ro.observe(rootRef.current)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('scroll', onReposition, true)
      ro?.disconnect()
    }
  }, [open, syncGeom])

  const bus = getActivityInbox()

  const panel = open && geom && typeof document !== 'undefined'
    ? createPortal(
      <div
        ref={panelRef}
        data-dsh-plugin="dsh-scholar"
        data-dsh-part="inbox-panel"
        role="dialog"
        aria-label={t('inbox.title')}
        style={{
          position: 'fixed',
          left: geom.left,
          bottom: geom.bottom,
          width: geom.width,
          maxHeight: geom.maxHeight,
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 12,
          overflow: 'hidden',
          zIndex: 2147483000,
          background: 'var(--dsw-alias-bg-base)',
          border: '1px solid var(--dsw-alias-border-l2)',
          boxShadow: 'var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,.28))',
          color: 'var(--dsw-alias-label-primary)',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
          borderBottom: '1px solid var(--dsw-alias-border-l2)',
          minWidth: 0,
        }}>
          <strong style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {t('inbox.title')}
          </strong>
          <span style={{ flex: 1, minWidth: 0 }} />
          <button type="button" onClick={() => bus.markAllRead()} style={linkBtn}>
            {t('inbox.markAll')}
          </button>
          <button type="button" onClick={() => bus.clear()} style={linkBtn}>
            {t('inbox.clear')}
          </button>
        </div>
        <div style={{ overflow: 'auto', flex: 1, minHeight: 0, padding: 6 }}>
          {items.length === 0 ? (
            <p style={{ margin: 12, fontSize: 12, color: 'var(--dsw-alias-label-caption)' }}>
              {t('inbox.empty')}
            </p>
          ) : items.map((it) => (
            <button
              key={it.id}
              type="button"
              onClick={() => {
                bus.markRead(it.id)
                if (it.ref) {
                  navigateResearch({ target: it.ref, source: 'inbox' })
                  setOpen(false)
                }
              }}
              style={{
                display: 'block', width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
                padding: '8px 10px', borderRadius: 9, marginBottom: 4, boxSizing: 'border-box',
                background: it.read
                  ? 'transparent'
                  : 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 8%, transparent)',
                color: 'inherit',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2, minWidth: 0 }}>
                <span style={{
                  width: 7, height: 7, borderRadius: 99, flex: 'none',
                  background: severityColor(it.severity),
                  opacity: it.read ? 0.45 : 1,
                }} />
                <span style={{
                  fontSize: 12, fontWeight: it.read ? 500 : 650, flex: 1, minWidth: 0,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {it.title}
                </span>
                <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-caption)', flex: 'none' }}>
                  {relTime(it.ts, t)}
                </span>
              </div>
              <div style={{
                fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', paddingLeft: 13,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {sourceLabel(t, it.source)}
                {it.body ? ` · ${it.body}` : ''}
                {it.ref ? ` · ${it.ref.kind}` : ''}
              </div>
            </button>
          ))}
        </div>
      </div>,
      document.body,
    )
    : null

  return (
    <div
      ref={rootRef}
      style={{ position: 'relative', width: wide ? '100%' : undefined }}
      data-dsh-plugin="dsh-scholar"
      data-dsh-part="activity-inbox"
    >
      <button
        type="button"
        data-dsh-part="inbox-entry"
        aria-pressed={open}
        title={t('inbox.title')}
        onClick={() => setOpen((v) => !v)}
        style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          height: wide ? 28 : 36,
          width: wide ? '100%' : 36,
          boxSizing: 'border-box',
          background: open
            ? 'color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent)'
            : 'transparent',
          border: 0,
          cursor: 'pointer',
          color: open
            ? 'var(--dsw-alias-label-primary)'
            : 'var(--dsw-alias-label-secondary)',
          padding: wide ? '0 6px' : 0,
          borderRadius: wide ? 8 : '50%',
          fontSize: 12,
          fontWeight: 500,
          font: 'inherit',
          minWidth: 0,
          overflow: 'hidden',
        }}
      >
        <span aria-hidden style={{ position: 'relative', display: 'inline-flex', width: 16, height: 16, flex: 'none' }}>
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none">
            <path d="M4 6h16v12H4zM4 6l8 7 8-7" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round" />
          </svg>
          {unread > 0 && !wide && (
            <span style={{
              position: 'absolute', top: -5, right: -6, minWidth: 14, height: 14, borderRadius: 999,
              padding: '0 3px', boxSizing: 'border-box',
              background: 'var(--dsw-alias-state-error-primary, #ff3b30)', color: '#fff', fontSize: 9, fontWeight: 700,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontVariantNumeric: 'tabular-nums',
            }}>
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </span>
        {wide ? <span style={{ fontSize: 12, fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('inbox.title')}</span> : null}
        {wide && unread > 0 ? (
          <span
            data-footer-badge
            style={{
              position: 'absolute',
              right: 4,
              top: '50%',
              transform: 'translateY(-50%)',
              minWidth: 14, height: 14, borderRadius: 999, padding: '0 3px', boxSizing: 'border-box',
              background: 'var(--dsw-alias-state-error-primary, #ff3b30)', color: '#fff',
              fontSize: 8, fontWeight: 700, lineHeight: '14px', textAlign: 'center',
              fontVariantNumeric: 'tabular-nums', flex: 'none', pointerEvents: 'none',
            }}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </button>
      {panel}
    </div>
  )
}

const linkBtn: React.CSSProperties = {
  border: 'none', background: 'none', cursor: 'pointer', padding: 0, flex: 'none',
  fontSize: 11, color: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
}
