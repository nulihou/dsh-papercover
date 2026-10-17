/**
 * In-sidebar PDF reader (continuous scroll).
 * Floating selection bar: highlight / note / word-translate (POST /scholar/translate).
 * PDF bytes come from /scholar/papers/:id/pdf; pdf.js assets from /scholar/pdfjs/*.
 * Highlights sync with Zotero via /scholar/papers/:id/annotations.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { PaperAnnotationFile, PaperHighlight } from '../shared/types';
import { resolveHighlightRects } from '../shared/pdf-coords';
import {
  buildOutline,
  extractCitationIndex,
  findCitationTargetPage,
  findReferencesPage,
  searchDocument,
  type OutlineItem,
  type SearchHit,
} from './pdf-nav';
import { isVocabHighlight, refineWordSelection, VOCAB_COLOR } from './pdf-selection';
import {
  appendToPaperNote,
  formatHighlightMarkdown,
  formatSelectionMarkdown,
  requestOpenNote,
} from './md-notes-bridge';

const PDFJS_BASE = '/scholar/pdfjs';

type PdfJs = {
  getDocument: (opts: {
    data: Uint8Array;
    cMapUrl?: string;
    cMapPacked?: boolean;
    standardFontDataUrl?: string;
  }) => { promise: Promise<PdfDoc> };
  GlobalWorkerOptions: { workerSrc: string };
  TextLayer?: new (opts: { textContentSource: unknown; container: HTMLElement; viewport: PdfViewport }) => { render: () => Promise<void> };
  renderTextLayer?: (opts: { textContent: unknown; container: HTMLElement; viewport: PdfViewport; textDivs: unknown[] }) => { promise: Promise<void> };
};
type PdfViewport = { width: number; height: number; scale: number };
type PdfPage = {
  getViewport: (opts: { scale: number }) => PdfViewport;
  render: (opts: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }) => { promise: Promise<void> };
  getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
};
type PdfDoc = {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
  destroy: () => void;
  getOutline?: () => Promise<unknown[] | null>;
  getDestination?: (name: string) => Promise<unknown>;
  getPageIndex?: (ref: unknown) => Promise<number>;
};

const HL_COLORS = ['#ffd400', '#7dcea0', '#f5a9c5', '#85c1e9', VOCAB_COLOR] as const;
const VIEW_KEY = (id: string) => `sch-pdf-view:${id}`;
/** Global PDF visual-mode preference (not per-paper). */
const VISUAL_MODE_KEY = 'sch-pdf-visual-mode';

/** Pages to actively rasterize around the viewport center. */
const NEAR = 2;
/** Keep rendered canvases within this radius while scrolling. */
const KEEP = 4;
const PAGE_GAP_PX = 12;
const SCALE_DEBOUNCE_MS = 80;
const VIEW_SAVE_MS = 400;

/** Reading themes for the pdf.js canvas stack. */
export type PdfVisualMode = 'original' | 'dark' | 'night' | 'eye-care' | 'sepia' | 'contrast' | 'sharp';

const PDF_VISUAL_MODES: readonly PdfVisualMode[] = [
  'original', 'dark', 'night', 'eye-care', 'sepia', 'contrast', 'sharp',
] as const;

type PdfVisualTheme = {
  /** CSS filter applied to page canvases only (highlight overlays stay true-color). */
  canvasFilter: string;
  hostBg: string;
  pageBg: string;
};

const PDF_VISUAL_THEMES: Record<PdfVisualMode, PdfVisualTheme> = {
  original: {
    canvasFilter: 'none',
    hostBg: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06))',
    pageBg: '#fff',
  },
  dark: {
    canvasFilter: 'invert(0.92) hue-rotate(180deg) brightness(0.95) contrast(0.95)',
    hostBg: '#12141a',
    pageBg: '#1c1f26',
  },
  night: {
    canvasFilter: 'invert(0.88) hue-rotate(180deg) sepia(0.28) brightness(0.82) contrast(0.9)',
    hostBg: '#0c0d10',
    pageBg: '#14161c',
  },
  'eye-care': {
    canvasFilter: 'sepia(0.22) saturate(0.78) brightness(0.98) contrast(0.92)',
    hostBg: '#d5e0c8',
    pageBg: '#e8efdc',
  },
  sepia: {
    canvasFilter: 'sepia(0.42) saturate(0.88) contrast(0.96)',
    hostBg: '#e8dcc4',
    pageBg: '#f4ecd8',
  },
  contrast: {
    canvasFilter: 'contrast(1.28) brightness(1.03)',
    hostBg: '#ececec',
    pageBg: '#fff',
  },
  /** Mild sharpening without invert - better glyph edge for dense papers. */
  sharp: {
    canvasFilter: 'contrast(1.12) brightness(1.02) saturate(0.92)',
    hostBg: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06))',
    pageBg: '#fbfbfd',
  },
};

function loadVisualMode(): PdfVisualMode {
  try {
    const raw = localStorage.getItem(VISUAL_MODE_KEY);
    if (raw && (PDF_VISUAL_MODES as readonly string[]).includes(raw)) return raw as PdfVisualMode;
  } catch { /* */ }
  return 'original';
}

function saveVisualMode(mode: PdfVisualMode): void {
  try { localStorage.setItem(VISUAL_MODE_KEY, mode); } catch { /* */ }
}

let pdfjsPromise: Promise<PdfJs> | null = null;

async function loadPdfJs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const url = `${PDFJS_BASE}/pdf.mjs`;
      try {
        const mod = await (Function('u', 'return import(u)') as (u: string) => Promise<PdfJs>)(url);
        mod.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.mjs`;
        return mod;
      } catch {
        const src =
          `import * as m from '${PDFJS_BASE}/pdf.mjs';` +
          `m.GlobalWorkerOptions.workerSrc='${PDFJS_BASE}/pdf.worker.mjs';` +
          'export default m;';
        const blobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        try {
          const mod = await (Function('u', 'return import(u)') as (u: string) => Promise<{ default: PdfJs }>)(blobUrl);
          return mod.default;
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
      }
    })().catch((err) => {
      pdfjsPromise = null;
      throw err;
    });
  }
  return pdfjsPromise;
}

function loadViewMemory(paperId: string): { page?: number; scale?: number } {
  try {
    const raw = localStorage.getItem(VIEW_KEY(paperId));
    if (!raw) return {};
    const o = JSON.parse(raw) as { page?: unknown; scale?: unknown };
    return {
      page: typeof o.page === 'number' && o.page >= 1 ? Math.floor(o.page) : undefined,
      scale: typeof o.scale === 'number' && o.scale >= 0.5 && o.scale <= 3 ? o.scale : undefined,
    };
  } catch {
    return {};
  }
}

/** Client rects relative to page wrap → page-space [x,y,w,h] at scale=1 */
function selectionRectsAtScale1(wrap: HTMLElement, scale: number): number[][] {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || scale <= 0) return [];
  const wrapBox = wrap.getBoundingClientRect();
  const raw: number[][] = [];
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    for (const r of Array.from(range.getClientRects())) {
      if (r.width < 1 || r.height < 1) continue;
      const x = (r.left - wrapBox.left) / scale;
      const y = (r.top - wrapBox.top) / scale;
      const w = r.width / scale;
      const h = r.height / scale;
      if (w > 0 && h > 0) raw.push([x, y, w, h]);
    }
  }
  return mergeHighlightRects(raw);
}

/**
 * Collapse pdf.js clientRects into one band per line and remove vertical overlap.
 * Without this, glyph-level / padded rects stack translucent fills → striped highlights.
 */
function mergeHighlightRects(rects: number[][]): number[][] {
  type R = { x: number; y: number; w: number; h: number };
  const list: R[] = [];
  for (const r of rects) {
    if (!Array.isArray(r) || r.length < 4) continue;
    const [x, y, w, h] = r;
    if (!(w > 0) || !(h > 0) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    list.push({ x, y, w, h });
  }
  if (list.length <= 1) return list.map((r) => [r.x, r.y, r.w, r.h]);

  list.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: R[][] = [];
  for (const r of list) {
    const row = lines[lines.length - 1];
    if (!row) {
      lines.push([r]);
      continue;
    }
    const ref = row[0]!;
    const midA = ref.y + ref.h / 2;
    const midB = r.y + r.h / 2;
    const sameLine = Math.abs(midA - midB) < Math.max(ref.h, r.h) * 0.55;
    if (sameLine) row.push(r);
    else lines.push([r]);
  }

  const out: number[][] = [];
  for (const row of lines) {
    let x0 = Infinity;
    let x1 = -Infinity;
    let ySum = 0;
    let hSum = 0;
    for (const r of row) {
      x0 = Math.min(x0, r.x);
      x1 = Math.max(x1, r.x + r.w);
      ySum += r.y;
      hSum += r.h;
    }
    const y = ySum / row.length;
    const h = hSum / row.length;
    // Tighten slightly so neighboring lines do not bleed into each other.
    const pad = Math.min(1.2, h * 0.1);
    out.push([x0, y + pad / 2, Math.max(0.5, x1 - x0), Math.max(0.5, h - pad)]);
  }

  out.sort((a, b) => a[1]! - b[1]!);
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1]!;
    const cur = out[i]!;
    const prevBottom = prev[1]! + prev[3]!;
    if (cur[1]! < prevBottom - 0.25) {
      const gap = 0.35;
      prev[3] = Math.max(0.5, cur[1]! - prev[1]! - gap);
      if (prev[3]! < 0.5) prev[3] = 0.5;
      cur[1] = prev[1]! + prev[3]! + gap;
    }
  }
  return out;
}

function colorWithAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

export interface PaperSidebarReaderProps {
  paperId: string;
  title?: string;
  t: (key: string, params?: Record<string, unknown>) => string;
}

export function PaperSidebarReader({ paperId, title, t }: PaperSidebarReaderProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const pagesHostRef = useRef<HTMLDivElement | null>(null);
  const pdfRef = useRef<PdfDoc | null>(null);
  const pageWrapRefs = useRef<Record<number, HTMLElement>>({});
  const pageNoRef = useRef(1);
  const pageInputRef = useRef<HTMLInputElement | null>(null);
  const estimatedH = useRef(900);
  const estimatedW = useRef(640);
  /** Ignore scroll鈫抪age sync while a programmatic jump is settling. */
  const scrollLockRef = useRef(0);

  const mem0 = loadViewMemory(paperId);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [err, setErr] = useState('');
  const [engineMissing, setEngineMissing] = useState(false);
  const [pages, setPages] = useState(0);
  const [pageNo, setPageNo] = useState(mem0.page ?? 1);
  const [visible, setVisible] = useState<Set<number>>(() => new Set([mem0.page ?? 1]));
  // Start at 0 so the first layout always fit-widths to the host.
  const [scale, setScale] = useState(0);
  const [renderScale, setRenderScale] = useState(0);
  const [pageDraft, setPageDraft] = useState(String(mem0.page ?? 1));
  const [highlights, setHighlights] = useState<PaperHighlight[]>([]);
  const [hlMsg, setHlMsg] = useState('');
  const [savingHl, setSavingHl] = useState(false);
  const [notesBusy, setNotesBusy] = useState(false);
  const [notesOpenTarget, setNotesOpenTarget] = useState<null | { workspaceId: string; name: string }>(null);
  const [hlColor, setHlColor] = useState<string>(HL_COLORS[0]);
  const [pendingComment, setPendingComment] = useState(false);
  const [commentDraft, setCommentDraft] = useState('');
  const pendingHlRef = useRef<{ text: string; rects: number[][]; page: number; color?: string } | null>(null);
  const [selBar, setSelBar] = useState<null | {
    text: string; rects: number[][]; page: number; left: number; top: number; below: boolean;
  }>(null);
  const [txBusy, setTxBusy] = useState(false);
  const [txPanel, setTxPanel] = useState<null | {
    text: string; translation: string; page: number; rects: number[][];
  }>(null);
  const [evidenceFilter, setEvidenceFilter] = useState<'all' | 'vocab'>('all');
  const [editingHlId, setEditingHlId] = useState<string | null>(null);
  const [editCommentDraft, setEditCommentDraft] = useState('');
  const [isFs, setIsFs] = useState(false);
  /** Skip auto-fit until the host has a real width (rightbar open animation). */
  const fittedForWidthRef = useRef(0);
  /** One-shot scroll align to remembered page after the stack is first built. */
  const alignedKeyRef = useRef('');
  const [shareBusy, setShareBusy] = useState(false);
  const [sharePanel, setSharePanel] = useState<null | {
    primaryUrl: string;
    urls: string[];
    qrSvg: string | null;
    lanBound: boolean;
    expiresAt: number;
    title: string;
  }>(null);
  const [shareMsg, setShareMsg] = useState('');
  /** PDF chrome (pager / zoom / actions / highlight) - hidden until opened. */
  const [chromeOpen, setChromeOpen] = useState(false);
  const [visualMode, setVisualMode] = useState<PdfVisualMode>(() => loadVisualMode());
  const visualTheme = PDF_VISUAL_THEMES[visualMode];
  type DrawerTab = 'outline' | 'search' | 'evidence' | null;
  const [drawer, setDrawer] = useState<DrawerTab>(null);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [searchQ, setSearchQ] = useState('');
  const [searchHits, setSearchHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [activeHlId, setActiveHlId] = useState<string | null>(null);
  const [citeMsg, setCiteMsg] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const pageHeightAt1Ref = useRef<Record<number, number>>({});

  const setVisualModePersist = useCallback((mode: PdfVisualMode) => {
    setVisualMode(mode);
    saveVisualMode(mode);
  }, []);

  const pdfUrl = `/scholar/papers/${encodeURIComponent(paperId)}/pdf`;

  const sendToTablet = useCallback(async () => {
    setShareBusy(true);
    setShareMsg('');
    try {
      // Prefer OS share sheet with the PDF file (Nearby Share / 寰俊 etc.).
      try {
        const res = await fetch(pdfUrl);
        if (res.ok) {
          const blob = await res.blob();
          const safe = `${(title || paperId).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)}.pdf`;
          const file = new File([blob], safe, { type: 'application/pdf' });
          const nav = navigator as Navigator & {
            canShare?: (data: ShareData) => boolean;
            share?: (data: ShareData) => Promise<void>;
          };
          if (nav.share && nav.canShare?.({ files: [file] })) {
            await nav.share({ files: [file], title: title || safe });
            setShareMsg(t('rightbar.sendShared'));
            return;
          }
        }
      } catch (err) {
        // User cancelled share sheet - stop; other failures fall through to QR link.
        if (err instanceof DOMException && err.name === 'AbortError') return;
      }

      const mint = await fetch(`/scholar/papers/${encodeURIComponent(paperId)}/tablet-share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const body = await mint.json() as {
        error?: string;
        primaryUrl?: string;
        urls?: string[];
        qrSvg?: string | null;
        lanBound?: boolean;
        expiresAt?: number;
        title?: string;
      };
      if (!mint.ok || !body.primaryUrl) {
        setShareMsg(body.error || t('rightbar.sendFail'));
        return;
      }
      setSharePanel({
        primaryUrl: body.primaryUrl,
        urls: Array.isArray(body.urls) ? body.urls : [body.primaryUrl],
        qrSvg: body.qrSvg ?? null,
        lanBound: Boolean(body.lanBound),
        expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : Date.now() + 7_200_000,
        title: body.title || title || paperId,
      });
      // No LAN bind: also kick a download so Nearby Share / 寰俊 can pick up the file.
      if (!body.lanBound) {
        try {
          const a = document.createElement('a');
          a.href = pdfUrl;
          a.download = `${(title || paperId).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)}.pdf`;
          a.rel = 'noopener';
          document.body.appendChild(a);
          a.click();
          a.remove();
        } catch { /* ignore */ }
      }
      try {
        await navigator.clipboard.writeText(body.primaryUrl);
        setShareMsg(body.lanBound ? t('rightbar.sendCopied') : t('rightbar.sendDownloaded'));
      } catch {
        setShareMsg(body.lanBound ? t('rightbar.sendReady') : t('rightbar.sendDownloaded'));
      }
    } catch (err) {
      setShareMsg(err instanceof Error ? err.message : t('rightbar.sendFail'));
    } finally {
      setShareBusy(false);
    }
  }, [paperId, pdfUrl, t, title]);

  // Debounce scale → renderScale (~80ms). scale=0 means not yet fit-width; skip paint.
  useEffect(() => {
    if (!(scale > 0)) return;
    const id = window.setTimeout(() => setRenderScale(scale), SCALE_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [scale]);

  // Per-paper memory: save debounced (only after fit-width has set a real scale)
  useEffect(() => {
    if (!(scale > 0)) return;
    const id = window.setTimeout(() => {
      try {
        localStorage.setItem(VIEW_KEY(paperId), JSON.stringify({ page: pageNo, scale }));
      } catch { /* ignore */ }
    }, VIEW_SAVE_MS);
    return () => clearTimeout(id);
  }, [paperId, pageNo, scale]);

  useEffect(() => {
    setPageDraft(String(pageNo));
  }, [pageNo]);

  // Ephemeral status line - don't leave caption text eating PDF height
  useEffect(() => {
    if (!hlMsg) return;
    const id = window.setTimeout(() => setHlMsg(''), 2400);
    return () => clearTimeout(id);
  }, [hlMsg]);

  useEffect(() => {
    if (!citeMsg) return;
    const id = window.setTimeout(() => setCiteMsg(''), 3200);
    return () => clearTimeout(id);
  }, [citeMsg]);

  useEffect(() => {
    pageNoRef.current = pageNo;
  }, [pageNo]);

  // Reset when paper changes: keep page memory, hand scale to auto fit-width
  useEffect(() => {
    const m = loadViewMemory(paperId);
    const start = m.page ?? 1;
    setPageNo(start);
    pageNoRef.current = start;
    setVisible(new Set([start]));
    setScale(0);
    setRenderScale(0);
    setPageDraft(String(start));
    fittedForWidthRef.current = 0;
    alignedKeyRef.current = '';
    setHlMsg('');
    setCiteMsg('');
    setChromeOpen(false);
    setSharePanel(null);
    setShareMsg('');
    setPendingComment(false);
    pendingHlRef.current = null;
    pageWrapRefs.current = {};
    if (pagesHostRef.current) pagesHostRef.current.replaceChildren();
  }, [paperId]);

  const clampPage = useCallback((n: number) => {
    const max = pdfRef.current?.numPages ?? (pages > 0 ? pages : 1);
    return Math.min(max, Math.max(1, Math.floor(n)));
  }, [pages]);

  const goPage = useCallback((n: number, behavior: ScrollBehavior = 'smooth') => {
    const target = clampPage(n);
    setPageNo(target);
    pageNoRef.current = target;
    setPageDraft(String(target));
    setVisible((prev) => {
      const next = new Set(prev);
      for (let i = target - NEAR; i <= target + NEAR; i += 1) {
        if (i >= 1 && i <= (pages || 1)) next.add(i);
      }
      return next;
    });
    scrollLockRef.current = Date.now() + 450;
    requestAnimationFrame(() => {
      const el = pageWrapRefs.current[target];
      const root = hostRef.current;
      if (el && root) {
        root.scrollTo({ top: Math.max(0, el.offsetTop - 8), behavior });
      }
    });
  }, [clampPage, pages]);

  // 杩介棶椤电爜鑺墖 / 澶栭儴璺抽〉
  useEffect(() => {
    const onGoto = (ev: Event) => {
      const detail = (ev as CustomEvent<{ paperId?: string; page?: number }>).detail;
      if (!detail || detail.paperId !== paperId) return;
      const page = Number(detail.page);
      if (!Number.isFinite(page) || page < 1) return;
      if ((pdfRef.current?.numPages ?? 0) < 1) return;
      try { sessionStorage.removeItem(`sch-pending-page:${paperId}`); } catch { /* ignore */ }
      goPage(page, 'auto');
    };
    window.addEventListener('scholar:goto-page', onGoto);
    return () => window.removeEventListener('scholar:goto-page', onGoto);
  }, [paperId, goPage]);

  useEffect(() => {
    if (status !== 'ready' || pages < 1) return;
    let raw = '';
    try { raw = sessionStorage.getItem(`sch-pending-page:${paperId}`) ?? ''; } catch { return; }
    if (!raw) return;
    try { sessionStorage.removeItem(`sch-pending-page:${paperId}`); } catch { /* ignore */ }
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) goPage(n, 'auto');
  }, [status, pages, paperId, goPage]);

  useEffect(() => {
    const onFs = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const loadHighlights = useCallback(async () => {
    try {
      const res = await fetch(`/scholar/papers/${encodeURIComponent(paperId)}/annotations`);
      if (!res.ok) return;
      const file = (await res.json()) as PaperAnnotationFile;
      setHighlights(Array.isArray(file.highlights) ? file.highlights : []);
    } catch { /* ignore */ }
  }, [paperId]);

  useEffect(() => {
    void loadHighlights();
  }, [loadHighlights]);

  useEffect(() => {
    let alive = true;
    let doc: PdfDoc | undefined;
    setStatus('loading');
    setErr('');
    setEngineMissing(false);
    setPages(0);
    pageWrapRefs.current = {};
    if (pagesHostRef.current) pagesHostRef.current.replaceChildren();
    ;(async () => {
      try {
        let pdfjs: PdfJs;
        try {
          pdfjs = await loadPdfJs();
        } catch {
          if (alive) {
            setEngineMissing(true);
            setErr(t('rightbar.pdfEngineMissing'));
            setStatus('error');
          }
          return;
        }
        const res = await fetch(pdfUrl);
        if (!res.ok) throw new Error(t('rightbar.pdfMissing'));
        const buf = await res.arrayBuffer();
        if (!alive) return;
        doc = await pdfjs.getDocument({
          data: new Uint8Array(buf),
          cMapUrl: `${PDFJS_BASE}/cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
        }).promise;
        if (!alive) { doc.destroy(); return; }
        pdfRef.current = doc;
        setPages(doc.numPages);
        setOutline([]);
        setSearchHits(null);
        setSearchQ('');
        setDrawer(null);
        pageHeightAt1Ref.current = {};
        setPageNo((p) => {
          const next = Math.min(doc!.numPages, Math.max(1, p));
          pageNoRef.current = next;
          const near = new Set<number>();
          for (let i = next - NEAR; i <= next + NEAR; i += 1) {
            if (i >= 1 && i <= doc!.numPages) near.add(i);
          }
          setVisible(near);
          return next;
        });
        setStatus('ready');
        void buildOutline(doc).then((items) => {
          if (alive) setOutline(items);
        });
      } catch (e) {
        if (alive) {
          setErr(String(e instanceof Error ? e.message : e));
          setStatus('error');
        }
      }
    })();
    return () => {
      alive = false;
      pageWrapRefs.current = {};
      if (pagesHostRef.current) pagesHostRef.current.replaceChildren();
      if (doc) {
        try { doc.destroy(); } catch { /* ignore */ }
      }
      pdfRef.current = null;
    };
  }, [paperId, t, pdfUrl]);

  const paintOverlays = useCallback((wrap: HTMLElement, page: number, s: number) => {
    wrap.querySelectorAll('[data-sch-hl]').forEach((n) => n.remove());
    const layer = document.createElement('div');
    layer.dataset.schHl = '1';
    layer.style.position = 'absolute';
    layer.style.inset = '0';
    layer.style.pointerEvents = 'none';
    layer.style.zIndex = '2';
    const pageH1 = pageHeightAt1Ref.current[page]
      ?? (s > 0 ? wrap.getBoundingClientRect().height / s : 0);
    for (const h of highlights) {
      if (h.page !== page || !h.rects?.length) continue;
      const color = h.color || '#ffd400';
      const boxes = mergeHighlightRects(resolveHighlightRects({
        rects: h.rects,
        coordSpace: h.coordSpace,
        pageHeightAtScale1: pageH1,
        preferPdf: Boolean(h.zoteroKey) && !h.coordSpace,
      }));
      const alpha = h.id === activeHlId ? 0.48 : 0.32;
      const fill = colorWithAlpha(color, alpha);
      for (const r of boxes) {
        if (!Array.isArray(r) || r.length < 4) continue;
        const [x, y, w, ht] = r;
        const box = document.createElement('div');
        box.dataset.schHlId = h.id;
        box.style.position = 'absolute';
        box.style.left = `${x * s}px`;
        box.style.top = `${y * s}px`;
        box.style.width = `${w * s}px`;
        box.style.height = `${ht * s}px`;
        box.style.background = fill;
        box.style.opacity = '1';
        box.style.mixBlendMode = 'normal';
        box.style.outline = h.id === activeHlId
          ? '2px solid var(--dsw-alias-state-info-primary, #3b82f6)'
          : 'none';
        box.style.transition = 'background .15s ease, outline .15s ease';
        layer.appendChild(box);
      }
    }
    wrap.appendChild(layer);
  }, [highlights, activeHlId]);

  useEffect(() => {
    const root = hostRef.current;
    if (!root || status !== 'ready') return;
    let raf: number | null = null;
    const apply = () => {
      raf = null;
      if (Date.now() < scrollLockRef.current) return;
      const mid = root.scrollTop + root.clientHeight * 0.35;
      let best = 1;
      let bestDist = Infinity;
      for (const [k, el] of Object.entries(pageWrapRefs.current)) {
        const dist = Math.abs(el.offsetTop - mid);
        if (dist < bestDist) {
          bestDist = dist;
          best = Number(k);
        }
      }
      if (!Number.isFinite(best) || best < 1) return;
      setPageNo((n) => (n === best ? n : best));
      pageNoRef.current = best;
      setPageDraft(String(best));
      setVisible((prev) => {
        const near = new Set<number>();
        for (let i = best - NEAR; i <= best + NEAR; i += 1) {
          if (i >= 1 && i <= pages) near.add(i);
        }
        if (near.size !== prev.size) return near;
        for (const n of near) {
          if (!prev.has(n)) return near;
        }
        return prev;
      });
    };
    const onScroll = () => {
      if (raf != null) return;
      raf = requestAnimationFrame(apply);
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    apply();
    return () => {
      root.removeEventListener('scroll', onScroll);
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, [status, pages, renderScale]);

  useEffect(() => {
    const doc = pdfRef.current;
    const stack = pagesHostRef.current;
    if (status !== 'ready' || !doc || !stack || !(renderScale > 0) || pages <= 0) return;
    let cancelled = false;

    ;(async () => {
      const pdfjs = await loadPdfJs();
      if (cancelled) return;

      for (let i = 1; i <= pages; i += 1) {
        let wrap = pageWrapRefs.current[i];
        if (!wrap) {
          wrap = document.createElement('div');
          wrap.dataset.schPage = String(i);
          wrap.className = 'sch-pdf-page sch-pdf-placeholder';
          wrap.style.position = 'relative';
          wrap.style.width = `${estimatedW.current}px`;
          wrap.style.height = `${estimatedH.current}px`;
          wrap.style.minHeight = `${estimatedH.current}px`;
          wrap.style.margin = `0 auto ${PAGE_GAP_PX}px`;
          wrap.style.maxWidth = '100%';
          wrap.style.boxShadow = '0 1px 4px rgba(0,0,0,.12)';
          wrap.style.background = '';
          stack.appendChild(wrap);
          pageWrapRefs.current[i] = wrap;
        } else if (wrap.parentElement !== stack) {
          stack.appendChild(wrap);
        }
      }

      for (const pno of Array.from(visible).sort((a, b) => a - b)) {
        if (cancelled) return;
        const wrap = pageWrapRefs.current[pno];
        if (!wrap) continue;
        const stamp = `${pno}@${renderScale.toFixed(2)}`;
        if (wrap.dataset.rendered === stamp) {
          paintOverlays(wrap, pno, renderScale);
          continue;
        }
        try {
          const page = await doc.getPage(pno);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: renderScale });
          const ratio = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
          estimatedH.current = Math.floor(viewport.height);
          estimatedW.current = Math.floor(viewport.width);
          pageHeightAt1Ref.current[pno] = renderScale > 0
            ? viewport.height / renderScale
            : viewport.height;

          wrap.replaceChildren();
          wrap.style.width = `${Math.floor(viewport.width)}px`;
          wrap.style.height = `${Math.floor(viewport.height)}px`;
          wrap.style.minHeight = `${Math.floor(viewport.height)}px`;
          wrap.className = 'sch-pdf-page';

          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width * ratio);
          canvas.height = Math.floor(viewport.height * ratio);
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          canvas.style.height = `${Math.floor(viewport.height)}px`;
          canvas.style.imageRendering = Number.isInteger(renderScale) ? 'crisp-edges' : 'auto';
          wrap.appendChild(canvas);

          const tl = document.createElement('div');
          tl.style.position = 'absolute';
          tl.style.inset = '0';
          tl.style.overflow = 'clip';
          tl.style.lineHeight = '1';
          tl.style.setProperty('--scale-factor', String(viewport.scale));
          tl.className = 'textLayer';
          tl.style.zIndex = '1';
          tl.style.setProperty('-webkit-text-size-adjust', 'none');
          tl.style.setProperty('text-size-adjust', 'none');
          wrap.appendChild(tl);

          const ctx2d = canvas.getContext('2d', { alpha: false });
          if (!ctx2d) continue;
          ctx2d.setTransform(ratio, 0, 0, ratio, 0, 0);
          ctx2d.imageSmoothingEnabled = true;
          ctx2d.imageSmoothingQuality = 'high';
          await page.render({ canvasContext: ctx2d, viewport }).promise;
          if (cancelled) return;

          const tc = await page.getTextContent();
          if (cancelled) return;
          if (typeof pdfjs.TextLayer === 'function') {
            const layer = new pdfjs.TextLayer({ textContentSource: tc, container: tl, viewport });
            await layer.render();
          } else if (typeof pdfjs.renderTextLayer === 'function') {
            await pdfjs.renderTextLayer({ textContent: tc, container: tl, viewport, textDivs: [] }).promise;
          }
          // Selection guard: without endOfContent, empty-space drags select whole columns.
          if (!tl.querySelector('.endOfContent')) {
            const end = document.createElement('div');
            end.className = 'endOfContent';
            tl.appendChild(end);
          }
          if (cancelled) return;

          wrap.dataset.rendered = stamp;
          paintOverlays(wrap, pno, renderScale);
        } catch (e) {
          if (!cancelled) setErr(String(e instanceof Error ? e.message : e));
        }
      }

      for (const [k, wrap] of Object.entries(pageWrapRefs.current)) {
        const n = Number(k);
        if (visible.has(n)) continue;
        if (Math.abs(n - pageNoRef.current) <= KEEP) continue;
        if (wrap.dataset.rendered) {
          wrap.replaceChildren();
          delete wrap.dataset.rendered;
          wrap.style.width = `${estimatedW.current}px`;
          wrap.style.height = `${estimatedH.current}px`;
          wrap.style.minHeight = `${estimatedH.current}px`;
          wrap.className = 'sch-pdf-page sch-pdf-placeholder';
        }
      }
    })();

    return () => { cancelled = true; };
  }, [status, pages, visible, renderScale, paintOverlays]);

  // Re-paint overlays when highlights change for visible pages
  useEffect(() => {
    if (status !== 'ready' || !(renderScale > 0)) return;
    for (const pno of visible) {
      const wrap = pageWrapRefs.current[pno];
      if (wrap?.dataset.rendered) paintOverlays(wrap, pno, renderScale);
    }
  }, [highlights, visible, renderScale, status, paintOverlays]);

  const commitPageDraft = () => {
    const n = Number(pageDraft);
    if (!Number.isFinite(n)) {
      setPageDraft(String(pageNo));
      return;
    }
    goPage(clampPage(n));
  };

  const fitWidth = useCallback(() => {
    const host = hostRef.current;
    const doc = pdfRef.current;
    if (!host || !doc) return;
    const avail = Math.max(120, host.clientWidth - 16);
    if (avail < 80) return;
    const probe = Math.min(Math.max(1, pageNoRef.current), doc.numPages || 1);
    void doc.getPage(probe).then((page) => {
      const base = page.getViewport({ scale: 1 });
      if (!(base.width > 0)) return;
      // Cap high enough for wide rightbars; floor keeps text readable.
      const next = Math.min(4, Math.max(0.5, +(avail / base.width).toFixed(3)));
      fittedForWidthRef.current = avail;
      setScale(next);
    });
  }, []);

  // After the continuous stack is first laid out, jump to the remembered page.
  useEffect(() => {
    if (status !== 'ready' || !(renderScale > 0) || pages <= 0) return;
    const key = `${paperId}:${pages}`;
    if (alignedKeyRef.current === key) return;
    const target = pageNoRef.current;
    const id = requestAnimationFrame(() => {
      const el = pageWrapRefs.current[target];
      const root = hostRef.current;
      if (!el || !root) return;
      alignedKeyRef.current = key;
      scrollLockRef.current = Date.now() + 300;
      root.scrollTop = Math.max(0, el.offsetTop - 8);
    });
    return () => cancelAnimationFrame(id);
  }, [status, pages, paperId, renderScale]);

  // After open / sidebar widen: auto fit-width (do not re-run on page change).
  useEffect(() => {
    if (status !== 'ready') return;
    const host = hostRef.current;
    if (!host) return;
    const run = () => {
      const w = host.clientWidth;
      if (w < 80) return;
      if (Math.abs(w - fittedForWidthRef.current) < 24 && scale > 0) return;
      fitWidth();
    };
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(run);
    });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => run()) : null;
    ro?.observe(host);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [status, fitWidth, scale]);

  const toggleFullscreen = async () => {
    const el = rootRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await el.requestFullscreen();
    } catch { /* ignore */ }
  };

  const postHighlight = async (text: string, rects: number[][], page: number, color: string, comment?: string) => {
    setSavingHl(true);
    setHlMsg('');
    try {
      const res = await fetch(`/scholar/papers/${encodeURIComponent(paperId)}/annotations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text, page, color, rects: rects.length ? rects : undefined,
          comment: comment || undefined, coordSpace: 'viewport',
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const body = await res.json() as { file?: PaperAnnotationFile };
      if (body.file?.highlights) setHighlights(body.file.highlights);
      else await loadHighlights();
      setHlMsg(t('rightbar.highlightAdded'));
      window.getSelection()?.removeAllRanges();
      setSelBar(null);
      const wrap = pageWrapRefs.current[page];
      if (wrap && renderScale > 0) paintOverlays(wrap, page, renderScale);
    } catch (e) {
      setHlMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingHl(false);
    }
  };

  const captureSelection = useCallback((): {
    text: string; rects: number[][]; page: number; left: number; top: number; below: boolean;
  } | null => {
    const host = hostRef.current;
    const root = rootRef.current;
    if (!host || !root) return null;
    refineWordSelection(host);
    const sel = window.getSelection();
    const text = sel?.toString().replace(/\s+/g, ' ').trim() ?? '';
    if (!text || !sel || sel.rangeCount === 0) return null;
    const node = sel.anchorNode ?? null;
    const el = node instanceof Element ? node : node?.parentElement ?? null;
    if (!el || !host.contains(el)) return null;
    const wrap = el.closest('[data-sch-page]') as HTMLElement | null;
    const page = wrap ? Number(wrap.dataset.schPage) : pageNoRef.current;
    const rects = wrap ? selectionRectsAtScale1(wrap, renderScale) : [];
    const range = sel.getRangeAt(0);
    const box = range.getBoundingClientRect();
    const rootBox = root.getBoundingClientRect();
    const relTop = box.top - rootBox.top;
    const below = relTop < 56;
    const left = Math.min(rootBox.width - 24, Math.max(24, box.left - rootBox.left + box.width / 2));
    const top = below ? box.bottom - rootBox.top + 8 : relTop - 6;
    return {
      text,
      rects,
      page: Number.isFinite(page) && page >= 1 ? page : pageNoRef.current,
      left,
      top,
      below,
    };
  }, [renderScale]);

  const onHostMouseUp = useCallback(() => {
    // Defer one tick so the browser finishes the selection range.
    window.setTimeout(() => {
      const cap = captureSelection();
      if (!cap) {
        setSelBar(null);
        return;
      }
      setSelBar(cap);
    }, 0);
  }, [captureSelection]);

  const addHighlightFromSelection = async (opts?: { withNote?: boolean; color?: string }) => {
    const cap = selBar ?? captureSelection();
    if (!cap) {
      setHlMsg(t('rightbar.highlightEmpty'));
      return;
    }
    const color = opts?.color ?? hlColor;
    if (opts?.withNote) {
      pendingHlRef.current = { text: cap.text, rects: cap.rects, page: cap.page, color };
      setCommentDraft('');
      setPendingComment(true);
      setSelBar(null);
      return;
    }
    await postHighlight(cap.text, cap.rects, cap.page, color);
  };

  const confirmHighlight = async (withComment: boolean) => {
    const pending = pendingHlRef.current;
    if (!pending) {
      setPendingComment(false);
      return;
    }
    const comment = withComment ? commentDraft.trim() : '';
    pendingHlRef.current = null;
    setPendingComment(false);
    await postHighlight(pending.text, pending.rects, pending.page, pending.color ?? hlColor, comment || undefined);
  };

  const translateSelection = async (saveAsVocab: boolean) => {
    const cap = selBar ?? captureSelection();
    if (!cap) {
      setHlMsg(t('rightbar.highlightEmpty'));
      return;
    }
    setTxBusy(true);
    setHlMsg('');
    try {
      const res = await fetch('/scholar/translate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: cap.text, domain: 'academic' }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(errText || `HTTP ${res.status}`);
      }
      const body = await res.json() as { translation?: string };
      const translation = (body.translation ?? '').trim();
      if (!translation) throw new Error(t('rightbar.translateEmpty'));
      setTxPanel({ text: cap.text, translation, page: cap.page, rects: cap.rects });
      const isWord = cap.text.split(/\s+/).length <= 3 && cap.text.length <= 48;
      if (isWord || saveAsVocab) setEvidenceFilter('vocab');
      // Auto-save short word picks; longer phrases wait for explicit「存为生词」
      if (isWord) {
        await postHighlight(cap.text, cap.rects, cap.page, VOCAB_COLOR, translation);
        setHlMsg(t('rightbar.vocabSaved'));
      }
      setSelBar(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setHlMsg(t('rightbar.translateFail', { msg: msg.slice(0, 120) }));
    } finally {
      setTxBusy(false);
    }
  };

  const saveTxAsVocab = async () => {
    if (!txPanel) return;
    await postHighlight(txPanel.text, txPanel.rects, txPanel.page, VOCAB_COLOR, txPanel.translation);
    setEvidenceFilter('vocab');
    setHlMsg(t('rightbar.vocabSaved'));
  };

  const removeHighlight = async (id: string) => {
    const next = highlights.filter((h) => h.id !== id);
    setHighlights(next);
    try {
      await fetch(`/scholar/papers/${encodeURIComponent(paperId)}/annotations`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ highlights: next }),
      });
    } catch {
      await loadHighlights();
    }
  };

  const saveHighlightComment = async (id: string, comment: string) => {
    const next = highlights.map((h) => (
      h.id === id ? { ...h, comment: comment.trim() || undefined, updatedAt: Date.now() } : h
    ));
    setHighlights(next);
    setEditingHlId(null);
    try {
      await fetch(`/scholar/papers/${encodeURIComponent(paperId)}/annotations`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ highlights: next }),
      });
      setHlMsg(t('rightbar.noteSaved'));
    } catch {
      await loadHighlights();
    }
  };

  const copySelection = async () => {
    const text = selBar?.text || window.getSelection()?.toString().trim() || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setHlMsg(t('rightbar.copied'));
      setSelBar(null);
    } catch {
      setHlMsg(t('rightbar.copyFail'));
    }
  };

  const runSearch = useCallback(async () => {
    const q = searchQ.trim();
    const doc = pdfRef.current;
    if (!q || !doc) {
      setSearchHits(null);
      return;
    }
    setSearching(true);
    setDrawer('search');
    try {
      setSearchHits(await searchDocument(doc, q, 80));
    } finally {
      setSearching(false);
    }
  }, [searchQ]);

  const jumpToEvidence = useCallback((h: PaperHighlight) => {
    setActiveHlId(h.id);
    setDrawer('evidence');
    goPage(h.page, 'smooth');
    window.setTimeout(() => setActiveHlId((cur) => (cur === h.id ? null : cur)), 2400);
  }, [goPage]);

  const exportEvidenceMd = useCallback(() => {
    if (!highlights.length) return;
    const lines = [
      `# Evidence - ${title || paperId}`,
      '',
      ...highlights
        .slice()
        .sort((a, b) => a.page - b.page || a.createdAt - b.createdAt)
        .map((h) => {
          const note = h.comment ? `\n> note: ${h.comment}` : '';
          return `## p.${h.page}\n\n> ${h.text.replace(/\n/g, ' ')}${note}\n`;
        }),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${paperId}-evidence.md`;
    a.click();
    URL.revokeObjectURL(a.href);
    setHlMsg(t('rightbar.evidenceExported'));
  }, [highlights, paperId, title, t]);

  const paperLabel = title?.trim() || paperId;

  const finishNotesWrite = useCallback(async (
    heading: string,
    markdown: string,
  ) => {
    setNotesBusy(true);
    setNotesOpenTarget(null);
    setHlMsg('');
    try {
      const res = await appendToPaperNote({
        paperId,
        paperTitle: paperLabel,
        heading,
        markdown,
      });
      if (!res.ok) {
        setHlMsg(res.code === 'no-workspace'
          ? t('notes.writeNoWorkspace')
          : t('notes.writeFail', { detail: res.error || res.code }));
        return;
      }
      setHlMsg(t('notes.writeOk', { name: res.name }));
      if (res.workspaceId) setNotesOpenTarget({ workspaceId: res.workspaceId, name: res.name });
    } catch (e) {
      setHlMsg(t('notes.writeFail', { detail: e instanceof Error ? e.message : String(e) }));
    } finally {
      setNotesBusy(false);
    }
  }, [paperId, paperLabel, t]);

  const writeSelectionToNotes = useCallback(() => {
    const text = selBar?.text || window.getSelection()?.toString().trim() || '';
    if (!text) return;
    const page = selBar?.page;
    void finishNotesWrite(
      t('notes.write'),
      formatSelectionMarkdown(paperId, paperLabel, text, page),
    );
  }, [selBar, finishNotesWrite, paperId, paperLabel, t]);

  const writeHighlightToNotes = useCallback((h: PaperHighlight) => {
    void finishNotesWrite(
      `p.${h.page}`,
      formatHighlightMarkdown(paperId, paperLabel, h),
    );
  }, [finishNotesWrite, paperId, paperLabel]);

  const writeAllEvidenceToNotes = useCallback(() => {
    if (!highlights.length) return;
    const body = highlights
      .slice()
      .sort((a, b) => a.page - b.page || a.createdAt - b.createdAt)
      .map((h) => formatHighlightMarkdown(paperId, paperLabel, h))
      .join('\n');
    void finishNotesWrite(t('notes.writeAllEvidence'), body);
  }, [highlights, finishNotesWrite, paperId, paperLabel, t]);

  const onCitationClick = useCallback(async (e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target?.closest?.('.textLayer')) return;
    const span = target.closest('span');
    const nearby = [
      span?.textContent ?? '',
      span?.previousElementSibling?.textContent ?? '',
      span?.nextElementSibling?.textContent ?? '',
    ].join('');
    const n = extractCitationIndex(nearby);
    if (n == null) return;
    const doc = pdfRef.current;
    if (!doc) return;
    e.preventDefault();
    setCiteMsg(t('rightbar.citeJumping', { n }));
    try {
      const refs = findReferencesPage(outline);
      const page = await findCitationTargetPage(doc, n, refs);
      if (page == null) {
        setCiteMsg(t('rightbar.citeMiss', { n }));
        return;
      }
      goPage(page, 'smooth');
      setCiteMsg(t('rightbar.citeJumped', { n, page }));
    } catch (err) {
      setCiteMsg(err instanceof Error ? err.message : String(err));
    }
  }, [outline, goPage, t]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      if (e.key === 'Escape') {
        e.preventDefault();
        (e.target as HTMLElement).blur();
        setDrawer(null);
      }
      return;
    }
    const key = e.key;
    if (key === 'ArrowLeft' || key === 'PageUp') {
      e.preventDefault();
      goPage(pageNo - 1);
    } else if (key === 'ArrowRight' || key === 'PageDown') {
      e.preventDefault();
      goPage(pageNo + 1);
    } else if (key === '+' || key === '=') {
      e.preventDefault();
      setScale((s) => Math.min(2.4, +(s + 0.15).toFixed(2)));
    } else if (key === '-' || key === '_') {
      e.preventDefault();
      setScale((s) => Math.max(0.7, +(s - 0.15).toFixed(2)));
    } else if (key === 'f' || key === 'F') {
      e.preventDefault();
      fitWidth();
    } else if (key === 'v' || key === 'V') {
      e.preventDefault();
      const idx = PDF_VISUAL_MODES.indexOf(visualMode);
      const next = PDF_VISUAL_MODES[(idx + 1) % PDF_VISUAL_MODES.length]!;
      setVisualModePersist(next);
    } else if (key === '/' || key === 's' || key === 'S') {
      e.preventDefault();
      setDrawer((d) => {
        if (d === 'search') return null;
        requestAnimationFrame(() => searchInputRef.current?.focus());
        return 'search';
      });
    } else if (key === 'o' || key === 'O') {
      e.preventDefault();
      setDrawer((d) => (d === 'outline' ? null : 'outline'));
    } else if (key === 'e' || key === 'E') {
      e.preventDefault();
      setDrawer((d) => (d === 'evidence' ? null : 'evidence'));
    } else if (key === 'h' || key === 'H') {
      e.preventDefault();
      void addHighlightFromSelection();
    } else if (key === 'n' || key === 'N') {
      e.preventDefault();
      void addHighlightFromSelection({ withNote: true });
    } else if (key === 't' || key === 'T') {
      e.preventDefault();
      void translateSelection(true);
    } else if (key === 'Escape' && (selBar || txPanel || pendingComment)) {
      e.preventDefault();
      setSelBar(null);
      setTxPanel(null);
      setPendingComment(false);
      pendingHlRef.current = null;
    } else if (key === 'Escape' && document.fullscreenElement) {
      e.preventDefault();
      void document.exitFullscreen();
    } else if (key === 'Escape' && drawer) {
      e.preventDefault();
      setDrawer(null);
    }
  };

  // Wheel over the reader must not chain-scroll the main DSH page. Ctrl/Meta =
  // zoom; otherwise continuous-scroll the page stack (no hard page flip).
  useEffect(() => {
    const root = rootRef.current;
    const host = hostRef.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      const drawerEl = root.querySelector('[data-sch-reader-drawer]');
      if (drawerEl && e.target instanceof Node && drawerEl.contains(e.target)) {
        const scroller = drawerEl.querySelector('[data-sch-reader-drawer-body]');
        if (scroller instanceof HTMLElement) {
          const dy = e.deltaY;
          const atTop = scroller.scrollTop <= 0 && dy < 0;
          const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1 && dy > 0;
          if (!atTop && !atBottom) scroller.scrollTop += dy;
        }
        e.preventDefault();
        return;
      }
      if (status !== 'ready' || pages <= 0) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const dir = e.deltaY > 0 ? -1 : 1;
        setScale((s) => {
          const base = s > 0 ? s : 1;
          return Math.min(4, Math.max(0.5, +(base + dir * 0.1).toFixed(2)));
        });
        return;
      }
      if (host) host.scrollTop += e.deltaY;
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, [status, pages]);

  const btn: React.CSSProperties = {
    fontSize: 11, padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
  };

  const visualSelect = (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>
      <span style={{ whiteSpace: 'nowrap' }}>{t('rightbar.visualMode')}</span>
      <select
        aria-label={t('rightbar.visualMode')}
        value={visualMode}
        onChange={(e) => setVisualModePersist(e.target.value as PdfVisualMode)}
        style={{
          fontSize: 11, padding: '2px 6px', borderRadius: 6, maxWidth: 120,
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-primary)',
        }}
      >
        {PDF_VISUAL_MODES.map((mode) => (
          <option key={mode} value={mode}>{t(`rightbar.visual.${mode}`)}</option>
        ))}
      </select>
    </label>
  );

  if (status === 'error') {
    return (
      <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-danger-primary)', padding: '8px 2px', lineHeight: 1.55 }}>
        {engineMissing ? t('rightbar.pdfEngineMissing') : (err || t('rightbar.pdfMissing'))}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{
        display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, gap: 6,
        position: 'relative', outline: 'none',
        overscrollBehavior: 'contain',
        background: isFs ? 'var(--dsw-alias-bg-layer-1, #111)' : undefined,
        padding: isFs ? 12 : undefined,
      }}
    >
      {/* Pager stays up. Outline / search / evidence toggle the overlay; 工具 opens annotate actions. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, flexWrap: 'wrap' }}>
        <button type="button" style={btn} disabled={pageNo <= 1} onClick={() => goPage(pageNo - 1)} aria-label="prev">‹</button>
        <input
          ref={pageInputRef}
          type="text"
          inputMode="numeric"
          aria-label={t('rightbar.pageInput')}
          value={pageDraft}
          onChange={(e) => setPageDraft(e.target.value.replace(/[^\d]/g, ''))}
          onBlur={commitPageDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitPageDraft();
              (e.target as HTMLInputElement).blur();
            }
          }}
          style={{
            width: 36, fontSize: 11, textAlign: 'center', padding: '2px 4px', borderRadius: 6,
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-primary)',
            fontVariantNumeric: 'tabular-nums',
          }}
        />
        <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)', fontVariantNumeric: 'tabular-nums' }}>
          / {status === 'loading' ? '…' : (pages || '—')}
        </span>
        <button type="button" style={btn} disabled={pageNo >= pages} onClick={() => goPage(pageNo + 1)} aria-label="next">›</button>
        <button type="button" style={btn} onClick={() => setScale((s) => Math.max(0.7, +(s - 0.15).toFixed(2)))} aria-label="zoom-out">-</button>
        <button type="button" style={btn} onClick={() => setScale((s) => Math.min(2.4, +(s + 0.15).toFixed(2)))} aria-label="zoom-in">+</button>
        <button type="button" style={btn} onClick={() => fitWidth()} title={t('rightbar.fitWidth')}>{t('rightbar.fitWidth')}</button>
        <span style={{ flex: 1, minWidth: 4 }} />
        <button
          type="button"
          aria-pressed={chromeOpen}
          style={{ ...btn, ...(chromeOpen ? { background: 'var(--dsw-alias-bg-layer-2)' } : {}) }}
          onClick={() => setChromeOpen((open) => !open)}
          title={chromeOpen ? t('rightbar.chromeHide') : t('rightbar.chromeShow')}
        >
          {t('rightbar.chromeShow')}
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        {([
          ['outline', 'O'],
          ['search', '/'],
          ['evidence', 'E'],
        ] as const).map(([tab, shortcut]) => (
          <button
            key={tab}
            type="button"
            aria-pressed={drawer === tab}
            style={{
              ...btn, flex: 1, padding: '3px 4px',
              background: drawer === tab ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-1)',
            }}
            title={`${t(`rightbar.${tab}`)} (${shortcut})`}
            onClick={() => {
              if (tab === 'search') {
                const opening = drawer !== 'search';
                setDrawer(opening ? 'search' : null);
                if (opening) requestAnimationFrame(() => searchInputRef.current?.focus());
                return;
              }
              setDrawer((d) => (d === tab ? null : tab));
            }}
          >
            {t(`rightbar.${tab}`)}
            {tab === 'evidence' && highlights.length ? ` (${highlights.length})` : ''}
          </button>
        ))}
        {drawer && (
          <button
            type="button"
            style={btn}
            onClick={() => setDrawer(null)}
            title={t('rightbar.chromeHide')}
          >
            {t('rightbar.chromeHide')}
          </button>
        )}
      </div>
      {chromeOpen && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
          {visualSelect}
          <a href={pdfUrl} download={`${paperId}.pdf`} style={{ ...btn, textDecoration: 'none', display: 'inline-flex' }} title={t('rightbar.download')}>
            {t('rightbar.download')}
          </a>
          <a href={pdfUrl} target="_blank" rel="noreferrer noopener" style={{ ...btn, textDecoration: 'none', display: 'inline-flex' }} title={t('rightbar.openExternal')}>
            {t('rightbar.openExternal')}
          </a>
          <button
            type="button"
            style={btn}
            disabled={shareBusy || status === 'loading'}
            onClick={() => void sendToTablet()}
            title={t('rightbar.sendTabletHint')}
          >
            {shareBusy ? '…' : t('rightbar.sendTablet')}
          </button>
          <button type="button" style={btn} onClick={() => void toggleFullscreen()} title={t('rightbar.fullscreen')}>
            {t('rightbar.fullscreen')}
          </button>
          <span style={{ fontSize: 10.5, color: 'var(--dsw-alias-label-caption)' }}>{t('rightbar.hlColor')}</span>
          {HL_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              onClick={() => setHlColor(c)}
              style={{
                width: 16, height: 16, borderRadius: 4, cursor: 'pointer', padding: 0,
                border: hlColor === c ? '2px solid var(--dsw-alias-label-primary)' : '1px solid var(--dsw-alias-border-l1)',
                background: c,
              }}
            />
          ))}
          <button
            type="button"
            style={btn}
            disabled={savingHl || status !== 'ready'}
            onClick={() => void addHighlightFromSelection()}
            title={`${t('rightbar.addHighlight')} (H)`}
          >
            {t('rightbar.addHighlight')}
          </button>
          <button
            type="button"
            style={btn}
            disabled={savingHl || status !== 'ready'}
            onClick={() => void addHighlightFromSelection({ withNote: true })}
            title={`${t('rightbar.addNote')} (N)`}
          >
            {t('rightbar.addNote')}
          </button>
          <button
            type="button"
            style={{ ...btn, ...(hlColor === VOCAB_COLOR ? { background: 'var(--dsw-alias-bg-layer-2)' } : {}) }}
            disabled={txBusy || savingHl || status !== 'ready'}
            onClick={() => void translateSelection(true)}
            title={`${t('rightbar.vocabTranslate')} (T)`}
          >
            {txBusy ? '…' : t('rightbar.vocabTranslate')}
          </button>
        </div>
      )}

      {(shareMsg || sharePanel) && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: '8px 10px',
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-1)',
            flexShrink: 0,
          }}
        >
          {shareMsg && (
            <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>{shareMsg}</div>
          )}
          {sharePanel && (
            <>
              <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-primary)', fontWeight: 600 }}>
                {t('rightbar.sendTablet')}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--dsw-alias-label-caption)', lineHeight: 1.45 }}>
                {sharePanel.lanBound
                  ? t('rightbar.sendLanHint')
                  : t('rightbar.sendNoLanHint')}
              </div>
              {sharePanel.qrSvg && sharePanel.lanBound && (
                <div
                  style={{
                    alignSelf: 'center',
                    width: 160,
                    height: 160,
                    background: '#fff',
                    borderRadius: 8,
                    padding: 6,
                    boxSizing: 'border-box',
                  }}
                  // Host-generated SVG from the qrcode encoder (same-process mint).
                  dangerouslySetInnerHTML={{ __html: sharePanel.qrSvg }}
                />
              )}
              <code
                style={{
                  fontSize: 10,
                  wordBreak: 'break-all',
                  color: 'var(--dsw-alias-label-secondary)',
                  lineHeight: 1.4,
                }}
              >
                {sharePanel.primaryUrl}
              </code>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  style={btn}
                  onClick={() => {
                    void navigator.clipboard.writeText(sharePanel.primaryUrl).then(
                      () => setShareMsg(t('rightbar.sendCopied')),
                      () => setShareMsg(t('rightbar.sendFail')),
                    );
                  }}
                >
                  {t('rightbar.sendCopy')}
                </button>
                <a
                  href={sharePanel.primaryUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  style={{ ...btn, textDecoration: 'none', display: 'inline-flex' }}
                >
                  {t('rightbar.sendOpen')}
                </a>
                <button type="button" style={btn} onClick={() => { setSharePanel(null); setShareMsg(''); }}>
                  {t('rightbar.sendClose')}
                </button>
              </div>
              <div style={{ fontSize: 10, color: 'var(--dsw-alias-label-caption)' }}>
                {t('rightbar.sendExpires', {
                  time: new Date(sharePanel.expiresAt).toLocaleTimeString(),
                })}
              </div>
            </>
          )}
        </div>
      )}

      {pendingComment && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
          <input
            value={commentDraft}
            onChange={(e) => setCommentDraft(e.target.value)}
            placeholder={t('rightbar.notePlaceholder')}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void confirmHighlight(true); }
              if (e.key === 'Escape') { setPendingComment(false); pendingHlRef.current = null; }
            }}
            style={{
              flex: 1, fontSize: 11, padding: '4px 8px', borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-layer-1)',
              color: 'var(--dsw-alias-label-primary)',
            }}
          />
          <button type="button" style={btn} disabled={savingHl} onClick={() => void confirmHighlight(true)}>{t('common.save')}</button>
          <button type="button" style={btn} disabled={savingHl} onClick={() => void confirmHighlight(false)}>{t('rightbar.noteSkip')}</button>
        </div>
      )}

      {txPanel && (
        <div
          style={{
            display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0,
            padding: '8px 10px', borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-1)',
          }}
        >
          <div style={{ fontSize: 10.5, fontWeight: 650, color: 'var(--dsw-alias-label-caption)' }}>
            {t('rightbar.translateTitle')} · p.{txPanel.page}
          </div>
          <div style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--dsw-alias-label-primary)' }}>
            <span style={{ color: 'var(--dsw-alias-label-caption)' }}>{txPanel.text}</span>
            <div style={{ marginTop: 4 }}>{txPanel.translation}</div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" style={btn} disabled={savingHl} onClick={() => void saveTxAsVocab()}>
              {t('rightbar.vocabSave')}
            </button>
            <button type="button" style={btn} onClick={() => {
              void navigator.clipboard.writeText(`${txPanel.text}\n${txPanel.translation}`);
              setHlMsg(t('rightbar.copied'));
            }}>
              {t('rightbar.copyPair')}
            </button>
            <button type="button" style={btn} onClick={() => setTxPanel(null)}>{t('rightbar.sendClose')}</button>
          </div>
        </div>
      )}

      {(citeMsg || hlMsg) && (
        <div style={{ fontSize: 10.5, color: 'var(--dsw-alias-label-caption)', flexShrink: 0, display: 'flex', gap: 8, alignItems: 'center' }}>
          <span>{citeMsg || hlMsg}</span>
          {notesOpenTarget && !citeMsg && (
            <button
              type="button"
              style={{ ...btn, padding: '1px 6px', fontSize: 10 }}
              onClick={() => {
                requestOpenNote(notesOpenTarget.workspaceId, notesOpenTarget.name);
                setNotesOpenTarget(null);
              }}
            >
              {t('notes.writeOpen')}
            </button>
          )}
        </div>
      )}

      <div style={{ position: 'relative', display: 'flex', flex: 1, minHeight: 180, overflow: 'hidden' }}>
        {drawer && (
          <div
            data-sch-reader-drawer=""
            style={{
              position: 'absolute', zIndex: 5, top: 0, bottom: 0, left: 0,
              width: 'min(280px, calc(100% - 36px))',
              display: 'flex', flexDirection: 'column',
              border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8,
              background: 'var(--dsw-alias-bg-layer-1)',
              boxShadow: '6px 0 24px rgba(0,0,0,.35)',
              overflow: 'hidden',
            }}
          >
            <div style={{ display: 'flex', gap: 2, padding: 4, borderBottom: '1px solid var(--dsw-alias-border-l1)', alignItems: 'center' }}>
              {(['outline', 'search', 'evidence'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  aria-pressed={drawer === tab}
                  style={{
                    ...btn, flex: 1, padding: '4px 2px', fontSize: 10,
                    background: drawer === tab ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                  }}
                  onClick={() => {
                    const opening = drawer !== tab;
                    setDrawer(opening ? tab : null);
                    if (opening && tab === 'search') requestAnimationFrame(() => searchInputRef.current?.focus());
                  }}
                >
                  {t(`rightbar.${tab}`)}
                </button>
              ))}
              <button
                type="button"
                style={{ ...btn, flex: '0 0 auto', padding: '4px 8px', fontSize: 10 }}
                onClick={() => setDrawer(null)}
                title={t('rightbar.chromeHide')}
              >
                {t('rightbar.chromeHide')}
              </button>
            </div>
            <div data-sch-reader-drawer-body="" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 8 }}>
              {drawer === 'outline' && (
                outline.length
                  ? (() => {
                    const renderItems = (items: OutlineItem[], depth = 0): React.ReactNode =>
                      items.map((it, i) => (
                        <React.Fragment key={`${depth}-${i}-${it.title}`}>
                          <button
                            type="button"
                            style={{
                              ...btn, display: 'block', width: '100%', textAlign: 'left', marginBottom: 3,
                              paddingLeft: 6 + depth * 10, fontSize: 11,
                            }}
                            onClick={() => goPage(it.page, 'smooth')}
                          >
                            {it.title}
                            <span style={{ color: 'var(--dsw-alias-label-caption)', marginLeft: 4 }}>p.{it.page}</span>
                          </button>
                          {it.items?.length ? renderItems(it.items, depth + 1) : null}
                        </React.Fragment>
                      ));
                    return renderItems(outline);
                  })()
                  : <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)' }}>{t('rightbar.outlineEmpty')}</div>
              )}
              {drawer === 'search' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <input
                    ref={searchInputRef}
                    value={searchQ}
                    onChange={(e) => setSearchQ(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }}
                    placeholder={t('rightbar.searchPlaceholder')}
                    style={{
                      fontSize: 11, padding: '5px 8px', borderRadius: 6,
                      border: '1px solid var(--dsw-alias-border-l1)',
                      background: 'var(--dsw-alias-bg-layer-2)',
                      color: 'var(--dsw-alias-label-primary)',
                    }}
                  />
                  <button type="button" style={btn} disabled={searching} onClick={() => void runSearch()}>
                    {searching ? t('rightbar.searching') : t('rightbar.searchGo')}
                  </button>
                  {searchHits === null && !searching && (
                    <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)' }}>{t('rightbar.searchEmpty')}</div>
                  )}
                  {searchHits && searchHits.length === 0 && (
                    <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)' }}>{t('rightbar.searchNone')}</div>
                  )}
                  {searchHits?.map((h, i) => (
                    <button
                      key={`${h.page}-${h.index}-${i}`}
                      type="button"
                      style={{ ...btn, display: 'block', width: '100%', textAlign: 'left', fontSize: 10.5, lineHeight: 1.4 }}
                      onClick={() => goPage(h.page, 'smooth')}
                    >
                      <span style={{ color: 'var(--dsw-alias-label-caption)' }}>p.{h.page}</span>
                      {' '}{h.text}
                    </button>
                  ))}
                </div>
              )}
              {drawer === 'evidence' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      type="button"
                      style={{ ...btn, flex: 1, ...(evidenceFilter === 'all' ? { background: 'var(--dsw-alias-bg-layer-2)' } : {}) }}
                      onClick={() => setEvidenceFilter('all')}
                    >
                      {t('rightbar.evidenceAll')}
                    </button>
                    <button
                      type="button"
                      style={{ ...btn, flex: 1, ...(evidenceFilter === 'vocab' ? { background: 'var(--dsw-alias-bg-layer-2)' } : {}) }}
                      onClick={() => setEvidenceFilter('vocab')}
                    >
                      {t('rightbar.evidenceVocab')}
                      {` (${highlights.filter(isVocabHighlight).length})`}
                    </button>
                  </div>
                  {highlights.length > 0 && (
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      <button type="button" style={btn} onClick={exportEvidenceMd}>
                        {t('rightbar.evidenceExport')}
                      </button>
                      <button
                        type="button"
                        style={btn}
                        disabled={notesBusy}
                        onClick={() => void writeAllEvidenceToNotes()}
                      >
                        {notesBusy ? t('notes.writeBusy') : t('notes.writeAllEvidence')}
                      </button>
                    </div>
                  )}
                  {highlights.filter((h) => evidenceFilter === 'all' || isVocabHighlight(h)).length === 0 && (
                    <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)', lineHeight: 1.45 }}>
                      {evidenceFilter === 'vocab' ? t('rightbar.vocabEmpty') : t('rightbar.evidenceEmpty')}
                    </div>
                  )}
                  {highlights
                    .filter((h) => evidenceFilter === 'all' || isVocabHighlight(h))
                    .slice()
                    .sort((a, b) => a.page - b.page)
                    .map((h) => (
                      <div
                        key={h.id}
                        style={{
                          fontSize: 11, lineHeight: 1.4, padding: '5px 6px', borderRadius: 6,
                          border: activeHlId === h.id
                            ? '1px solid var(--dsw-alias-state-info-primary, #3b82f6)'
                            : '1px solid var(--dsw-alias-border-l1)',
                          background: `color-mix(in srgb, ${h.color || '#ffd400'} 18%, transparent)`,
                        }}
                      >
                        <button
                          type="button"
                          style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}
                          onClick={() => jumpToEvidence(h)}
                        >
                          <span style={{ color: 'var(--dsw-alias-label-caption)', marginRight: 4 }}>p.{h.page}</span>
                          {isVocabHighlight(h) ? (
                            <span style={{
                              fontSize: 9, fontWeight: 700, marginRight: 4, padding: '0 4px', borderRadius: 3,
                              background: 'color-mix(in srgb, #a78bfa 28%, transparent)',
                            }}>{t('rightbar.vocabBadge')}</span>
                          ) : null}
                          {h.zoteroKey ? (
                            <span style={{
                              fontSize: 9, fontWeight: 700, marginRight: 4, padding: '0 4px', borderRadius: 3,
                              background: 'var(--dsw-alias-bg-layer-2)',
                            }}>{t('rightbar.zoteroBadge')}</span>
                          ) : null}
                          {h.text.slice(0, 180)}{h.text.length > 180 ? '…' : ''}
                        </button>
                        {editingHlId === h.id ? (
                          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                            <input
                              value={editCommentDraft}
                              onChange={(e) => setEditCommentDraft(e.target.value)}
                              placeholder={t('rightbar.notePlaceholder')}
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  void saveHighlightComment(h.id, editCommentDraft);
                                }
                                if (e.key === 'Escape') setEditingHlId(null);
                              }}
                              style={{
                                flex: 1, fontSize: 10.5, padding: '3px 6px', borderRadius: 5,
                                border: '1px solid var(--dsw-alias-border-l1)',
                                background: 'var(--dsw-alias-bg-layer-1)',
                                color: 'var(--dsw-alias-label-primary)',
                              }}
                            />
                            <button type="button" style={{ ...btn, padding: '1px 6px' }} onClick={() => void saveHighlightComment(h.id, editCommentDraft)}>
                              {t('common.save')}
                            </button>
                          </div>
                        ) : (
                          <>
                            {h.comment ? (
                              <div style={{ marginTop: 2, color: 'var(--dsw-alias-label-secondary)', fontSize: 10.5 }}>
                                {h.comment}
                              </div>
                            ) : null}
                            <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                              <button
                                type="button"
                                style={{ ...btn, padding: '1px 6px' }}
                                onClick={() => {
                                  setEditingHlId(h.id);
                                  setEditCommentDraft(h.comment ?? '');
                                }}
                              >
                                {h.comment ? t('rightbar.editNote') : t('rightbar.addNote')}
                              </button>
                              <button
                                type="button"
                                style={{ ...btn, padding: '1px 6px' }}
                                disabled={notesBusy}
                                onClick={() => writeHighlightToNotes(h)}
                              >
                                {t('notes.write')}
                              </button>
                              <button
                                type="button"
                                style={{ ...btn, padding: '1px 6px' }}
                                onClick={() => void removeHighlight(h.id)}
                              >×</button>
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div
          ref={hostRef}
          title={title}
          data-sch-pdf-mode={visualMode}
          onClick={(e) => void onCitationClick(e)}
          onMouseUp={onHostMouseUp}
          onScroll={() => { if (selBar) setSelBar(null); }}
          style={{
            flex: 1, minWidth: 0, minHeight: 180, overflow: 'auto',
            overscrollBehavior: 'contain',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 8,
            background: visualTheme.hostBg,
            padding: 4,
            position: 'relative',
            transition: 'background .2s ease',
          }}
        >
          {status === 'loading' && (
            <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-caption)', padding: 12 }}>{t('rightbar.pdfLoading')}</div>
          )}
          <div
            ref={pagesHostRef}
            className="sch-pdf-stack"
            data-mode={visualMode}
            style={{
              display: status === 'ready' ? 'flex' : 'none',
              flexDirection: 'column',
              alignItems: 'center',
              width: '100%',
              minHeight: '100%',
              ...( {
                '--sch-pdf-canvas-filter': visualTheme.canvasFilter,
                '--sch-pdf-page-bg': visualTheme.pageBg,
              } as React.CSSProperties),
            }}
          />
        </div>
      </div>

      {chromeOpen && (
        <div style={{ fontSize: 10, color: 'var(--dsw-alias-label-caption)', flexShrink: 0, lineHeight: 1.45 }}>
          {t('rightbar.pdfHintAnnotate')}
        </div>
      )}

      {selBar && (
        <div
          role="toolbar"
          aria-label={t('rightbar.selToolbar')}
          style={{
            position: 'absolute',
            left: selBar.left,
            top: selBar.top,
            transform: selBar.below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
            zIndex: 20,
            display: 'flex', flexWrap: 'wrap', gap: 3, padding: 4,
            width: 'max-content',
            maxWidth: 'calc(100% - 16px)',
            borderRadius: 10,
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-base, #161616)',
            boxShadow: '0 8px 24px rgba(0,0,0,.35)',
            pointerEvents: 'auto',
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button type="button" style={{ ...btn, padding: '4px 8px', fontSize: 11 }} disabled={savingHl} onClick={() => void addHighlightFromSelection()}>
            {t('rightbar.addHighlight')}
          </button>
          <button type="button" style={{ ...btn, padding: '4px 8px', fontSize: 11 }} disabled={savingHl} onClick={() => void addHighlightFromSelection({ withNote: true })}>
            {t('rightbar.addNote')}
          </button>
          <button type="button" style={{ ...btn, padding: '4px 8px', fontSize: 11 }} disabled={txBusy || savingHl} onClick={() => void translateSelection(true)}>
            {txBusy ? '…' : t('rightbar.vocabTranslate')}
          </button>
          <button type="button" style={{ ...btn, padding: '4px 8px', fontSize: 11 }} onClick={() => void copySelection()}>
            {t('rightbar.copySel')}
          </button>
          <button
            type="button"
            style={{ ...btn, padding: '4px 8px', fontSize: 11 }}
            disabled={notesBusy || savingHl}
            onClick={() => void writeSelectionToNotes()}
          >
            {notesBusy ? t('notes.writeBusy') : t('notes.write')}
          </button>
        </div>
      )}

      <style>{`
        .sch-pdf-page {
          position: relative;
          background: var(--sch-pdf-page-bg, #fff);
          box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 4px 14px rgba(0,0,0,.08);
          margin: 0 0 12px;
          border-radius: 2px;
          overflow: hidden;
          transition: background .2s ease;
        }
        .sch-pdf-page.sch-pdf-placeholder {
          background: color-mix(in srgb, var(--sch-pdf-page-bg, #fff) 85%, var(--dsw-alias-bg-layer-1));
          box-shadow: none;
        }
        .sch-pdf-stack canvas {
          display: block;
          filter: var(--sch-pdf-canvas-filter, none);
        }
        .textLayer {
          position: absolute; inset: 0; overflow: clip; line-height: 1;
          pointer-events: auto; cursor: text; text-align: initial;
          transform-origin: 0 0; z-index: 1;
          -webkit-text-size-adjust: none; text-size-adjust: none;
        }
        .textLayer span, .textLayer br {
          color: transparent;
          position: absolute;
          white-space: pre;
          cursor: text;
          transform-origin: 0% 0%;
        }
        .textLayer > span:not(.markedContent),
        .textLayer .markedContent > span:not(.markedContent) {
          padding: .05em .16em .05em .04em;
          margin: -.05em -.08em -.05em 0;
          box-sizing: content-box;
        }
        .textLayer .endOfContent {
          display: block; position: absolute; inset: 100% 0 0;
          z-index: -1; cursor: default; user-select: none;
        }
        .textLayer.selecting .endOfContent { top: 0; }
        .textLayer ::selection {
          background: color-mix(in srgb, var(--dsw-alias-state-info-primary, #2563eb) 38%, transparent);
        }
      `}</style>
    </div>
  );
}
