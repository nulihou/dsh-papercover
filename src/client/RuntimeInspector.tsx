/**
 * Runtime Inspector panel — settings-friendly diagnostics for the workbench.
 */
import React, { useCallback, useState } from 'react'
import { injectWorkbenchStyles, runWorkbenchInspect, type InspectorReport } from './workbench-ui/index.js'

type TFunc = (key: string, params?: Record<string, unknown>) => string

export function RuntimeInspector({ t }: { t: TFunc }) {
  injectWorkbenchStyles()
  const [report, setReport] = useState<InspectorReport | null>(null)

  const run = useCallback(() => {
    setReport(runWorkbenchInspect())
  }, [])

  React.useEffect(() => { run() }, [run])

  const score = report?.score
  const allOk = score && score.ok === score.total

  return (
    <section
      data-dsh-plugin="dsh-scholar"
      data-dsh-part="runtime-inspector"
      style={{
        marginTop: 16, padding: 14, borderRadius: 12,
        background: 'var(--dsw-alias-bg-layer-1)',
        boxShadow: '0 0 0 0.5px color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 13, fontWeight: 650, flex: 1 }}>{t('inspector.title')}</h2>
        {score && (
          <span className="wb-chip" data-sev={allOk ? 'success' : 'warn'}>
            {score.ok}/{score.total}
          </span>
        )}
        <button
          type="button"
          onClick={run}
          style={{
            fontSize: 12, padding: '5px 10px', borderRadius: 8, cursor: 'pointer', fontWeight: 600,
            border: '0.5px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
          }}
        >
          {t('inspector.refresh')}
        </button>
      </div>
      <p style={{ margin: '0 0 10px', fontSize: 11.5, color: 'var(--dsw-alias-label-caption)', lineHeight: 1.4 }}>
        {t('inspector.hint')}
      </p>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {(report?.rows ?? []).map((row) => (
          <li
            key={row.id}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              padding: '8px 10px', borderRadius: 8,
              background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent)',
            }}
          >
            <span
              aria-hidden
              style={{
                width: 8, height: 8, borderRadius: 99, marginTop: 4, flex: 'none',
                background: row.ok ? 'var(--wb-status-success)' : 'var(--wb-status-error)',
              }}
            />
            <span style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{row.label}</div>
              {row.detail && (
                <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 2, wordBreak: 'break-all' }}>
                  {row.detail}
                </div>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
