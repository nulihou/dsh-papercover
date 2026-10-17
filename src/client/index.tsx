import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { zh, en } from './locales';
import { PaperLibraryView } from './PaperLibraryView';
import { ScholarReadEntry } from './StudyLauncher';
import { ReadProgressBanner } from './ReadProgressBanner';
import { BookshelfView } from './BookshelfView';
import { ProjectView } from './ProjectView';
import { GraphView } from './GraphView';
import { ScholarSettings } from './SettingsSection';
import { Icon, IconButton, Icons, SchStyles, containWheelChain, useOpaqueBase, Z } from './ui';
import { api } from './api';
import { navBus, useNav, type TabId, type TFunc } from './nav';
import { registerScholarRightbar, READING_EVENT, openPaperPdfInSidebar, currentSessionId, isReadingMode, clearReadingMode } from './rightbar';
import { OPEN_PAPER_EVENT } from './md-notes-bridge';
import { onResearchNav } from './research-protocol/index.js';
import { ActivityInboxTrigger } from './ActivityInbox';
import { claimPrimary, injectWorkbenchStyles, officialRightInset, onPrimaryClaim, publishDock, WB_TOP_INSET } from './workbench-ui/index.js';

const NS = 'scholar';

/** Client services this plugin needs (merged into ctx by the runtime). */
export const inject = ['slots', 'locale'];

/* ---------- drawer open state (trigger button ⇄ right drawer) ---------- */
type PanelMode = 'open' | 'rail' | 'closed' | 'float';
const MODE_KEY = 'dsh-scholar:panel-mode';

function loadPanelMode(): PanelMode {
  if (typeof localStorage === 'undefined') return 'rail';
  try {
    const raw = localStorage.getItem(MODE_KEY);
    if (raw === 'open' || raw === 'rail' || raw === 'closed' || raw === 'float') return raw;
  } catch { /* quota / private */ }
  return 'rail';
}

function savePanelMode(mode: PanelMode): void {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ }
}

const panelBus = {
  mode: loadPanelMode(),
  listeners: new Set<() => void>(),
  getSnapshot: () => panelBus.mode,
  subscribe(listener: () => void) {
    panelBus.listeners.add(listener);
    return () => { panelBus.listeners.delete(listener); };
  },
  set(next: PanelMode) {
    if (panelBus.mode !== next) {
      panelBus.mode = next;
      savePanelMode(next);
      for (const l of panelBus.listeners) l();
    }
  },
};
function usePanelMode(): PanelMode {
  return useSyncExternalStore(panelBus.subscribe, panelBus.getSnapshot);
}

/**
 * 打开dsh-papercover：dock 推挤对话列（padding-right = dsh-papercover宽），与左侧栏同理，
 * 不盖住聊天。官方 rightbar 已有 grid 轨道时只让位 right，不再把轨道宽加进推挤，
 * 避免「双倍占位」留下空白缝。
 */
function openScholarDesk(): void {
  // Reopening the desk exits PDF reading hide-state so clicks land again.
  if (isReadingMode()) clearReadingMode();
  panelBus.set('open');
}

/** 切换入口：关 ↔ 开（dock） */
function toggleScholarDesk(): void {
  const m = panelBus.mode;
  if (m === 'closed' || m === 'rail') {
    openScholarDesk();
    return;
  }
  panelBus.set('closed');
}

/** AppFrame 中心列（对话）：rightbar 左侧的 grid 项 */
function resolveCenterColumn(): HTMLElement | null {
  try {
    const marked = document.querySelector('[data-dsh-center-col]');
    if (marked instanceof HTMLElement) return marked;
    const right = document.querySelector('[data-rightbar-col]');
    const center = right?.previousElementSibling;
    return center instanceof HTMLElement ? center : null;
  } catch {
    return null;
  }
}

/**
 * 把dsh-papercover宽度写入中心列 padding-right，对话向左压缩。
 * 只写dsh-papercover自身宽度；官方右栏轨道由 AppFrame grid 负责，切勿叠加。
 * 同时关掉对话列 overscroll：接缝处就是聊天滚动条，滚轮会橡皮筋抽搐整页。
 */
function syncScholarLayoutPush(pushPx: number, animate = true): void {
  const center = resolveCenterColumn();
  if (center) {
    if (pushPx > 0) {
      center.style.boxSizing = 'border-box';
      center.style.transition = animate
        ? 'padding-right 320ms cubic-bezier(.22,.82,.24,1)'
        : 'none';
      center.style.paddingRight = `${Math.round(pushPx)}px`;
      center.style.overscrollBehavior = 'none';
      center.dataset.schPush = '1';
    } else {
      center.style.removeProperty('padding-right');
      center.style.removeProperty('box-sizing');
      center.style.removeProperty('overscroll-behavior');
      delete center.dataset.schPush;
      if ((center.style.transition || '').includes('padding-right')) {
        center.style.removeProperty('transition');
      }
    }
  }
  try {
    if (pushPx > 0) {
      document.documentElement.style.setProperty('--dsh-scholar-dock-width', `${Math.round(pushPx)}px`);
      document.documentElement.style.setProperty('overscroll-behavior', 'none');
      document.documentElement.dataset.schDockOpen = '1';
    } else {
      document.documentElement.style.removeProperty('--dsh-scholar-dock-width');
      if (document.documentElement.dataset.schDockOpen) {
        document.documentElement.style.removeProperty('overscroll-behavior');
        delete document.documentElement.dataset.schDockOpen;
      }
    }
  } catch { /* */ }
}

/** 关闭 / 卸载时清掉推挤，避免残留空白。 */
function clearScholarLayoutPush(): void {
  syncScholarLayoutPush(0, false);
  try {
    document.documentElement.style.removeProperty('--dsh-scholar-drawer-width');
  } catch { /* */ }
}

/**
 * 更新抽屉宽度；dock 模式下同步推挤对话列。
 * 必须写入实宽并清掉 left：绝对定位在 left+right 同时存在时会撑满。
 */
function applyScholarDrawerWidth(
  panel: HTMLElement | null,
  w: number,
  opts?: { push?: boolean; animate?: boolean },
): void {
  const px = `${Math.round(w)}px`;
  try {
    document.documentElement.style.setProperty('--dsh-scholar-drawer-width', px);
  } catch { /* */ }
  if (panel) {
    panel.style.width = px;
    panel.style.removeProperty('left');
  }
  if (opts?.push !== false) {
    syncScholarLayoutPush(w, opts?.animate ?? false);
  }
}

/* ---------- library stats for tab badges ---------- */
export interface ScholarCounts { papers: number; cards: number }
const statsBus = {
  counts: { papers: 0, cards: 0 } as ScholarCounts,
  listeners: new Set<() => void>(),
  getSnapshot: () => statsBus.counts,
  subscribe(listener: () => void) {
    statsBus.listeners.add(listener);
    return () => { statsBus.listeners.delete(listener); };
  },
  set(counts: ScholarCounts) {
    if (statsBus.counts.papers !== counts.papers || statsBus.counts.cards !== counts.cards) {
      statsBus.counts = counts;
      for (const l of statsBus.listeners) l();
    }
  },
};
function useCounts(): ScholarCounts {
  return useSyncExternalStore(statsBus.subscribe, statsBus.getSnapshot);
}

/* ---------- right-edge launcher (drawer closed; vertical drag) ---------- */
const EDGE_TOP_KEY = 'dsh-scholar:edge-launch-top';
const EDGE_DRAG_THRESHOLD = 5;

function readEdgeTop(): number | null {
  try {
    const raw = localStorage.getItem(EDGE_TOP_KEY);
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeEdgeTop(top: number): void {
  try { localStorage.setItem(EDGE_TOP_KEY, String(Math.round(top))); } catch { /* quota / private */ }
}

function clampEdgeTop(top: number, height: number): number {
  const margin = 8;
  const min = margin;
  const max = Math.max(min, window.innerHeight - height - margin);
  return Math.min(max, Math.max(min, top));
}

function EdgeLaunch({ t }: { t: TFunc }) {
  const mode = usePanelMode();
  const counts = useCounts();
  const btnRef = useRef<HTMLButtonElement>(null);
  const [top, setTop] = useState<number | null>(() => readEdgeTop());
  const [dragging, setDragging] = useState(false);
  const topRef = useRef<number | null>(top);
  topRef.current = top;
  const suppressClick = useRef(false);
  const drag = useRef<{ pointerId: number; startY: number; originTop: number; moved: boolean } | null>(null);

  // Re-clamp after resize so a saved position never sits off-screen.
  useEffect(() => {
    const onResize = () => {
      setTop((prev) => {
        if (prev == null) return prev;
        const h = btnRef.current?.offsetHeight ?? 120;
        const next = clampEdgeTop(prev, h);
        if (next !== prev) writeEdgeTop(next);
        return next;
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Closed dock shows the edge chip. Keep it during PDF reading too — otherwise
  // the desk vanishes with no reopen target once reading mode sticks.
  if (mode !== 'closed') return null;
  const badge = counts.papers + counts.cards;

  const onPointerDown = (ev: React.PointerEvent<HTMLButtonElement>) => {
    if (ev.button !== 0) return;
    const el = ev.currentTarget;
    const rect = el.getBoundingClientRect();
    const originTop = topRef.current ?? rect.top;
    drag.current = { pointerId: ev.pointerId, startY: ev.clientY, originTop, moved: false };
    try { el.setPointerCapture(ev.pointerId); } catch { /* */ }
  };

  const onPointerMove = (ev: React.PointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== ev.pointerId) return;
    const dy = ev.clientY - state.startY;
    if (!state.moved && Math.abs(dy) < EDGE_DRAG_THRESHOLD) return;
    state.moved = true;
    setDragging(true);
    const h = ev.currentTarget.offsetHeight || 120;
    setTop(clampEdgeTop(state.originTop + dy, h));
  };

  const endDrag = (ev: React.PointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== ev.pointerId) return;
    drag.current = null;
    setDragging(false);
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch { /* */ }
    if (state.moved) {
      const h = ev.currentTarget.offsetHeight || 120;
      const next = clampEdgeTop(topRef.current ?? state.originTop, h);
      setTop(next);
      writeEdgeTop(next);
      suppressClick.current = true;
    }
  };

  const onClick = (ev: React.MouseEvent<HTMLButtonElement>) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    openScholarDesk();
  };

  return (
    <button
      ref={btnRef}
      type="button"
      data-dsh-plugin="dsh-scholar"
      data-dsh-part="edge-launch"
      data-dragging={dragging ? 'true' : undefined}
      data-positioned={top != null ? 'true' : undefined}
      className="sch-edge-launch"
      style={{
        right: 'var(--dsh-scholar-right-inset, 0px)',
        ...(top != null ? { top } : null),
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={onClick}
      title={`${t('nav.open')} (${t('nav.shortcut')})`}
      aria-label={t('nav.open')}
    >
      <span className="sch-edge-launch-inner">
        <Icon d={Icons.book} size={15} />
        <span className="sch-edge-launch-label">{t('nav.label')}</span>
        {badge > 0 && (
          <span className="sch-edge-launch-badge">{badge > 99 ? '99+' : badge}</span>
        )}
      </span>
    </button>
  );
}

/* ---------- left sidebar trigger (compact companion to right-edge launch) ---------- */
function Trigger({ t, wide }: { t: TFunc; wide?: boolean }) {
  const mode = usePanelMode();
  const counts = useCounts();
  const active = mode === 'open' || mode === 'float' || mode === 'rail';
  const badge = counts.papers + counts.cards;
  const badgeText = badge > 99 ? '99+' : String(badge);
  return (
    <>
      <SchStyles />
      <button
        type="button"
        data-dsh-plugin="dsh-scholar"
        data-dsh-part="sidebar-entry"
        className={wide ? 'sch-entry sch-entry--scholar' : 'sch-entry sch-entry--scholar sch-entry--rail'}
        aria-pressed={active}
        onClick={() => toggleScholarDesk()}
        title={`${t('nav.title')} · ${t('nav.shortcut')}`}
      >
        <span aria-hidden className="sch-entry-icon">
          <Icon d={Icons.book} size={16} />
        </span>
        {wide && <span className="sch-entry-text">{t('nav.label')}</span>}
        {badge > 0 && (
          <span
            className={wide ? 'sch-entry-count' : 'sch-badge'}
            data-footer-badge={wide || undefined}
            data-wide={!wide && badge > 99 ? 'true' : undefined}
            aria-hidden
          >
            {badgeText}
          </span>
        )}
      </button>
    </>
  );
}

/* ---------- right-docked collapsible drawer (shell.overlay entry) ---------- */
const DRAWER_MIN = 320;
const DRAWER_DEFAULT = 400;
/** 对话列最少保留；与软顶一起防止拖拽铺满 */
const CHAT_RESERVE = 320;
/** 拖拽软顶：最多约占视口 55%，贴近左栏可调空间；更大请用「整窗展开」 */
const DRAWER_SOFT_MAX_RATIO = 0.55;
const WIDTH_KEY = 'dsh-scholar:drawer-width';
/** Always-visible icon rail width (no peek collapse; PDF reading hides the whole dock). */
const RAIL_W = 40;

/** 浮动窗口几何夹取:不越出视口、不小于可读下限 */
function clampFloat(g: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
  const vw = window.innerWidth, vh = window.innerHeight;
  return {
    x: Math.max(8, Math.min(g.x, vw - 80)),
    y: Math.max(8, Math.min(g.y, vh - 60)),
    w: Math.max(300, Math.min(g.w, vw - 16)),
    h: Math.max(220, Math.min(g.h, vh - 16)),
  };
}

/** Host bottom inset when a layout writes --dsh-sidebar-height. */
function hostBottomInset(): number {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--dsh-sidebar-height').trim();
    if (!raw) return 0;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  } catch {
    return 0;
  }
}

/** 硬顶：视口 − 官方右栏 − 对话保留 */
function drawerHardMax(officialInset = 0): number {
  const inset = Math.max(0, Math.round(officialInset) || 0);
  return Math.max(DRAWER_MIN, window.innerWidth - inset - CHAT_RESERVE);
}

/** 拖拽软顶 */
function drawerDragMax(officialInset = 0): number {
  const hard = drawerHardMax(officialInset);
  const soft = Math.max(DRAWER_MIN, Math.floor(window.innerWidth * DRAWER_SOFT_MAX_RATIO));
  return Math.min(hard, soft);
}

function clampW(w: number, max: number): number {
  if (!Number.isFinite(w)) return DRAWER_DEFAULT;
  return Math.max(DRAWER_MIN, Math.min(max, Math.round(w)));
}

function loadSavedWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(n) && n >= DRAWER_MIN) {
      return clampW(n, drawerDragMax(0));
    }
  } catch { /* ignore */ }
  return DRAWER_DEFAULT;
}

function saveWidth(w: number) {
  try { localStorage.setItem(WIDTH_KEY, String(Math.round(w))); } catch { /* ignore */ }
}

function Drawer({ t }: { t: TFunc }) {
  const mode = usePanelMode();
  const nav = useNav();
  const counts = useCounts();
  const solid = useOpaqueBase();
  const [width, setWidth] = useState(() => loadSavedWidth());
  const [full, setFull] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [handleHover, setHandleHover] = useState(false);
  const dragOrigin = useRef({ x: 0, w: DRAWER_DEFAULT });
  const panelRef = useRef<HTMLDivElement | null>(null);
  const collapsedRailRef = useRef<HTMLDivElement | null>(null);
  const liveWidthRef = useRef(width);
  const draggingRef = useRef(false);
  const dragRafRef = useRef<number | null>(null);
  const pendingWidthRef = useRef<number | null>(null);
  const officialInsetRef = useRef(0);
  const insetRafRef = useRef<number | null>(null);

  // 浮动窗口：fixed 定位，头部拖拽，角上缩放，几何记在 localStorage。
  const floatGeomRef = useRef({ x: 0, y: 0, w: 420, h: 560 });
  const [floatGeom, setFloatGeom] = useState(() => {
    const base = clampFloat({ x: window.innerWidth - 920, y: 100, w: 420, h: Math.min(560, window.innerHeight - 180) });
    try {
      const saved = JSON.parse(localStorage.getItem('sch-float-geom') ?? '');
      if (saved && Number.isFinite(saved.x)) return clampFloat(saved);
    } catch {}
    return base;
  });
  useEffect(() => { floatGeomRef.current = floatGeom; }, [floatGeom]);
  useEffect(() => {
    liveWidthRef.current = width;
    try {
      document.documentElement.style.setProperty('--dsh-scholar-drawer-width', `${Math.round(width)}px`);
    } catch { /* */ }
  }, [width]);
  useEffect(() => {
    // seed CSS var on mount
    try {
      document.documentElement.style.setProperty('--dsh-scholar-drawer-width', `${Math.round(liveWidthRef.current)}px`);
    } catch { /* */ }
  }, []);

  // 竖直栏 / 抽屉 chrome 上滚轮不链式传导到外壳（否则整页抽搐）
  useEffect(() => {
    if (mode !== 'open' && mode !== 'float') return;
    return containWheelChain(panelRef.current);
  }, [mode, full, nav.tab]);

  useEffect(() => {
    if (mode !== 'rail') return;
    return containWheelChain(collapsedRailRef.current);
  }, [mode]);

  // 接缝杀手：dsh-papercover左缘 ≈ 对话区右侧滚动条所在。滚轮落在滚动条上会滚聊天并
  // 触发外壳橡皮筋，看起来像「整个容器上下弹」。捕获阶段吞掉接缝带宽内的滚轮。
  useEffect(() => {
    if (mode !== 'open') return;
    const SEAM = 16;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return;
      const panel = panelRef.current;
      if (!panel) return;
      const left = panel.getBoundingClientRect().left;
      if (e.clientX >= left - SEAM && e.clientX <= left + SEAM) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    // 对话列及其可滚子孙也禁 overscroll（滚动条本体不一定挂在 center 上）
    const center = resolveCenterColumn();
    const touched: HTMLElement[] = [];
    const lock = (el: HTMLElement | null) => {
      if (!el) return;
      touched.push(el);
      el.style.setProperty('overscroll-behavior', 'none');
    };
    lock(center);
    if (center) {
      center.querySelectorAll<HTMLElement>('*').forEach((el) => {
        const s = getComputedStyle(el);
        const oy = s.overflowY;
        if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay')
          && el.scrollHeight > el.clientHeight + 1) {
          lock(el);
        }
      });
    }
    document.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => {
      document.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
      for (const el of touched) {
        if (el.dataset.schPush === '1') continue; // syncScholarLayoutPush owns center
        el.style.removeProperty('overscroll-behavior');
      }
    };
  }, [mode, width, full]);

  // 侧栏打开 PDF 时完全隐藏dsh-papercover竖直栏（含 rail 图标列），避免挡阅读；
  // 退出阅读后恢复进阅读前的 open / float / rail。
  const preReadingMode = useRef<PanelMode | null>(null);
  const preReadingFull = useRef(false);
  useEffect(() => {
    const onReading = (ev: Event) => {
      const active = !!(ev as CustomEvent<{ active?: boolean }>).detail?.active;
      if (active) {
        if (full) {
          preReadingFull.current = true;
          setFull(false);
        }
        if (panelBus.mode === 'open' || panelBus.mode === 'float' || panelBus.mode === 'rail') {
          preReadingMode.current = panelBus.mode;
          panelBus.set('closed');
        }
      } else {
        if (preReadingMode.current && panelBus.mode === 'closed') {
          const restore = preReadingMode.current;
          preReadingMode.current = null;
          panelBus.set(restore);
        } else {
          preReadingMode.current = null;
        }
        if (preReadingFull.current) {
          preReadingFull.current = false;
          setFull(true);
        }
      }
    };
    window.addEventListener(READING_EVENT, onReading);
    return () => window.removeEventListener(READING_EVENT, onReading);
  }, [full]);
  useEffect(() => {
    const onResize = () => setFloatGeom((g) => clampFloat(g));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const [floatMoving, setFloatMoving] = useState(false);
  const floatOrigin = useRef({ x: 0, y: 0, g: { x: 0, y: 0, w: 0, h: 0 } });
  const floatRafRef = useRef<number | null>(null);
  const saveFloatGeom = () => { try { localStorage.setItem('sch-float-geom', JSON.stringify(floatGeomRef.current)); } catch {} };
  const onFloatDragDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest?.('button')) return;
    setFloatMoving(true);
    floatOrigin.current = { x: e.clientX, y: e.clientY, g: floatGeomRef.current };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  }, []);
  const onFloatDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!floatMoving) return;
    const o = floatOrigin.current;
    const next = clampFloat({ ...o.g, x: o.g.x + (e.clientX - o.x), y: o.g.y + (e.clientY - o.y) });
    floatGeomRef.current = next;
    if (floatRafRef.current == null) {
      floatRafRef.current = requestAnimationFrame(() => {
        floatRafRef.current = null;
        setFloatGeom(floatGeomRef.current);
      });
    }
  }, [floatMoving]);
  const onFloatDragUp = useCallback(() => {
    if (!floatMoving) return;
    if (floatRafRef.current != null) {
      cancelAnimationFrame(floatRafRef.current);
      floatRafRef.current = null;
    }
    setFloatGeom(floatGeomRef.current);
    setFloatMoving(false);
    saveFloatGeom();
  }, [floatMoving]);
  const onFloatResizeDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    setFloatMoving(true);
    floatOrigin.current = { x: e.clientX, y: e.clientY, g: floatGeomRef.current };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  }, []);
  const onFloatResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!floatMoving) return;
    const o = floatOrigin.current;
    const next = clampFloat({ ...o.g, w: o.g.w + (e.clientX - o.x), h: o.g.h + (e.clientY - o.y) });
    floatGeomRef.current = next;
    if (floatRafRef.current == null) {
      floatRafRef.current = requestAnimationFrame(() => {
        floatRafRef.current = null;
        setFloatGeom(floatGeomRef.current);
      });
    }
  }, [floatMoving]);

  // keep the tab badges fresh — edge launcher needs counts even when closed
  useEffect(() => {
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const BACKOFFS = mode === 'closed' ? [120000] : [30000, 60000, 120000];
    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(run, BACKOFFS[Math.min(failures, BACKOFFS.length - 1)]);
    };
    const run = () => {
      if (stopped) return;
      if (document.hidden) { schedule(); return; }
      void api<{ papers: number; cards: number }>('/scholar/stats')
        .then((s) => {
          if (stopped) return;
          statsBus.set({ papers: s.papers, cards: s.cards });
          failures = 0;
        })
        .catch(() => {
          if (!stopped) failures = Math.min(failures + 1, BACKOFFS.length - 1);
        })
        .finally(() => { if (!stopped) schedule(); });
    };
    run();
    const onVisibility = () => {
      if (!document.hidden && !stopped) {
        if (timer) clearTimeout(timer);
        run();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [mode]);

  const flushDragWidth = useCallback(() => {
    dragRafRef.current = null;
    const w = pendingWidthRef.current;
    if (w == null || !draggingRef.current) return;
    liveWidthRef.current = w;
    // 拖拽中同步推挤对话，无过渡，跟手
    applyScholarDrawerWidth(panelRef.current, w, { push: true, animate: false });
  }, []);

  const onHandleDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    // 退出全屏再拖。全屏态 DOM 宽 ≈ 视口，绝不能拿来当起点，否则一点就「铺满」。
    const wasFull = full;
    if (wasFull) setFull(false);

    const inset = officialInsetRef.current;
    const maxW = drawerDragMax(inset);
    // 仅用记忆宽度作原点；全屏后 getBoundingClientRect 会接近视口宽
    const startW = clampW(liveWidthRef.current, maxW);

    draggingRef.current = true;
    setDragging(true);
    dragOrigin.current = { x: e.clientX, w: startW };
    pendingWidthRef.current = startW;
    liveWidthRef.current = startW;
    applyScholarDrawerWidth(panelRef.current, startW, { push: true, animate: false });
    try { document.body.setAttribute('data-sch-drawer-dragging', ''); } catch { /* */ }

    const frozenInset = inset;
    let armed = false;

    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      const x = ev.clientX;
      if (!Number.isFinite(x)) return;

      // 纯增量：右缘固定（right: inset），左拖加宽。
      const dx = dragOrigin.current.x - x;
      if (!armed) {
        if (Math.abs(dx) < 3) return;
        armed = true;
      }
      if (Math.abs(dx) > 400) return;

      const next = clampW(dragOrigin.current.w + dx, drawerDragMax(frozenInset));
      pendingWidthRef.current = next;
      if (dragRafRef.current == null) {
        dragRafRef.current = requestAnimationFrame(flushDragWidth);
      }
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      if (dragRafRef.current != null) {
        cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
      const w = clampW(pendingWidthRef.current ?? liveWidthRef.current, drawerDragMax(frozenInset));
      liveWidthRef.current = w;
      applyScholarDrawerWidth(panelRef.current, w, { push: true, animate: false });
      setWidth(w);
      saveWidth(w);
      draggingRef.current = false;
      setDragging(false);
      try { document.body.removeAttribute('data-sch-drawer-dragging'); } catch { /* */ }
    };

    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
  }, [flushDragWidth, full]);

  // dock 足迹：推挤宽度（不含官方右栏轨道）
  const pushW = mode === 'open' && !full
    ? (dragging ? liveWidthRef.current : width)
    : mode === 'rail' ? RAIL_W
    : 0;
  const selfW = pushW;

  // 官方右侧栏：轨道宽或零轨道挂载面板宽 → dsh-papercover right 让位。
  // 宿主底栏高度 → bottom 让位。
  const [officialInset, setOfficialInset] = useState(() => officialRightInset());
  useEffect(() => { officialInsetRef.current = officialInset; }, [officialInset]);
  useEffect(() => {
    const writeInsetVars = (right: number, bottom: number) => {
      try {
        document.documentElement.style.setProperty('--dsh-scholar-right-inset', `${right}px`);
        document.documentElement.style.setProperty('--dsh-scholar-bottom-inset', `${bottom}px`);
      } catch { /* */ }
    };
    writeInsetVars(officialInsetRef.current, hostBottomInset());

    let lastRight = -1;
    let lastBottom = -1;
    const applyInsets = () => {
      insetRafRef.current = null;
      if (draggingRef.current) return;
      const nextRight = officialRightInset();
      const nextBottom = hostBottomInset();
      // 无变化不写 DOM，避免 style 写入 → MutationObserver → 再调度 的反馈环
      if (nextRight === lastRight && nextBottom === lastBottom) return;
      lastRight = nextRight;
      lastBottom = nextBottom;
      writeInsetVars(nextRight, nextBottom);
      officialInsetRef.current = nextRight;
      setOfficialInset((cur) => (cur === nextRight ? cur : nextRight));
    };
    const schedule = () => {
      if (insetRafRef.current != null) return;
      insetRafRef.current = requestAnimationFrame(applyInsets);
    };

    schedule();
    window.addEventListener('resize', schedule);

    const ros: ResizeObserver[] = [];
    const observe = (el: Element | null) => {
      if (!el || typeof ResizeObserver === 'undefined') return;
      const ro = new ResizeObserver(schedule);
      ro.observe(el);
      ros.push(ro);
    };
    observe(document.querySelector('[data-rightbar-col]'));
    observe(document.querySelector('[data-sidebar-right-panel]'));
    observe(document.querySelector('[data-dsh-part="sidebar-bottom"]'));
    observe(document.querySelector('[data-dsh-sidebar-bottom]'));

    // 只盯布局相关 data-*；尺寸变化交给 ResizeObserver。
    // 绝不观察 style——官方栏/其它插件写 CSS 变量会形成 schedule→量宽→再调度 的反馈环。
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { attributes: true, attributeFilter: ['data-dsh-sidebar-dragging'] });
    const frame = document.querySelector('[data-dsh-frame]');
    if (frame) {
      mo.observe(frame, {
        attributes: true,
        attributeFilter: ['data-rightbar-fullscreen', 'data-sidebar-collapsed', 'data-rightbar-collapsed'],
      });
    }

    return () => {
      window.removeEventListener('resize', schedule);
      if (insetRafRef.current != null) cancelAnimationFrame(insetRafRef.current);
      for (const ro of ros) ro.disconnect();
      mo.disconnect();
    };
  }, []);

  // 推挤对话列：与侧栏同理；拖拽中由 applyScholarDrawerWidth 直写
  useEffect(() => {
    if (dragging) {
      applyScholarDrawerWidth(panelRef.current, liveWidthRef.current, { push: true, animate: false });
      return undefined;
    }
    if (mode === 'float' || mode === 'closed' || full) {
      syncScholarLayoutPush(0, true);
      return undefined;
    }
    if (mode === 'rail') {
      syncScholarLayoutPush(RAIL_W, true);
      return undefined;
    }
    applyScholarDrawerWidth(panelRef.current, liveWidthRef.current, { push: true, animate: true });
    return undefined;
  }, [mode, full, width, dragging]);

  // 视口 / 右栏变化时只在超出软顶时收缩，绝不自动拉满
  const liveMax = drawerDragMax(officialInset);
  useEffect(() => {
    if (dragging) return;
    setWidth((w) => {
      if (w <= liveMax) return w;
      const next = clampW(w, liveMax);
      liveWidthRef.current = next;
      saveWidth(next);
      applyScholarDrawerWidth(panelRef.current, next, {
        push: mode === 'open' && !full,
        animate: false,
      });
      return next;
    });
  }, [liveMax, dragging, mode, full]);

  useEffect(() => {
    if (dragging) return;
    publishDock('dsh-scholar', { open: mode === 'open' || mode === 'rail', width: selfW });
  }, [mode, selfW, dragging]);
  useEffect(() => () => {
    publishDock('dsh-scholar', { open: false, width: 0 });
    clearScholarLayoutPush();
  }, []);

  useEffect(() => {
    injectWorkbenchStyles();
    if (mode === 'open' || mode === 'float') claimPrimary('dsh-scholar');
  }, [mode]);
  useEffect(() => onPrimaryClaim((id) => {
    if (id === 'dsh-scholar') return;
    if (panelBus.mode === 'open') panelBus.set('rail');
  }), []);

  const tabs: { id: TabId; label: string; icon: string; badge?: number }[] = [
    { id: 'papers', label: t('tab.papers'), icon: Icons.book, badge: counts.papers },
    { id: 'projects', label: t('tab.projects'), icon: Icons.stack },
    { id: 'graph', label: t('tab.graph'), icon: Icons.graph },
    { id: 'cards', label: t('tab.cards'), icon: Icons.cards, badge: counts.cards },
  ];

  const panelNode = (mode === 'open' || mode === 'float') ? (
            <div
              ref={panelRef}
              className="sch-root"
              data-dsh-plugin="dsh-scholar"
              data-dsh-part="drawer-panel"
              data-dragging={dragging || floatMoving || undefined}
              style={{
                ...(mode === 'float'
                  ? {
                      position: 'fixed' as const,
                      top: floatGeom.y, left: floatGeom.x, width: floatGeom.w, height: floatGeom.h,
                      pointerEvents: 'auto' as const, zIndex: 1200, borderRadius: 12,
                      border: '1px solid var(--dsw-alias-border-l2)',
                      boxShadow: 'var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,.28))',
                      overflow: 'hidden',
                      willChange: floatMoving ? 'left, top, width, height' : undefined,
                    }
                  : {
                      // fixed escapes shell.overlay (z≈20) so the desk stays above
                      // better-sidebar chrome (z=25); absolute children cannot.
                      position: 'fixed' as const,
                      top: WB_TOP_INSET,
                      right: 'var(--dsh-scholar-right-inset, 0px)',
                      bottom: 'var(--dsh-scholar-bottom-inset, 0px)',
                      // 非全屏给实宽；拖拽中用 live ref，避免 React 用旧 state 盖回
                      width: full ? '100%' : `${Math.round(dragging ? liveWidthRef.current : width)}px`,
                      left: full ? 0 : 'auto',
                      pointerEvents: 'auto' as const,
                      zIndex: Z.drawer,
                      maxWidth: full ? undefined : `${Math.round(drawerDragMax(officialInset))}px`,
                      willChange: dragging ? 'width' : undefined,
                      transition: dragging ? 'none' : undefined,
                    }),
                display: 'flex', flexDirection: 'column',
                // 强制实色底：皮肤 bg-base 常半透明，否则对话会透进来
                backgroundColor: solid,
                backgroundImage: 'var(--sch-paper)',
                borderLeft: mode === 'float' ? undefined : '1px solid var(--dsw-alias-border-l2)',
                boxShadow: mode === 'float'
                  ? undefined
                  : 'var(--dsw-shadow-lv1, -4px 0 18px rgba(0,0,0,.12))',
                color: 'var(--dsw-alias-label-primary)',
                isolation: 'isolate',
                contain: 'layout style paint',
                overscrollBehavior: 'none',
              }}
            >
              {mode === 'float' && (
                <div
                  onPointerDown={onFloatResizeDown}
                  onPointerMove={onFloatResizeMove}
                  onPointerUp={onFloatDragUp}
                  title={t('drawer.resize')}
                  style={{ position: 'absolute', right: 0, bottom: 0, width: 18, height: 18, cursor: 'nwse-resize', zIndex: 3, userSelect: 'none', touchAction: 'none', display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', padding: 2, color: 'var(--dsw-alias-label-caption)' }}
                >
                  <svg width={9} height={9} viewBox="0 0 10 10" aria-hidden><path d="M9 1v8H1M9 5v4M5 9H1" stroke="currentColor" strokeWidth={1.4} fill="none" strokeLinecap="round" /></svg>
                </div>
              )}
              {/* resize handle — inside bounds (contain:paint clips left:-N); sink wheel so shell won't bounce */}
              {mode !== 'float' && (
              <div
                data-sch-wheel="contain"
                onPointerDown={onHandleDown}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const next = clampW(DRAWER_DEFAULT, drawerDragMax(officialInset));
                  liveWidthRef.current = next;
                  applyScholarDrawerWidth(panelRef.current, next, { push: true, animate: true });
                  setWidth(next);
                  saveWidth(next);
                  setFull(false);
                }}
                onMouseEnter={() => setHandleHover(true)}
                onMouseLeave={() => setHandleHover(false)}
                title={t('drawer.resize')}
                style={{
                  position: 'absolute', left: 0, top: 0, bottom: 0, width: 10, cursor: 'col-resize',
                  zIndex: 2, userSelect: 'none', touchAction: 'none', display: 'flex', justifyContent: 'center',
                  overscrollBehavior: 'none',
                }}
              >
                <span
                  style={{
                    width: 3, borderRadius: 2, margin: '12px 0', flex: 'none',
                    background: dragging || handleHover
                      ? 'var(--sch-accent, var(--dsw-alias-label-primary))'
                      : 'var(--dsw-alias-border-l3, var(--dsw-alias-label-caption))',
                    opacity: dragging || handleHover ? 1 : 0.45,
                    transition: 'opacity .15s, background .15s',
                  }}
                />
              </div>
              )}

              {/* body = left icon rail + content column */}
              <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                {/* icon rail — always visible; PDF reading hides the whole dock */}
                <nav
                  className="sch-drawer-rail"
                  data-sch-wheel="contain"
                  aria-label={t('nav.title')}
                >
                  <div className="sch-drawer-rail-inner">
                    {tabs.map(({ id, icon, badge, label }) => {
                      const active = nav.tab === id;
                      const count = badge ?? 0;
                      return (
                        <button
                          key={id}
                          type="button"
                          title={label}
                          onClick={() => navBus.go(id)}
                          className={`sch-nav-item${active ? ' sch-on' : ''}`}
                          aria-current={active ? 'page' : undefined}
                        >
                          <Icon d={icon} size={18} strokeWidth={1.7} />
                          {count > 0 && (
                            <span className="sch-badge" data-wide={count > 99 ? 'true' : undefined}>
                              {count > 99 ? '99+' : count}
                            </span>
                          )}
                        </button>
                      );
                    })}
                    <span style={{ flex: 1 }} />
                    <span style={{
                      writingMode: 'vertical-rl', fontSize: 10, letterSpacing: '0.04em',
                      color: 'var(--dsw-alias-label-caption)', userSelect: 'none', paddingBottom: 10, fontWeight: 580,
                    }}>
                      {t('nav.label')}
                    </span>
                  </div>
                </nav>

                {/* content */}
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  {/* content header: current view name + window controls */}
                  <div className="sch-drawer-head" key={nav.tab}
                    onPointerDown={mode === 'float' ? onFloatDragDown : undefined}
                    onPointerMove={mode === 'float' ? onFloatDragMove : undefined}
                    onPointerUp={mode === 'float' ? onFloatDragUp : undefined}
                    style={{
                    cursor: mode === 'float' ? (floatMoving ? 'grabbing' : 'grab') : undefined,
                    userSelect: floatMoving ? 'none' : undefined,
                    touchAction: mode === 'float' ? 'none' : undefined,
                  }}>
                    <span aria-hidden className="sch-drawer-mark">P</span>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                      <span className="sch-drawer-head-brand">{t('nav.title')}</span>
                      <span className="sch-drawer-head-title">
                        {tabs.find((x) => x.id === nav.tab)?.label}
                      </span>
                      {(nav.tab === 'papers' && counts.papers > 0) || (nav.tab === 'cards' && counts.cards > 0) ? (
                        <span className="sch-drawer-head-meta">
                          {nav.tab === 'papers' ? t('paper.count', { count: counts.papers }) : t('card.count', { count: counts.cards })}
                        </span>
                      ) : null}
                    </div>
                    <span style={{ flex: 1 }} />
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                      {mode !== 'float' && <IconButton label={full ? t('drawer.restore') : t('drawer.expand')} active={full} onClick={() => setFull(!full)} icon={<Icon d={Icons.expand} size={15} />} />}
                      {mode !== 'float' && <IconButton label={t('drawer.float')} onClick={() => { setFull(false); panelBus.set('float'); }} icon={<Icon d={Icons.popout} size={15} />} />}
                      {mode === 'float' && <IconButton label={t('drawer.dock')} onClick={() => { setFull(false); panelBus.set('open'); }} icon={<Icon d={Icons.dock} size={15} />} />}
                      {mode !== 'float' && <IconButton label={t('drawer.collapse')} onClick={() => { setFull(false); panelBus.set('rail'); }} icon={<Icon d={Icons.collapseRight} size={15} />} />}
                      <IconButton label={t('drawer.close')} onClick={() => panelBus.set('closed')} icon={<Icon d={Icons.close} size={15} />} />
                    </span>
                  </div>
                  {/* 后台精读实时进度（轮询 /scholar/read/status，完成广播刷新） */}
                  <ReadProgressBanner t={t} />
                  {/* views */}
                  <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    {nav.tab === 'papers' && <PaperLibraryView t={t} />}
                    {nav.tab === 'projects' && <ProjectView t={t} />}
                    {nav.tab === 'graph' && <GraphView t={t} />}
                    {nav.tab === 'cards' && <BookshelfView t={t} />}
                  </div>
                </div>
              </div>
            </div>
  ) : null;

  return (
    <>
      <SchStyles />
      <EdgeLaunch t={t} />
      {mode !== 'closed' && mode !== 'float' && (
        <div data-dsh-plugin="dsh-scholar" data-dsh-surface="drawer" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: Z.drawer }}>
          {mode === 'rail' && (
            <div
              ref={collapsedRailRef}
              className="sch-peek-rail"
              data-dsh-part="drawer-rail"
              data-sch-wheel="contain"
            >
              <div className="sch-drawer-rail-inner">
                {tabs.map(({ id, icon, badge, label }) => {
                  const count = badge ?? 0;
                  return (
                    <button
                      key={id}
                      type="button"
                      title={label}
                      onClick={() => {
                        navBus.go(id);
                        openScholarDesk();
                      }}
                      className="sch-nav-item"
                    >
                      <Icon d={icon} size={18} strokeWidth={1.7} />
                      {count > 0 && (
                        <span className="sch-badge" data-wide={count > 99 ? 'true' : undefined}>
                          {count > 99 ? '99+' : count}
                        </span>
                      )}
                    </button>
                  );
                })}
                <span style={{ flex: 1 }} />
                <span style={{
                  writingMode: 'vertical-rl', fontSize: 10, letterSpacing: 2.5,
                  color: 'var(--dsw-alias-label-caption)', userSelect: 'none', paddingBottom: 6, fontWeight: 580,
                }}>
                  {t('nav.label')}
                </span>
                <IconButton
                  label={t('drawer.close')}
                  onClick={() => panelBus.set('closed')}
                  size={22}
                  icon={<Icon d={Icons.close} size={13} />}
                />
              </div>
            </div>
          )}
          {mode === 'open' && panelNode}
        </div>
      )}
      {mode === 'float' && panelNode ? createPortal(panelNode, document.body) : null}
    </>
  );
}

/**
 * apply-guard：client 工厂在同一页面可能被加载两次（新旧 bundle 混合加载），
 * 先挂上的那份生效；卸载时放开，方便热替换。
 */
const APPLY_FLAG = '__dshScholarApplied';

/** Client plugin entry. */
export function apply(ctx: any) {
  const g = globalThis as Record<string, unknown>;
  if (g[APPLY_FLAG]) return;
  g[APPLY_FLAG] = true;
  ctx.effect(() => () => { g[APPLY_FLAG] = false; }, 'dsh-scholar: apply guard');
  // 卸载时清掉推挤，避免残留空白
  ctx.effect(() => () => clearScholarLayoutPush(), 'dsh-scholar: clear layout push');
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-scholar: dictionaries');
  // 跨插件深链:统一 research-nav（兼容旧 dsh-scholar-nav）
  const onDeepLink = (detail: { target: { kind: string; id: string } }) => {
    try {
      const { kind, id } = detail.target
      if (kind === 'paper') {
        openScholarDesk()
        navBus.go('papers', id)
      } else if (kind === 'card') {
        openScholarDesk()
        navBus.go('cards', null, id)
      }
    } catch { /* defensive: deep link must never crash the shell */ }
  }
  const stopNav = onResearchNav(onDeepLink)
  ctx.effect(() => () => stopNav(), 'dsh-scholar: research-nav')

  // Ctrl/Cmd+Shift+S toggles the scholar drawer
  const onHotkey = (ev: KeyboardEvent) => {
    if (!(ev.ctrlKey || ev.metaKey) || !ev.shiftKey) return;
    if (ev.key !== 'S' && ev.key !== 's') return;
    const tag = (ev.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (ev.target as HTMLElement | null)?.isContentEditable) {
      // Still allow — scholar toggle is intentional even while typing
    }
    ev.preventDefault();
    toggleScholarDesk();
  };
  window.addEventListener('keydown', onHotkey, true);
  ctx.effect(() => () => window.removeEventListener('keydown', onHotkey, true), 'dsh-scholar: hotkey');

  // Cross-view navigation always reveals the drawer (graph → paper, etc.)
  const baseGo = navBus.go.bind(navBus);
  navBus.go = ((tab, paperId, cardId, prefillPaperId) => {
    baseGo(tab, paperId, cardId, prefillPaperId);
    if (panelBus.mode === 'closed' || panelBus.mode === 'rail') openScholarDesk();
  }) as typeof navBus.go;

  // 官方右侧 Sidebar 页签(0.1.5+):旧宿主无该服务时静默跳过
  registerScholarRightbar(ctx);
  // Expose session id for md-notes bridge (avoid circular imports at call sites).
  ;(globalThis as { __dshScholarSessionId?: () => string | undefined }).__dshScholarSessionId = currentSessionId
  ctx.effect(() => () => {
    delete (globalThis as { __dshScholarSessionId?: () => string | undefined }).__dshScholarSessionId
  }, 'dsh-scholar: session id hook')

  // Notes preview deep-link → open paper PDF (in-desk modal if no Session seat)
  const onOpenPaper = (ev: Event) => {
    const id = (ev as CustomEvent<{ id?: string }>).detail?.id?.trim()
    if (!id) return
    void openPaperPdfInSidebar(id).then((ok) => {
      if (ok) return
      navBus.go('papers', id)
      openScholarDesk()
    })
  }
  window.addEventListener(OPEN_PAPER_EVENT, onOpenPaper)
  ctx.effect(() => () => window.removeEventListener(OPEN_PAPER_EVENT, onOpenPaper), 'dsh-scholar: open-paper')

  // 对话输入框左侧 📚 精读入口（单/多篇精读任务面板）
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'dsh-scholar-read',
    order: 60,
    locale: NS,
  }, ScholarReadEntry));
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-activity-inbox',
    order: 9,
    locale: NS,
  }, function InboxEntry({ wide }: { wide?: boolean }) {
    const t = ctx.locale.bind(NS) as TFunc;
    return <ActivityInboxTrigger t={t} wide={wide} />;
  }));
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-scholar',
    order: 11,
    locale: NS,
  }, Trigger));
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-scholar-drawer',
    order: 90,
    locale: NS,
  }, Drawer));
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-scholar',
    order: 110,
    label: () => ctx.locale.bind(NS)('settings.nav'),
    locale: NS,
  }, ScholarSettings));
}
