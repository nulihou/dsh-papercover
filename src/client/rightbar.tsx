/**
 * 官方右侧 Sidebar(0.1.5+)的「论文速查」页签。
 *
 * 两阶段注册(照 dsh-client-ui-sidebar-files 的官方姿势):
 *  1. ctx.sidebarRightTabs.register(定义) —— 静态类型声明(页类型:无 patterns,
 *     由 openTab(kind) 打开;priority 默认 extension,最高优先级带)
 *  2. ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
 *       { name, key: 定义id, locale: NS }, Body)) —— body 组件 props 拿
 *     useTabInfo(读 tab.navigation.params/revision/actions)与 t
 *
 * body 双模:无 params = 迷你检索(防抖拉 /scholar/papers);params.id = 论文速览
 * + 侧栏内 PDF（划词翻译）。旧宿主无 sidebarRightTabs/sidebarRight 服务时
 * 静默跳过(特性检测),入口按钮同步隐藏。
 *
 * 阅读 PDF 走官方右栏里的 PaperSidebarReader。
 */
import React from 'react';
import type { Paper } from '../shared/types';
import { api, qs } from './api';
import { getCurrentProjectId } from './currentProject';
import { PaperSidebarReader } from './PaperSidebarReader';
import { navBus } from './nav';

const NS = 'scholar';
/** 注册 id = 包名(tab 系统里实现的身份,也是 body 注册的 key) */
const TAB_ID = 'dsh-papercover';
export const PAPER_TAB_KIND = 'dsh-scholar.paper';

/** 通知工作台抽屉：进入/退出侧栏阅读态（完全隐藏竖直栏，避免挡 PDF） */
export const READING_EVENT = 'scholar:reading';

let readingActive = false;

/** 侧栏是否正在读 PDF（官方右栏或 better-sidebar） */
export function isReadingMode(): boolean {
  return readingActive;
}

function emitReadingMode(active: boolean): void {
  if (readingActive === active) {
    // 仍广播，便于监听方刷新；但避免无意义的重复折叠由调用方自行判断
  }
  readingActive = active;
  window.dispatchEvent(new CustomEvent(READING_EVENT, { detail: { active } }));
}

/** Clear PDF reading hide-state when the user deliberately reopens the desk. */
export function clearReadingMode(): void {
  emitReadingMode(false);
}

type PaperWithAbs = Paper & { pdfAbsolutePath?: string };

/* ---------- openTab 服务句柄(apply 时注入,旧宿主为 null) ---------- */
let svc: {
  openTab(kind: string, options?: { params?: unknown }): void;
  mounted?: { getSnapshot?: () => string | undefined };
} | null = null;

/** 入口可用性(PaperLibraryView 据此显示/隐藏「右侧栏打开」)。 */
export function rightbarAvailable(): boolean {
  return svc !== null;
}

/** Session id of the mounted official right bar. */
export function currentSessionId(): string | undefined {
  try {
    const official = svc?.mounted?.getSnapshot?.()
    if (typeof official === 'string' && official.trim()) return official.trim()
  } catch { /* snapshot unavailable */ }
  return undefined
}

/** 在右侧栏打开一篇论文(id 省略 = 打开检索模式);服务缺席时静默 no-op。 */
export function openPaperInRightbar(id?: string): void {
  try {
    // Persist selection for reload: sidebar layout keeps the tab, not params.
    saveLastPaper(id?.trim() || null);
    svc?.openTab(PAPER_TAB_KIND, id ? { params: { id } } : undefined);
  } catch {
    /* 服务未挂载(无会话 seat)——忽略 */
  }
}

/** 打开侧栏 PDF 并翻到指定页。阅读器还没就绪时先记下页码，加载完再跳。 */
export function jumpToPaperPage(paperId: string, page: number): void {
  const target = Math.max(1, Math.floor(page));
  try { sessionStorage.setItem(`sch-pending-page:${paperId}`, String(target)); } catch { /* 隐私模式忽略 */ }
  void openPaperPdfInSidebar(paperId);
  const fire = () => window.dispatchEvent(new CustomEvent('scholar:goto-page', { detail: { paperId, page: target } }));
  fire();
  window.setTimeout(fire, 700);
  window.setTimeout(fire, 1800);
}

/**
 * 打开论文 PDF。只走官方右栏里的dsh-papercover阅读页。
 * openTab 在没有挂载会话时抛出 "sidebarRight: no session surface is mounted"，
 * 这时返回 false，由调用方退回台内预览。
 *
 * @returns true when the official sidebar reader opened
 */
export async function openPaperPdfInSidebar(paperId: string, _title?: string): Promise<boolean> {
  try {
    await api<{ paper: PaperWithAbs }>(`/scholar/papers/${encodeURIComponent(paperId)}`);
    if (!svc) return false;
    try {
      saveLastPaper(paperId.trim() || null);
      svc.openTab(PAPER_TAB_KIND, { params: { id: paperId } });
      emitReadingMode(true);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

/* ---------- body ---------- */

type PaperLite = Pick<Paper, 'id' | 'title'> & { year?: number; importance?: number; tags?: string[]; pdfPath?: string };

const LAST_PAPER_KEY = 'dsh-scholar:rightbar-paper';

function loadLastPaper(): string | null {
  try {
    const id = localStorage.getItem(LAST_PAPER_KEY);
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

function saveLastPaper(id: string | null): void {
  try {
    if (id && id.trim()) localStorage.setItem(LAST_PAPER_KEY, id.trim());
    else localStorage.removeItem(LAST_PAPER_KEY);
  } catch { /* quota / private */ }
}

function Stars({ n }: { n: number }) {
  return <span style={{ color: 'var(--sch-accent)', fontSize: 11, letterSpacing: 1 }}>{'★'.repeat(n)}</span>;
}

function PaperTabBody({ useTabInfo, t }: {
  useTabInfo: () => { tab: any };
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  const { tab } = useTabInfo();
  const nav = tab?.navigation;
  const paramsId: string | undefined = typeof nav?.params?.id === 'string' ? nav.params.id : undefined;
  const revision: number = nav?.revision ?? 0;

  // Sidebar layout restores the tab chip but not navigation.params — revive the
  // last paper from localStorage when params are absent.
  const [selectedId, setSelectedId] = React.useState<string | null>(() => paramsId ?? loadLastPaper());

  React.useEffect(() => {
    if (paramsId) {
      setSelectedId(paramsId);
      saveLastPaper(paramsId);
    }
  }, [paramsId, revision]);

  const pick = (id: string) => {
    setSelectedId(id);
    saveLastPaper(id);
    try {
      tab?.actions?.openTab?.(PAPER_TAB_KIND, { params: { id }, replaceTab: true });
    } catch {
      openPaperInRightbar(id);
    }
  };

  const back = () => {
    setSelectedId(null);
    saveLastPaper(null);
    try {
      tab?.actions?.openTab?.(PAPER_TAB_KIND, { replaceTab: true });
    } catch {
      openPaperInRightbar();
    }
  };

  if (selectedId) {
    return <PaperDetail id={selectedId} t={t} onBack={back} />;
  }
  return <PaperSearch t={t} onPick={pick} />;
}

function PaperSearch({ t, onPick }: { t: (key: string, params?: Record<string, unknown>) => string; onPick: (id: string) => void }) {
  const [q, setQ] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [list, setList] = React.useState<PaperLite[] | null>(null);
  const [err, setErr] = React.useState('');

  React.useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(id);
  }, [q]);

  React.useEffect(() => {
    let alive = true;
    setErr('');
    api<{ papers: PaperLite[] }>(`/scholar/papers${qs({ q: debounced, limit: 8 })}`)
      .then((d) => { if (alive) setList(d.papers ?? []); })
      .catch((e) => { if (alive) setErr(String(e instanceof Error ? e.message : e)); });
    return () => { alive = false; };
  }, [debounced]);

  return (
    <div data-dsh-plugin="dsh-scholar" className="sch-root" style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10, minHeight: '100%' }}>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('rightbar.searchPh')}
        style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', fontSize: 12, borderRadius: 8,
          border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', outline: 'none' }}
      />
      {err && <div style={{ fontSize: 11, color: 'var(--dsw-alias-state-danger-primary)' }}>{err}</div>}
      {list && list.length === 0 && !err && (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-caption)', padding: '8px 2px' }}>
          {debounced ? t('rightbar.noResult') : t('rightbar.empty')}
        </div>
      )}
      {list?.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onPick(p.id)}
          style={{ textAlign: 'left', cursor: 'pointer', display: 'block', width: '100%', padding: '8px 10px', borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
            fontSize: 12, lineHeight: 1.5 }}
        >
          <div style={{ fontWeight: 600 }}>{p.title}</div>
          <div style={{ marginTop: 3, display: 'flex', gap: 6, alignItems: 'center', color: 'var(--dsw-alias-label-caption)', fontSize: 11 }}>
            {p.year ? <span>{p.year}</span> : null}
            {p.importance ? <Stars n={p.importance} /> : null}
            {p.pdfPath ? <span>PDF</span> : null}
            {(p.tags ?? []).slice(0, 3).map((tg) => <span key={tg}>#{tg}</span>)}
          </div>
        </button>
      ))}
    </div>
  );
}

function PaperDetail({ id, t, onBack }: { id: string; t: (key: string, params?: Record<string, unknown>) => string; onBack: () => void }) {
  const [paper, setPaper] = React.useState<PaperWithAbs | null>(null);
  const [err, setErr] = React.useState('');
  const [metaOpen, setMetaOpen] = React.useState(false);
  const [busy, setBusy] = React.useState('');

  React.useEffect(() => {
    let alive = true;
    setErr(''); setPaper(null);
    api<{ paper: PaperWithAbs }>(`/scholar/papers/${encodeURIComponent(id)}`)
      .then((d) => {
        if (!alive) return;
        setPaper(d.paper);
        if (d.paper.pdfPath || d.paper.pdfAbsolutePath) emitReadingMode(true);
      })
      .catch((e) => { if (alive) setErr(String(e instanceof Error ? e.message : e)); });
    return () => {
      alive = false;
      // 离开论文详情时解除阅读态，允许抽屉恢复正常 dock
      emitReadingMode(false);
    };
  }, [id]);

  const link = { color: 'var(--sch-accent)', textDecorationLine: 'underline', fontSize: 12 } as const;
  const hasPdf = !!(paper?.pdfPath || paper?.pdfAbsolutePath);

  const handleBack = () => {
    emitReadingMode(false);
    onBack();
  };

  const toEvidence = async () => {
    if (!paper) return;
    setBusy('evidence');
    try {
      const claim = (paper.summary || paper.title || '').trim().slice(0, 240);
      await api('/scholar/evidences', {
        method: 'POST',
        body: JSON.stringify({ claim, paperId: paper.id, kind: 'author_claim', confidence: 3 }),
      });
      setBusy('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy('');
    }
  };

  const linkProject = async () => {
    if (!paper) return;
    const pid = getCurrentProjectId();
    if (!pid) {
      navBus.go('projects');
      return;
    }
    setBusy('link');
    try {
      await api(`/scholar/projects/${encodeURIComponent(pid)}/link`, {
        method: 'POST',
        body: JSON.stringify({ paperIds: [paper.id] }),
      });
      const refreshed = await api<{ paper: PaperWithAbs }>(`/scholar/papers/${encodeURIComponent(paper.id)}`);
      setPaper(refreshed.paper);
      setBusy('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy('');
    }
  };

  return (
    <div data-dsh-plugin="dsh-scholar" className="sch-root" style={{ padding: '10px 12px 12px', display: 'flex', flexDirection: 'column', gap: 8, height: '100%', minHeight: 0, boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <button type="button" className="sch-btn" onClick={handleBack} style={{ minHeight: 24, padding: '0 8px', fontSize: 11 }}>
          {t('rightbar.back')}
        </button>
        <span style={{ flex: 1 }} />
        {paper && (
          <>
            <button type="button" className="sch-btn" disabled={!!busy} onClick={() => void toEvidence()}
              style={{ minHeight: 24, padding: '0 8px', fontSize: 11 }}>{t('rightbar.toEvidence')}</button>
            <button type="button" className="sch-btn" disabled={!!busy} onClick={() => void linkProject()}
              style={{ minHeight: 24, padding: '0 8px', fontSize: 11 }}>{t('rightbar.linkProject')}</button>
            <button
              type="button"
              className={`sch-btn${metaOpen ? ' sch-btn--soft' : ''}`}
              onClick={() => setMetaOpen((v) => !v)}
              style={{ minHeight: 24, padding: '0 8px', fontSize: 11 }}
            >
              {metaOpen ? t('rightbar.hideMeta') : t('rightbar.showMeta')}
            </button>
          </>
        )}
      </div>
      {err && <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-danger-primary)', flexShrink: 0 }}>{err}</div>}
      {!paper && !err && <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-caption)', flexShrink: 0 }}>…</div>}
      {paper && (
        <>
          <div
            title={paper.title}
            style={{
              fontWeight: 700, fontSize: 13, lineHeight: 1.35, flexShrink: 0,
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
            }}
          >{paper.title}</div>
          {metaOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0, maxHeight: '28%', overflow: 'auto' }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 11, color: 'var(--dsw-alias-label-caption)' }}>
                {paper.year ? <span>{paper.year}</span> : null}
                {paper.venue ? <span>· {paper.venue}</span> : null}
                {paper.importance ? <Stars n={paper.importance} /> : null}
              </div>
              {paper.authors.length > 0 && (
                <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)', lineHeight: 1.6 }}>{paper.authors.join(', ')}</div>
              )}
              {paper.tags.length > 0 && (
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  {paper.tags.map((tg) => (
                    <span key={tg} style={{ fontSize: 10.5, padding: '1px 7px', borderRadius: 999,
                      background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' }}>#{tg}</span>
                  ))}
                </div>
              )}
              {paper.summary && (
                <div className="sch-prose" style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--dsw-alias-label-primary)',
                  borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 8 }}>{paper.summary}</div>
              )}
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {paper.arxivId && (
                  <a style={link} href={`https://arxiv.org/abs/${encodeURIComponent(paper.arxivId)}`} target="_blank" rel="noreferrer noopener">arXiv</a>
                )}
                {paper.url && /^(https?:)/i.test(paper.url) && (
                  <a style={link} href={paper.url} target="_blank" rel="noreferrer noopener">{t('rightbar.openLink')}</a>
                )}
                {paper.doi && (
                  <a style={link} href={`https://doi.org/${encodeURIComponent(paper.doi)}`} target="_blank" rel="noreferrer noopener">DOI</a>
                )}
              </div>
            </div>
          )}
          {hasPdf ? (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <PaperSidebarReader paperId={paper.id} title={paper.title} t={t} />
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-caption)', lineHeight: 1.55 }}>{t('rightbar.noPdf')}</div>
          )}
        </>
      )}
    </div>
  );
}

/* ---------- 注册(apply 时调用;旧宿主无该服务时静默跳过) ---------- */

export function registerScholarRightbar(ctx: any): void {
  // 用 ctx.inject 子插件而非静态 inject:服务缺席时父插件(抽屉/入口)照常工作,
  // 仅右栏页签不注册——旧宿主优雅降级。package.json 的 dsh.client.inject
  // 已声明 '@deepseek-ai/dsh-client-ui-sidebar-right' 保证图序(服务先于我们到达)。
  ctx.inject(['sidebarRightTabs', 'sidebarRight'], (ctx2: any) => {
    svc = ctx2.sidebarRight;
    const t = ctx2.locale.bind(NS);
    // 阶段一:静态类型声明(页类型,extension 带;title thunk 每次使用时重读,语言切换自动跟随)
    ctx2.effect(() => ctx2.sidebarRightTabs.register({
      id: TAB_ID,
      kind: PAPER_TAB_KIND,
      title: () => t('rightbar.tabTitle'),
      guide: [{
        order: 60,
        title: () => t('rightbar.tabTitle'),
        description: () => t('rightbar.guideDesc'),
      }],
    }), 'dsh-scholar: rightbar paper tab type');
    // 阶段二:body 注册(key = 定义 id;locale 选项让框架给组件注入 t)
    ctx2.effect(() => ctx2.slots.inject('sidebar.right.pane.tab', () => ctx2.slots.register({
      name: 'sidebar.right.pane.tab',
      key: TAB_ID,
      locale: NS,
    }, PaperTabBody)), 'dsh-scholar: rightbar paper tab body');
    return () => { svc = null; };
  });
}
