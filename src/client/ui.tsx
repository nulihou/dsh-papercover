import { useModalFocus } from './modalFocus';
import React from 'react';
import { createPortal } from 'react-dom';

/* ---------- shared UI primitives — big-tech quiet chrome on DSH tokens ---------- */

/**
 * 某些皮肤的 bg-base / bg-layer 半透明（壁纸透出）。
 * dsh-papercover抽屉、弹窗必须垫真正不透明底，否则对话会透进来。
 *
 * Cache is keyed by the shell scheme (`body[data-ds-dark-theme]`). A bare
 * forever-cache freezes the light paint under dark labels after a theme flip
 * (left rail white + light-gray text).
 */
let cachedOpaque: { key: string; value: string } | null = null;

/** Strip alpha from a computed color; returns opaque `rgb(...)` or null. */
function forceOpaqueRgb(raw: string): string | null {
  const c = raw.trim();
  if (!c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)') return null;
  const rgba = c.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (rgba) {
    const r = Math.round(Number(rgba[1]));
    const g = Math.round(Number(rgba[2]));
    const b = Math.round(Number(rgba[3]));
    if (![r, g, b].every(Number.isFinite)) return null;
    return `rgb(${r}, ${g}, ${b})`;
  }
  if (c.startsWith('#')) {
    const h = c.length === 4
      ? c.slice(1).split('').map((ch) => ch + ch).join('')
      : c.slice(1, 7);
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    const n = Number.parseInt(h, 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
  }
  return null;
}

/** Shell scheme key — matches ui-layout ThemePresenter (`data-ds-dark-theme`). */
function schemeCacheKey(): string {
  if (typeof document === 'undefined') return 'ssr';
  const decided = document.documentElement.style.colorScheme !== '';
  if (decided) return document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light';
  if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'light';
}

/** Resolve opaque paint from the live theme token (preferred over body bg). */
function resolveOpaqueFromTheme(): string | null {
  if (typeof document === 'undefined') return null;
  try {
    const probe = document.createElement('div');
    // Attach under body so inherited theme tokens apply; off-screen.
    probe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;background:var(--dsw-alias-bg-base,#161616)';
    document.body.appendChild(probe);
    const fromProbe = forceOpaqueRgb(getComputedStyle(probe).backgroundColor);
    probe.remove();
    if (fromProbe) return fromProbe;
  } catch { /* ignore */ }
  const token = getComputedStyle(document.documentElement)
    .getPropertyValue('--dsw-alias-bg-base').trim();
  const fromToken = forceOpaqueRgb(token);
  if (fromToken) return fromToken;
  for (const el of [document.body, document.documentElement]) {
    const solid = forceOpaqueRgb(getComputedStyle(el).backgroundColor);
    if (solid) return solid;
  }
  return null;
}

/** Opaque desk/modal underlay — never pass through wallpaper or chat. */
export function opaqueBase(): string {
  const key = schemeCacheKey();
  if (cachedOpaque?.key === key) return cachedOpaque.value;
  const resolved = resolveOpaqueFromTheme()
    ?? (key === 'light' ? '#f5f5f5' : '#161616');
  cachedOpaque = { key, value: resolved };
  return resolved;
}

/** Drop cached solid after theme switch. */
export function resetOpaqueBaseCache(): void {
  cachedOpaque = null;
}

/**
 * Re-render when the shell flips light/dark so `--sch-solid` and inline
 * opaque pads track the theme instead of freezing the first paint.
 */
export function useOpaqueBase(): string {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    const bump = () => {
      resetOpaqueBaseCache();
      setTick((n) => n + 1);
    };
    const obs = new MutationObserver(bump);
    // Theme flips rewrite body[data-ds-dark-theme]. Do not observe
    // documentElement style/class — dock/theme CSS vars would thrash
    // SchStyles and restart list fade animations at opacity 0.
    obs.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
    let mql: MediaQueryList | null = null;
    const onMql = () => bump();
    try {
      mql = matchMedia('(prefers-color-scheme: dark)');
      mql.addEventListener('change', onMql);
    } catch { /* ignore */ }
    return () => {
      obs.disconnect();
      try { mql?.removeEventListener('change', onMql); } catch { /* ignore */ }
    };
  }, []);
  return opaqueBase();
}

/**
 * Stop wheel events from chaining into the DSH shell (page bounce / "抽搐").
 * Nested overflow regions still scroll until they hit an edge; chrome like the
 * vertical icon rail / resize handle has no scrollport so every notch is contained.
 * Capture phase so chrome (handle/rail) wins before a deep scrollport sees the event.
 */
export function containWheelChain(root: HTMLElement | null): () => void {
  if (!root) return () => {};
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey) return; // leave browser zoom alone
    const target = e.target instanceof HTMLElement ? e.target : null;
    // Resize grip / icon rail / drawer chrome: never chain-scroll the shell.
    if (target?.closest('[data-sch-wheel="contain"], .sch-drawer-rail, .sch-peek-rail')) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    let node: HTMLElement | null = target;
    while (node && node !== root) {
      const style = getComputedStyle(node);
      const oy = style.overflowY;
      const ox = style.overflowX;
      const canY = (oy === 'auto' || oy === 'scroll' || oy === 'overlay')
        && node.scrollHeight > node.clientHeight + 1;
      const canX = (ox === 'auto' || ox === 'scroll' || ox === 'overlay')
        && node.scrollWidth > node.clientWidth + 1;
      if (canY) {
        const atTop = node.scrollTop <= 0;
        const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
        if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom)) return;
      }
      if (canX) {
        const atLeft = node.scrollLeft <= 0;
        const atRight = node.scrollLeft + node.clientWidth >= node.scrollWidth - 1;
        if ((e.deltaX < 0 && !atLeft) || (e.deltaX > 0 && !atRight)) return;
      }
      node = node.parentElement;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  root.addEventListener('wheel', onWheel, { passive: false, capture: true });
  return () => root.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
}

/**
 * dsh-papercover (dsh-papercover) color system — ink desk, warm lamp accent:
 * - Structure from ink hierarchy; warm amber only for focus / sparse highlights
 * - Primary CTAs invert ink (not saturated brand-blue wash)
 * - Surfaces: paper grain + hairline; no purple glow
 */
export const T = {
  primary: 'var(--dsw-alias-label-primary)',
  secondary: 'var(--dsw-alias-label-secondary)',
  tertiary: 'var(--dsw-alias-label-tertiary)',
  caption: 'var(--dsw-alias-label-caption)',
  success: 'var(--sch-success, #059669)',
  warning: 'var(--sch-warn, #b45309)',
  danger: 'var(--sch-danger, #dc2626)',
  /** Links / sparse accent — warm lamp, not blue wash */
  business: 'var(--sch-accent)',
  borderL1: 'var(--dsw-alias-border-l1)',
  borderL2: 'var(--sch-hairline, var(--dsw-alias-border-l2))',
  hoverBg: 'var(--sch-fill, var(--dsw-alias-interactive-bg-hover))',
  cardBg: 'var(--sch-fill)',
  layer2: 'var(--dsw-alias-bg-layer-2, transparent)',
  purple: 'var(--sch-indigo, #6366f1)',
  teal: 'var(--sch-cyan, #0e7490)',
} as const;

/**
 * z-index 约定 —— 对齐宿主 shell，而不是「盖过一切」：
 * - drawer：viewport fixed，高于 better-sidebar 底栏(25)，低于官方弹层
 * - float：略高于同层抽屉，仍不越出 overlay 层与官方弹层抢焦点
 * - modal / toast：对齐 ui-primitives（Modal 1000 / Toast 1100），经 portal 挂 body
 */
export const Z = { drawer: 40, float: 42, modal: 1050, toast: 1100 } as const;

/**
 * One-shot global stylesheet: everything inline styles cannot express
 * (:hover / :focus / scrollbars / keyframes). Rendered once per surface.
 */
export function SchStyles() {
  const solid = useOpaqueBase();
  return (
    <style>{`
      /* dsh-papercover desk — ink paper, warm lamp accent, quiet chrome */
      :root, .sch-root {
        --sch-fast: 110ms; --sch-dur: 180ms; --sch-slow: 260ms;
        --sch-ease: cubic-bezier(.22,.82,.24,1); --sch-spring: cubic-bezier(.34,1.18,.48,1);
        --sch-space-1: 4px; --sch-space-2: 8px; --sch-space-3: 12px; --sch-space-4: 16px;
        --sch-control: 28px; --sch-radius: 7px; --sch-radius-lg: 10px;
        /* Warm lamp accent — not product-blue / AI-purple */
        --sch-accent: #c4a35a;
        --sch-accent-ink: #8a6d2f;
        --sch-accent-fg: #1a1610;
        --sch-success: #059669;
        --sch-warn: #b45309;
        --sch-danger: #dc2626;
        --sch-indigo: #6b7280;
        --sch-cyan: #0e7490;
        /* True opaque desk paint — never wallpaper/chat bleed */
        --sch-solid: ${solid};
        --sch-fill: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, var(--sch-solid));
        --sch-fill-hover: color-mix(in srgb, var(--dsw-alias-label-primary) 6.5%, var(--sch-solid));
        --sch-fill-strong: color-mix(in srgb, var(--dsw-alias-label-primary) 9.5%, var(--sch-solid));
        --sch-hairline: color-mix(in srgb, var(--dsw-alias-label-primary) 9%, var(--sch-solid));
        --sch-hairline-strong: color-mix(in srgb, var(--dsw-alias-label-primary) 15%, var(--sch-solid));
        --sch-lift:
          0 1px 0 color-mix(in srgb, #fff 5%, transparent) inset,
          0 8px 24px color-mix(in srgb, #000 12%, transparent);
        --sch-glass: var(--sch-solid);
        --sch-paper:
          linear-gradient(180deg,
            color-mix(in srgb, var(--dsw-alias-label-primary) 2.2%, transparent) 0%,
            transparent 42%),
          radial-gradient(120% 80% at 0% 0%,
            color-mix(in srgb, var(--sch-accent) 5%, transparent), transparent 55%);
        --sch-surface: var(--sch-paper), var(--sch-solid);
      }
      /* Dark scheme: warmer ink on amber chips; solid already tracks via hook. */
      body[data-ds-dark-theme] .sch-root,
      body[data-ds-dark-theme] {
        --sch-accent-ink: #e8d5a3;
      }
      .sch-toolbar {
        display: flex; flex-wrap: wrap; align-items: center; gap: var(--sch-space-2);
        padding: var(--sch-space-2) var(--sch-space-3);
        min-height: 44px;
      }
      .sch-pane { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
      .sch-icon {
        display: block; flex: none;
        shape-rendering: geometricPrecision;
      }

      .sch-scroll { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent) transparent; overscroll-behavior: contain; }
      .sch-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
      .sch-scroll::-webkit-scrollbar-track { background: transparent; }
      .sch-scroll::-webkit-scrollbar-thumb {
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent); border-radius: 999px;
        border: 1px solid transparent; background-clip: content-box;
      }
      .sch-scroll::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 32%, transparent); background-clip: content-box; }

      /* Desk typography — nuke host/theme justify everywhere inside the plugin.
         CJK+Latin + text-align:justify creates irregular word gaps. */
      [data-dsh-plugin="dsh-scholar"],
      [data-dsh-plugin="dsh-scholar"] *,
      [data-dsh-part="drawer-panel"],
      [data-dsh-part="drawer-panel"] *,
      [data-dsh-part="drawer-rail"],
      [data-dsh-part="drawer-rail"] *,
      [data-dsh-part="peek-rail"],
      [data-dsh-part="peek-rail"] *,
      .sch-root,
      .sch-root *,
      .sch-modal-bd,
      .sch-modal-bd *,
      .sch-modal-in,
      .sch-modal-in *,
      .sch-pane,
      .sch-pane *,
      .sch-scroll,
      .sch-scroll *,
      .sch-prose,
      .sch-prose * {
        text-align: start !important;
        text-justify: none !important;
        word-spacing: normal !important;
        letter-spacing: normal !important;
      }
      .sch-prose {
        word-break: normal;
        overflow-wrap: break-word;
        line-height: 1.65;
        font-variant-numeric: tabular-nums;
        hanging-punctuation: allow-end;
      }
      .sch-prose p, .sch-prose li { margin: 0; }
      .sch-prose ul { margin: 0; padding-left: 16px; }
      /* Intentional centers (flex still owns layout; keep badge/empty glyphs readable) */
      [data-dsh-plugin="dsh-scholar"] .sch-badge,
      [data-dsh-plugin="dsh-scholar"] .sch-entry-count,
      [data-dsh-part="drawer-panel"] .sch-badge,
      [data-dsh-part="drawer-rail"] .sch-badge,
      .sch-empty,
      .sch-empty *,
      .sch-empty-glyph,
      .sch-modal-bd {
        text-align: center !important;
      }

      .sch-card {
        transition:
          background var(--sch-fast) var(--sch-ease),
          border-color var(--sch-fast) var(--sch-ease),
          box-shadow var(--sch-dur) var(--sch-ease);
      }
      .sch-card:hover {
        border-color: var(--sch-hairline-strong) !important;
        background: var(--sch-fill) !important;
      }
      .sch-paper {
        position: relative;
        background: var(--sch-fill);
      }
      .sch-paper:hover {
        border-color: var(--sch-hairline-strong) !important;
      }
      .sch-press:active { /* no scale — keeps toolbars from jittering */ }

      /* —— Buttons: ink primary, neutral soft (not blue wash) —— */
      .sch-icon-btn {
        width: 28px; height: 28px; border-radius: var(--sch-radius); flex: none;
        display: inline-flex; align-items: center; justify-content: center;
        background: transparent; border: 1px solid transparent;
        color: var(--dsw-alias-label-secondary);
        cursor: pointer; padding: 0;
        transition: background var(--sch-fast) var(--sch-ease), color var(--sch-fast) var(--sch-ease), border-color var(--sch-fast) var(--sch-ease);
      }
      .sch-icon-btn:hover:not(:disabled) {
        background: var(--sch-fill-hover);
        color: var(--dsw-alias-label-primary);
      }
      .sch-icon-btn:active:not(:disabled) {
        background: var(--sch-fill-strong);
      }
      .sch-icon-btn:focus-visible {
        outline: none;
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--sch-accent) 32%, transparent);
      }
      .sch-icon-btn:disabled { opacity: .4; cursor: default; }
      .sch-icon-btn[aria-pressed="true"], .sch-icon-btn.sch-on {
        background: var(--sch-fill-strong);
        color: var(--dsw-alias-label-primary);
        border-color: var(--sch-hairline);
      }
      .sch-icon-btn[aria-pressed="true"]:hover:not(:disabled), .sch-icon-btn.sch-on:hover:not(:disabled) {
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent);
        color: var(--dsw-alias-label-primary);
      }
      .sch-icon-btn.sch-danger { color: var(--sch-danger); }
      .sch-icon-btn.sch-danger:hover:not(:disabled) {
        background: color-mix(in srgb, var(--sch-danger) 10%, transparent);
        color: var(--sch-danger);
      }

      .sch-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        min-height: 28px; padding: 0 11px; line-height: 1.35;
        border-radius: var(--sch-radius); font-size: 12px; font-weight: 500;
        border: 1px solid var(--sch-hairline);
        background: transparent;
        color: var(--dsw-alias-label-primary);
        cursor: pointer; white-space: nowrap;
        transition: background var(--sch-fast) var(--sch-ease), border-color var(--sch-fast) var(--sch-ease), color var(--sch-fast) var(--sch-ease), box-shadow var(--sch-fast) var(--sch-ease);
      }
      .sch-btn:hover:not(:disabled) {
        background: var(--sch-fill-hover);
        border-color: var(--sch-hairline-strong);
      }
      .sch-btn:active:not(:disabled) {
        background: var(--sch-fill-strong);
      }
      .sch-btn:focus-visible {
        outline: none;
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--sch-accent) 28%, transparent);
      }
      .sch-btn:disabled { opacity: .4; cursor: default; }

      /* Ink inverse CTA — product primary, not brand-blue wash */
      .sch-btn--primary {
        background: var(--dsw-alias-label-primary);
        border-color: var(--dsw-alias-label-primary);
        color: var(--dsw-alias-bg-base, #fff); font-weight: 600;
      }
      .sch-btn--primary svg { color: inherit; }
      .sch-btn--primary:hover:not(:disabled) {
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 88%, var(--dsw-alias-bg-base, #fff));
        border-color: transparent;
        color: var(--dsw-alias-bg-base, #fff);
        opacity: .92;
      }
      .sch-btn--primary:active:not(:disabled) {
        opacity: .84;
        color: var(--dsw-alias-bg-base, #fff);
      }

      .sch-btn--soft {
        background: var(--sch-fill);
        border-color: var(--sch-hairline);
        color: var(--dsw-alias-label-primary);
      }
      .sch-btn--soft:hover:not(:disabled) {
        background: var(--sch-fill-hover);
        border-color: var(--sch-hairline-strong);
        color: var(--dsw-alias-label-primary);
      }

      .sch-btn--danger {
        color: var(--sch-danger);
        border-color: color-mix(in srgb, var(--sch-danger) 28%, transparent);
      }
      .sch-btn--danger:hover:not(:disabled) {
        background: color-mix(in srgb, var(--sch-danger) 9%, transparent);
        color: var(--sch-danger);
      }

      /* Segmented — elevated pill on muted track */
      .sch-seg {
        display: inline-flex; align-items: center; gap: 2px; padding: 2px;
        border-radius: calc(var(--sch-radius) + 2px); flex: none;
        background: var(--sch-fill);
        border: 1px solid var(--sch-hairline);
      }
      .sch-seg-item {
        display: inline-flex; align-items: center; justify-content: center; gap: 4px;
        min-height: 24px; padding: 0 9px; border-radius: var(--sch-radius);
        border: 0; background: transparent; cursor: pointer;
        font-size: 11px; font-weight: 500;
        color: var(--dsw-alias-label-secondary);
        transition: background var(--sch-fast) var(--sch-ease), color var(--sch-fast) var(--sch-ease), box-shadow var(--sch-fast) var(--sch-ease);
      }
      .sch-seg-item:hover:not(:disabled):not([aria-pressed="true"]) {
        color: var(--dsw-alias-label-primary);
        background: var(--sch-fill-hover);
      }
      .sch-seg-item[aria-pressed="true"] {
        background: var(--sch-solid);
        color: var(--dsw-alias-label-primary);
        box-shadow: var(--sch-lift), 0 0 0 1px var(--sch-hairline);
        font-weight: 600;
      }
      .sch-seg-item:focus-visible {
        outline: none;
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--sch-accent) 28%, transparent);
      }

      .sch-entry {
        display: inline-flex; flex-direction: row; flex-wrap: nowrap;
        align-items: center; align-content: center; gap: 4px; height: 28px;
        padding: 0 6px; border-radius: 8px; border: 0; cursor: pointer; font-size: 12px;
        background: transparent; color: var(--dsw-alias-label-secondary);
        box-sizing: border-box; font: inherit; font-weight: 500; line-height: 1;
        min-width: 0; overflow: hidden; width: 100%;
        transition: background var(--sch-fast) var(--sch-ease), color var(--sch-fast) var(--sch-ease);
      }
      .sch-entry:hover { background: var(--sch-fill-hover); color: var(--dsw-alias-label-primary); }
      .sch-entry[aria-pressed="true"] {
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent);
        color: var(--dsw-alias-label-primary);
      }
      .sch-entry--scholar {
        position: relative;
        width: 100%;
        justify-content: center;
      }
      .sch-entry--scholar.sch-entry--rail {
        width: 36px; height: 36px; padding: 0; border-radius: 50%;
        justify-content: center;
        color: var(--dsw-alias-label-primary);
      }
      .sch-entry--scholar.sch-entry--rail[aria-pressed="true"] {
        color: var(--dsw-alias-label-primary);
      }
      .sch-entry-icon {
        position: relative;
        display: inline-flex;
        flex: none;
        align-items: center;
        align-self: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        line-height: 0;
      }
      .sch-entry-icon svg {
        display: block;
      }
      .sch-entry-text {
        font-size: 12px; font-weight: 500; letter-spacing: .01em; line-height: 1;
        min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        align-self: center;
      }
      /* Wide sidebar: pin count to the trailing edge — out of flex flow so icon/label stay column-aligned. */
      .sch-entry-count {
        position: absolute;
        right: 4px;
        top: 50%;
        transform: translateY(-50%);
        margin-left: 0;
        min-width: 14px; height: 14px; border-radius: 999px; padding: 0 3px; box-sizing: border-box;
        display: inline-flex; align-items: center; justify-content: center;
        background: var(--dsw-alias-state-error-primary, #ff3b30); color: #fff;
        font-size: 8px; line-height: 1; font-weight: 700;
        font-variant-numeric: tabular-nums; letter-spacing: -.02em;
        flex: none; pointer-events: none;
      }
      /* Compact icon-only entry: pin the badge to the button corner. */
      .sch-entry--scholar > .sch-badge {
        top: -4px; right: -4px;
      }

      /* Right-edge Research Desk launcher — vertical drag repositions; default centered */
      .sch-edge-launch {
        position: fixed;
        top: 50%; transform: translateY(-50%);
        z-index: 40; pointer-events: auto;
        border: 0; padding: 0; cursor: grab;
        touch-action: none;
        user-select: none;
        background: transparent;
        color: var(--dsw-alias-label-primary);
      }
      .sch-edge-launch[data-positioned='true'] {
        transform: none;
      }
      .sch-edge-launch[data-dragging='true'] {
        cursor: grabbing;
      }
      .sch-edge-launch-inner {
        display: flex; flex-direction: column; align-items: center; gap: 8px;
        padding: 14px 8px 14px 10px;
        border-radius: 12px 0 0 12px;
        background: var(--sch-solid);
        border: 1px solid var(--sch-hairline);
        border-right: 0;
        box-shadow: -4px 0 20px color-mix(in srgb, #000 11%, transparent);
        transition: padding var(--sch-dur) var(--sch-ease), background var(--sch-fast) var(--sch-ease),
          box-shadow var(--sch-dur) var(--sch-ease), transform var(--sch-dur) var(--sch-ease),
          border-color var(--sch-fast) var(--sch-ease);
      }
      .sch-edge-launch-label {
        writing-mode: vertical-rl; text-orientation: mixed;
        font-size: 11px; font-weight: 700; letter-spacing: .28em;
        color: var(--dsw-alias-label-secondary);
      }
      .sch-edge-launch:hover .sch-edge-launch-label {
        color: var(--sch-accent-ink);
      }
      .sch-edge-launch-badge {
        min-width: 16px; height: 16px; border-radius: 999px; padding: 0 4px; box-sizing: border-box;
        background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-base, #fff);
        font-size: 9px; line-height: 16px; text-align: center; font-weight: 650;
        font-variant-numeric: tabular-nums;
      }
      .sch-edge-launch:hover .sch-edge-launch-inner {
        padding-right: 12px;
        background:
          linear-gradient(180deg, color-mix(in srgb, var(--sch-accent) 8%, transparent), transparent 70%),
          var(--sch-solid);
        box-shadow: -8px 0 26px color-mix(in srgb, #000 16%, transparent);
        border-color: color-mix(in srgb, var(--sch-accent) 28%, var(--sch-hairline));
      }

      /* Drawer left rail — always shows the icon column (PDF reading hides the dock). */
      .sch-drawer-rail {
        --sch-rail-w: 40px;
        position: relative;
        width: var(--sch-rail-w);
        flex: none;
        overflow: hidden;
        border-right: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 6%, var(--sch-solid));
        background:
          linear-gradient(180deg, color-mix(in srgb, var(--sch-accent) 5%, transparent), transparent 55%),
          color-mix(in srgb, var(--dsw-alias-label-primary) 3.2%, var(--sch-solid));
        overscroll-behavior: contain;
        touch-action: pan-y;
      }
      .sch-drawer-rail-inner {
        width: var(--sch-rail-w);
        height: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        padding: 10px 0 8px;
        box-sizing: border-box;
      }
      /* Standalone dock rail when drawer is collapsed to rail mode */
      .sch-peek-rail {
        --sch-rail-w: 40px;
        position: fixed;
        top: var(--wb-top-inset, var(--dsh-windows-titlebar-height, var(--dsh-title-bar-strip, var(--dsh-desktop-titlebar-inset, 0px))));
        right: var(--dsh-scholar-right-inset, 0px);
        bottom: var(--dsh-scholar-bottom-inset, 0px);
        width: var(--sch-rail-w);
        pointer-events: auto;
        overflow: hidden;
        border-left: 1px solid var(--dsw-alias-border-l2);
        background: var(--sch-solid, var(--dsw-alias-bg-base));
        overscroll-behavior: contain;
        box-shadow: -4px 0 14px color-mix(in srgb, #000 10%, transparent);
        z-index: 40;
      }
      .sch-peek-rail .sch-drawer-rail-inner {
        width: var(--sch-rail-w);
        height: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        padding: 10px 0 8px;
        box-sizing: border-box;
      }
      .sch-drawer-head {
        display: flex; align-items: center; gap: 10px; padding: 11px 14px 10px; flex: none;
        border-bottom: 1px solid var(--sch-hairline);
        background: var(--sch-surface);
        position: relative;
      }
      .sch-drawer-head::after {
        content: ''; position: absolute; left: 14px; right: 14px; bottom: 0; height: 1px;
        background: linear-gradient(90deg,
          transparent,
          color-mix(in srgb, var(--sch-accent) 35%, transparent) 35%,
          color-mix(in srgb, var(--sch-accent) 35%, transparent) 65%,
          transparent);
        opacity: .55; pointer-events: none;
      }
      .sch-drawer-mark {
        width: 34px; height: 34px; border-radius: 9px; flex: none;
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 15px; font-weight: 720; letter-spacing: -.02em;
        color: var(--dsw-alias-bg-base, #fff);
        background: var(--dsw-alias-label-primary);
        box-shadow:
          0 1px 0 color-mix(in srgb, #fff 14%, transparent) inset,
          0 6px 14px color-mix(in srgb, #000 14%, transparent);
        user-select: none;
      }
      .sch-drawer-head-brand {
        font-size: 11px; font-weight: 650; letter-spacing: .01em;
        color: var(--sch-accent-ink);
      }
      .sch-drawer-head-title {
        font-weight: 720; font-size: 15px; letter-spacing: -.02em; line-height: 1.15;
        color: var(--dsw-alias-label-primary);
      }
      .sch-drawer-head-meta {
        font-size: 10.5px; color: var(--dsw-alias-label-caption);
        font-variant-numeric: tabular-nums; line-height: 1.2; letter-spacing: .01em;
      }

      /* Knowledge graph — enterprise chrome */
      .sch-graph {
        flex: 1; min-height: 0; display: flex; flex-direction: column;
      }
      .sch-graph-toolbar {
        display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
        padding: 8px 12px; min-height: 44px;
        border-bottom: 1px solid var(--sch-hairline);
        background: var(--sch-solid);
      }
      .sch-graph-toolbar-group {
        display: inline-flex; align-items: center; gap: 3px;
        padding: 2px; border-radius: 8px;
        background: var(--sch-fill);
        border: 1px solid var(--sch-hairline);
      }
      .sch-graph-meta {
        font-size: 10.5px; font-weight: 560; letter-spacing: .01em;
        color: var(--dsw-alias-label-secondary);
        padding: 3px 9px; border-radius: 999px; flex: none;
        background: var(--sch-fill);
        border: 1px solid var(--sch-hairline);
        font-variant-numeric: tabular-nums;
      }
      .sch-graph-banner {
        margin: 8px 12px 0; padding: 8px 12px; border-radius: 10px; font-size: 11.5;
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 8%, transparent);
        border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 22%, transparent);
      }
      .sch-graph-stage {
        flex: 1; min-height: 0; position: relative;
        margin: 10px 12px 12px; border-radius: 12px; overflow: hidden;
        border: 1px solid var(--sch-hairline);
        box-shadow: var(--sch-lift);
      }
      .sch-graph-legend {
        position: absolute; left: 10px; bottom: 10px; max-width: min(94%, 440px);
        font-size: 10px; color: var(--dsw-alias-label-caption);
        border-radius: 10px; padding: 8px 10px; pointer-events: none;
        background: var(--sch-solid);
        border: 1px solid var(--sch-hairline);
        box-shadow: 0 4px 16px color-mix(in srgb, #000 10%, transparent);
      }
      .sch-graph-legend-row {
        display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
      }
      .sch-graph-legend-item {
        display: inline-flex; align-items: center; gap: 5px;
        color: var(--dsw-alias-label-secondary); font-weight: 500;
      }
      .sch-graph-legend-swatch {
        width: 12px; height: 2.5px; border-radius: 2px; display: inline-block; flex: none;
      }
      .sch-graph-inspector {
        position: absolute; right: 10px; top: 10px; left: 10px; max-width: 320px; margin-left: auto;
        border-radius: 12px; padding: 12px 12px 11px; font-size: 11.5;
        background: var(--sch-solid);
        border: 1px solid var(--sch-hairline);
        box-shadow:
          0 1px 0 color-mix(in srgb, #fff 6%, transparent) inset,
          0 12px 32px color-mix(in srgb, #000 18%, transparent);
      }
      .sch-graph-zoom {
        position: absolute; right: 10px; bottom: 10px;
        display: inline-flex; align-items: center; gap: 2px;
        padding: 3px; border-radius: 9px;
        background: var(--sch-solid);
        border: 1px solid var(--sch-hairline);
        box-shadow: 0 4px 14px color-mix(in srgb, #000 10%, transparent);
      }
      .sch-graph-zoom-pct {
        min-width: 40px; text-align: center; font-size: 10.5; font-weight: 600;
        color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums;
        user-select: none;
      }

      .sch-list > *, .sch-stagger > * {
        animation: schFadeUp var(--sch-dur) var(--sch-ease) forwards;
        animation-delay: calc(var(--sch-i, 0) * 16ms);
      }
      .sch-skeleton {
        border-radius: var(--sch-radius-lg); margin-bottom: 8px;
        background: linear-gradient(90deg,
          var(--sch-fill) 25%,
          var(--sch-fill-strong) 37%,
          var(--sch-fill) 63%);
        background-size: 480px 100%;
        animation: schShimmer 1.25s linear infinite;
      }
      .sch-skeleton-card {
        border: 1px solid var(--sch-hairline);
        border-radius: var(--sch-radius-lg); padding: 12px; margin-bottom: 8px;
        background: transparent;
      }
      .sch-skeleton-line {
        height: 10px; border-radius: 4px; margin-bottom: 8px;
        background: linear-gradient(90deg,
          var(--sch-fill) 25%,
          var(--sch-fill-strong) 37%,
          var(--sch-fill) 63%);
        background-size: 480px 100%;
        animation: schShimmer 1.25s linear infinite;
      }
      .sch-skeleton-line:last-child { margin-bottom: 0; }
      .sch-paper-card {
        display: block; width: 100%; text-align: left; box-sizing: border-box;
        border: 1px solid transparent;
        border-bottom-color: var(--sch-hairline);
        border-radius: 0; padding: 10px 12px 9px; margin-bottom: 0; cursor: pointer;
        color: var(--dsw-alias-label-primary);
        background: transparent;
        transition: background var(--sch-fast) var(--sch-ease), border-color var(--sch-fast) var(--sch-ease);
      }
      .sch-paper-card:hover {
        background: var(--sch-fill);
        border-color: transparent;
        border-bottom-color: var(--sch-hairline);
      }
      .sch-paper-card.sch-cursor {
        background: var(--sch-fill-strong);
        box-shadow: inset 2px 0 0 var(--dsw-alias-label-primary);
      }
      .sch-list-item { /* no stagger — keeps open/scroll smooth */ }
      .sch-check-row {
        display: flex; align-items: center; gap: 8px; padding: 6px 10px;
        cursor: pointer; font-size: 12px; color: var(--dsw-alias-label-primary);
        border-radius: var(--sch-radius); margin: 0 4px;
        transition: background var(--sch-fast) var(--sch-ease);
      }
      .sch-check-row:hover { background: var(--sch-fill-hover); }
      .sch-check-row[data-on="true"] {
        background: var(--sch-fill-strong);
      }
      @keyframes schShimmer { from { background-position: -240px 0; } to { background-position: 240px 0; } }

      .sch-input:focus, .sch-select:focus, textarea.sch-input:focus {
        outline: none !important;
        border-color: color-mix(in srgb, var(--sch-accent) 55%, var(--sch-hairline)) !important;
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--sch-accent) 16%, transparent);
      }
      .sch-input::placeholder { color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-caption)); }
      .sch-select option { background: var(--sch-solid); color: var(--dsw-alias-label-primary); }

      @keyframes schFadeUp { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
      .sch-fade { animation: schFadeUp var(--sch-dur) var(--sch-ease) forwards; }

      /* 拖dsh-papercover宽度时关掉推挤过渡，避免跟手不同步 */
      body[data-sch-drawer-dragging] #root [data-dsh-center-col] {
        transition: none !important;
      }
      [data-dsh-part="drawer-panel"][data-dragging] {
        transition: none !important;
      }

      @keyframes schPulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }

      .sch-modal-in { animation: schModalIn var(--sch-slow) var(--sch-spring) both; }
      @keyframes schModalIn { from { opacity: 0; transform: scale(.97) translateY(6px); } to { opacity: 1; transform: none; } }
      .sch-modal-bd { animation: schBdIn var(--sch-slow) ease both; background: color-mix(in srgb, #000 42%, transparent); }
      @keyframes schBdIn { from { opacity: 0; } to { opacity: 1; } }

      .sch-collapse { display: grid; grid-template-rows: 1fr; transition: grid-template-rows var(--sch-slow) var(--sch-ease), opacity var(--sch-dur) ease; }
      .sch-collapse.sch-collapsed { grid-template-rows: 0fr; opacity: 0; }
      .sch-collapse > .sch-collapse-inner { overflow: hidden; min-height: 0; }

      .sch-card.sch-dragging {
        transform: rotate(1.2deg) scale(1.02) !important;
        box-shadow: 0 10px 28px color-mix(in srgb, #000 22%, transparent) !important;
        opacity: .96; cursor: grabbing !important;
      }
      .sch-dropped { animation: schSettle .45s var(--sch-spring) both; }
      @keyframes schSettle {
        0% { transform: scale(1.03); box-shadow: 0 0 0 0 color-mix(in srgb, var(--sch-accent) 28%, transparent); }
        60% { transform: scale(.995); }
        100% { transform: none; box-shadow: 0 0 0 6px transparent; }
      }
      .sch-kanban-col { transition: border-color .15s ease, background .15s ease, transform var(--sch-dur) var(--sch-ease), box-shadow var(--sch-dur) var(--sch-ease); }
      .sch-kanban-col.sch-drop-target {
        transform: translateY(-1px);
        border-color: var(--sch-hairline-strong) !important;
        background: var(--sch-fill) !important;
        box-shadow: var(--sch-lift);
      }

      .sch-rail-active {
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 10%, var(--sch-solid)) !important;
        color: var(--dsw-alias-label-primary) !important;
        box-shadow: none !important;
      }

      /*
       * Archive rail — Apple Sidebar rhythm:
       * soft secondary fill, rounded selection slabs, air between sections
       * (no hard rules, no left accent bars).
       */
      .sch-col-rail {
        width: 200px; min-height: 0; box-sizing: border-box; flex: none;
        display: flex; flex-direction: column;
        border-right: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 6%, var(--sch-solid));
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 3.2%, var(--sch-solid));
        overflow: hidden;
        overscroll-behavior: contain;
      }
      .sch-library-layout { position: relative; }
      .sch-library-layout[data-compact="true"] .sch-col-rail {
        position: absolute; inset: 0 auto 0 0; z-index: 2;
        width: min(200px, calc(100% - 48px));
        box-shadow: 8px 0 24px color-mix(in srgb, #000 16%, transparent);
      }
      .sch-col-rail-bar {
        flex: none; display: flex; align-items: center; justify-content: space-between;
        gap: 4px; padding: 6px 4px 0 10px;
      }
      .sch-col-rail-scroll {
        flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden;
        padding: 8px 10px 20px;
        overscroll-behavior: contain;
      }
      .sch-col-rail-backdrop {
        position: absolute; inset: 0; z-index: 1;
        border: 0; padding: 0; margin: 0;
        background: transparent; cursor: pointer;
      }
      .sch-rail-sec { margin-top: 18px; }
      .sch-rail-sec:first-child { margin-top: 2px; }
      .sch-rail-sec-head {
        display: flex; align-items: center; gap: 4px;
        padding: 0 8px 6px; min-height: 20px;
      }
      .sch-rail-sec-toggle {
        display: inline-flex; align-items: center; gap: 5px;
        margin: 0; padding: 0; border: 0; background: transparent;
        cursor: pointer; color: inherit; min-width: 0;
        border-radius: 6px;
      }
      .sch-rail-sec-toggle:hover .sch-rail-sec-title {
        color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary));
      }
      .sch-rail-sec-toggle:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--sch-accent) 26%, transparent);
      }
      .sch-rail-sec-title {
        font-size: 11px; font-weight: 590; letter-spacing: -.01em;
        color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-caption));
        user-select: none;
      }
      .sch-rail-sec-count {
        font-size: 10px; font-variant-numeric: tabular-nums;
        color: var(--dsw-alias-label-caption);
        opacity: .75;
      }
      .sch-rail-item {
        display: flex; align-items: center; gap: 9px; width: 100%;
        text-align: left; box-sizing: border-box;
        min-height: 30px; padding: 5px 8px; border-radius: 8px; margin-bottom: 1px;
        border: 0; cursor: pointer; background: transparent;
        color: var(--dsw-alias-label-primary);
        font-size: 12.5px; font-weight: 450; letter-spacing: -.01em; line-height: 1.2;
        transition: background 120ms ease, color 120ms ease;
      }
      .sch-rail-row {
        display: flex; align-items: center; gap: 2px;
        margin-bottom: 1px; border-radius: 8px;
      }
      .sch-rail-row > .sch-rail-item {
        flex: 1; min-width: 0; margin-bottom: 0;
      }
      .sch-rail-row:hover,
      .sch-rail-row:focus-within {
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 5.5%, var(--sch-solid));
      }
      .sch-rail-row:hover > .sch-rail-item,
      .sch-rail-row:focus-within > .sch-rail-item {
        background: transparent;
      }
      .sch-rail-row[data-active="true"] {
        background: color-mix(in srgb, var(--sch-accent) 12%, var(--sch-solid));
      }
      .sch-rail-item-action {
        flex: none; display: inline-flex; align-items: center; justify-content: center;
        width: 22px; height: 22px; margin-right: 2px; padding: 0;
        border: 0; border-radius: 6px; cursor: pointer;
        background: transparent;
        color: var(--dsw-alias-label-caption);
        opacity: 0; pointer-events: none;
        transition: opacity 120ms ease, color 120ms ease, background 120ms ease;
      }
      .sch-rail-row:hover .sch-rail-item-action,
      .sch-rail-row:focus-within .sch-rail-item-action,
      .sch-rail-item-action:focus-visible {
        opacity: 1; pointer-events: auto;
      }
      .sch-rail-item-action:hover,
      .sch-rail-item-action:focus-visible {
        color: var(--dsw-alias-label-primary);
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
      }
      .sch-rail-item-action--danger:hover,
      .sch-rail-item-action--danger:focus-visible {
        color: var(--dsw-alias-status-danger, #dc2626);
        background: color-mix(in srgb, var(--dsw-alias-status-danger, #dc2626) 12%, transparent);
      }
      .sch-rail-item-action:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--sch-accent) 26%, transparent);
      }
      .sch-rail-rename {
        flex: 1; min-width: 0; box-sizing: border-box;
        margin: 1px 4px; padding: 5px 8px; border-radius: 8px;
        border: 1px solid color-mix(in srgb, var(--sch-accent) 45%, var(--dsw-alias-border-l2));
        background: var(--dsw-alias-bg-layer-1, var(--sch-solid));
        color: var(--dsw-alias-label-primary);
        font-size: 12.5px; font-weight: 450; letter-spacing: -.01em; line-height: 1.2;
        outline: none;
      }
      .sch-rail-rename:focus {
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--sch-accent) 26%, transparent);
      }
      .sch-rail-item:hover {
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 5.5%, var(--sch-solid));
      }
      .sch-rail-item:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--sch-accent) 26%, transparent);
      }
      .sch-rail-item[data-dim="true"]:not([aria-pressed="true"]) {
        color: var(--dsw-alias-label-secondary);
      }
      .sch-rail-item[aria-pressed="true"] {
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 10%, var(--sch-solid));
        font-weight: 560;
        box-shadow: none;
      }
      .sch-rail-glyph {
        width: 18px; height: 18px; border-radius: 5px; flex: none;
        display: inline-flex; align-items: center; justify-content: center;
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, var(--sch-solid));
        color: var(--dsw-alias-label-secondary);
      }
      .sch-rail-item[aria-pressed="true"] .sch-rail-glyph {
        background: color-mix(in srgb, var(--sch-accent) 22%, var(--sch-solid));
        color: var(--sch-accent-ink);
      }
      .sch-rail-dot {
        width: 8px; height: 8px; border-radius: 999px; flex: none;
        box-shadow: inset 0 0 0 1px color-mix(in srgb, #000 8%, transparent);
      }
      .sch-rail-count {
        flex: none; font-size: 11px; font-variant-numeric: tabular-nums;
        color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-caption));
        font-weight: 500; min-width: 1.1em; text-align: right;
        letter-spacing: -.02em;
      }
      .sch-rail-item[aria-pressed="true"] .sch-rail-count {
        color: var(--dsw-alias-label-secondary);
      }
      .sch-rail-ghost {
        width: 100%; display: flex; align-items: center; justify-content: center; gap: 5px;
        margin-top: 6px; min-height: 30px; padding: 0 10px; border-radius: 8px;
        font-size: 12px; font-weight: 510; letter-spacing: -.01em; cursor: pointer;
        color: var(--dsw-alias-label-secondary);
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, var(--sch-solid));
        border: 0;
        transition: background 120ms ease, color 120ms ease;
      }
      .sch-rail-ghost:hover:not(:disabled) {
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, var(--sch-solid));
        color: var(--dsw-alias-label-primary);
      }
      .sch-rail-ghost:disabled { opacity: .4; cursor: default; }
      .sch-rail-recent {
        display: flex; align-items: center; gap: 9px; width: 100%;
        text-align: left; min-height: 28px; padding: 4px 8px; border-radius: 8px; margin-bottom: 1px;
        border: 0; cursor: pointer; background: transparent;
        color: var(--dsw-alias-label-secondary); font-size: 12px; letter-spacing: -.01em; line-height: 1.25;
        transition: background 120ms ease, color 120ms ease;
      }
      .sch-rail-recent:hover {
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 5.5%, var(--sch-solid));
        color: var(--dsw-alias-label-primary);
      }
      .sch-rail-status {
        display: flex; flex-direction: column; gap: 2px;
        margin: 0 2px 12px; padding: 4px;
        border-radius: 10px;
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, var(--sch-solid));
      }
      .sch-rail-status-cell {
        display: flex; align-items: center; gap: 8px;
        min-height: 28px; padding: 0 8px; border-radius: 7px;
        background: transparent; border: 0;
      }
      .sch-rail-status-n {
        margin-left: auto;
        font-size: 12.5px; font-weight: 600; font-variant-numeric: tabular-nums;
        color: var(--dsw-alias-label-primary); line-height: 1;
        letter-spacing: -.02em;
      }
      .sch-rail-status-l {
        font-size: 12px; font-weight: 450; letter-spacing: -.01em;
        color: var(--dsw-alias-label-secondary);
      }
      .sch-rail-year {
        display: grid; grid-template-columns: 34px 1fr 20px; gap: 8px;
        align-items: center; margin: 0 8px 7px;
        font-size: 11px; color: var(--dsw-alias-label-secondary);
        font-variant-numeric: tabular-nums; letter-spacing: -.02em;
      }
      .sch-rail-year-bar {
        height: 4px; border-radius: 999px; overflow: hidden;
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, var(--sch-solid));
      }
      .sch-rail-year-fill {
        display: block; height: 100%; border-radius: 999px;
        background: color-mix(in srgb, var(--sch-accent) 55%, var(--dsw-alias-label-primary));
        opacity: .85;
        min-width: 0;
      }
      .sch-rail-tags { display: flex; flex-wrap: wrap; gap: 5px; margin: 10px 6px 0; }
      .sch-rail-tag {
        font-size: 11px; padding: 3px 9px; border-radius: 999px; cursor: pointer;
        color: var(--dsw-alias-label-secondary);
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 5.5%, var(--sch-solid));
        border: 0; letter-spacing: -.01em;
        max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        transition: background 120ms ease, color 120ms ease;
      }
      .sch-rail-tag:hover {
        color: var(--dsw-alias-label-primary);
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, var(--sch-solid));
      }
      .sch-rail-tag[aria-pressed="true"] {
        color: var(--sch-accent-fg, var(--sch-accent-ink));
        background: color-mix(in srgb, var(--sch-accent) 28%, var(--sch-solid));
      }

      .sch-empty-glyph {
        width: 40px; height: 40px; border-radius: var(--sch-radius-lg);
        display: inline-flex; align-items: center; justify-content: center;
        background:
          linear-gradient(145deg, color-mix(in srgb, var(--sch-accent) 10%, transparent), transparent 60%),
          var(--sch-fill);
        border: 1px solid var(--sch-hairline);
        color: var(--dsw-alias-label-secondary);
        box-shadow: 0 1px 0 color-mix(in srgb, #fff 5%, transparent) inset;
      }

      /* Paper detail sticky chrome — inset tray, not a full-bleed ink slab */
      .sch-detail { position: relative; }
      .sch-detail-top {
        position: sticky; top: 0; z-index: 4;
        display: flex; align-items: center; gap: 6px;
        min-height: 40px; margin: 0; padding: 8px 12px;
        background: var(--sch-solid);
        border-bottom: 1px solid var(--sch-hairline);
      }
      .sch-detail-body { padding: 12px 12px 14px; }
      .sch-detail-actions {
        position: sticky; top: 40px; z-index: 3;
        display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
        margin: 6px 0 16px; padding: 5px;
        background: var(--dsw-alias-bg-layer-1, var(--sch-fill));
        border: 1px solid var(--sch-hairline);
        border-radius: 10px;
        box-shadow: var(--sch-lift);
      }
      .sch-detail-actions .sch-btn {
        border-radius: 7px;
        border-color: transparent;
        background: transparent;
        color: var(--dsw-alias-label-secondary);
        font-weight: 500;
      }
      .sch-detail-actions .sch-btn:hover:not(:disabled) {
        background: var(--sch-fill-hover);
        border-color: transparent;
        color: var(--dsw-alias-label-primary);
      }
      .sch-detail-actions .sch-btn--primary {
        background: var(--dsw-alias-label-primary);
        border-color: transparent;
        color: var(--dsw-alias-bg-base, #fff);
        font-weight: 600;
        box-shadow: 0 1px 2px color-mix(in srgb, #000 10%, transparent);
      }
      .sch-detail-actions .sch-btn--primary:hover:not(:disabled) {
        opacity: .92;
        background: var(--dsw-alias-label-primary);
        color: var(--dsw-alias-bg-base, #fff);
      }
      .sch-detail-actions .sch-btn--soft {
        background: transparent;
        border-color: transparent;
        color: var(--dsw-alias-label-secondary);
      }
      .sch-detail-actions .sch-btn--soft:hover:not(:disabled) {
        background: var(--sch-fill-hover);
        color: var(--dsw-alias-label-primary);
      }
      .sch-detail-actions-sep {
        width: 1px; height: 16px; margin: 0 4px; flex: none;
        background: var(--sch-hairline);
      }
      .sch-detail-hero { padding-bottom: 2px; }
      .sch-detail-hero h2 {
        margin: 0; font-weight: 650; font-size: 16px; line-height: 1.4;
        letter-spacing: -.018em; color: var(--dsw-alias-label-primary);
      }
      .sch-edge-row {
        display: flex; align-items: center; gap: 6px;
        width: 100%; text-align: left; margin-top: 2px; padding: 5px 7px;
        border: 0; border-radius: 7px; background: transparent; cursor: pointer;
        font-size: 10.5px; color: var(--dsw-alias-label-secondary);
        transition: background var(--sch-fast) var(--sch-ease), color var(--sch-fast) var(--sch-ease);
      }
      .sch-edge-row:hover {
        background: var(--sch-fill-hover);
        color: var(--dsw-alias-label-primary);
      }

      /* Nav rail — SF-style rounded selection, no left ink bar */
      .sch-nav-item {
        position: relative; width: 32px; height: 32px; border-radius: 9px;
        display: inline-flex; align-items: center; justify-content: center;
        border: none; cursor: pointer; background: transparent;
        color: var(--dsw-alias-label-secondary);
        transition: background 120ms ease, color 120ms ease, transform 120ms ease;
      }
      .sch-nav-item:hover {
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, var(--sch-solid));
        color: var(--dsw-alias-label-primary);
      }
      .sch-nav-item:active { transform: scale(.96); }
      .sch-nav-item[aria-current="page"], .sch-nav-item.sch-on {
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 10%, var(--sch-solid));
        color: var(--dsw-alias-label-primary);
      }
      .sch-nav-item[aria-current="page"]::before, .sch-nav-item.sch-on::before { display: none; }
      .sch-nav-item .sch-icon { display: block; }
      .sch-badge {
        position: absolute; top: 2px; right: 1px;
        min-width: 16px; height: 16px; border-radius: 999px; padding: 0 4px; box-sizing: border-box;
        display: inline-flex; align-items: center; justify-content: center;
        background: #ff3b30; color: #fff;
        font-size: 9px; line-height: 1; font-weight: 700;
        font-variant-numeric: tabular-nums; letter-spacing: -.02em;
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-label-primary) 3.2%, var(--sch-solid));
        pointer-events: none;
      }
      .sch-badge[data-wide="true"] {
        min-width: 22px; padding: 0 5px; font-size: 8.5px;
      }

      @keyframes schSpin { to { transform: rotate(360deg); } }
      .sch-spin { animation: schSpin .8s linear infinite; }

      @media (prefers-reduced-motion: reduce) {
        .sch-card, .sch-press, .sch-collapse, .sch-kanban-col, .sch-dragging, .sch-dropped,
        .sch-list > *, .sch-stagger > *, .sch-fade, .sch-modal-in, .sch-modal-bd, .sch-skeleton, .sch-spin,
        .sch-icon-btn, .sch-btn, .sch-seg-item, .sch-entry, .sch-nav-item,
        .sch-drawer-rail, .sch-drawer-rail-inner, .sch-peek-rail, .sch-peek-rail .sch-drawer-rail-inner {
          animation: none !important; transition: none !important;
        }
        .sch-collapse.sch-collapsed { display: none; }
        .sch-drawer-rail, .sch-peek-rail { width: var(--sch-rail-w, 40px); }
        .sch-drawer-rail-inner, .sch-peek-rail .sch-drawer-rail-inner {
          opacity: 1 !important; transform: none !important; pointer-events: auto !important;
        }
      }
    `}</style>
  );
}

/** 24×24 stroke icon system (Lucide-grade geometry, 1.75px stroke). */
export function Icon({ d, size = 16, color = 'currentColor', className, strokeWidth }: {
  d: string; size?: number; color?: string; className?: string; strokeWidth?: number;
}) {
  // Optical stroke: keep perceived weight stable across 12–20px sizes.
  const sw = strokeWidth ?? (size <= 12 ? 2.1 : size <= 14 ? 1.95 : 1.75);
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      className={`sch-icon ${className ?? ''}`.trim()}
      style={{ color }}
    >
      <path
        d={d}
        stroke="currentColor"
        strokeWidth={sw}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Path data on a 24×24 grid — optically centered, consistent corner radii. */
export const Icons = {
  close: 'M18 6L6 18M6 6l12 12',
  check: 'M20 6L9 17l-5-5',
  copy: 'M8 8h10v12H8zM6 16V4h10',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 18l6-6-6-6',
  collapseRight: 'M13 17l5-5-5-5M6 17l5-5-5-5',
  refresh: 'M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  plus: 'M12 5v14M5 12h14',
  edit: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  back: 'M15 18l-6-6 6-6',
  // Nav glyphs — equal-height books, centered on the 24×24 grid
  book: 'M4.5 5h4.5v14H4.5zM13 5h4.5v14H13z',
  graph: 'M6 19V10M12 19V5M18 19v-7',
  cards: 'M8 5.5h11v13H8zM5.5 8v11.5A1.5 1.5 0 0 0 7 21h10',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  filter: 'M4 5h16M7 12h10M10 19h4',
  external: 'M14 4h6v6M10 14L20 4M18 14v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h5',
  sparkle: 'M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3zM19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z',
  doc: 'M14 2H7a1 1 0 0 0-1 1v18a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8zM14 2v6h6M9 13h6M9 17h6',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 1 3.5 10.8c-.7.5-1.1 1.2-1.2 2V17h-4.6v-.4c-.1-.8-.5-1.5-1.2-2A6 6 0 0 1 12 3z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  list: 'M9 6h12M9 12h12M9 18h12M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  stack: 'M12 2l9 4.5-9 4.5L3 6.5 12 2zM3 12.5l9 4.5 9-4.5M3 17.5l9 4.5 9-4.5',
  frame: 'M3 9V4h5M15 4h5v5M21 15v5h-5M9 21H4v-5',
  expand: 'M9 4H4v5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  sidebarRight: 'M4 5h16v14H4zM15 5v14',
  popout: 'M13 4h7v7M11 13l9-9M9 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3',
  dock: 'M4 4h16v16H4v-3h13V7H4V4zM10 9l4 3-4 3v-2H7v-2h3V9z',
  download: 'M12 4v10M8 10l4 4 4-4M5 18h14',
  rail: 'M5 4h14v16H5zM10 4v16M14 8h3M14 12h3M14 16h3',
  kanban: 'M5 5h4v12H5zM10 5h4v8h-4zM15 5h4v14h-4z',
  table: 'M4 5h16v14H4zM4 9h16M10 9v10',
} as const;

/** round icon button with DSH hover fill */
export function IconButton(props: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
  disabled?: boolean;
  size?: number;
  color?: string;
  /** toggled look (filter buttons etc.) */
  active?: boolean;
}) {
  const { label, onClick, icon, disabled, size = 28, color, active } = props;
  const danger = color === T.danger || color === 'var(--sch-danger, #dc2626)' || color === 'var(--dsw-alias-state-error-primary, #e5484d)';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active ? true : undefined}
      disabled={disabled}
      onClick={onClick}
      className={`sch-icon-btn${active ? ' sch-on' : ''}${danger ? ' sch-danger' : ''}`}
      style={{
        width: size, height: size,
        ...(color && !danger && !active ? { color } : null),
      }}
    >
      {icon}
    </button>
  );
}

/** small bordered button; heights align on a 28px control rhythm */
export function Btn(props: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: 'default' | 'primary' | 'danger' | 'soft';
  style?: React.CSSProperties;
  title?: string;
}) {
  const { children, onClick, disabled, tone = 'default', style, title } = props;
  const toneClass = tone === 'default' ? '' : ` sch-btn--${tone}`;
  return (
    <button
      title={title}
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`sch-btn${toneClass}`}
      style={style}
    >
      {children}
    </button>
  );
}

/** Segmented control — one pressed option at a time */
export function SegGroup({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div className="sch-seg" role="group" style={style}>{children}</div>;
}

export function SegItem(props: {
  label: string;
  pressed: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  disabled?: boolean;
}) {
  const { label, pressed, onClick, icon, disabled } = props;
  return (
    <button
      type="button"
      className="sch-seg-item"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

/** Icon-only segment (view mode toggles) */
export function SegIcon(props: {
  label: string;
  pressed: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  disabled?: boolean;
}) {
  const { label, pressed, onClick, icon, disabled } = props;
  return (
    <button
      type="button"
      className="sch-seg-item"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      style={{ padding: '0 7px', minWidth: 28 }}
    >
      {icon}
    </button>
  );
}

/** labeled text input */
export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { style, ...rest } = props;
  return (
    <input
      {...rest}
      className={`sch-input ${rest.className ?? ''}`}
      style={{
        minHeight: 28, lineHeight: 1.4, display: 'block', width: '100%', boxSizing: 'border-box',
        padding: '0 10px', borderRadius: 6, border: '1px solid var(--sch-hairline, var(--dsw-alias-border-l2))',
        background: 'var(--sch-fill, var(--dsw-alias-bg-layer-2, transparent))', color: 'var(--dsw-alias-label-primary)',
        fontSize: 12, transition: 'border-color .12s ease, box-shadow .12s ease', ...style,
      }}
    />
  );
}

/** multi-line text input. Grows with the text so a summary is not stuck in two lines. */
export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { style, value, onChange, ...rest } = props;
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const [height, setHeight] = React.useState(72);
  const fit = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    const next = Math.min(Math.max(el.scrollHeight, 72), 480);
    el.style.height = '';
    setHeight(next);
  }, []);
  React.useLayoutEffect(() => { fit(); }, [fit, value]);
  return (
    <textarea
      {...rest}
      ref={ref}
      value={value}
      onChange={(e) => { onChange?.(e); fit(); }}
      className={`sch-input ${rest.className ?? ''}`}
      style={{
        display: 'block', width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box',
        resize: 'none', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
        overflow: height >= 480 ? 'auto' : 'hidden',
        padding: '6px 8px', borderRadius: 6, border: '1px solid var(--sch-hairline, var(--dsw-alias-border-l2))',
        background: 'var(--sch-fill, var(--dsw-alias-bg-layer-2, transparent))', color: 'var(--dsw-alias-label-primary)',
        fontSize: 12, lineHeight: 1.55, transition: 'border-color .12s ease, box-shadow .12s ease',
        ...style,
        height,
      }}
    />
  );
}

/** native select dressed with a chevron (appearance none) */
export function Select({ children, style, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', minWidth: 0, ...style }}>
      <select
        {...rest}
        className={`sch-input ${rest.className ?? ''}`}
        style={{
          minHeight: 28, lineHeight: 1.4, paddingTop: 0, paddingBottom: 0, appearance: 'none', WebkitAppearance: 'none', paddingRight: 22, paddingLeft: 10,
          borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-2, transparent)', color: 'var(--dsw-alias-label-primary)',
          fontSize: 11.5, cursor: 'pointer', boxSizing: 'border-box', width: '100%',
          display: 'inline-block', transition: 'border-color .12s ease, box-shadow .12s ease',
        }}
      >
        {children}
      </select>
      <span style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', display: 'inline-flex', color: 'var(--dsw-alias-label-caption)' }}>
        <Icon d={Icons.chevronDown} size={11} />
      </span>
    </span>
  );
}

/** search input with magnifier + one-click clear */
export function SearchInput({ value, onChange, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', flex: '1 1 160px', minWidth: 128 }}>
      <span style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', display: 'inline-flex', color: 'var(--dsw-alias-label-caption)' }}>
        <Icon d={Icons.search} size={14} />
      </span>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={{ paddingLeft: 30, paddingRight: value ? 28 : 10 }} />
      {value && (
        <span style={{ position: 'absolute', right: 3, top: '50%', transform: 'translateY(-50%)' }}>
          <IconButton label="×" size={22} onClick={() => onChange('')} icon={<Icon d={Icons.close} size={12} />} />
        </span>
      )}
    </span>
  );
}

export const labelStyle: React.CSSProperties = {
  fontSize: 11, color: 'var(--dsw-alias-label-secondary)', display: 'block',
  marginBottom: 4, fontWeight: 500, letterSpacing: '.01em',
};

/** form field: label above control */
export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ marginBottom: 10, minWidth: 0, maxWidth: '100%' }}>
      <span style={labelStyle}>{label}</span>
      {children}
      {hint && <div style={{ fontSize: 10.5, color: T.caption, marginTop: 3, lineHeight: 1.45 }}>{hint}</div>}
    </div>
  );
}

/** empty-state block: quiet glyph + title + hint */
export function EmptyState({ icon, title, hint, action }: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="sch-fade sch-empty" style={{
      flex: 1, minHeight: 120, display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', textAlign: 'center', padding: '28px 20px', gap: 6,
    }}>
      <span className="sch-empty-glyph" style={{ color: 'var(--dsw-alias-label-secondary)', marginBottom: 2 }}>
        {icon}
      </span>
      <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-.01em', color: 'var(--dsw-alias-label-primary)' }}>{title}</div>
      {hint && <div style={{ fontSize: 11.5, color: T.caption, lineHeight: 1.65, maxWidth: 260 }}>{hint}</div>}
      {action && <div style={{ marginTop: 10 }}>{action}</div>}
    </div>
  );
}

/** Paper-shaped loading placeholders */
export function SkeletonCards({ count = 4 }: { count?: number }) {
  return (
    <div aria-hidden className="sch-fade">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="sch-skeleton-card" style={{ opacity: 1 - i * 0.12 }}>
          <div className="sch-skeleton-line" style={{ width: `${78 - i * 6}%`, height: 12 }} />
          <div className="sch-skeleton-line" style={{ width: `${52 - i * 4}%`, height: 9 }} />
          <div className="sch-skeleton-line" style={{ width: '92%', height: 9, opacity: 0.7 }} />
        </div>
      ))}
    </div>
  );
}

/** removable chip for "active filters" rows */
export function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3, borderRadius: 999, padding: '2px 4px 2px 8px',
      fontSize: 10.5, color: T.primary, flex: 'none',
      background: 'var(--sch-fill-strong)',
      border: '1px solid var(--sch-hairline)',
      maxWidth: 200,
    }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <IconButton label="×" size={15} onClick={onRemove} icon={<Icon d={Icons.close} size={9} color="inherit" />} />
    </span>
  );
}

/** bordered section card used across detail pages */
export function Section({ title, sub, icon, children, accent, style }: {
  title?: string;
  /** 标题右侧的弱化副标题（如数据来源说明） */
  sub?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  accent?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{
      marginTop: 10, borderRadius: 8,
      border: '1px solid var(--sch-hairline, var(--dsw-alias-border-l2))',
      background: 'var(--sch-fill, transparent)',
      overflow: 'hidden', ...style,
    }}>
      {title && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 5, padding: '8px 12px 0',
          fontSize: 11, fontWeight: 600, letterSpacing: '-.01em', textTransform: 'none', color: 'var(--dsw-alias-label-primary)',
        }}>
          {icon}{title}
          {sub && <span style={{ fontWeight: 400, color: T.caption }}>· {sub}</span>}
        </div>
      )}
      <div style={{ padding: title ? '6px 12px 10px' : '10px 12px', fontSize: 12, lineHeight: 1.6, textAlign: 'start' }}>{children}</div>
    </div>
  );
}

/** key/value line for detail metadata grids */
export function Meta({ k, v }: { k: string; v: React.ReactNode }) {
  if (v === undefined || v === null || v === '') return null;
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 11, lineHeight: 1.5, minHeight: 18 }}>
      <span style={{ color: T.caption, flex: 'none', width: 52 }}>{k}</span>
      <span style={{ color: T.secondary, flex: 1, minWidth: 0, wordBreak: 'break-all' }}>{v}</span>
    </div>
  );
}

/** tag chip (non-filter decorative by default) */
export function Chip({ label, active, onClick, color }: { label: string; active?: boolean; onClick?: () => void; color?: string }) {
  const clickable = !!onClick;
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={onClick}
      className={clickable ? 'sch-press' : undefined}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        border: `1px solid ${active ? 'var(--sch-hairline-strong)' : 'var(--sch-hairline)'}`,
        background: active
          ? 'var(--sch-fill-strong)'
          : color
            ? `color-mix(in srgb, ${color} 12%, transparent)`
            : 'var(--sch-fill)',
        color: active ? 'var(--dsw-alias-label-primary)' : (color ?? 'var(--dsw-alias-label-secondary)'),
        borderRadius: 999, padding: '1px 8px', fontSize: 10.5,
        cursor: clickable ? 'pointer' : 'default',
        fontWeight: active ? 600 : 500,
        transition: 'background .12s ease, border-color .12s ease, color .12s ease',
      }}
    >
      {color && !active && <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: color, flex: 'none' }} />}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </button>
  );
}

/** importance stars ⭐1-5 */
export function Stars({ value, onChange, size = 11 }: { value: number; onChange?: (v: number) => void; size?: number }) {
  const keys = (e: React.KeyboardEvent, i: number) => {
    const next = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? Math.min(5, i + 1)
      : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? Math.max(1, i - 1) : e.key === 'Home' ? 1 : e.key === 'End' ? 5 : null;
    if (next !== null && onChange) {
      e.preventDefault(); e.stopPropagation(); onChange(next);
      (e.currentTarget.parentElement?.children[next - 1] as HTMLElement | undefined)?.focus();
    }
  };
  return <span role={onChange ? 'radiogroup' : undefined} aria-label={onChange ? '重要性 / Importance' : undefined} style={{ display: 'inline-flex', gap: 2, color: T.warning }}>
    {[1, 2, 3, 4, 5].map(i => onChange ? <button type="button" role="radio" aria-checked={i === value} aria-label={i + ' / 5'} tabIndex={i === (value || 1) ? 0 : -1} key={i}
      onKeyDown={e => keys(e, i)} onClick={e => { e.stopPropagation(); onChange(i); }}
      style={{ border: 0, background: 'none', color: 'inherit', padding: 2, cursor: 'pointer', opacity: i <= value ? 1 : .3, fontSize: size, lineHeight: 1 }}>★</button>
      : <span key={i} style={{ opacity: i <= value ? 1 : .25, fontSize: size, lineHeight: 1 }}>★</span>)}
  </span>;
}

/** status color for cards */
export function statusColor(status: string): string {
  switch (status) {
    case 'validated': return T.success;
    case 'adopted': return T.business;
    case 'dropped': return T.caption;
    default: return T.warning;
  }
}

/** category color for cards */
export function categoryColor(category: string): string {
  switch (category) {
    case 'method': return T.business;
    case 'theory': return T.purple;
    case 'dataset': return T.success;
    case 'evaluation': return T.warning;
    case 'engineering': return T.teal;
    default: return T.caption;
  }
}

/**
 * Enterprise SVG palette (Linear / Obsidian Graph / Notion-adjacent).
 * Presentation attributes cannot use CSS var/color-mix — they fall back to black.
 */
export const GraphPaint = {
  paperFill: '#1e2430',
  paperFillLight: '#ffffff',
  paperStroke: '#3d4654',
  paperStrokeLight: '#d8dde6',
  paperText: '#eef1f6',
  paperTextLight: '#0f172a',
  concept: '#0891b2',
  conceptSoft: '#ecfeff',
  conceptSel: '#155e75',
  ideaFill: '#292524',
  ideaFillLight: '#fff7ed',
  ideaStroke: '#ea580c',
  ideaText: '#c4c9d2',
  label: '#94a3b8',
  labelStrong: '#f8fafc',
  labelMuted: '#64748b',
  canvasDark: '#12151c',
  canvasLight: '#f7f8fa',
  gridDark: 'rgba(148,163,184,.07)',
  gridLight: 'rgba(15,23,42,.045)',
  edge: {
    proposes: '#3b82f6',
    improves: '#10b981',
    extends: '#8b5cf6',
    builds_on: '#f59e0b',
    compares: '#ef4444',
    uses: '#06b6d4',
    cites: 'rgba(100,116,139,.38)',
    derives_from: 'rgba(245,158,11,.55)',
    related: 'rgba(100,116,139,.32)',
    default: '#94a3b8',
  },
} as const;

/** Detect light shell background for graph contrast. */
export function graphIsLightTheme(): boolean {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-bg-base').trim()
      || getComputedStyle(document.body).backgroundColor;
    const m = raw.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (m) {
      const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
      return (r * 299 + g * 587 + b * 114) / 1000 > 160;
    }
    if (raw.startsWith('#')) {
      const h = raw.length === 4
        ? raw.slice(1).split('').map((c) => c + c).join('')
        : raw.slice(1, 7);
      const n = Number.parseInt(h, 16);
      if (!Number.isFinite(n)) return false;
      const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      return (r * 299 + g * 587 + b * 114) / 1000 > 160;
    }
  } catch { /* ignore */ }
  return false;
}

/** Mix hex color toward a base (SVG-safe; no color-mix). */
export function mixHex(hex: string, base: string, amount: number): string {
  const parse = (h: string): [number, number, number] | null => {
    const s = h.trim();
    if (!s.startsWith('#')) return null;
    const raw = s.length === 4
      ? s.slice(1).split('').map((c) => c + c).join('')
      : s.slice(1, 7);
    if (!/^[0-9a-fA-F]{6}$/.test(raw)) return null;
    const n = Number.parseInt(raw, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const a = parse(hex);
  const b = parse(base);
  if (!a || !b) return base;
  const t = Math.max(0, Math.min(1, amount));
  const ch = (i: number) => Math.round(a[i] * t + b[i] * (1 - t));
  const to = (n: number) => n.toString(16).padStart(2, '0');
  return `#${to(ch(0))}${to(ch(1))}${to(ch(2))}`;
}

/** edge color for the knowledge graph — always concrete for SVG paints */
export function edgeColor(kind: string): string {
  switch (kind) {
    case 'proposes': return GraphPaint.edge.proposes;
    case 'improves': return GraphPaint.edge.improves;
    case 'extends': return GraphPaint.edge.extends;
    case 'builds_on': return GraphPaint.edge.builds_on;
    case 'compares': return GraphPaint.edge.compares;
    case 'uses': return GraphPaint.edge.uses;
    case 'cites': return GraphPaint.edge.cites;
    case 'derives_from': return GraphPaint.edge.derives_from;
    case 'related': return GraphPaint.edge.related;
    default: return GraphPaint.edge.default;
  }
}

/** truncate long text for graph labels */
export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/* ---------- modal portal (shared by views) ---------- */

export function Modal({ title, onClose, children, width = 480 }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
}) {
  const { boxRef, layer } = useModalFocus(onClose);
  const solid = useOpaqueBase();
  return createPortal(
    <div
      data-dsh-plugin="dsh-scholar"
      className="sch-modal-bd"
      style={{
        position: 'fixed', inset: 0, zIndex: Z.modal + layer, background: 'rgba(0,0,0,.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="sch-modal-in"
        style={{
          position: 'relative',
          width: `min(${width}px, 90vw)`,
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: 12, boxShadow: 'var(--dsw-shadow-lv3, 0 12px 40px rgba(0,0,0,.4))',
          color: 'var(--dsw-alias-label-primary)', overflow: 'hidden',
        }}
      >
        {/* 不透明垫底 + 主题色表面(半透明皮肤下保证弹窗不透底) */}
        <div style={{ position: 'absolute', inset: 0, background: solid }} />
        <div style={{ position: 'absolute', inset: 0, background: 'var(--dsw-alias-bg-layer-2, transparent)' }} />
        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', maxHeight: '82vh' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--dsw-alias-border-l2)', flex: 'none' }}>
            <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{title}</span>
            <IconButton label={document.documentElement.lang.startsWith('en') ? 'Close' : '关闭'} onClick={onClose} icon={<Icon d={Icons.close} size={14} />} />
          </div>
          <div className="sch-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 14px' }}>{children}</div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
