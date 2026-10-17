import { queueMutation } from './mutationQueue';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IdeaCard, Paper, PaperCollection, PaperLifecycle, ReadStatus, ResearchProject, ScholarConfig, ZoteroSyncResult } from '../shared/types';
import { READ_STATUSES } from '../shared/types';
import { api, loadSavedFilters, qs, saveFilters } from './api';
import { getCurrentProjectId, setCurrentProjectId } from './currentProject';
import { navBus, useNav, type TFunc } from './nav';
import { jumpToPaperPage, openPaperPdfInSidebar, rightbarAvailable } from './rightbar';
import { downloadTextFile, libraryToBibtex, paperToBibtex } from './bibtex';
import { gbCitation, apaCitation, venueTier } from './citation';
import { StudyLauncher, deliverToComposer } from './StudyLauncher';
import { buildPaperGenerateCardsPrompt } from './cardGenerate';
import { DiscoverModal, BibtexImportModal } from './DiscoverPanels';
import { PaperAsk } from './PaperAsk';
import {
  Btn, Chip, EmptyState, Field, FilterChip, Icon, Icons, IconButton, Input, Meta, Modal, SchStyles,
  SearchInput, Section, SegGroup, SegItem, Select, SkeletonCards, Stars, T, Textarea, truncate,
} from './ui';

/** preset swatches for collection colors */
const COL_COLORS = ['#2563eb', '#059669', '#d97706', '#dc2626', '#6366f1', '#0e7490'];

/** 筛选/排序状态按 tab 存 sessionStorage 的键 */
const FILTERS_KEY = 'dsh-scholar:papers:filters';

/** 保存的筛选（命名查询，Zotero saved searches）持久在 localStorage */
const SAVED_SEARCHES_KEY = 'dsh-scholar:papers:savedSearches';

/** 浏览足迹（最近在看，id 有序去重，上限 15）持久在 localStorage */
const RECENT_KEY = 'dsh-scholar:papers:recent';

/** 课题组分区展开态（localStorage） */
const PROJECTS_RAIL_OPEN_KEY = 'dsh-scholar:papers:projects-rail-open';
/** 主题分区展开态（localStorage） */
const COLLECTIONS_RAIL_OPEN_KEY = 'dsh-scholar:papers:collections-rail-open';

function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

function loadRailOpen(key: string, fallback = true): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === '0') return false;
    if (v === '1') return true;
  } catch { /* quota */ }
  return fallback;
}

/** 详情页"相关论文"区块的数据形状（host /scholar/papers/:id/related 的响应） */
interface RelatedWorkLite {
  openalexId: string;
  title: string;
  year?: number;
  venue?: string;
  doi?: string;
  arxivId?: string;
  citedBy: number;
  authors: string[];
  libraryPaperId?: string;
}
interface RelatedReportLite {
  openalexId?: string;
  similar: RelatedWorkLite[];
  citations: RelatedWorkLite[];
  references: RelatedWorkLite[];
  note?: string;
}

interface SavedSearch {
  id: string;
  name: string;
  f: { q: string; tag: string; yearFrom: string; yearTo: string; importance: string; readStatus: string; col: string; unfiled: boolean };
}

/** 阅读状态展示（ReadPaper 式 想读/在读/读过） */
const READ_STATUS_LABELS: Record<ReadStatus, string> = { want: 'paper.read.want', reading: 'paper.read.reading', done: 'paper.read.done' };

function readStatusColor(rs: ReadStatus | undefined): string {
  if (rs === 'done') return 'var(--dsw-alias-state-success-primary, #34a853)';
  if (rs === 'reading') return 'var(--sch-accent)';
  return 'var(--dsw-alias-label-caption)';
}

const LIFECYCLE_NEXT: Partial<Record<PaperLifecycle, PaperLifecycle>> = {
  inbox: 'saved',
  saved: 'pdf_verified',
  pdf_verified: 'reading',
  reading: 'read',
  read: 'annotated',
  annotated: 'distilled',
  distilled: 'linked',
  linked: 'cited',
  cited: 'archived',
};

function lifecycleLabel(t: TFunc, lc: PaperLifecycle | undefined): string {
  const key = `paper.lifecycle.${lc ?? 'saved'}`;
  return t(key);
}

/** venue 徽章：会议/期刊着色，无 venue 的 arXiv 论文给灰色 arXiv 标 */
function venueBadge(p: Paper): { label: string; color: string } | null {
  const v = (p.venue ?? '').trim();
  const clip = (s: string) => (s.length > 18 ? `${s.slice(0, 17)}…` : s);
  if (v) {
    if (/cvpr|iccv|eccv/i.test(v)) return { label: clip(v), color: '#dc2626' };
    if (/neurips|nips\b|icml|iclr/i.test(v)) return { label: clip(v), color: '#6366f1' };
    if (/aaai|ijcai/i.test(v)) return { label: clip(v), color: '#d97706' };
    if (/t-?pami|t-?ip|t-?mm|t-?csvt|journal|transactions/i.test(v)) return { label: clip(v), color: '#0e7490' };
    return { label: clip(v), color: 'var(--sch-accent)' };
  }
  if (p.arxivId) return { label: 'arXiv', color: 'var(--dsw-alias-label-caption)' };
  return null;
}

/** 等宽字体（arXiv/DOI/引用条目） */
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const CITATION_FORMATS = ['gb', 'apa', 'bibtex'] as const;
type CitationFmt = (typeof CITATION_FORMATS)[number];
const CIT_LABEL: Record<CitationFmt, string> = { gb: 'GB/T 7714', apa: 'APA 7', bibtex: 'BibTeX' };

/** 引用文本：gb/apa 走格式化器，bibtex 走生成器 */
function citationText(p: Paper, fmt: CitationFmt): string {
  if (fmt === 'bibtex') return paperToBibtex(p);
  return fmt === 'gb' ? gbCitation(p) : apaCitation(p);
}

const has = (v: string | undefined): boolean => !!v;

/** P0-4:url 字段可能存任意字符串(agent 输入),只有 http(s) 才可点击 */
function isHttpUrl(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

/** 精研卡：从最新 sidecar 读取 Nature 风格压缩字段，展示在详情页 */
type StudyCardView = {
  oneSentence?: string
  painPoints?: string[]
  coreIdea?: string
  methodOverview?: string
  novelty?: string
  boundedConclusion?: string
  transfer?: string[]
  ideas?: Array<{ name: string; hypothesis: string; from: string }>
}

function PaperStudyCard({ paperId, t }: { paperId: string; t: TFunc }) {
  const [card, setCard] = useState<StudyCardView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const refresh = useCallback(() => {
    let alive = true;
    api<{ sidecar: { card?: StudyCardView } | null }>(`/scholar/papers/${encodeURIComponent(paperId)}/sidecar`)
      .then((r) => {
        if (!alive) return;
        setCard(r.sidecar?.card ?? null);
        setLoaded(true);
      })
      .catch(() => {
        if (!alive) return;
        setCard(null);
        setLoaded(true);
      });
    return () => { alive = false; };
  }, [paperId]);
  useEffect(() => refresh(), [refresh]);
  useEffect(() => {
    const h = () => refresh();
    window.addEventListener('scholar:read-done', h);
    return () => window.removeEventListener('scholar:read-done', h);
  }, [refresh]);

  const hasBody = Boolean(
    card
    && (card.oneSentence || card.coreIdea || card.methodOverview || card.novelty || card.boundedConclusion
      || (card.painPoints?.length ?? 0) > 0 || (card.transfer?.length ?? 0) > 0
      || (card.ideas?.length ?? 0) > 0),
  );
  if (!loaded) return null;
  if (!hasBody) {
    return (
      <Section title={t('paper.studyCard')} icon={<Icon d={Icons.sparkle} size={11} color={T.business} />} accent={T.business} style={{ marginTop: 2 }}>
        <div style={{ color: T.caption, fontSize: 11.5, lineHeight: 1.55 }}>{t('paper.studyCardEmpty')}</div>
      </Section>
    );
  }
  const row = (label: string, body: React.ReactNode) => (
    <div style={{ display: 'grid', gridTemplateColumns: '72px 1fr', gap: 8, padding: '7px 0', borderBottom: `1px solid ${T.borderL2}` }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: T.warning, paddingTop: 2 }}>{label}</div>
      <div className="sch-prose" style={{ fontSize: 12, lineHeight: 1.65, minWidth: 0 }}>{body}</div>
    </div>
  );
  return (
    <Section title={t('paper.studyCard')} icon={<Icon d={Icons.sparkle} size={11} color={T.business} />} accent={T.business} style={{ marginTop: 2 }}>
      <div style={{ borderRadius: 8, border: `1px solid ${T.borderL2}`, background: T.cardBg, padding: '2px 12px' }}>
        {card!.oneSentence ? row(t('paper.card.oneSentence'), card!.oneSentence) : null}
        {(card!.painPoints?.length ?? 0) > 0 ? row(t('paper.card.pain'), (
          <ul style={{ margin: 0, paddingLeft: 16 }}>{card!.painPoints!.map((p) => <li key={p}>{p}</li>)}</ul>
        )) : null}
        {card!.coreIdea ? row(t('paper.card.idea'), card!.coreIdea) : null}
        {card!.methodOverview ? row(t('paper.card.method'), card!.methodOverview) : null}
        {card!.novelty ? row(t('paper.card.novelty'), card!.novelty) : null}
        {card!.boundedConclusion ? row(t('paper.card.bounded'), card!.boundedConclusion) : null}
        {(card!.transfer?.length ?? 0) > 0 ? row(t('paper.card.transfer'), (
          <ul style={{ margin: 0, paddingLeft: 16 }}>{card!.transfer!.map((p) => <li key={p}>{p}</li>)}</ul>
        )) : null}
        {(card!.ideas?.length ?? 0) > 0 ? row(t('paper.card.ideas'), (
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {card!.ideas!.map((i, idx) => (
              <li key={`${i.name}-${idx}`}>
                <b>{i.name || '—'}</b>{i.hypothesis ? ` — ${i.hypothesis}` : ''}
                {i.from ? <div style={{ color: T.caption, fontSize: 10.5, marginTop: 2 }}>{t('paper.card.from')}：{i.from}</div> : null}
              </li>
            ))}
          </ul>
        )) : null}
      </div>
    </Section>
  );
}

/** 精研报告列表。paper_read 归档后在这里打开。 */
function PaperReports({ paperId, notify, t }: { paperId: string; notify?: (msg: string) => void; t: TFunc }) {
  type ReportRow = { file: string; size: number; savedAt: number; mode?: 'paper' | 'quick' | 'compare' | '' };
  const [reports, setReports] = useState<ReportRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const refresh = useCallback(() => {
    let alive = true;
    setFailed(false);
    api<{ reports: ReportRow[] }>(`/scholar/papers/${encodeURIComponent(paperId)}/reports`)
      .then((r) => { if (alive) setReports(r.reports ?? []); })
      .catch(() => {
        // 静默吞错会让人误以为"没有报告"——失败时明确显示加载失败
        if (alive) setFailed(true);
      });
    return () => { alive = false; };
  }, [paperId]);
  useEffect(() => refresh(), [refresh]);
  // 后台精读完成 → 报告列表自动长出最新一份（不用手刷）
  useEffect(() => {
    const h = () => refresh();
    window.addEventListener('scholar:read-done', h);
    return () => window.removeEventListener('scholar:read-done', h);
  }, [refresh]);

  /** 从报告建卡：精读报告二次速读 → 提取创新点 → idea_card_create（经对话注入） */
  const cardsFromReport = async (file: string) => {
    try {
      const cfg = await api<{ config: ScholarConfig }>('/scholar/config');
      const path = `${cfg.config.paperDir.replace(/[\\/]+$/, '')}/reports/${file}`;
      deliverToComposer(
        `请基于这篇论文（id: ${paperId}）的精读报告提取创新点建卡：用 paper_read 工具速读报告文件（path 参数） ${path}（quick 模式），`
        + `focus=从报告结论中提取 1-3 条对我研究方向可迁移的创新点（结合上下文注入的研究方向），`
        + `然后 idea_card_create 建卡（关联论文 ${paperId}，evidence 引用报告中的具体数据与表号）。`,
        (r) => notify?.(t(r === 'sent' ? 'paper.studySent' : r === 'filled' ? 'paper.studyFilled' : r === 'failed' ? 'paper.studyFailed' : 'paper.studyCopied')),
      );
    } catch (e) {
      notify?.(e instanceof Error ? e.message : String(e));
    }
  };

  if (failed) {
    return (
      <Section title={t('paper.reports')} icon={<Icon d={Icons.doc} size={11} color={T.business} />} accent={T.business}>
        <div style={{ color: T.danger, fontSize: 11.5 }}>{t('paper.reportsFailed')}</div>
      </Section>
    );
  }
  if (!reports || reports.length === 0) return null;
  return (
    <Section title={`${t('paper.reports')} · ${reports.length}`} icon={<Icon d={Icons.doc} size={11} color={T.business} />} accent={T.business}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {reports.map((r) => (
          <div
            key={r.file}
            className="sch-card"
            style={{
              display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5,
              border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 9,
              padding: '7px 10px', background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.04))',
            }}
          >
            {r.mode === 'paper' || r.mode === 'quick' || r.mode === 'compare' ? (
              <span
                data-dsh-part="report-mode"
                style={{
                  flex: 'none', fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 999,
                  color: r.mode === 'paper' ? 'var(--sch-accent)' : r.mode === 'quick' ? 'var(--sch-success, #059669)' : 'var(--sch-indigo, #6366f1)',
                  border: `1px solid ${r.mode === 'paper'
                    ? 'color-mix(in srgb, var(--sch-accent) 35%, transparent)'
                    : r.mode === 'quick'
                      ? 'color-mix(in srgb, var(--sch-success, #059669) 35%, transparent)'
                      : 'color-mix(in srgb, var(--sch-indigo, #6366f1) 35%, transparent)'}`,
                  background: r.mode === 'paper'
                    ? 'color-mix(in srgb, var(--sch-accent) 8%, transparent)'
                    : r.mode === 'quick'
                      ? 'color-mix(in srgb, var(--sch-success, #059669) 8%, transparent)'
                      : 'color-mix(in srgb, var(--sch-indigo, #6366f1) 8%, transparent)',
                }}
              >{t(r.mode === 'paper' ? 'study.paperLabel' : r.mode === 'quick' ? 'study.quickLabel' : 'study.compareLabel')}</span>
            ) : (
              <Icon d={Icons.doc} size={13} color={T.business} />
            )}
            <button
              type="button"
              data-dsh-plugin="dsh-scholar"
              data-dsh-part="report-preview"
              className="sch-press"
              onClick={() => setPreview(r.file)}
              style={{
                display: 'inline-flex', alignItems: 'baseline', gap: 6, color: 'var(--dsw-alias-label-primary)',
                background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, minWidth: 0, flex: 1,
              }}
              title={t('paper.reportPreview')}
            >
              <span style={{ fontWeight: 550 }}>{new Date(r.savedAt).toLocaleDateString()}</span>
              <span style={{ color: T.caption, fontSize: 10.5 }}>{new Date(r.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              <span style={{ color: T.caption, fontSize: 10 }}>({Math.round(r.size / 1024)} KB)</span>
            </button>
            <IconButton
              label={t('paper.reportToCards')}
              onClick={() => void cardsFromReport(r.file)}
              icon={<Icon d={Icons.plus} size={11} />}
            />
            <a
              href={`/scholar/papers/${encodeURIComponent(paperId)}/reports/${encodeURIComponent(r.file)}`}
              target="_blank"
              rel="noreferrer noopener"
              title={t('paper.reportOpen')}
              style={{ display: 'inline-flex', color: T.caption, padding: '2px 0' }}
            >
              <Icon d={Icons.external} size={11} />
            </a>
            <IconButton
              label={t('paper.reportDelete')}
              color={T.danger}
              onClick={() => {
                if (!window.confirm(t('paper.reportDeleteConfirm'))) return;
                void (async () => {
                  try {
                    await api(`/scholar/papers/${encodeURIComponent(paperId)}/reports/${encodeURIComponent(r.file)}`, { method: 'DELETE' });
                    notify?.(t('paper.reportDeleted'));
                    refresh();
                  } catch (e) {
                    notify?.(e instanceof Error ? e.message : String(e));
                  }
                })();
              }}
              icon={<Icon d={Icons.trash} size={11} />}
            />
          </div>
        ))}
      </div>
      {preview && (
        <Modal title={t('paper.reportPreview')} onClose={() => setPreview(null)} width={720}>
          <iframe
            src={`/scholar/papers/${encodeURIComponent(paperId)}/reports/${encodeURIComponent(preview)}`}
            title={preview}
            style={{ width: '100%', height: '62vh', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: '#fff' }}
            onLoad={(e) => {
              const frame = e.currentTarget;
              try {
                const doc = frame.contentDocument;
                if (!doc || doc.documentElement.dataset.schJump === '1') return;
                doc.documentElement.dataset.schJump = '1';
                doc.addEventListener('click', (ev) => {
                  const node = ev.target instanceof Element ? ev.target : null;
                  const link = node?.closest('[data-sch-page]');
                  if (!(link instanceof HTMLElement)) return;
                  ev.preventDefault();
                  const page = Number(link.getAttribute('data-sch-page'));
                  const id = doc.body?.getAttribute('data-paper-id') || paperId;
                  if (page >= 1 && id) jumpToPaperPage(id, page);
                });
              } catch { /* 沙箱拒绝访问时，报告仍可阅读，只是点页码不会跳 */ }
            }}
          />
        </Modal>
      )}
    </Section>
  );
}

/** 详情页"相关论文"区块：OpenAlex 相似/被引/引用，已在库标注 + 一键入库 */
function PaperRelated({ paperId, t, onAdded, notify }: {
  paperId: string;
  t: TFunc;
  /** 入库成功后刷新父级列表 */
  onAdded: () => void;
  notify: (text: string) => void;
}) {
  const [data, setData] = useState<RelatedReportLite | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<'similar' | 'citations' | 'references'>('citations');
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Map<string, string>>(new Map()); // openalexId → libraryPaperId

  useEffect(() => {
    let alive = true;
    setData(null);
    setFailed(false);
    api<RelatedReportLite>(`/scholar/papers/${encodeURIComponent(paperId)}/related`)
      .then((r) => {
        if (!alive) return;
        setData(r);
        // 相似有结果时默认展示相似，否则被引
        setTab(r.similar?.length ? 'similar' : 'citations');
      })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [paperId]);

  if (failed) return null; // 网络不可达时整块隐藏，不打扰阅读
  if (!data) {
    return (
      <Section title={t('paper.related')} icon={<Icon d={Icons.graph} size={11} color={T.business} />} accent={T.business}>
        <div style={{ color: T.caption, fontSize: 11 }}>{t('paper.relatedLoading')}</div>
      </Section>
    );
  }

  const tabs = ([
    { key: 'similar', list: data.similar ?? [] },
    { key: 'citations', list: data.citations ?? [] },
    { key: 'references', list: data.references ?? [] },
  ] as { key: 'similar' | 'citations' | 'references'; list: RelatedWorkLite[] }[]).filter((x) => x.list.length > 0);
  const list = tabs.find((x) => x.key === tab)?.list ?? [];

  const addToLibrary = async (w: RelatedWorkLite) => {
    if (saving.has(w.openalexId)) return;
    setSaving((cur) => new Set(cur).add(w.openalexId));
    try {
      const res = await api<{ created: boolean; duplicate: boolean; paper: Paper }>('/scholar/papers', {
        method: 'POST',
        body: JSON.stringify({
          title: w.title, authors: w.authors, year: w.year, venue: w.venue,
          doi: w.doi ?? '', arxivId: w.arxivId ?? '', tags: [], notes: '', summary: '', abstract: '',
          url: '', importance: 3, readStatus: 'want',
        }),
      });
      setAdded((cur) => new Map(cur).set(w.openalexId, res.paper.id));
      notify(t('paper.addedToast', { title: w.title.slice(0, 30) }));
      onAdded();
    } catch (e) {
      notify(`${t('paper.addToLib')} ✗: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving((cur) => { const n = new Set(cur); n.delete(w.openalexId); return n; });
    }
  };

  return (
    <Section
      title={t('paper.related')}
      sub={t('paper.relatedSub')}
      icon={<Icon d={Icons.graph} size={11} color={T.business} />}
      accent={T.business}
    >
      {tabs.length === 0 ? (
        <div style={{ color: T.caption, fontSize: 11.5 }}>{data.note || t('paper.relatedEmpty')}</div>
      ) : (
        <div data-dsh-plugin="dsh-scholar" data-dsh-part="related-papers">
          <div style={{ display: 'flex', gap: 5, marginBottom: 7 }}>
            {tabs.map((x) => (
              <Chip
                key={x.key}
                label={`${{ similar: t('paper.relatedSimilar'), citations: t('paper.relatedCitations'), references: t('paper.relatedRefs') }[x.key]} ${x.list.length}`}
                active={tab === x.key}
                onClick={() => setTab(x.key)}
              />
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {list.map((w) => {
              const libId = w.libraryPaperId ?? added.get(w.openalexId);
              const inLib = !!libId;
              return (
                <div
                  key={w.openalexId}
                  data-dsh-part="related-item"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 9,
                    padding: '7px 9px', background: T.cardBg,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 11.5, fontWeight: 600, lineHeight: 1.4,
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                    }}>{w.title}</div>
                    <div style={{ fontSize: 10, color: T.caption, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {w.year ?? '—'}{w.venue ? ` · ${truncate(w.venue, 22)}` : ''} · {t('paper.relatedCited', { count: w.citedBy })}
                    </div>
                  </div>
                  {inLib ? (
                    <span
                      data-dsh-part="related-inlib"
                      title={t('paper.inLibrary')}
                      onClick={() => libId && navBus.go('papers', libId)}
                      style={{
                        flex: 'none', fontSize: 10, color: T.success, cursor: 'pointer',
                        padding: '2px 8px', borderRadius: 999,
                        background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #30a46c) 12%, transparent)',
                        border: '1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary, #30a46c) 30%, transparent)',
                      }}
                    >{t('paper.inLibrary')} ✓</span>
                  ) : (
                    <button
                      type="button"
                      data-dsh-part="related-add"
                      disabled={saving.has(w.openalexId)}
                      onClick={() => void addToLibrary(w)}
                      style={{
                        flex: 'none', fontSize: 10.5, cursor: 'pointer', padding: '2px 9px', borderRadius: 999,
                        color: T.business, background: 'color-mix(in srgb, var(--sch-accent) 12%, transparent)',
                        border: '1px solid color-mix(in srgb, var(--sch-accent) 35%, transparent)',
                      }}
                    >{saving.has(w.openalexId) ? '…' : `＋ ${t('paper.addToLib')}`}</button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Section>
  );
}

export function PaperLibraryView({ t }: { t: TFunc }) {
  const loadSeq = useRef(0);
  const papersLenRef = useRef(0);
  const [papers, setPapers] = useState<Paper[]>([]);
  papersLenRef.current = papers.length;
  const [tags, setTags] = useState<string[]>([]);
  const [cols, setCols] = useState<PaperCollection[]>([]);
  const [projects, setProjects] = useState<ResearchProject[]>([]);
  /** 课题组筛选：选中某研究项目后只看其 paperIds */
  const [projectId, setProjectId] = useState('');
  const [projectsRailOpen, setProjectsRailOpen] = useState(() => loadRailOpen(PROJECTS_RAIL_OPEN_KEY, true));
  const [collectionsRailOpen, setCollectionsRailOpen] = useState(() => loadRailOpen(COLLECTIONS_RAIL_OPEN_KEY, true));
  const [colModal, setColModal] = useState(false);
  const [loading, setLoading] = useState(true);
  /** list-fetch failures only — cleared by the next successful load */
  const [loadError, setLoadError] = useState('');
  /** per-action failures (open/edit/delete/jump) — NOT cleared by background loads */
  const [actionError, setActionError] = useState('');
  /** E03:关联卡片独立加载错误(与主详情错误分离) */
  const [cardsError, setCardsError] = useState('');
  /** 非致命降级(collections/config 加载失败)的提示条 */
  const [degraded, setDegraded] = useState('');
  const shownError = actionError || loadError;
  const [selected, setSelected] = useState<Paper | null>(null);
  /* 详情页弹层状态：PDF 全文 / 摘要折叠 / 精读面板（声明必须在 selected 之后） */
  const [pdfOpen, setPdfOpen] = useState(false);
  const [citeFmt, setCiteFmt] = useState<CitationFmt>('gb');
  const [citeOpen, setCiteOpen] = useState(false);
  const [absOpen, setAbsOpen] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [related, setRelated] = useState<IdeaCard[]>([]);
  const [form, setForm] = useState<{ mode: 'new' | 'edit'; paper: Paper } | null>(null);
  /** 表单脏数据保护:任一字段改过即置位,关闭前 confirm */
  const [formDirty, setFormDirty] = useState(false);
  const [defaultTags, setDefaultTags] = useState<string[]>([]);
  /** PDF 上传中:入口禁用 + 显示"上传中…" */
  const [uploadingPdf, setUploadingPdf] = useState(false);
  /** Zotero 双向同步中 */
  const [zoteroSyncing, setZoteroSyncing] = useState(false);
  /** 开放检索 / BibTeX 导入面板 */
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [bibImportOpen, setBibImportOpen] = useState(false);
  /** 全量（未筛选）论文：分区计数 + BibTeX 全库导出用 */
  const [allPapers, setAllPapers] = useState<Paper[]>([]);
  const layoutRef = useRef<HTMLDivElement>(null);
  const [compactLayout, setCompactLayout] = useState(false);
  const [railChoice, setRailChoice] = useState<boolean | null>(null);
  const railOpen = railChoice ?? !compactLayout;
  useEffect(() => {
    const root = layoutRef.current;
    if (!root) return;
    const observer = new ResizeObserver(() => setCompactLayout(root.clientWidth <= 520));
    observer.observe(root);
    setCompactLayout(root.clientWidth <= 520);
    return () => observer.disconnect();
  }, []);
  /** 保存的筛选（命名查询） */
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>(() => {
    try { return JSON.parse(localStorage.getItem(SAVED_SEARCHES_KEY) ?? '[]') as SavedSearch[]; } catch { return []; }
  });
  /** 绿色成功提示（BibTeX 复制等），2.5s 自动消失 */
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 2500);
  }, []);
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  /** 浏览足迹：最近在看（localStorage 持久，去重上限 15） */
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const pushRecent = useCallback((id: string) => {
    setRecent((cur) => {
      const next = [id, ...cur.filter((x) => x !== id)].slice(0, 15);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* 存储异常降级为会话内 */ }
      return next;
    });
  }, []);

  // 恢复上次的筛选/排序(同 tab 会话级持久)
  const [saved] = useState(() => loadSavedFilters<{
    q: string; tag: string; yearFrom: string; yearTo: string; importance: string; col: string; sort: string; readStatus: string;
  }>(FILTERS_KEY));
  const [q, setQ] = useState(saved.q ?? '');
  const [tag, setTag] = useState(saved.tag ?? '');
  const [yearFrom, setYearFrom] = useState(saved.yearFrom ?? '');
  const [yearTo, setYearTo] = useState(saved.yearTo ?? '');
  const [importance, setImportance] = useState(saved.importance ?? '');
  const [readStatus, setReadStatus] = useState<ReadStatus | ''>(saved.readStatus ? (saved.readStatus as ReadStatus) : '');
  const [col, setCol] = useState(saved.col ?? '');
  const [unfiled, setUnfiled] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sort, setSort] = useState(saved.sort ?? 'createdAt');

  const debouncedQ = useDebounced(q, 250);

  const loadCols = useCallback(async () => {
    try {
      const r = await api<{ collections: PaperCollection[] }>('/scholar/collections');
      setCols(r.collections);
      // if the active filter targets a collection that no longer exists
      // (deleted in this or another view), fall back to "all" instead of
      // silently filtering against a ghost id
      setCol((cur) => (cur && !r.collections.some((c) => c.id === cur) ? '' : cur));
      setDegraded('');
    } catch (e) {
      // collections 加载失败不再静默:控制台留痕 + UI 提示条
      console.warn('dsh-scholar: collections load failed', e);
      setDegraded(t('common.partialLoadFailed'));
    }
  }, [t]);

  const loadProjects = useCallback(async () => {
    try {
      const r = await api<{ projects: ResearchProject[] }>('/scholar/projects');
      setProjects(r.projects ?? []);
      setProjectId((cur) => (cur && !(r.projects ?? []).some((p) => p.id === cur) ? '' : cur));
    } catch (e) {
      console.warn('dsh-scholar: projects load failed', e);
    }
  }, []);

  const toggleProjectsRail = useCallback(() => {
    setProjectsRailOpen((cur) => {
      const next = !cur;
      try { localStorage.setItem(PROJECTS_RAIL_OPEN_KEY, next ? '1' : '0'); } catch { /* quota */ }
      return next;
    });
  }, []);

  const toggleCollectionsRail = useCallback(() => {
    setCollectionsRailOpen((cur) => {
      const next = !cur;
      try { localStorage.setItem(COLLECTIONS_RAIL_OPEN_KEY, next ? '1' : '0'); } catch { /* quota */ }
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    // Keep existing cards visible while refreshing so theme churn / remount
    // races do not flash an empty skeleton that Playwright treats as "stuck".
    if (papersLenRef.current === 0) setLoading(true);
    const filtersEmpty = !debouncedQ && !tag && !yearFrom && !yearTo
      && !importance && !col && !unfiled && !readStatus;
    try {
      const data = await api<{ papers: Paper[]; tags: string[] }>(
        `/scholar/papers${qs({ q: debouncedQ, tag, yearFrom, yearTo, importance, collection: col || undefined, unfiled: unfiled ? 1 : undefined, readStatus: readStatus || undefined, sort })}`,
      );
      if (seq !== loadSeq.current) return; // 已有更新的请求,丢弃过期响应
      setPapers(data.papers);
      setTags(data.tags);
      // 无筛选时列表即全库：复用结果填 allPapers，跳过二次 loadAll
      if (filtersEmpty) setAllPapers(data.papers);
      setLoadError('');
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [debouncedQ, tag, yearFrom, yearTo, importance, readStatus, col, unfiled, sort]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { loadSeq.current += 1; }, []);
  useEffect(() => { void loadCols(); }, [loadCols]);
  useEffect(() => { void loadProjects(); }, [loadProjects]);

  /** 全量论文（分区计数 / BibTeX 导出）；lite=1 省带宽；失败静默降级 */
  const loadAll = useCallback(async () => {
    try {
      const r = await api<{ papers: Paper[] }>('/scholar/papers?sort=year&lite=1');
      setAllPapers(r.papers);
    } catch (e) {
      console.warn('dsh-scholar: full papers load failed', e);
    }
  }, []);

  const removeCollection = useCallback(async (id: string, name: string) => {
    if (!window.confirm(`${t('common.confirmDelete')}\n${name}\n${t('col.deleteHint')}`)) return;
    try {
      await api(`/scholar/collections/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (col === id) setCol('');
      setActionError('');
      await Promise.all([loadCols(), load(), loadAll()]);
      showNotice(t('col.deleted'));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }, [t, col, loadCols, load, loadAll, showNotice]);

  const [renamingProject, setRenamingProject] = useState<{ id: string; title: string } | null>(null);

  const renameProject = useCallback(async (id: string, title: string) => {
    const next = title.trim();
    if (!next) {
      setRenamingProject(null);
      return;
    }
    try {
      const r = await api<{ project: ResearchProject }>(`/scholar/projects/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ title: next }),
      });
      setProjects((cur) => cur.map((p) => (p.id === id ? { ...p, title: r.project.title } : p)));
      setRenamingProject(null);
      setActionError('');
      showNotice(t('project.renamed'));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }, [t, showNotice]);

  // 有筛选时才单独拉全库；无筛选由 load 合并填充（空字符串是未筛选，不是 null）
  const filtersEmpty = !debouncedQ && !tag && !yearFrom && !yearTo
    && !importance && !col && !unfiled && !readStatus;
  useEffect(() => {
    if (filtersEmpty) return;
    void loadAll();
  }, [loadAll, filtersEmpty]);

  // 筛选/排序变化即落盘(会话级)
  useEffect(() => {
    saveFilters(FILTERS_KEY, { q, tag, yearFrom, yearTo, importance, readStatus, col, sort });
  }, [q, tag, yearFrom, yearTo, importance, readStatus, col, sort]);

  // load default tags for the create form; config 晚到也会经 PaperForm 内的
  // effect 补上,不在打开表单的瞬间固化空数组
  useEffect(() => {
    void api<{ config: { defaultTags?: string[] } }>('/scholar/config')
      .then((r) => setDefaultTags(r.config.defaultTags ?? []))
      .catch((e) => {
        console.warn('dsh-scholar: config load failed', e);
        setDegraded(t('common.partialLoadFailed'));
      });
  }, [t]);

  // cross-view jump: open a specific paper (from graph / cards)
  const nav = useNav();
  useEffect(() => {
    if (nav.paperId) {
      void openPaper(nav.paperId);
      navBus.consumePaperId();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav.paperId]);

  const detailSeq = useRef(0);
  const detailTarget = useRef<string | null>(null);
  const cardsSeq = useRef(0);
  const leavePaper = () => { ++detailSeq.current; ++cardsSeq.current; detailTarget.current = null; setSelected(null); };
  useEffect(() => () => { ++detailSeq.current; ++cardsSeq.current; detailTarget.current = null; }, []);
  const loadCards = useCallback(async (id: string) => {
    const token = ++cardsSeq.current;
    try {
      const cards = await api<{ cards: IdeaCard[] }>(`/scholar/cards${qs({ paperId: id })}`);
      if (token !== cardsSeq.current || detailTarget.current !== id) return;
      setRelated(cards.cards ?? []); setCardsError('');
    } catch {
      if (token === cardsSeq.current && detailTarget.current === id) setCardsError(t('paper.cardsLoadFailed'));
    }
  }, [t]);
  const openPaper = useCallback(async (id: string, refresh = false) => {
    const token = ++detailSeq.current;
    const same = detailTarget.current === id;
    if (refresh && !same) return;
    detailTarget.current = id;
    if (!same) { setSelected(null); setRelated([]); setCardsError(''); }
    try {
      const detail = await api<{ paper: Paper }>(`/scholar/papers/${encodeURIComponent(id)}`);
      if (detailSeq.current !== token || detailTarget.current !== id) return;
      setSelected(detail.paper); setActionError(''); pushRecent(id);
      // 浏览详情不自动抢侧栏；全文/侧栏按钮才进入阅读态
    } catch (e) {
      if (detailSeq.current !== token) return;
      setActionError(e instanceof Error ? e.message : String(e));
      return;
    }
    await loadCards(id);
  }, [pushRecent, loadCards]);

  // 切换论文时重置详情弹层（必须在 selected/各 state 声明之后）
  useEffect(() => { setPdfOpen(false); setAbsOpen(false); setCiteOpen(false); setLaunchOpen(false); }, [selected?.id]);

  // 后台精读完成 → 刷新列表/全量缓存/打开中的详情（summary 已回填、报告已归档）
  useEffect(() => {
    const h = () => {
      void load();
      void loadAll();
      if (selected) void openPaper(selected.id, true);
    };
    window.addEventListener('scholar:read-done', h);
    return () => window.removeEventListener('scholar:read-done', h);
  }, [load, loadAll, openPaper, selected]);

  const savePaper = async (paper: Paper, isNew: boolean) => {
    const body = {
      title: paper.title,
      authors: paper.authors,
      year: paper.year,
      venue: paper.venue,
      arxivId: paper.arxivId,
      doi: paper.doi,
      url: paper.url,
      abstract: paper.abstract,
      summary: paper.summary,
      tags: paper.tags,
      importance: paper.importance,
      readStatus: paper.readStatus,
      notes: paper.notes,
      collectionIds: paper.collectionIds ?? [],
    };
    try {
      if (isNew) {
        const res = await api<{ created: boolean; duplicate?: boolean; paper: Paper }>('/scholar/papers', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (res.duplicate) setActionError(`${t('paper.duplicateHint')}: ${res.paper.title}`);
      } else {
        const res = await api<{ paper: Paper }>(`/scholar/papers/${encodeURIComponent(paper.id)}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
        setSelected(cur => cur?.id === paper.id ? res.paper : cur);
      }
      setForm(null);
      setFormDirty(false);
      await Promise.all([load(), loadAll()]);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  const removePaper = async (id: string) => {
    if (!window.confirm(t('common.confirmDelete'))) return;
    try {
      await api(`/scholar/papers/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (detailTarget.current === id) leavePaper();
      await Promise.all([load(), loadAll()]);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  const quickPatch = (paper: Paper, patch: Partial<Pick<Paper, 'importance' | 'readStatus' | 'lifecycle'>>) =>
    queueMutation('paper:' + paper.id, async () => {
      try {
        const res = await api<{ paper: Paper }>(`/scholar/papers/${encodeURIComponent(paper.id)}`, { method: 'PUT', body: JSON.stringify(patch) });
        // A response may contain other fields from an earlier server snapshot.
        const fields = Object.fromEntries(Object.keys(patch).map(key => [key, res.paper[key as keyof Paper]]));
        const update = (p: Paper) => p.id === paper.id ? { ...p, ...fields } : p;
        setPapers(cur => cur.map(update)); setAllPapers(cur => cur.map(update));
        setSelected(cur => cur ? update(cur) : cur);
      } catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
    });
  const quickImportance = (paper: Paper, importance: number) => quickPatch(paper, { importance });
  const quickReadStatus = (paper: Paper, readStatus: ReadStatus) => quickPatch(paper, { readStatus });
  const quickLifecycle = (paper: Paper, lifecycle: PaperLifecycle) => quickPatch(paper, { lifecycle });

  const saveAsEvidence = async (paper: Paper) => {
    const claim = (paper.summary || paper.title || '').trim().slice(0, 240);
    if (!claim) return;
    try {
      await api('/scholar/evidences', {
        method: 'POST',
        body: JSON.stringify({ claim, paperId: paper.id, kind: 'author_claim', confidence: 3 }),
      });
      showNotice(t('paper.evidenceOk'));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  const linkToCurrentProject = async (paper: Paper) => {
    const pid = getCurrentProjectId();
    if (!pid) {
      showNotice(t('paper.linkProjectNone'));
      navBus.go('projects');
      return;
    }
    try {
      await api(`/scholar/projects/${encodeURIComponent(pid)}/link`, {
        method: 'POST',
        body: JSON.stringify({ paperIds: [paper.id] }),
      });
      const refreshed = await api<{ paper: Paper }>(`/scholar/papers/${encodeURIComponent(paper.id)}`);
      setSelected(refreshed.paper);
      setPapers((cur) => cur.map((p) => (p.id === paper.id ? refreshed.paper : p)));
      setAllPapers((cur) => cur.map((p) => (p.id === paper.id ? refreshed.paper : p)));
      void loadProjects();
      showNotice(t('paper.linkProjectOk'));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  /** 复制单篇 BibTeX 到剪贴板 */
  const copyBibtex = async (paper: Paper) => {
    try {
      await navigator.clipboard.writeText(paperToBibtex(paper));
      showNotice(t('paper.bibtexCopied'));
    } catch {
      setActionError(t('paper.bibtexCopyFail'));
    }
  };

  /** 全库导出 .bib（用全量列表，不受当前筛选影响） */
  const exportBibtex = () => {
    if (allPapers.length === 0) { setActionError(t('paper.bibtexEmpty')); return; }
    downloadTextFile('scholar-library.bib', libraryToBibtex(allPapers) + '\n', 'application/x-bibtex;charset=utf-8');
  };

  /* ---------- saved searches（命名筛选，Zotero smart collections 式） ---------- */
  const persistSavedSearches = (list: SavedSearch[]) => {
    setSavedSearches(list);
    try { localStorage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(list)); } catch { /* 存满等异常降级为会话内 */ }
  };

  const saveCurrentSearch = () => {
    const name = window.prompt(t('paper.saveSearchPrompt'));
    if (!name || !name.trim()) return;
    persistSavedSearches([...savedSearches, {
      id: `ss_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: name.trim(),
      f: { q, tag, yearFrom, yearTo, importance, readStatus, col, unfiled },
    }]);
  };

  const applySavedSearch = (ss: SavedSearch) => {
    setQ(ss.f.q); setTag(ss.f.tag); setYearFrom(ss.f.yearFrom); setYearTo(ss.f.yearTo);
    setImportance(ss.f.importance); setReadStatus(ss.f.readStatus as ReadStatus | ''); setCol(ss.f.col);
    setUnfiled(ss.f.unfiled === true); // 旧数据无此字段 → false
  };

  const removeSavedSearch = (id: string) => {
    persistSavedSearches(savedSearches.filter((s) => s.id !== id));
  };

  /** Upload / replace the PDF attached to a saved paper. */
  const uploadPdf = async (paper: Paper, file: File | null | undefined) => {
    if (!file || uploadingPdf) return;
    if (file.size > 50 * 1024 * 1024) { setActionError(t('paper.pdfSizeLimit')); return; }
    setUploadingPdf(true);
    try {
      await api(`/scholar/papers/${encodeURIComponent(paper.id)}/pdf`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      });
      const fresh = await api<{ paper: Paper }>(`/scholar/papers/${encodeURIComponent(paper.id)}`);
      // 上传期间用户可能已返回列表——仅当仍停留在同一篇详情时才更新,
      // 避免"复活"已退出的详情页
      setSelected((cur) => (cur && cur.id === paper.id ? fresh.paper : cur));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploadingPdf(false);
    }
  };

  const syncZotero = async () => {
    if (zoteroSyncing) return;
    setZoteroSyncing(true);
    setActionError('');
    try {
      const r = await api<ZoteroSyncResult>('/scholar/zotero/sync', {
        method: 'POST',
        body: JSON.stringify({ direction: 'both' }),
      });
      showNotice(t('settings.zoteroSyncDone', {
        pulled: Object.values(r.pulled).reduce((a, b) => a + b, 0),
        pushed: Object.values(r.pushed).reduce((a, b) => a + b, 0),
        conflicts: r.conflicts,
      }));
      if (r.errors?.length) setActionError(r.errors.slice(0, 2).join('; '));
      await Promise.all([load(), loadAll()]);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setZoteroSyncing(false);
    }
  };

  /** 关闭表单前若有未保存修改,先 confirm */
  const closeForm = () => {
    if (formDirty && !window.confirm(t('common.confirmDiscard'))) return;
    setForm(null);
    setFormDirty(false);
  };

  /** 课题组筛选后的列表（与其它服务端筛选项叠加） */
  const listedPapers = useMemo(() => {
    if (!projectId) return papers;
    const proj = projects.find((p) => p.id === projectId);
    if (!proj) return papers;
    const allow = new Set(proj.paperIds);
    return papers.filter((p) => allow.has(p.id));
  }, [papers, projectId, projects]);

  /** 年份分组（sort=year 时）：年份降序 + 粘性组头；无年份的沉底。
   *  注意必须位于所有条件 return 之前（Hooks 规则）——详情/表单视图同样会执行此 hook。 */
  const yearGroups = useMemo(() => {
    if (sort !== 'year') return null;
    const withYear = new Map<number, Paper[]>();
    const noYear: Paper[] = [];
    for (const p of listedPapers) {
      if (p.year) {
        if (!withYear.has(p.year)) withYear.set(p.year, []);
        withYear.get(p.year)!.push(p);
      } else noYear.push(p);
    }
    const groups = [...withYear.entries()].sort((a, b) => b[0] - a[0]).map(([y, list]) => ({ y: String(y), list }));
    if (noYear.length) groups.push({ y: '', list: noYear });
    return groups;
  }, [listedPapers, sort]);

  /** 键盘导航用的平铺顺序（分组视图=组序拼接）；同样必须在条件 return 之前 */
  const flatPapers = useMemo(() => (yearGroups ? yearGroups.flatMap((g) => g.list) : listedPapers), [yearGroups, listedPapers]);
  const flatIdxOf = useMemo(() => new Map(flatPapers.map((p, i) => [p.id, i])), [flatPapers]);
  /** 键盘选中下标（null=未启用）；仅列表视图生效 */
  const [cursorIdx, setCursorIdx] = useState<number | null>(null);

  // 列表变化后游标越界即复位（筛选/搜索导致）
  useEffect(() => {
    if (cursorIdx !== null && cursorIdx >= flatPapers.length) setCursorIdx(null);
  }, [flatPapers.length, cursorIdx]);

  // 键盘导航：列表视图 ↑↓ 移动、Enter 打开、Esc 清除；详情视图 Esc 返回
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement | null)?.isContentEditable) return;
      if (e.key === 'Escape') {
        if (selected || detailTarget.current) leavePaper();
        else setCursorIdx(null);
        return;
      }
      if (form || selected) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setCursorIdx((cur) => {
          const n = flatPapers.length;
          if (!n) return null;
          if (cur === null) return 0;
          return Math.max(0, Math.min(n - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)));
        });
      } else if (e.key === 'Enter') {
        if (cursorIdx !== null && flatPapers[cursorIdx]) {
          // 焦点若停在某个按钮上（如刚点过的卡片），Enter 还会触发按钮原生激活
          // → 两篇论文竞态打开；preventDefault 抑制原生点击，只走键盘游标
          e.preventDefault();
          void openPaper(flatPapers[cursorIdx].id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [form, selected, flatPapers, cursorIdx, openPaper]);

  // 游标移动后滚动到可见（nearest 避免列表跳动）
  useEffect(() => {
    if (cursorIdx === null) return;
    const el = document.querySelectorAll('[data-dsh-part="paper-card"]')[cursorIdx];
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursorIdx]);

  /** 侧栏底部统计（全量口径）：年份分布 / 阅读状态 / top 标签 */
  const railStats = useMemo(() => {
    const byYear = new Map<number, number>();
    const rs: Record<'want' | 'reading' | 'done', number> = { want: 0, reading: 0, done: 0 };
    const tagCount = new Map<string, number>();
    for (const p of allPapers) {
      if (p.year) byYear.set(p.year, (byYear.get(p.year) ?? 0) + 1);
      // 手改磁盘等途径可能写入非法枚举——按 want 兜底，避免 NaN 计数
      const rsKey = (READ_STATUSES as readonly string[]).includes(p.readStatus ?? 'want') ? (p.readStatus ?? 'want') : 'want';
      rs[rsKey as 'want' | 'reading' | 'done']++;
      for (const tg of p.tags) tagCount.set(tg, (tagCount.get(tg) ?? 0) + 1);
    }
    const years = [...byYear.entries()]
      .filter(([y]) => y >= 1990 && y <= new Date().getFullYear() + 1)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 4);
    const topTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    return { years, maxYear: Math.max(1, ...years.map(([, n]) => n)), rs, topTags };
  }, [allPapers]);

  /* ---------- form (new / edit) ---------- */
  if (form) {
    return (
      <div className="sch-scroll sch-fade" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 12px', fontSize: 12 }}>
        <SchStyles />
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <Btn onClick={closeForm}><Icon d={Icons.back} size={12} /> {t('common.back')}</Btn>
          <span style={{ fontWeight: 600, marginLeft: 10 }}>
            {form.mode === 'new' ? t('paper.new') : t('paper.edit')}
          </span>
        </div>
        <PaperForm
          initial={form.paper}
          defaultTags={form.mode === 'new' ? defaultTags : []}
          collections={cols}
          onSave={(p) => void savePaper(p, form.mode === 'new')}
          onCancel={closeForm}
          onTouch={() => setFormDirty(true)}
          t={t}
        />
        {shownError && <div style={{ color: T.danger, marginTop: 6 }}>{shownError}</div>}
      </div>
    );
  }

  /* ---------- detail ---------- */
  if (selected) {
    return (
      <div className="sch-scroll sch-fade sch-detail" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 0, fontSize: 12 }} key={selected.id}>
        <SchStyles />
        <div className="sch-detail-top">
          <Btn onClick={leavePaper}><Icon d={Icons.back} size={12} /> {t('common.back')}</Btn>
          <span style={{ flex: 1 }} />
          <Chip label={selected.source === 'agent' ? t('paper.sourceAgent') : t('paper.sourceManual')} />
          {rightbarAvailable() && (
            <IconButton
              label={t('rightbar.open')}
              onClick={() => {
                void openPaperPdfInSidebar(selected.id, selected.title).then((ok) => {
                  if (!ok) setPdfOpen(true);
                });
              }}
              icon={<Icon d={Icons.sidebarRight} size={14} />}
            />
          )}
          <IconButton label={t('common.edit')} onClick={() => { ++detailSeq.current; ++cardsSeq.current; setForm({ mode: 'edit', paper: { ...selected } }); }} icon={<Icon d={Icons.edit} size={14} />} />
          <IconButton label={t('common.delete')} color={T.danger} onClick={() => void removePaper(selected.id)} icon={<Icon d={Icons.trash} size={14} />} />
        </div>
        <div className="sch-detail-body">

        {/* Hero：书目主信息一屏内可读完 */}
        <div className="sch-detail-hero">
          <h2>{selected.title}</h2>
          {selected.authors.length > 0 && (
            <div style={{ marginTop: 5, fontSize: 11, color: T.secondary, lineHeight: 1.55 }}>
              {selected.authors.length > 6
                ? selected.authors.slice(0, 6).join(', ') + ' et al.'
                : selected.authors.join(', ')}
            </div>
          )}
          <div style={{ marginTop: 7, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {(() => {
              const name = (selected.venue ?? '').trim();
              const tier = venueTier(selected.venue);
              if (!name && !selected.arxivId) return null;
              return (
                <span style={{
                  fontSize: 10, fontWeight: 500, padding: '1px 7px', borderRadius: 6,
                  color: T.secondary, background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.07))',
                  border: '1px solid var(--dsw-alias-border-l2)',
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                }}>
                  {name || (selected.arxivId ? 'arXiv' : '')}
                  {tier && <span style={{ fontWeight: 700, color: 'var(--dsw-alias-label-primary)' }}>{tier}</span>}
                </span>
              );
            })()}
            {selected.year ? <span style={{ fontSize: 10.5, color: T.caption, fontVariantNumeric: 'tabular-nums' }}>{String(selected.year)}</span> : null}
            {selected.arxivId && (
              <a
                href={/^https?:/i.test(selected.arxivId) ? selected.arxivId : `https://arxiv.org/abs/${encodeURIComponent(selected.arxivId)}`}
                target="_blank" rel="noreferrer noopener"
                style={{ fontFamily: MONO, fontSize: 10.5, color: T.business }}
              >arXiv:{selected.arxivId}</a>
            )}
            {selected.doi && (
              <a
                href={/^https?:/i.test(selected.doi) ? selected.doi : `https://doi.org/${encodeURIComponent(selected.doi)}`}
                target="_blank" rel="noreferrer noopener"
                style={{ fontFamily: MONO, fontSize: 10.5, color: T.business, wordBreak: 'break-all' }}
              >DOI</a>
            )}
          </div>
          {(selected.tags.length > 0 || (selected.collectionIds ?? []).length > 0) && (
            <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              {(selected.collectionIds ?? []).map((cid) => {
                const c = cols.find((x) => x.id === cid);
                return c ? <Chip key={cid} label={c.name} color={c.color} /> : null;
              })}
              {selected.tags.map((tg) => <Chip key={tg} label={tg} />)}
            </div>
          )}
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Stars value={selected.importance ?? 0} onChange={(v) => void quickImportance(selected, v)} />
            <Chip label={lifecycleLabel(t, selected.lifecycle)} color="var(--sch-accent)" />
            {LIFECYCLE_NEXT[selected.lifecycle ?? 'saved'] && (
              <Btn tone="soft" onClick={() => {
                const next = LIFECYCLE_NEXT[selected.lifecycle ?? 'saved'];
                if (!next) return;
                void quickLifecycle(selected, next);
              }}>{t('paper.lifecycle.advance')} → {lifecycleLabel(t, LIFECYCLE_NEXT[selected.lifecycle ?? 'saved'])}</Btn>
            )}
            <Btn tone="soft" onClick={() => void saveAsEvidence(selected)}>{t('paper.toEvidence')}</Btn>
            <Btn tone="soft" onClick={() => void linkToCurrentProject(selected)}>{t('paper.linkProject')}</Btn>
            <span style={{ flex: 1 }} />
            <div className="sch-seg" role="group" aria-label={t('paper.readStatus')}>
              {READ_STATUSES.map((rs) => {
                const active = (selected.readStatus ?? 'want') === rs;
                const color = readStatusColor(rs);
                return (
                  <button
                    key={rs}
                    type="button"
                    className="sch-seg-item"
                    data-dsh-plugin="dsh-scholar"
                    data-dsh-part="read-status-btn"
                    aria-pressed={active}
                    onClick={() => { if (!active) void quickReadStatus(selected, rs); }}
                    style={active ? { color } : undefined}
                  >{t(READ_STATUS_LABELS[rs])}</button>
                );
              })}
            </div>
          </div>
        </div>

        {/* 主操作：浅色圆角托盘，滚动时贴在顶栏下方 */}
        <div className="sch-detail-actions" role="toolbar" aria-label={t('paper.study')}>
          <Btn
            tone="primary"
            data-dsh-part="detail-primary-read"
            onClick={() => setLaunchOpen(true)}
          ><Icon d={Icons.book} size={12} /> {t('paper.study')}</Btn>
          <span className="sch-detail-actions-sep" aria-hidden />
          <Btn tone="soft" onClick={() => {
            if (rightbarAvailable() && selected.pdfPath) {
              void openPaperPdfInSidebar(selected.id, selected.title).then((ok) => {
                if (!ok) setPdfOpen(true);
              });
            } else {
              setPdfOpen(true);
            }
          }}>
            <Icon d={Icons.doc} size={12} /> {t(rightbarAvailable() && selected.pdfPath ? 'paper.fulltext' : 'paper.fulltextFallback')}
          </Btn>
          {selected.pdfPath && (
            <>
              <a
                href={`/scholar/papers/${encodeURIComponent(selected.id)}/pdf`}
                download={`${selected.id}.pdf`}
                className="sch-btn sch-btn--soft"
                style={{ fontSize: 11, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0 8px', minHeight: 28 }}
              ><Icon d={Icons.doc} size={11} /> {t('paper.download')}</a>
              <a
                href={`/scholar/papers/${encodeURIComponent(selected.id)}/pdf`}
                target="_blank" rel="noreferrer noopener"
                className="sch-btn sch-btn--soft"
                style={{ fontSize: 11, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0 8px', minHeight: 28 }}
              ><Icon d={Icons.external} size={11} /> {t('paper.fulltextWin')}</a>
            </>
          )}
          <Btn tone="soft" onClick={() => {
            setCiteOpen(true);
            requestAnimationFrame(() => {
              document.querySelector('[data-dsh-part="citation-text"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
          }}>
            <Icon d={Icons.copy} size={12} /> {t('paper.cite')}
          </Btn>
          <span style={{ flex: 1 }} />
          <Btn tone="soft" onClick={() => {
            void (async () => {
              try {
                await api(`/scholar/papers/${encodeURIComponent(selected.id)}/obsidian`, {
                  method: 'POST',
                  body: '{}',
                });
                showNotice(t('paper.obsidianPushed'));
              } catch (e) {
                setActionError(e instanceof Error ? e.message : String(e));
              }
            })();
          }}>
            <Icon d={Icons.download} size={12} /> {t('paper.obsidianPush')}
          </Btn>
          <Btn tone="soft" onClick={() => void copyBibtex(selected)}>
            <Icon d={Icons.doc} size={12} /> BibTeX
          </Btn>
        </div>

        <PaperStudyCard paperId={selected.id} t={t} />

        {selected.summary && (
          <Section title={t('paper.summary')} icon={<Icon d={Icons.sparkle} size={11} color={T.business} />} accent={T.business} style={{ marginTop: 2 }}>
            <div className="sch-prose" style={{ textAlign: 'start', wordSpacing: 'normal', letterSpacing: 'normal' }}>{selected.summary}</div>
          </Section>
        )}

        {/* 摘要优先于引用：先读内容再取格式 */}
        {selected.abstract && (
          <Section title={t('paper.abstract')}>
            <div
              className="sch-prose"
              style={{
                color: T.secondary,
                display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: absOpen ? 'unset' : 3,
                overflow: 'hidden',
              }}
            >{selected.abstract}</div>
            {selected.abstract.length > 160 && (
              <button
                type="button"
                data-dsh-part="abstract-toggle"
                onClick={() => setAbsOpen((v) => !v)}
                style={{ all: 'unset', cursor: 'pointer', fontSize: 10.5, color: T.business, marginTop: 4 }}
              >{t(absOpen ? 'paper.abstractCollapse' : 'paper.abstractExpand', { count: String(selected.abstract.length) })}</button>
            )}
          </Section>
        )}

        <Section style={{ marginTop: 2 }}>
          <Meta
            k="URL" v={selected.url ? (
              isHttpUrl(selected.url) ? (
                <a href={selected.url} target="_blank" rel="noreferrer noopener" style={{ color: T.business, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>{truncate(urlLabel(selected.url), 46)}</span>
                  <Icon d={Icons.external} size={11} />
                </a>
              ) : (
                <span style={{ wordBreak: 'break-all' }}>{selected.url}</span>
              )
            ) : undefined}
          />
          <Meta
            k={t('paper.pdf')}
            v={
              selected.pdfPath ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => {
                      if (rightbarAvailable()) {
                        void openPaperPdfInSidebar(selected.id, selected.title).then((ok) => {
                          if (!ok) setPdfOpen(true);
                        });
                      } else setPdfOpen(true);
                    }}
                    style={{ color: T.business, display: 'inline-flex', alignItems: 'center', gap: 3, background: 'none', border: 0, padding: 0, cursor: 'pointer', fontSize: 'inherit' }}
                  >
                    {t(rightbarAvailable() ? 'paper.pdfOpen' : 'paper.fulltextFallback')} {rightbarAvailable() ? <Icon d={Icons.sidebarRight} size={11} /> : <Icon d={Icons.doc} size={11} />}
                  </button>
                  <label style={{ cursor: uploadingPdf ? 'default' : 'pointer', color: T.caption, fontSize: 11, textDecorationLine: 'underline', opacity: uploadingPdf ? 0.55 : 1 }}>
                    {uploadingPdf ? t('paper.pdfUploading') : t('paper.pdfReplace')}
                    <input type="file" accept="application/pdf,.pdf" hidden disabled={uploadingPdf} onChange={(e) => { void uploadPdf(selected, e.target.files?.[0]); e.target.value = ''; }} />
                  </label>
                </span>
              ) : (
                <label style={{ cursor: uploadingPdf ? 'default' : 'pointer', color: T.business, fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4, opacity: uploadingPdf ? 0.55 : 1 }}>
                  <Icon d={Icons.doc} size={11} /> {uploadingPdf ? t('paper.pdfUploading') : t('paper.pdfUpload')}
                  <input type="file" accept="application/pdf,.pdf" hidden disabled={uploadingPdf} onChange={(e) => { void uploadPdf(selected, e.target.files?.[0]); e.target.value = ''; }} />
                </label>
              )
            }
          />
        </Section>

        {/* 引用：默认收起，点「引用」展开 */}
        <Section
          title={t('paper.citation')}
          icon={<Icon d={Icons.copy} size={11} color={T.business} />}
          accent={T.business}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: citeOpen ? 7 : 0, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => setCiteOpen((v) => !v)}
              style={{
                all: 'unset', cursor: 'pointer', fontSize: 11, color: T.business,
                display: 'inline-flex', alignItems: 'center', gap: 4,
              }}
            >
              <Icon d={citeOpen ? Icons.chevronDown : Icons.chevronRight} size={11} />
              {t(citeOpen ? 'paper.citationHide' : 'paper.citationShow')}
            </button>
            <span style={{ flex: 1 }} />
            {citeOpen && (
              <Btn tone="soft" onClick={() => {
                void navigator.clipboard.writeText(citationText(selected, citeFmt))
                  .then(() => showNotice(t('paper.citationCopied')))
                  .catch(() => setActionError(t('paper.bibtexCopyFail')));
              }}><Icon d={Icons.copy} size={11} /> {t('paper.copyCitation')}</Btn>
            )}
          </div>
          {citeOpen && (
            <>
              <SegGroup style={{ marginBottom: 7 }}>
                {CITATION_FORMATS.map((f) => (
                  <SegItem key={f} label={CIT_LABEL[f]} pressed={citeFmt === f} onClick={() => setCiteFmt(f)} />
                ))}
              </SegGroup>
              <div
                data-dsh-part="citation-text"
                style={{
                  fontFamily: MONO, fontSize: 11, lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))',
                  border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '8px 10px',
                  userSelect: 'all', color: T.secondary,
                }}
              >{citationText(selected, citeFmt)}</div>
            </>
          )}
        </Section>

        {has(selected.notes) && (
          <Section title={t('paper.notes')}>
            <div style={{ lineHeight: 1.6, color: T.secondary, whiteSpace: 'pre-wrap' }}>{selected.notes}</div>
          </Section>
        )}
        <PaperReports paperId={selected.id} t={t} notify={showNotice} />

        <PaperAsk
          key={selected.id}
          paperId={selected.id}
          t={t}
          onPageClick={(page) => {
            const iframe = document.querySelector<HTMLIFrameElement>(
              `iframe[title="${CSS.escape(selected.title)}"]`,
            ) ?? document.querySelector<HTMLIFrameElement>('iframe[src*="/scholar/papers/"][src*="/pdf"]');
            if (iframe) {
              const base = iframe.src.replace(/#.*$/, '');
              iframe.src = `${base}#page=${page}`;
            }
            const jump = () => {
              window.dispatchEvent(new CustomEvent('scholar:goto-page', { detail: { paperId: selected.id, page } }));
            };
            jump();
            if (iframe || pdfOpen) return;
            if (rightbarAvailable() && selected.pdfPath) {
              void openPaperPdfInSidebar(selected.id, selected.title).then((ok) => {
                if (ok) window.setTimeout(jump, 320);
                else {
                  showNotice(t('rightbar.gotoNeedOpen'));
                  setPdfOpen(true);
                }
              });
              return;
            }
            showNotice(t('rightbar.gotoNeedOpen'));
            if (selected.pdfPath) setPdfOpen(true);
          }}
        />

        <PaperRelated
          paperId={selected.id}
          t={t}
          notify={showNotice}
          onAdded={() => { void load(); void loadAll(); }}
        />

        <div style={{ marginTop: 12, borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 7 }}>
            <span style={{ fontSize: 11, fontWeight: 600 }}>{t('paper.relatedCards')}</span>
            <span style={{ flex: 1 }} />
            <Btn onClick={() => {
              void (async () => {
                let researchFocus = '';
                try {
                  const cfg = await api<{ config: { researchFocus?: string } }>('/scholar/config');
                  researchFocus = (cfg.config.researchFocus ?? '').trim();
                } catch { /* optional */ }
                const prompt = buildPaperGenerateCardsPrompt({
                  paper: selected,
                  researchFocus,
                  relatedCardTitles: related.map((c) => c.title),
                });
                deliverToComposer(prompt, (r) => {
                  showNotice(t(
                    r === 'sent' || r === 'filled' ? 'card.genFilled'
                      : r === 'clipboard' ? 'card.genCopied'
                        : 'card.genFailed',
                  ));
                });
              })();
            }}>
              <Icon d={Icons.sparkle} size={11} /> {t('card.genForPaper')}
            </Btn>
            <Btn onClick={() => navBus.go('cards', undefined, undefined, selected.id)}>
              <Icon d={Icons.plus} size={11} /> {t('paper.addCard')}
            </Btn>
          </div>
          {cardsError && (
            <div style={{ color: 'var(--dsw-alias-state-danger-primary)', fontSize: 11, lineHeight: 1.6, display: 'flex', gap: 8, alignItems: 'center' }}>
              <span>{cardsError}</span>
              <Btn onClick={() => { if (selected) void loadCards(selected.id); }}>
                <Icon d={Icons.refresh} size={10} /> {t('paper.retry')}
              </Btn>
            </div>
          )}
          {related.length === 0 && !cardsError && <div style={{ color: T.caption, fontSize: 11, lineHeight: 1.6 }}>{t('paper.noRelatedCards')}</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {related.map((c) => (
              <button
                key={c.id}
                type="button"
                data-dsh-plugin="dsh-scholar"
                data-dsh-part="idea-card-ref"
                className="sch-card sch-press"
                onClick={() => navBus.go('cards', undefined, c.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                  border: '1px solid var(--dsw-alias-border-l2)', background: T.cardBg, borderRadius: 9,
                  padding: '8px 10px', cursor: 'pointer', color: 'var(--dsw-alias-label-primary)',
                }}
              >
                <span aria-hidden style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, background: T.caption, opacity: .5 }} />
                <span style={{ flex: 1, overflow: 'hidden' }}>
                  <span style={{ display: 'block', fontSize: 11.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
                  <span style={{ display: 'block', fontSize: 10.5, color: T.secondary, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.insight}</span>
                </span>
                <Stars value={c.importance} size={9} />
              </button>
            ))}
          </div>
        </div>

        {/* PDF 全文弹窗：浏览器原生 iframe 渲染 + 新窗/下载；无 PDF=虚线上传区 */}
        {pdfOpen && (
          <Modal title={t('paper.fulltitleModal')} onClose={() => setPdfOpen(false)} width={720}>
            {selected.pdfPath ? (
              <>
                <iframe
                  src={`/scholar/papers/${encodeURIComponent(selected.id)}/pdf`}
                  title={selected.title}
                  style={{ width: '100%', height: '68vh', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: '#fff' }}
                />
                <div style={{ display: 'flex', gap: 7, marginTop: 8 }}>
                  <a
                    href={`/scholar/papers/${encodeURIComponent(selected.id)}/pdf`}
                    target="_blank" rel="noreferrer"
                    style={{ fontSize: 11.5, color: T.business, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  ><Icon d={Icons.external} size={11} /> {t('paper.fulltextWin')}</a>
                  <a
                    href={`/scholar/papers/${encodeURIComponent(selected.id)}/pdf`}
                    download={`${selected.id}.pdf`}
                    style={{ fontSize: 11.5, color: T.business, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  ><Icon d={Icons.doc} size={11} /> {t('paper.download')}</a>
                </div>
              </>
            ) : (
              <div style={{ padding: 18, textAlign: 'center' }}>
                <div style={{ fontSize: 11.5, color: T.caption, marginBottom: 10 }}>{t('paper.noPdfHint')}</div>
                <label
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, cursor: uploadingPdf ? 'default' : 'pointer',
                    border: '1.5px dashed var(--dsw-alias-border-l2)', borderRadius: 10,
                    padding: '16px 26px', color: T.business, fontSize: 11.5, opacity: uploadingPdf ? 0.55 : 1,
                  }}
                >
                  <Icon d={Icons.doc} size={13} /> {uploadingPdf ? t('paper.pdfUploading') : t('paper.pdfUploadDrop')}
                  <input type="file" accept="application/pdf,.pdf" hidden disabled={uploadingPdf} onChange={(e) => { void uploadPdf(selected, e.target.files?.[0]); e.target.value = ''; }} />
                </label>
              </div>
            )}
          </Modal>
        )}

        {/* 精读启动面板（单/多篇、模式、透镜、上下文、focus） */}
        <StudyLauncher
          open={launchOpen}
          current={selected}
          allPapers={allPapers}
          onClose={() => setLaunchOpen(false)}
          notify={showNotice}
          t={t}
        />
        </div>
      </div>
    );
  }

  const filtersActive = !!(tag || importance || yearFrom || yearTo || readStatus || unfiled || projectId);

  /** 单张论文卡：紧凑书目行（Linear 密度） */
  const renderCard = (p: Paper, schI = 0) => {
    const accentDot = (p.collectionIds ?? [])
      .map((cid) => cols.find((c) => c.id === cid)?.color)
      .find(Boolean);
    const vb = venueBadge(p);
    const rs = p.readStatus ?? 'want';
    const rsColor = readStatusColor(rs);
    const isCursor = cursorIdx !== null && flatIdxOf.get(p.id) === cursorIdx;
    return (
      <button
        key={p.id}
        type="button"
        data-dsh-plugin="dsh-scholar"
        data-dsh-part="paper-card"
        className={`sch-paper-card sch-list-item${isCursor ? ' sch-cursor' : ''}`}
        onClick={() => { setActionError(''); void openPaper(p.id); }}
        style={{ ['--sch-i' as string]: Math.min(schI, 20) }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          {accentDot ? (
            <span aria-hidden style={{
              width: 6, height: 6, borderRadius: 999, flex: 'none', marginTop: 5, background: accentDot,
            }} />
          ) : (
            <span aria-hidden style={{ width: 6, flex: 'none' }} />
          )}
          <span style={{
            flex: 1, fontWeight: 600, fontSize: 12.5, lineHeight: 1.35, letterSpacing: '-.012em',
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>{p.title}</span>
          {p.zoteroKey && (
            <span
              title={t('paper.zoteroLinked')}
              style={{
                flex: 'none', fontSize: 9, fontWeight: 700, marginTop: 2, padding: '1px 5px',
                borderRadius: 4, letterSpacing: '0.02em',
                color: 'var(--sch-accent, #2563eb)',
                border: '1px solid color-mix(in srgb, var(--sch-accent, #2563eb) 40%, transparent)',
                background: 'color-mix(in srgb, var(--sch-accent, #2563eb) 10%, transparent)',
              }}
            >Z</span>
          )}
          <span
            title={t('paper.readStatus')}
            style={{
              flex: 'none', fontSize: 9.5, fontWeight: 600, color: rsColor, marginTop: 2,
              fontVariantNumeric: 'tabular-nums',
            }}
          >{t(READ_STATUS_LABELS[rs])}</span>
          {(p.importance ?? 0) > 0 && <Stars value={p.importance ?? 0} size={9} />}
        </div>
        {(p.authors.length > 0 || p.year || vb) && (
          <div style={{
            fontSize: 10.5, color: T.secondary, marginTop: 4, display: 'flex', alignItems: 'center', gap: 6,
            paddingLeft: 14,
          }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {p.authors.slice(0, 2).join(', ')}{p.authors.length > 2 ? ' et al.' : ''}
              {p.year ? <span style={{ color: T.caption, fontVariantNumeric: 'tabular-nums' }}> · {p.year}</span> : null}
            </span>
            {vb && (
              <span style={{
                flex: 'none', fontSize: 9.5, fontWeight: 600, padding: '0 5px', borderRadius: 4,
                color: vb.color, background: `color-mix(in srgb, ${vb.color} 12%, transparent)`,
              }}>{vb.label}</span>
            )}
          </div>
        )}
        {p.summary && (
          <div
            className="sch-prose"
            style={{
              fontSize: 11, color: T.caption, marginTop: 5, paddingLeft: 14,
              display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden',
            }}
          >
            {p.summary}
          </div>
        )}
        {p.tags.length > 0 && (
          <div style={{ display: 'flex', gap: 3, marginTop: 5, flexWrap: 'wrap', paddingLeft: 14 }}>
            {p.tags.slice(0, 3).map((tg) => <Chip key={tg} label={tg} />)}
            {p.tags.length > 3 && (
              <span style={{ fontSize: 9.5, color: T.caption, alignSelf: 'center' }}>+{p.tags.length - 3}</span>
            )}
          </div>
        )}
      </button>
    );
  };

  /* ---------- list ---------- */
  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <SchStyles />
      <div ref={layoutRef} className="sch-library-layout" data-compact={compactLayout} style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'row' }}>
        {/* 典藏栏：阅读队列 / 主题分区 / 标签 / 年份 / 筛选笺 / 近览 */}
        {railOpen && (
          <div
            data-dsh-plugin="dsh-scholar"
            data-dsh-part="collection-rail"
            className="sch-col-rail"
          >
            <div className="sch-col-rail-bar">
              <span className="sch-rail-sec-title">{t('paper.rail')}</span>
              <IconButton
                label={t('paper.railCollapse')}
                onClick={() => setRailChoice(false)}
                icon={<Icon d={Icons.back} size={14} />}
              />
            </div>
            <div className="sch-col-rail-scroll sch-scroll">
              {/* 1. 阅读队列：想读 / 在读 / 读过 — 论文工作流主分区 */}
              <section className="sch-rail-sec">
                <div className="sch-rail-sec-head">
                  <span className="sch-rail-sec-title">{t('paper.railReading')}</span>
                </div>
                <RailItem
                  label={t('paper.allPapers')}
                  count={allPapers.length}
                  active={!readStatus && col === '' && !unfiled && !tag && !yearFrom && !yearTo && !projectId}
                  glyph={Icons.book}
                  onClick={() => {
                    setReadStatus('');
                    setCol('');
                    setUnfiled(false);
                    setTag('');
                    setYearFrom('');
                    setYearTo('');
                    setProjectId('');
                  }}
                />
                {READ_STATUSES.map((rs) => (
                  <RailItem
                    key={rs}
                    label={t(READ_STATUS_LABELS[rs])}
                    count={railStats.rs[rs]}
                    active={readStatus === rs && col === '' && !unfiled}
                    color={readStatusColor(rs)}
                    onClick={() => {
                      setReadStatus(readStatus === rs ? '' : rs);
                      setCol('');
                      setUnfiled(false);
                    }}
                  />
                ))}
              </section>

              {/* 2. 主题分区（用户 / Zotero 合集）— 可折叠 */}
              <section className="sch-rail-sec">
                <div className="sch-rail-sec-head">
                  <button
                    type="button"
                    className="sch-rail-sec-toggle"
                    aria-expanded={collectionsRailOpen}
                    onClick={toggleCollectionsRail}
                    title={collectionsRailOpen ? t('paper.railCollectionsCollapse') : t('paper.railCollectionsExpand')}
                  >
                    <Icon d={collectionsRailOpen ? Icons.chevronDown : Icons.chevronRight} size={10} />
                    <span className="sch-rail-sec-title">{t('paper.railCollections')}</span>
                    <span className="sch-rail-sec-count">{cols.length}</span>
                  </button>
                  <span style={{ flex: 1 }} />
                  <IconButton label={t('col.new')} size={18} onClick={() => setColModal(true)} icon={<Icon d={Icons.plus} size={10} />} />
                </div>
                {collectionsRailOpen && (
                  <>
                    <RailItem
                      label={t('paper.unfiled')}
                      count={allPapers.filter((p) => (p.collectionIds ?? []).length === 0).length}
                      active={unfiled && col === ''}
                      dim
                      glyph={Icons.doc}
                      onClick={() => {
                        if (unfiled) {
                          setUnfiled(false);
                        } else {
                          setUnfiled(true);
                          setCol('');
                          setReadStatus('');
                          setProjectId('');
                        }
                      }}
                    />
                    {cols.length === 0 && (
                      <div style={{ fontSize: 10.5, color: 'var(--dsw-alias-label-caption)', padding: '4px 8px', lineHeight: 1.4 }}>
                        {t('paper.railCollectionsEmpty')}
                      </div>
                    )}
                    {cols.map((c) => (
                      <RailItem
                        key={c.id}
                        label={c.name}
                        color={c.color}
                        count={allPapers.filter((p) => (p.collectionIds ?? []).includes(c.id)).length}
                        active={col === c.id && !unfiled}
                        onClick={() => {
                          setUnfiled(false);
                          setReadStatus('');
                          setProjectId('');
                          setCol(col === c.id ? '' : c.id);
                        }}
                        onRemove={() => { void removeCollection(c.id, c.name); }}
                        removeLabel={t('col.delete')}
                      />
                    ))}
                  </>
                )}
              </section>

              {/* 3. 课题组（研究项目）— 可折叠 */}
              <section className="sch-rail-sec">
                <div className="sch-rail-sec-head">
                  <button
                    type="button"
                    className="sch-rail-sec-toggle"
                    aria-expanded={projectsRailOpen}
                    onClick={toggleProjectsRail}
                    title={projectsRailOpen ? t('paper.railProjectsCollapse') : t('paper.railProjectsExpand')}
                  >
                    <Icon d={projectsRailOpen ? Icons.chevronDown : Icons.chevronRight} size={10} />
                    <span className="sch-rail-sec-title">{t('paper.railProjects')}</span>
                    <span className="sch-rail-sec-count">{projects.length}</span>
                  </button>
                  <span style={{ flex: 1 }} />
                  <IconButton
                    label={t('project.add')}
                    size={18}
                    onClick={() => navBus.go('projects')}
                    icon={<Icon d={Icons.plus} size={10} />}
                  />
                </div>
                {projectsRailOpen && (
                  <>
                    {projects.length === 0 && (
                      <div style={{ fontSize: 10.5, color: 'var(--dsw-alias-label-caption)', padding: '4px 8px', lineHeight: 1.4 }}>
                        {t('paper.railProjectsEmpty')}
                      </div>
                    )}
                    {projects.map((proj) => (
                      renamingProject?.id === proj.id ? (
                        <div key={proj.id} className="sch-rail-row" data-active={projectId === proj.id || undefined}>
                          <input
                            className="sch-rail-rename"
                            value={renamingProject.title}
                            autoFocus
                            aria-label={t('project.rename')}
                            onChange={(e) => setRenamingProject({ id: proj.id, title: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                void renameProject(proj.id, renamingProject.title);
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                setRenamingProject(null);
                              }
                            }}
                            onBlur={() => { void renameProject(proj.id, renamingProject.title); }}
                          />
                        </div>
                      ) : (
                        <RailItem
                          key={proj.id}
                          label={proj.title}
                          count={proj.paperIds.length}
                          active={projectId === proj.id}
                          glyph={Icons.stack}
                          onClick={() => {
                            if (projectId === proj.id) {
                              setProjectId('');
                            } else {
                              setProjectId(proj.id);
                              setCol('');
                              setUnfiled(false);
                              setCurrentProjectId(proj.id);
                            }
                          }}
                          onEdit={() => setRenamingProject({ id: proj.id, title: proj.title })}
                          editLabel={t('project.rename')}
                        />
                      )
                    ))}
                  </>
                )}
              </section>

              {/* 4. 标签速览 */}
              {railStats.topTags.length > 0 && (
                <section className="sch-rail-sec">
                  <div className="sch-rail-sec-head">
                    <span className="sch-rail-sec-title">{t('paper.railTags')}</span>
                  </div>
                  <div className="sch-rail-tags">
                    {railStats.topTags.map(([tg, n]) => (
                      <button
                        key={tg}
                        type="button"
                        className="sch-rail-tag"
                        title={`#${tg} · ${n}`}
                        aria-pressed={tg === tag}
                        onClick={() => {
                          setTag(tg === tag ? '' : tg);
                          setCol('');
                          setUnfiled(false);
                        }}
                      >#{tg} {n}</button>
                    ))}
                  </div>
                </section>
              )}

              {/* 5. 年份速览 */}
              {railStats.years.length > 0 && (
                <section className="sch-rail-sec">
                  <div className="sch-rail-sec-head">
                    <span className="sch-rail-sec-title">{t('paper.railYears')}</span>
                  </div>
                  {railStats.years.map(([y, n]) => {
                    const active = yearFrom === String(y) && yearTo === String(y);
                    return (
                      <div key={y} className="sch-rail-year" role="button" tabIndex={0}
                        aria-pressed={active}
                        onClick={() => {
                          if (active) { setYearFrom(''); setYearTo(''); }
                          else { setYearFrom(String(y)); setYearTo(String(y)); }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            if (active) { setYearFrom(''); setYearTo(''); }
                            else { setYearFrom(String(y)); setYearTo(String(y)); }
                          }
                        }}
                        style={{ cursor: 'pointer', borderRadius: 6, background: active ? 'var(--dsw-alias-fill-hover, rgba(0,0,0,.04))' : undefined }}
                      >
                        <span>{y}</span>
                        <span className="sch-rail-year-bar" aria-hidden>
                          <span className="sch-rail-year-fill" style={{ width: `${Math.round((n / railStats.maxYear) * 100)}%` }} />
                        </span>
                        <span style={{ textAlign: 'right' }}>{n}</span>
                      </div>
                    );
                  })}
                </section>
              )}

              {/* 6. 智能筛选笺 */}
              <section className="sch-rail-sec">
                <div className="sch-rail-sec-head">
                  <span className="sch-rail-sec-title">{t('paper.savedSearches')}</span>
                </div>
                {savedSearches.map((ss) => (
                  <div key={ss.id} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <button
                      type="button"
                      data-dsh-plugin="dsh-scholar"
                      data-dsh-part="saved-search"
                      className="sch-rail-item"
                      onClick={() => applySavedSearch(ss)}
                      style={{ flex: 1, minWidth: 0 }}
                    >
                      <Icon d={Icons.search} size={10} color={T.caption} />
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ss.name}</span>
                    </button>
                    <button
                      type="button"
                      title={t('common.delete')}
                      onClick={() => removeSavedSearch(ss.id)}
                      style={{ flex: 'none', background: 'none', border: 'none', cursor: 'pointer', color: T.caption, padding: 4, display: 'inline-flex', borderRadius: 6 }}
                    >
                      <Icon d={Icons.close} size={9} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="sch-rail-ghost"
                  onClick={saveCurrentSearch}
                  disabled={!(q || filtersActive || col || readStatus)}
                >
                  <Icon d={Icons.plus} size={10} /> {t('paper.saveSearch')}
                </button>
              </section>

              {/* 7. 最近打开 */}
              {recent.length > 0 && (
                <section className="sch-rail-sec">
                  <div className="sch-rail-sec-head">
                    <span className="sch-rail-sec-title">{t('paper.recent')}</span>
                  </div>
                  {recent.slice(0, 5).map((rid) => {
                    const rp = allPapers.find((p) => p.id === rid);
                    if (!rp) return null;
                    return (
                      <button
                        key={rid}
                        type="button"
                        data-dsh-plugin="dsh-scholar"
                        data-dsh-part="recent-item"
                        className="sch-rail-recent"
                        onClick={() => { setActionError(''); void openPaper(rid); }}
                        title={rp.title}
                      >
                        <span aria-hidden className="sch-rail-glyph">
                          <Icon d={Icons.doc} size={10} />
                        </span>
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rp.title}</span>
                      </button>
                    );
                  })}
                </section>
              )}
            </div>
          </div>
        )}
        {railOpen && compactLayout && (
          <button
            type="button"
            className="sch-col-rail-backdrop"
            aria-label={t('paper.railCollapse')}
            onClick={() => setRailChoice(false)}
          />
        )}

        {/* Keep the list constrained to the panel so papers scroll independently of the collection rail. */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {/* toolbar */}
          <div className="sch-toolbar" style={{ borderBottom: '1px solid var(--sch-hairline)' }}>
            <IconButton
              label={t('paper.rail')}
              active={railOpen}
              onClick={() => setRailChoice(!railOpen)}
              icon={<Icon d={Icons.rail} size={15} />}
            />
            <SearchInput value={q} onChange={setQ} placeholder={t('paper.searchPh')} />
            <IconButton
              label={t('paper.filters')}
              active={filtersOpen || filtersActive}
              onClick={() => setFiltersOpen(!filtersOpen)}
              icon={<Icon d={Icons.filter} size={15} />}
            />
            <Select value={sort} onChange={(e) => setSort(e.target.value)} title={t('paper.sort')} style={{ flex: 'none', minWidth: 108 }}>
              <option value="createdAt">{t('paper.sortCreated')}</option>
              <option value="year">{t('paper.sortYear')}</option>
              <option value="title">{t('paper.sortTitle')}</option>
            </Select>
            <IconButton
              label={t('paper.bibtexExport')}
              onClick={exportBibtex}
              icon={<Icon d={Icons.download} size={15} />}
            />
            <IconButton
              label={t('paper.discover')}
              onClick={() => setDiscoverOpen(true)}
              icon={<Icon d={Icons.search} size={15} />}
            />
            <IconButton
              label={t('paper.bibtexImport')}
              onClick={() => setBibImportOpen(true)}
              icon={<Icon d={Icons.doc} size={15} />}
            />
            <Btn tone="soft" disabled={zoteroSyncing} onClick={() => void syncZotero()}>
              {zoteroSyncing ? t('settings.zoteroSyncing') : t('paper.zoteroSync')}
            </Btn>
            <span style={{ flex: 1, minWidth: 4 }} />
            <Btn tone="primary" onClick={() => { leavePaper(); setFormDirty(false); setForm({ mode: 'new', paper: emptyPaper() }); }}>
              <Icon d={Icons.plus} size={14} /> {t('paper.add')}
            </Btn>
          </div>

          {(filtersOpen || filtersActive) && (
            <div className="sch-fade" style={{ padding: '0 10px 6px', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <Select value={tag} onChange={(e) => setTag(e.target.value)} title={t('paper.tagAll')} style={{ minWidth: 96 }}>
                <option value="">{t('paper.tagAll')}</option>
                {tags.map((tg) => <option key={tg} value={tg}>{tg}</option>)}
              </Select>
              <Select value={importance} onChange={(e) => setImportance(e.target.value)} title={t('paper.importanceAll')} style={{ minWidth: 92 }}>
                <option value="">{t('paper.importanceAll')}</option>
                {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{'★'.repeat(n)}</option>)}
              </Select>
              <Select value={readStatus} onChange={(e) => setReadStatus(e.target.value as ReadStatus | '')} title={t('paper.readStatusAll')} style={{ minWidth: 86 }}>
                <option value="">{t('paper.readStatusAll')}</option>
                {READ_STATUSES.map((rs) => <option key={rs} value={rs}>{t(READ_STATUS_LABELS[rs])}</option>)}
              </Select>
              <Input type="number" min={1900} max={2100} placeholder={t('paper.yearFrom')} value={yearFrom} onChange={(e) => setYearFrom(e.target.value)} style={{ width: 70 }} />
              <span style={{ color: T.caption }}>–</span>
              <Input type="number" min={1900} max={2100} placeholder={t('paper.yearTo')} value={yearTo} onChange={(e) => setYearTo(e.target.value)} style={{ width: 70 }} />
            </div>
          )}

          {filtersActive && (
            <div style={{ padding: '0 10px 7px', display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
              {tag && <FilterChip label={`#${tag}`} onRemove={() => setTag('')} />}
              {importance && <FilterChip label={`★ ≥ ${importance}`} onRemove={() => setImportance('')} />}
              {readStatus && <FilterChip label={t(READ_STATUS_LABELS[readStatus])} onRemove={() => setReadStatus('')} />}
              {unfiled && <FilterChip label={t('paper.unfiled')} onRemove={() => setUnfiled(false)} />}
              {projectId && (
                <FilterChip
                  label={projects.find((p) => p.id === projectId)?.title ?? t('paper.railProjects')}
                  onRemove={() => setProjectId('')}
                />
              )}
              {(yearFrom || yearTo) && <FilterChip label={`${yearFrom || '…'} – ${yearTo || '…'}`} onRemove={() => { setYearFrom(''); setYearTo(''); }} />}
            </div>
          )}

          {shownError && <div style={{ color: T.danger, padding: '2px 12px 6px', fontSize: 11 }}>{shownError}</div>}
          {notice && !shownError && <div style={{ color: T.success, padding: '2px 12px 6px', fontSize: 11 }}>{notice}</div>}
          {degraded && !shownError && !notice && (
            <div style={{ color: T.warning, padding: '2px 12px 6px', fontSize: 11 }}>{degraded}</div>
          )}

          <div className="sch-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 0 12px' }}>
            {!loading && listedPapers.length === 0 && !shownError && (
              // 分区/筛选下 0 结果 = "没搜到"，不是"库是空的"——避免误导性的大空态
              q || filtersActive || col ? (
                <EmptyState icon={<Icon d={Icons.search} size={22} />} title={t('common.empty')} />
              ) : (
                <EmptyState
                  icon={<Icon d={Icons.book} size={24} />}
                  title={t('common.empty')}
                  hint={t('paper.aiHint')}
                  action={<Btn tone="primary" onClick={() => { leavePaper(); setFormDirty(false); setForm({ mode: 'new', paper: emptyPaper() }); }}><Icon d={Icons.plus} size={12} /> {t('paper.add')}</Btn>}
                />
              )
            )}
            {loading && listedPapers.length === 0 && <SkeletonCards count={5} />}
            <div key={`${debouncedQ}|${sort}|${tag}|${yearFrom}|${yearTo}|${importance}|${readStatus}|${projectId}`} className="sch-fade sch-list">
              {yearGroups ? (
                /* 年份分组视图：粘性组头 + 组内卡片 */
                yearGroups.map((g) => (
                  <div key={g.y || '__none__'} data-dsh-plugin="dsh-scholar" data-dsh-part="year-group">
                    <div style={{
                      position: 'sticky', top: 0, zIndex: 2,
                      display: 'flex', alignItems: 'baseline', gap: 7, padding: '8px 2px 5px',
                      background: 'var(--sch-solid, var(--dsw-alias-bg-base, #161616))',
                      borderBottom: '1px solid var(--dsw-alias-border-l2)',
                    }}>
                      <span style={{ fontWeight: 700, fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>{g.y || t('paper.yearUnknown')}</span>
                      <span style={{ fontSize: 10, color: T.caption }}>{t('paper.groupCount', { count: g.list.length })}</span>
                    </div>
                    {g.list.map((p, i) => renderCard(p, i))}
                  </div>
                ))
              ) : (
                listedPapers.map((p, i) => renderCard(p, i))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* collection manage modal */}
      {colModal && (
        <CollectionsModal
          t={t}
          onClose={() => setColModal(false)}
          onChanged={() => { void loadCols(); void load(); void loadAll(); }}
        />
      )}
      {discoverOpen && (
        <DiscoverModal
          t={t}
          onClose={() => setDiscoverOpen(false)}
          onIngested={() => { void load(); void loadAll(); }}
        />
      )}
      {bibImportOpen && (
        <BibtexImportModal
          t={t}
          onClose={() => setBibImportOpen(false)}
          onImported={() => { void load(); void loadAll(); }}
        />
      )}
    </div>
  );
}

/** 典藏栏单行 — Apple sidebar 式圆角选中块 + 小图标 */
function RailItem({ label, count, color, active, dim, onClick, glyph, onRemove, removeLabel, onEdit, editLabel }: {
  label: string;
  count: number;
  color?: string;
  active?: boolean;
  dim?: boolean;
  onClick: () => void;
  /** 可选前置图标路径；默认用色点 / 圆角块 */
  glyph?: string;
  /** 悬停显示的删除动作（主题分区等） */
  onRemove?: () => void;
  removeLabel?: string;
  /** 悬停显示的重命名动作（课题组等） */
  onEdit?: () => void;
  editLabel?: string;
}) {
  return (
    <div className="sch-rail-row" data-active={active || undefined}>
      <button
        type="button"
        data-dsh-plugin="dsh-scholar"
        data-dsh-part="rail-item"
        className="sch-rail-item"
        aria-pressed={active || undefined}
        data-dim={dim || undefined}
        onClick={onClick}
        title={label}
      >
        {glyph ? (
          <span aria-hidden className="sch-rail-glyph">
            <Icon d={glyph} size={11} />
          </span>
        ) : color ? (
          <span aria-hidden className="sch-rail-dot" style={{ background: color }} />
        ) : (
          <span aria-hidden className="sch-rail-glyph">
            <Icon d={Icons.book} size={11} />
          </span>
        )}
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <span className="sch-rail-count">{count}</span>
      </button>
      {onEdit && (
        <button
          type="button"
          className="sch-rail-item-action"
          title={editLabel}
          aria-label={editLabel}
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
        >
          <Icon d={Icons.edit} size={10} />
        </button>
      )}
      {onRemove && (
        <button
          type="button"
          className="sch-rail-item-action sch-rail-item-action--danger"
          title={removeLabel}
          aria-label={removeLabel}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <Icon d={Icons.trash} size={10} />
        </button>
      )}
    </div>
  );
}

/* ---------- collections manager (create / rename / recolor / delete) ---------- */
function CollectionsModal({ t, onClose, onChanged }: {
  t: TFunc;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [cols, setCols] = useState<PaperCollection[]>([]);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<string>(COL_COLORS[0]);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ collections: PaperCollection[] }>('/scholar/collections');
      setCols(r.collections);
    } catch (e) {
      // 保留旧列表,但不再无声——留痕 + 弹窗内提示,与"空列表"可区分
      console.warn('dsh-scholar: collections refresh failed', e);
      setErr(t('common.partialLoadFailed'));
    }
  }, [t]);

  useEffect(() => { void refresh(); }, [refresh]);

  const create = async () => {
    if (!newName.trim()) return;
    try {
      const res = await api<{ created: boolean }>("/scholar/collections", { method: "POST", body: JSON.stringify({ name: newName, color: newColor }) });
      setNewName("");
      setErr("");
      setNote(res.created ? "" : t("col.merged"));
      await refresh();
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const saveEdit = async (id: string, patch: { name?: string; color?: string }) => {
    try {
      await api(`/scholar/collections/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) });
      setEditing(null);
      setErr('');
      await refresh();
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const remove = async (id: string, name: string) => {
    if (!window.confirm(`${t('common.confirmDelete')}\n${name}\n${t('col.deleteHint')}`)) return;
    try {
      await api(`/scholar/collections/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setErr('');
      await refresh();
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <Modal title={t('col.manage')} onClose={onClose} width={440}>
      <div className="sch-fade">
        {/* create row */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 12 }}>
          <Input
            value={newName}
            placeholder={t('col.addPh')}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
          />
          <span style={{ display: 'inline-flex', gap: 3, flex: 'none' }}>
            {COL_COLORS.map((c) => (
              <button key={c} type="button" aria-label="color" onClick={() => setNewColor(c)} style={{
                width: 16, height: 16, borderRadius: 999, background: c,
                border: newColor === c ? '2px solid var(--dsw-alias-label-primary)' : 'none',
                cursor: 'pointer', padding: 0,
              }} />
            ))}
          </span>
          <Btn tone="primary" onClick={() => void create()} disabled={!newName.trim()}>
            <Icon d={Icons.plus} size={11} /> {t('col.new')}
          </Btn>
        </div>

        {err && <div style={{ color: T.danger, fontSize: 11, marginBottom: 8 }}>{err}</div>}
        {note && <div style={{ color: T.success, fontSize: 11, marginBottom: 8 }}>✓ {note}</div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {cols.length === 0 && (
            <div style={{ color: T.caption, fontSize: 11.5 }}>{t('common.empty')}</div>
          )}
          {cols.map((c) => (
            editing?.id === c.id ? (
              <div key={c.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Input value={editing.name} autoFocus onChange={(e) => setEditing({ ...editing, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') void saveEdit(c.id, { name: editing.name }); }} />
                <Btn tone="primary" onClick={() => void saveEdit(c.id, { name: editing.name })}>{t('common.save')}</Btn>
                <Btn onClick={() => setEditing(null)}>{t('common.cancel')}</Btn>
              </div>
            ) : (
              <div key={c.id} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 9, padding: '6px 8px',
                background: T.cardBg,
              }}>
                <span aria-hidden style={{ width: 10, height: 10, borderRadius: 999, flex: 'none', background: c.color ?? 'var(--dsw-alias-label-caption)' }} />
                <span style={{ flex: 1, fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                <span style={{ display: 'inline-flex', gap: 2, flex: 'none' }}>
                  {COL_COLORS.map((color) => (
                    <button key={color} type="button" aria-label="recolor" onClick={() => void saveEdit(c.id, { color })} style={{
                      width: 12, height: 12, borderRadius: 999, cursor: 'pointer', padding: 0,
                      background: color, opacity: c.color === color ? 1 : 0.45,
                      border: c.color === color ? '1.5px solid var(--dsw-alias-label-primary)' : 'none',
                    }} />
                  ))}
                </span>
                <IconButton label={t('common.edit')} size={22} onClick={() => setEditing({ id: c.id, name: c.name })} icon={<Icon d={Icons.edit} size={13} />} />
                <IconButton label={t('common.delete')} size={22} color={T.danger} onClick={() => void remove(c.id, c.name)} icon={<Icon d={Icons.trash} size={13} />} />
              </div>
            )
          ))}
        </div>
      </div>
    </Modal>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setV(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return v;
}

function emptyPaper(): Paper {
  return {
    id: '', title: '', authors: [], tags: [], source: 'manual', readStatus: 'want',
    createdAt: Date.now(), updatedAt: Date.now(),
  };
}

function urlLabel(u: string): string {
  try { return new URL(u).host + (new URL(u).pathname !== '/' ? new URL(u).pathname : ''); } catch { return u; }
}

/* ---------- paper form ---------- */
function PaperForm({ initial, defaultTags, collections, onSave, onCancel, onTouch, t }: {
  initial: Paper;
  defaultTags: string[];
  collections: PaperCollection[];
  onSave: (p: Paper) => void;
  onCancel: () => void;
  /** 任一字段首次修改时回调(父组件的脏数据保护) */
  onTouch: () => void;
  t: TFunc;
}) {
  const [p, setP] = useState<Paper>({
    ...initial,
    tags: initial.tags.length > 0 ? initial.tags : defaultTags,
  });
  const [invalid, setInvalid] = useState('');
  const [src, setSrc] = useState('');
  const [fetching, setFetching] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [touched, setTouched] = useState(false);
  /** defaultTags 是否已应用(或无需应用)——避免 config 晚到时覆盖用户输入 */
  const appliedDefaults = useRef(initial.tags.length > 0);

  // defaultTags 竞态:config 在表单打开后才返回时,只要用户还没动过表单,
  // 就补应用一次;不在挂载时固化空数组
  useEffect(() => {
    if (appliedDefaults.current || touched || defaultTags.length === 0) return;
    appliedDefaults.current = true;
    setP((cur) => (cur.tags.length > 0 ? cur : { ...cur, tags: defaultTags }));
  }, [defaultTags, touched]);

  /** mark the draft dirty (parent guards accidental close) */
  const touch = () => {
    if (!touched) setTouched(true);
    onTouch();
  };

  /** toggle collection membership on the draft */
  const toggleCol = (id: string) => {
    touch();
    setP((cur) => {
      const curIds = cur.collectionIds ?? [];
      const next = curIds.includes(id) ? curIds.filter((x) => x !== id) : [...curIds, id];
      return { ...cur, collectionIds: next };
    });
  };

  const set = (patch: Partial<Paper>) => {
    touch();
    setP((cur) => ({ ...cur, ...patch }));
  };

  const splitList = (s: string): string[] => s.split(/[,，]/).map((x) => x.trim()).filter(Boolean);

  /** Pull metadata from an arXiv id/URL or DOI and merge it into the draft. */
  const grabMeta = async () => {
    if (!src.trim() || fetching) return;
    setFetching(true);
    setNote(null);
    try {
      const r = await api<{
        meta?: Partial<{
          title: string; authors: string[]; year?: number; venue?: string;
          arxivId?: string; doi?: string; url?: string; abstract?: string;
        }>;
        error?: string;
      }>(`/scholar/fetch?input=${encodeURIComponent(src.trim())}`);
      const m = r?.meta;
      if (!m || !m.title) throw new Error(r?.error ?? t('paper.fetchNoMeta'));
      touch(); // 自动填充的内容也是会丢失的草稿,同样计入脏数据
      setP((cur) => ({
        ...cur,
        title: m.title || cur.title,
        authors: m.authors?.length ? m.authors : cur.authors,
        year: m.year ?? cur.year,
        venue: m.venue ?? cur.venue,
        arxivId: m.arxivId ?? cur.arxivId,
        doi: m.doi ?? cur.doi,
        url: m.url ?? cur.url,
        abstract: m.abstract ?? cur.abstract,
      }));
      setNote({ ok: true, text: t('paper.fetchOk') });
      setSrc('');
    } catch (e) {
      setNote({ ok: false, text: `${t('paper.fetchFail')}: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setFetching(false);
    }
  };

  const save = () => {
    if (!p.title.trim()) { setInvalid(t('paper.form.title')); return; }
    onSave({ ...p, tags: splitList(p.tags.join(',')), authors: splitList(p.authors.join(',')) });
  };

  return (
    <div style={{ maxWidth: 520 }}>
      {/* source auto-fill row */}
      <Field label={t('paper.fetch')}>
        <div style={{ display: 'flex', gap: 6 }}>
          <Input
            value={src}
            placeholder={t('paper.fetchPh')}
            onChange={(e) => { setSrc(e.target.value); setNote(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void grabMeta(); }}
          />
          <Btn tone="soft" disabled={fetching} onClick={() => void grabMeta()} style={{ flex: 'none' }}>
            <Icon d={fetching ? Icons.refresh : Icons.sparkle} size={12} className={fetching ? 'sch-spin' : undefined} />
            {fetching ? t('paper.fetching') : t('paper.fetch')}
          </Btn>
        </div>
        {note && (
          <div style={{ fontSize: 10.5, marginTop: 4, color: note.ok ? T.success : T.danger }}>{note.text}</div>
        )}
      </Field>

      <Field label={t('paper.form.title')}>
        <Input value={p.title} placeholder={t('paper.form.titlePh')} onChange={(e) => set({ title: e.target.value })} />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 86px', gap: 8 }}>
        <Field label={t('paper.form.authors')}>
          <Input value={p.authors.join(', ')} onChange={(e) => set({ authors: splitList(e.target.value) })} />
        </Field>
        <Field label={t('paper.form.year')}>
          <Input type="number" min={1900} max={2100} value={p.year ?? ''} onChange={(e) => set({ year: e.target.value ? Number(e.target.value) : undefined })} />
        </Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px', gap: 8 }}>
        <Field label={t('paper.form.venue')}>
          <Input value={p.venue ?? ''} onChange={(e) => set({ venue: e.target.value })} />
        </Field>
        <Field label={t('paper.form.arxivId')}>
          <Input value={p.arxivId ?? ''} onChange={(e) => set({ arxivId: e.target.value })} />
        </Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Field label={t('paper.form.doi')}>
          <Input value={p.doi ?? ''} onChange={(e) => set({ doi: e.target.value })} />
        </Field>
        <Field label={t('paper.form.url')}>
          <Input value={p.url ?? ''} onChange={(e) => set({ url: e.target.value })} />
        </Field>
      </div>

      <Field label={t('paper.form.summary')}>
        <Textarea rows={2} value={p.summary ?? ''} onChange={(e) => set({ summary: e.target.value })} style={{ minHeight: 48 }} />
      </Field>

      <Field label={t('paper.form.abstract')}>
        <Textarea rows={3} value={p.abstract ?? ''} onChange={(e) => set({ abstract: e.target.value })} style={{ minHeight: 64 }} />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 8 }}>
        <Field label={t('paper.form.tags')}>
          <Input value={p.tags.join(', ')} onChange={(e) => set({ tags: splitList(e.target.value) })} />
        </Field>
        <Field label={t('paper.form.importance')}>
          <Select value={p.importance ?? 3} onChange={(e) => set({ importance: Number(e.target.value) })}>
            {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{'★'.repeat(n)}{'☆'.repeat(5 - n)}</option>)}
          </Select>
        </Field>
      </div>

      <Field label={t('paper.readStatus')}>
        <div style={{ display: 'flex', gap: 6 }}>
          {READ_STATUSES.map((rs) => {
            const active = (p.readStatus ?? 'want') === rs;
            const color = readStatusColor(rs);
            return (
              <button
                key={rs}
                type="button"
                onClick={() => set({ readStatus: rs })}
                style={{
                  fontSize: 11.5, padding: '3px 12px', borderRadius: 999, cursor: 'pointer',
                  border: `1px solid ${active ? `color-mix(in srgb, ${color} 55%, transparent)` : 'var(--dsw-alias-border-l2)'}`,
                  background: active ? `color-mix(in srgb, ${color} 16%, transparent)` : 'transparent',
                  color: active ? color : T.secondary,
                  fontWeight: active ? 600 : 400,
                }}
              >{t(READ_STATUS_LABELS[rs])}</button>
            );
          })}
        </div>
      </Field>

      <Field label={t('paper.form.notes')}>
        <Textarea rows={2} value={p.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} style={{ minHeight: 40 }} />
      </Field>

      <Field label={t('col.manage')}>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {collections.length === 0 && <span style={{ fontSize: 11, color: T.caption }}>{t('common.empty')}</span>}
          {collections.map((c) => {
            const active = (p.collectionIds ?? []).includes(c.id);
            const chipColor = active ? (c.color ?? T.business) : undefined;
            return <Chip key={c.id} label={c.name} color={chipColor} active={active} onClick={() => toggleCol(c.id)} />;
          })}
        </div>
      </Field>

      {invalid && <div style={{ color: T.danger, fontSize: 11, marginBottom: 6 }}>{invalid}</div>}

      <div style={{ display: 'flex', gap: 8, margin: '6px 0 10px' }}>
        <Btn tone="primary" onClick={save}>{t('common.save')}</Btn>
        <Btn onClick={onCancel}>{t('common.cancel')}</Btn>
      </div>
    </div>
  );
}
