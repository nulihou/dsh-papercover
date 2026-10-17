/**
 * dsh-papercover顶部横幅：后台精读实时进度。
 * 有进行中 run 时 2s 轮询；完成后慢轮询至关闭；无 run 停轮询；页签隐藏时降频。
 * 完成瞬间广播 'scholar:read-done'；listen 'scholar:read-start' / 'scholar:read-wake' 唤醒。
 */
import React, { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { navBus } from './nav';
import { Icon, Icons, T, truncate } from './ui';
import type { TFunc } from './nav';

interface RunPaper { title: string; paperId?: string; state: 'pending' | 'running' | 'ok' | 'fail'; error?: string }
interface RunState {
  id: number;
  mode: 'paper' | 'quick';
  light?: boolean;
  total: number;
  skipped: number;
  startedAt: number;
  finishedAt: number | null;
  ok: number;
  fail: number;
  papers: RunPaper[];
  phase: string;
  /** 最后一次失败的原因（宿主截断 200 字） */
  error: string;
  retryable?: boolean;
  suggestLight?: boolean;
}

const DOT_COLOR: Record<RunPaper['state'], string> = {
  pending: 'var(--dsw-alias-border-l2)',
  running: 'var(--sch-accent)',
  ok: 'var(--dsw-alias-state-success-primary, #34a853)',
  fail: T.danger,
};

export function ReadProgressBanner({ t }: { t: TFunc }) {
  const [run, setRun] = useState<RunState | null>(null);
  /** 用户手动关闭过的 run id（完成态横幅可关） */
  const [dismissed, setDismissed] = useState<number | null>(null);
  /** 已广播过 read-done 的 run id（防轮询重复触发） */
  const doneFiredRef = useRef(0);
  const runRef = useRef<RunState | null>(null);
  const dismissedRef = useRef<number | null>(null);
  runRef.current = run;
  dismissedRef.current = dismissed;

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const schedule = (ms: number) => {
      if (!alive) return;
      if (timer) clearTimeout(timer);
      timer = window.setTimeout(() => { void tick(); }, ms);
    };
    const sameRun = (a: RunState | null, b: RunState | null) => {
      if (a === b) return true;
      if (!a || !b) return false;
      return a.id === b.id
        && a.finishedAt === b.finishedAt
        && a.ok === b.ok
        && a.fail === b.fail
        && a.phase === b.phase
        && a.error === b.error
        && a.papers.length === b.papers.length
        && a.papers.every((p, i) => p.state === b.papers[i]?.state && p.title === b.papers[i]?.title);
    };
    const tick = async () => {
      if (document.hidden) {
        schedule(8000);
        return;
      }
      try {
        const r = await api<{ run: RunState | null }>('/scholar/read/status');
        if (!alive) return;
        const next = r.run ?? null;
        if (!sameRun(runRef.current, next)) setRun(next);
        if (next?.finishedAt && doneFiredRef.current !== next.id) {
          doneFiredRef.current = next.id;
          window.dispatchEvent(new CustomEvent('scholar:read-done', { detail: { id: next.id } }));
        }
        if (!next) return; // 无 run：停轮询，等 wake
        if (!next.finishedAt) {
          schedule(2000);
          return;
        }
        // 完成态：慢轮询直到用户关闭
        if (dismissedRef.current !== next.id) schedule(12000);
      } catch {
        // 网络抖动：若仍有活动 run 则重试，否则停
        if (alive && runRef.current && !runRef.current.finishedAt) schedule(2500);
      }
    };
    void tick();
    const wake = () => { void tick(); };
    window.addEventListener('scholar:read-start', wake);
    window.addEventListener('scholar:read-wake', wake);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      window.removeEventListener('scholar:read-start', wake);
      window.removeEventListener('scholar:read-wake', wake);
    };
  }, []);

  if (!run || dismissed === run.id) return null;
  const done = run.finishedAt !== null;
  // F29/R16:三态结果——容器/图标/进度条共同消费同一口径
  const allFailed = done && run.fail > 0 && run.ok === 0;
  const someFailed = done && run.fail > 0 && run.ok > 0;
  const toneColor = allFailed
    ? 'var(--dsw-alias-state-danger-primary, #e5484d)'
    : someFailed
      ? 'var(--dsw-alias-state-warn-primary, #f5a524)'
      : done
        ? 'var(--dsw-alias-state-success-primary, #34a853)'
        : 'var(--sch-accent)';
  const doneCount = run.ok + run.fail;
  const runningIdx = run.papers.findIndex((p) => p.state === 'running');
  const current = runningIdx >= 0 ? run.papers[runningIdx] : null;
  const pct = run.total > 0 ? Math.round((doneCount / run.total) * 100) : 100;
  const modeLabel = t(run.mode === 'quick' ? 'study.quickLabel' : 'study.paperLabel');
  const skipNote = run.skipped > 0 ? t('study.progressSkipped', { count: String(run.skipped) }) : '';

  return (
    <div
      data-dsh-plugin="dsh-scholar"
      data-dsh-part="read-progress"
      role={done ? 'button' : undefined}
      tabIndex={done ? 0 : undefined}
      onClick={done ? () => { navBus.go('papers'); } : undefined}
      onKeyDown={done ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navBus.go('papers'); } } : undefined}
      title={done ? t('tab.papers') : undefined}
      style={{
        flex: 'none', margin: '0 12px 6px', padding: '7px 10px 8px',
        borderRadius: 9, fontSize: 11.5, lineHeight: 1.5,
        border: `1px solid color-mix(in srgb, ${toneColor} 38%, transparent)`,
        background: `color-mix(in srgb, ${toneColor} 8%, transparent)`,
        animation: 'schFadeUp .19s var(--sch-ease, ease-out)',
        cursor: done ? 'pointer' : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Icon
          d={allFailed ? Icons.close : done ? Icons.check : Icons.book}
          size={12}
          color={toneColor}
        />
        <span style={{ fontWeight: 650 }}>
          {done
            ? t('study.progressDone', { ok: String(run.ok), fail: String(run.fail) })
            : t('study.progressRunning', { mode: modeLabel, done: String(doneCount), total: String(run.total) })}
        </span>
        {!done && (
          <button
            type="button"
            onClick={() => { void fetch('/scholar/read/cancel', { method: 'POST', headers: { 'content-type': 'application/json' } }).catch(() => {}); }}
            style={{ background: 'none', cursor: 'pointer', fontSize: 10.5, padding: '1px 6px', borderRadius: 6, color: toneColor,
              border: `1px solid color-mix(in srgb, ${toneColor} 40%, transparent)` }}
          >
            {t('study.progressCancel')}
          </button>
        )}
        {done && run.fail > 0 && (
          <>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void api('/scholar/read/retry', { method: 'POST', body: JSON.stringify({ light: false }) })
                  .then(() => { window.dispatchEvent(new CustomEvent('scholar:read-wake')); })
                  .catch(() => {});
              }}
              style={{ background: 'none', cursor: 'pointer', fontSize: 10.5, padding: '1px 6px', borderRadius: 6, color: toneColor,
                border: `1px solid color-mix(in srgb, ${toneColor} 40%, transparent)` }}
            >
              {t('study.progressRetry')}
            </button>
            {(run.suggestLight || !run.light) && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void api('/scholar/read/retry', { method: 'POST', body: JSON.stringify({ light: true }) })
                    .then(() => { window.dispatchEvent(new CustomEvent('scholar:read-wake')); })
                    .catch(() => {});
                }}
                style={{ background: 'none', cursor: 'pointer', fontSize: 10.5, padding: '1px 6px', borderRadius: 6, color: toneColor,
                  border: `1px solid color-mix(in srgb, ${toneColor} 40%, transparent)` }}
              >
                {t('study.progressLight')}
              </button>
            )}
          </>
        )}
        {skipNote && <span style={{ color: T.caption, fontSize: 10.5 }}>{skipNote}</span>}
        <span style={{ flex: 1 }} />
        {!done && <span style={{ fontSize: 10.5, color: T.caption }}>{run.phase || '…'}</span>}
        {done && (
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={(e) => { e.stopPropagation(); setDismissed(run.id); }}
            style={{ all: 'unset', cursor: 'pointer', color: T.caption, display: 'inline-flex', padding: 2 }}
          ><Icon d={Icons.close} size={11} /></button>
        )}
      </div>
      {/* 进度条：done/total；running 段以斜纹示意"进行中" */}
      <div style={{
        marginTop: 6, height: 4, borderRadius: 999, overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.14))',
      }}>
        <div style={{
          width: `${pct}%`, height: '100%', borderRadius: 999,
          background: done
            // F29:全部失败=危险色;部分失败=警告色;仅全部成功才绿
            ? (run.fail > 0 && run.ok === 0
                ? 'var(--dsw-alias-state-danger-primary, #e5484d)'
                : run.fail > 0
                  ? 'var(--dsw-alias-state-warn-primary, #f5a524)'
                  : 'var(--dsw-alias-state-success-primary, #34a853)')
            : 'linear-gradient(90deg, var(--sch-accent), color-mix(in srgb, var(--sch-accent) 55%, #fff))',
          transition: 'width .45s var(--sch-ease, ease-out)',
        }} />
      </div>
      {/* 进行中：每篇状态点 + 当前篇；完成且有失败：只列失败篇名（成功完成不再画点，避免进度条下多一颗绿点像第二行） */}
      {(!done || run.fail > 0) && (
        <div style={{ marginTop: 5, display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
          {!done && run.papers.map((p, i) => (
            <span
              key={i}
              title={p.title}
              style={{
                width: 7, height: 7, borderRadius: 999, flex: 'none',
                background: DOT_COLOR[p.state],
                boxShadow: p.state === 'running' ? '0 0 0 2px color-mix(in srgb, var(--sch-accent) 25%, transparent)' : undefined,
                animation: p.state === 'running' ? 'schPulse 1.1s ease-in-out infinite' : undefined,
              }}
            />
          ))}
          {current && (
            <span style={{ color: T.secondary, fontSize: 10.5, minWidth: 0 }}>
              {truncate(current.title, 44)}
            </span>
          )}
          {done && run.fail > 0 && (
            <span style={{ color: T.danger, fontSize: 10.5 }}>
              {run.papers.filter((p) => p.state === 'fail').map((p) => truncate(p.title, 30)).join('；')}
            </span>
          )}
        </div>
      )}
      {/* 失败原因：直接回答"为什么失败"，不用翻服务器日志 */}
      {done && run.fail > 0 && run.error && (
        <div
          data-dsh-part="read-progress-error"
          title={run.error}
          style={{ marginTop: 4, fontSize: 10.5, lineHeight: 1.55, color: T.danger, wordBreak: 'break-all' }}
        >
          {truncate(run.error, 160)}
        </div>
      )}
    </div>
  );
}
