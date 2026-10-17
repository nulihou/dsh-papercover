/**
 * 精读任务启动面板（v1.18：一键精读的优雅形态）。
 *
 * 设计：面板配置（单篇/多篇、模式、透镜开关、上下文论文/卡片多选、focus 可编辑）
 * → POST /scholar/read/run 后台直跑（jobs 不可用时脱离任务系统执行）
 * 需要对话交付时，只填入空白编辑器或复制文本，由用户确认发送。
 * 透镜不再强制：quick 速读恒不带；map 默认勾选可取消。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { IdeaCard, Paper, ScholarConfig } from '../shared/types';
import { api } from './api';
import { ACADEMIC_LENS } from '../shared/lens';
import type { TFunc } from './nav';
import { Btn, Icon, Icons, Modal, SchStyles, SearchInput, SegGroup, T, Textarea, truncate, Z } from './ui';

type ComposerDelivery = 'sent' | 'filled' | 'clipboard' | 'failed';

/**
 * 只填入插件区域外唯一的空白编辑器。复杂富文本、草稿或歧义目标均复制降级。
 * 不自动发送；剪贴板不可用或被拒绝时必须明确通知调用方失败。
 */
// E07:非破坏交付——宿主输入框为空且唯一可识别才填入(不自动点发送);
// 已有草稿/附件/多编辑器时降级为剪贴板复制,绝不覆盖用户未发送的内容。
export function deliverToComposer(text: string, done: (r: ComposerDelivery) => void): void {
  const visible = (el: Element): boolean => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const inPlugin = (el: Element): boolean => !!el.closest('[data-dsh-plugin]');
  const ces = [...document.querySelectorAll('[contenteditable]:not([contenteditable="false"])')].filter((el) => visible(el) && !inPlugin(el));
  const tas = [...document.querySelectorAll('textarea')].filter((el) => visible(el) && !inPlugin(el));
  const copy = () => {
    if (!navigator.clipboard?.writeText) { done('failed'); return; }
    try { void navigator.clipboard.writeText(text).then(() => done('clipboard'), () => done('failed')); }
    catch { done('failed'); }
  };
  // All candidates count, including a textarea beside rich-text editors.
  if (ces.length + tas.length !== 1) { copy(); return; }
  const ce = ces[0] as HTMLElement | undefined;
  const ta = tas[0] as HTMLTextAreaElement | undefined;
  // Only an empty editor or the conventional single BR placeholder is safe.
  const emptyCE = ce && [...ce.childNodes].every(n => n.nodeType === Node.TEXT_NODE ? !n.textContent?.trim() : n instanceof HTMLBRElement && !n.attributes.length);
  if (ce ? !emptyCE : !ta || ta.value.trim() || ta.disabled || ta.readOnly) { copy(); return; }
  try {
    let injected = false;
    if (ce) {
      ce.focus();
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(ce);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      injected = document.execCommand('insertText', false, text);
    } else if (ta) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) {
        setter.call(ta, text);
        try {
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        } catch { /* 受控组件对合成事件重入抛错不阻断 */ }
        injected = ta.value === text;
      }
    }
    if (!injected) {
      copy();
      return;
    }
    // E07:填入即止——不自动点发送(全页找'发送'按钮会误触别的会话/编辑器);
    // 通知用户检查后手动发送
    done('filled');
  } catch { copy(); }
}
function CheckList({ items, checked, onToggle, max }: {
  items: { id: string; label: string; note?: string }[];
  checked: Set<string>;
  onToggle: (id: string) => void;
  max?: number;
}) {
  const atMax = max !== undefined && checked.size >= max;
  return (
    <div
      className="sch-scroll"
      style={{
        maxHeight: 148, overflowY: 'auto', marginTop: 6,
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 9, padding: '4px 0',
        background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.04))',
      }}
    >
      {items.length === 0 && (
        <div style={{ padding: '8px 12px', fontSize: 11, color: T.caption }}>-</div>
      )}
      {items.map((it) => {
        const on = checked.has(it.id);
        const disabled = !on && atMax;
        return (
          <label
            key={it.id}
            className="sch-check-row"
            data-on={on ? 'true' : 'false'}
            style={{ opacity: disabled ? 0.45 : 1, cursor: disabled ? 'default' : 'pointer' }}
            onClick={(e) => {
              if (disabled) { e.preventDefault(); return; }
              e.preventDefault();
              onToggle(it.id);
            }}
          >
            <input type="checkbox" checked={on} readOnly style={{ accentColor: 'var(--sch-accent)', margin: 0 }} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={it.label}>
              {it.label}
            </span>
            {it.note && <span style={{ flex: 'none', fontSize: 9.5, color: it.note === 'no-pdf' ? T.warning : T.caption }}>{it.note === 'no-pdf' ? '无PDF' : it.note}</span>}
          </label>
        );
      })}
    </div>
  );
}

function Segment<K extends string>({ value, options, onChange }: {
  value: K; options: { key: K; label: string }[]; onChange: (k: K) => void;
}) {
  return (
    <SegGroup>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          className="sch-seg-item"
          data-dsh-plugin="dsh-scholar"
          data-dsh-part="study-seg"
          aria-pressed={value === o.key}
          onClick={() => onChange(o.key)}
          style={{ maxWidth: 220 }}
          title={o.label}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</span>
        </button>
      ))}
    </SegGroup>
  );
}

const labelStyle: React.CSSProperties = { display: 'block', fontSize: 10.5, fontWeight: 600, color: T.caption, marginBottom: 4, letterSpacing: '.02em' };

/**
 * 对话栏底端入口（conversation.input.left 插槽）：
 * 打开精读任务面板。无当前论文上下文 → 默认多篇模式，从库里选。
 */
export function ScholarReadEntry({ t }: { t: TFunc }) {
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState('');
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(id);
  }, [toast]);
  return (
    <>
      <SchStyles />
      <button
        type="button"
        data-dsh-plugin="dsh-scholar"
        data-dsh-part="study-entry"
        className="sch-icon-btn"
        title={t('study.entryTitle')}
        aria-label={t('study.entryTitle')}
        aria-expanded={open}
        onClick={() => setOpen(true)}
        style={{ width: 28, height: 28 }}
      >
        <Icon d={Icons.book} size={15} />
      </button>
      {open && (
        <StudyLauncher
          open={open}
          onClose={() => setOpen(false)}
          notify={(msg) => setToast(msg)}
          t={t}
        />
      )}
      {toast && createPortal(
        <div
          role="status"
          data-dsh-plugin="dsh-scholar"
          data-dsh-part="study-toast"
          style={{
            position: 'fixed', left: '50%', bottom: 88, transform: 'translateX(-50%)',
            zIndex: Z.toast, maxWidth: 'min(420px, calc(100vw - 32px))',
            padding: '10px 14px', borderRadius: 10, fontSize: 12.5, fontWeight: 500,
            color: 'var(--dsw-alias-label-primary)',
            background: 'var(--sch-solid, var(--dsw-alias-bg-base, #161616))',
            border: '1px solid var(--dsw-alias-border-l2)',
            boxShadow: '0 10px 28px color-mix(in srgb, #000 18%, transparent)',
          }}
        >{toast}</div>,
        document.body,
      )}
    </>
  );
}

export function StudyLauncher({ open, current, allPapers: allPapersProp, onClose, notify, t }: {
  open: boolean;
  /** 详情页入口传入；对话栏入口（composer 按钮）无当前论文 */
  current?: Paper;
  /** 详情页入口传入现成列表；对话栏入口自行拉取 */
  allPapers?: Paper[];
  onClose: () => void;
  notify: (msg: string) => void;
  t: TFunc;
}) {
  const [scope, setScope] = useState<'single' | 'multi'>(current ? 'single' : 'multi');
  const [mode, setMode] = useState<'paper' | 'light' | 'quick'>('paper');
  /** 直接对比已有成果（仅多篇范围）：不重读，1-3 分钟出对比报告 */
  const [directCompare, setDirectCompare] = useState(false);
  /** 多篇精读完成后是否自动出对比报告（默认关，省一次模型调用） */
  const [autoCompare, setAutoCompare] = useState(false);
  const [lens, setLens] = useState(true);
  const [allPapers, setAllPapers] = useState<Paper[]>(allPapersProp ?? []);
  const [paperIds, setPaperIds] = useState<Set<string>>(new Set());
  const [paperQ, setPaperQ] = useState('');
  const [ctxIds, setCtxIds] = useState<Set<string>>(new Set());
  const [cardIds, setCardIds] = useState<Set<string>>(new Set());
  const [ctxQ, setCtxQ] = useState('');
  const [focus, setFocus] = useState('');
  const [cards, setCards] = useState<IdeaCard[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open) return;
    setErr('');
    let alive = true;
    (async () => {
      try {
        const reqs: Array<Promise<{ cards?: IdeaCard[]; config?: ScholarConfig; papers?: Paper[] }>> = [
          api<{ cards: IdeaCard[] }>('/scholar/cards?sort=title'),
          api<{ config: ScholarConfig }>('/scholar/config'),
        ];
        // 对话栏入口没有现成论文列表：顺带拉全库
        if (!allPapersProp) reqs.push(api<{ papers: Paper[] }>('/scholar/papers?sort=title'));
        const results = await Promise.all(reqs);
        const cs = (results.find((r) => 'cards' in r && r.cards) ?? { cards: [] as IdeaCard[] }) as { cards: IdeaCard[] };
        const cfg = (results.find((r) => 'config' in r && r.config) ?? { config: {} as ScholarConfig }) as { config: ScholarConfig };
        const rest = results.filter((r) => 'papers' in r && r.papers);
        if (!alive) return;
        const papers = allPapersProp ?? ((rest[0] as { papers: Paper[] } | undefined)?.papers ?? []);
        setAllPapers(papers);
        setCards(cs.cards);
        // 预填 focus：设置项优先，空则库内高频标签推断
        const f = (cfg.config.researchFocus ?? '').trim()
          || [...papers.flatMap((p) => p.tags).reduce((m, tg) => m.set(tg, (m.get(tg) ?? 0) + 1), new Map<string, number>())]
            .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([tg]) => tg).join('、');
        setFocus(f);
        if (current) {
          // 预选上下文：与当前论文标签重叠 top6（排除自身）；卡片预选本论文的卡
          setCtxIds(new Set(papers
            .filter((p) => p.id !== current.id)
            .map((p) => ({ p, score: p.tags.filter((tg) => current.tags.includes(tg)).length }))
            .filter((r) => r.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 6)
            .map((r) => r.p.id)));
          setCardIds(new Set(cs.cards.filter((c) => c.paperId === current.id).map((c) => c.id)));
        }
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [open, current?.id, allPapersProp]);

  const toggle = (set: (fn: (s: Set<string>) => Set<string>) => void, id: string) => set((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const targetIds = scope === 'single' && current ? [current.id] : [...paperIds];
  const papersWithPdf = useMemo(() => new Set(allPapers.filter((p) => p.pdfPath).map((p) => p.id)), [allPapers]);

  const paperItems = useMemo(() => allPapers
    .filter((p) => p.id !== current?.id || scope === 'multi')
    .filter((p) => !paperQ.trim() || p.title.toLowerCase().includes(paperQ.trim().toLowerCase())
      || (p.tags ?? []).some((tg) => tg.toLowerCase().includes(paperQ.trim().toLowerCase())))
    .map((p) => ({ id: p.id, label: truncate(p.title, 64), note: papersWithPdf.has(p.id) ? undefined : 'no-pdf' })), [allPapers, paperQ, scope, current?.id, papersWithPdf]);

  const ctxItems = useMemo(() => allPapers
    .filter((p) => !targetIds.includes(p.id))
    .filter((p) => !ctxQ.trim() || p.title.toLowerCase().includes(ctxQ.trim().toLowerCase()))
    .map((p) => ({ id: p.id, label: truncate(p.title, 64), note: p.year ? String(p.year) : undefined })), [allPapers, ctxQ, targetIds]);

  const cardItems = useMemo(() => (cards ?? [])
    .map((c) => ({ id: c.id, label: truncate(c.title, 56) })), [cards]);

  const launch = async () => {
    if (scope === 'multi' && (paperIds.size < 2 || paperIds.size > 10)) {
      setErr(t('study.errCount'));
      return;
    }
    try {
      setBusy(true);
      setErr('');
      // focus 组装：方向 + 透镜（勾选时）+ 上下文论文 + 已有卡（引擎 focus 是唯一注入口）
      const focusParts: string[] = [];
      if (focus.trim()) focusParts.push('我的研究方向：' + focus.trim());
      if (lens && (mode === 'paper' || mode === 'light')) focusParts.push(ACADEMIC_LENS);
      const rel = allPapers.filter((p) => ctxIds.has(p.id));
      const relCards = (cards ?? []).filter((c) => cardIds.has(c.id));
      if (relCards.length > 0) focusParts.push('已有 idea 卡（避免重复）：' + relCards.map((c) => c.title).join('；'));
      // 上下文论文：标题 + sidecar 迷你摘要（核心结论/关键数字，每篇 ~200 字）——
      // 无 sidecar（未深读过/旧报告）回退纯标题。透镜第⑤点的对比定位由此有实质材料。
      if (rel.length > 0) {
        const briefs = await Promise.all(rel.map(async (p) => {
          try {
            const r = await api<{ sidecar: { coreConclusions?: string[]; dataPoints?: Array<{ subject: string; value: string }>; summary?: string } | null }>(`/scholar/papers/${encodeURIComponent(p.id)}/sidecar`);
            const sc = r.sidecar;
            if (!sc) return p.title;
            const concl = (sc.coreConclusions ?? []).slice(0, 2).join('；');
            const nums = (sc.dataPoints ?? []).slice(0, 2).map((d) => `${d.subject} ${d.value}`).join('，');
            const brief = `${p.title}【${concl || (sc.summary ?? '').slice(0, 80)}${nums ? `；关键数字：${nums}` : ''}】`;
            return brief.length > 260 ? brief.slice(0, 257) + '…' : brief;
          } catch {
            return p.title;
          }
        }));
        focusParts.push('库内相关论文（对比定位，透镜第⑤点引用）：' + briefs.join('；'));
      }
      // E12:effectiveCompare 派生——单篇范围时隐藏的直接对比选项不得控制请求;
      // 此前 multi+勾选→切回 single 仍发 compare 接口并报数量错误
      const effectiveCompare = scope === 'multi' && directCompare;
      const endpoint = effectiveCompare ? '/scholar/read/compare' : '/scholar/read/run';
      const payload = effectiveCompare
        ? { paperIds: targetIds, focus: focusParts.join('\n') }
        : { paperIds: targetIds, mode: mode === 'quick' ? 'quick' : 'paper', light: mode === 'light', focus: focusParts.join('\n'), autoCompare: scope === 'multi' && autoCompare };
      const r = await api<{ ok: boolean; jobId?: string; detached?: boolean; label?: string; started?: number; skipped?: number }>(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      // 后台 detached 路径没有 jobId（脱离任务系统），成功条件两种都认
      if (!r.ok || (!r.jobId && !r.detached)) throw new Error(r.label || '启动失败');
      window.dispatchEvent(new CustomEvent('scholar:read-start'));
      notify(t('study.launchedDetached', {
        label: r.label ?? '',
        count: String(r.skipped ? `${r.started ?? 0} 篇（${r.skipped} 篇无 PDF 跳过）` : `${r.started ?? 0} 篇`),
      }));
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/进行中|#\d+/.test(msg) || msg.includes('409')) {
        window.dispatchEvent(new CustomEvent('scholar:read-wake'));
      }
      setErr(msg);
    } finally {
      setBusy(false);
    }
  };

  // 门控渲染：open=false 时必须返回 null——否则详情页挂载即弹窗、关闭无效
  // （open 此前只控制数据加载，是"点卡跳精读且关不掉"的根因）
  if (!open) return null;

  return (
    <Modal title={`${t('nav.title')} · ${t('study.title')}`} onClose={onClose} width={560}>
      <SchStyles />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 2 }}>
        <div>
          <span style={labelStyle}>{t('study.scope')}</span>
          <Segment value={scope} onChange={(v) => { setScope(v); if (v !== 'multi') setDirectCompare(false);
          }} options={current ? [
            { key: 'single', label: `${t('study.single')}：${truncate(current.title, 26)}` },
            { key: 'multi', label: t('study.multi') },
          ] : [
            { key: 'multi', label: t('study.multi') },
          ]} />
        </div>

        {scope === 'multi' && (
        <div>
          <span style={labelStyle}>{t('study.pickPapers')}{paperIds.size > 0 ? `（${paperIds.size}/10）` : ''}</span>
          <SearchInput value={paperQ} onChange={(v) => setPaperQ(v)} placeholder={t('study.search')} />
          <CheckList items={paperItems} checked={paperIds} onToggle={(id) => toggle(setPaperIds, id)} max={10} />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11, cursor: 'pointer', color: directCompare ? 'var(--sch-accent)' : T.secondary }}
            onClick={(e) => { e.preventDefault(); setDirectCompare((v) => !v); if (!directCompare) setAutoCompare(false); }}>
            <input type="checkbox" checked={directCompare} readOnly style={{ accentColor: 'var(--sch-accent)', margin: 0 }} />
            {t('study.directCompare')}
          </label>
          {!directCompare && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 11, cursor: 'pointer', color: autoCompare ? 'var(--sch-accent)' : T.secondary }}
              onClick={(e) => { e.preventDefault(); setAutoCompare((v) => !v); }}
              title={t('study.autoCompareHint')}>
              <input type="checkbox" checked={autoCompare} readOnly style={{ accentColor: 'var(--sch-accent)', margin: 0 }} />
              {t('study.autoCompare')}
            </label>
          )}
        </div>
        )}

        <div>
          <span style={labelStyle}>{t('study.mode')}</span>
          <Segment value={mode} onChange={(m) => { setMode(m); if (m === 'quick') setLens(false); }} options={[
            { key: 'paper', label: t('study.paper') },
            { key: 'light', label: t('study.light') },
            { key: 'quick', label: t('study.quick') },
          ]} />
          {mode === 'paper' && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 12, fontSize: 11, cursor: 'pointer', color: T.secondary }}
              onClick={(e) => { e.preventDefault(); setLens((v) => !v); }}>
              <input type="checkbox" checked={lens} readOnly style={{ accentColor: 'var(--sch-accent)', margin: 0 }} />
              {t('study.lens')}
            </label>
          )}
          {mode === 'light' && (
            <span style={{ marginLeft: 12, fontSize: 10.5, color: T.caption }}>{t('study.lightHint')}</span>
          )}
        </div>

        <div>
          <span style={labelStyle}>{t('study.ctxPapers')}（{ctxIds.size}）</span>
          <SearchInput value={ctxQ} onChange={(v) => setCtxQ(v)} placeholder={t('study.search')} />
          <CheckList items={ctxItems} checked={ctxIds} onToggle={(id) => toggle(setCtxIds, id)} />
        </div>

        <div>
          <span style={labelStyle}>{t('study.ctxCards')}（{cardIds.size}）</span>
          <CheckList items={cardItems} checked={cardIds} onToggle={(id) => toggle(setCardIds, id)} />
        </div>

        <div>
          <span style={labelStyle}>{t('study.focus')}</span>
          <Textarea value={focus} rows={3} onChange={(e) => setFocus(e.target.value)} placeholder={t('settings.researchFocusPlaceholder')} />
        </div>

        {err && <div style={{ color: T.danger, fontSize: 11 }}>{err}</div>}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
          <span style={{ flex: 1, fontSize: 10, color: T.caption }}>{t('study.footHint2')}</span>
          <Btn onClick={onClose}>{t('common.cancel')}</Btn>
          <Btn tone="primary" onClick={() => void launch()} disabled={busy}>
            <Icon d={Icons.book} size={12} /> {t('study.launch')}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}
