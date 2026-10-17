/* dsh-papercover抽屉在窄屏下铺满窗口。 */
/** dsh-papercover界面的状态色和动效时长。 */

export const WB_MOTION = {
  fast: '110ms',
  dur: '180ms',
  slow: '280ms',
  drawer: '320ms',
  ease: 'cubic-bezier(.22,.82,.24,1)',
  spring: 'cubic-bezier(.34,1.18,.48,1)',
} as const

export const WB_STATUS = {
  info: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
  success: 'var(--dsw-alias-state-success-primary, #30a46c)',
  warn: 'var(--dsw-alias-state-warn-primary, #f5a524)',
  error: 'var(--dsw-alias-state-error-primary, #e5484d)',
  muted: 'var(--dsw-alias-label-caption)',
} as const

/** Object visual identity — kind → accent (for refs / inbox chips). */
export const WB_KIND_COLOR: Record<string, string> = {
  paper: WB_STATUS.info,
  card: 'var(--dsw-alias-state-business-primary, #7c5cff)',
  project: WB_STATUS.info,
  node: WB_STATUS.success,
  host: WB_STATUS.warn,
  job: WB_STATUS.muted,
}

/**
 * Fixed drawer / rail top clearance under desktop captions.
 * Prefer the official Windows shell marker, then better-sidebar's published
 * strip, then the shell URL contract (rarely stamped as a CSS var).
 */
export const WB_TOP_INSET =
  'var(--dsh-windows-titlebar-height, var(--dsh-title-bar-strip, var(--dsh-desktop-titlebar-inset, 0px)))'

export const WB_CSS = `
:root {
  --wb-fast: ${WB_MOTION.fast};
  --wb-dur: ${WB_MOTION.dur};
  --wb-slow: ${WB_MOTION.slow};
  --wb-drawer: ${WB_MOTION.drawer};
  --wb-ease: ${WB_MOTION.ease};
  --wb-spring: ${WB_MOTION.spring};
  --wb-status-info: ${WB_STATUS.info};
  --wb-status-success: ${WB_STATUS.success};
  --wb-status-warn: ${WB_STATUS.warn};
  --wb-status-error: ${WB_STATUS.error};
  --wb-status-muted: ${WB_STATUS.muted};
  --wb-top-inset: ${WB_TOP_INSET};
}
.wb-drawer-chrome {
  display: flex; align-items: center; gap: 10px; padding: 11px 14px 10px; flex: none;
  border-bottom: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent);
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
}
.wb-drawer-mark {
  width: 34px; height: 34px; border-radius: 9px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 15px; font-weight: 720; letter-spacing: -.02em;
  color: var(--dsw-alias-bg-base, #fff);
  background: var(--dsw-alias-label-primary);
}
.wb-drawer-title { font-weight: 720; font-size: 15px; letter-spacing: -.02em; line-height: 1.15; }
.wb-drawer-meta { font-size: 10.5px; color: var(--dsw-alias-label-caption); }
.wb-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent);
  color: var(--dsw-alias-label-secondary);
}
.wb-chip[data-sev="warn"] { background: color-mix(in srgb, var(--wb-status-warn) 16%, transparent); color: var(--wb-status-warn); }
.wb-chip[data-sev="error"] { background: color-mix(in srgb, var(--wb-status-error) 14%, transparent); color: var(--wb-status-error); }
.wb-chip[data-sev="success"] { background: color-mix(in srgb, var(--wb-status-success) 16%, transparent); color: var(--wb-status-success); }
.wb-chip[data-sev="info"] { background: color-mix(in srgb, var(--wb-status-info) 14%, transparent); color: var(--wb-status-info); }
@media (max-width: 640px) {
  [data-dsh-surface="drawer"][data-dsh-plugin="dsh-scholar"]:has([data-dsh-part="drawer-panel"]) {
    z-index: 1000 !important;
  }
  [data-dsh-surface="drawer"][data-dsh-plugin="dsh-scholar"] [data-dsh-part="drawer-panel"] {
    position: fixed !important;
    top: var(--wb-top-inset) !important;
    right: 0 !important;
    bottom: 0 !important;
    left: 0 !important;
    width: 100vw !important;
    max-width: none !important;
    height: auto !important;
    border-radius: 0 !important;
    box-sizing: border-box;
  }
}
@media (prefers-reduced-motion: reduce) {
  :root { --wb-fast: 0ms; --wb-dur: 0ms; --wb-slow: 0ms; --wb-drawer: 0ms; }
}
`

export function injectWorkbenchStyles(doc: Document = document): void {
  if (typeof doc === 'undefined') return
  if (doc.querySelector('style[data-wb-tokens]')) return
  const tag = doc.createElement('style')
  tag.dataset.wbTokens = '1'
  tag.textContent = WB_CSS
  doc.head.appendChild(tag)
}
