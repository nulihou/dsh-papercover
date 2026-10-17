/* dsh-papercover运行状态检查。 */
/**
 * Runtime Inspector — lightweight compat / presence diagnostics for the
 * research workbench trio. Pure client observations (no host RPC required).
 */

import { readDock } from './shell.js'
import { getActivityInbox } from '../research-protocol/inbox.js'

export type InspectorRow = {
  id: string
  label: string
  ok: boolean
  detail?: string
}

export type InspectorReport = {
  at: number
  rows: InspectorRow[]
  score: { ok: number; total: number }
}

export function runWorkbenchInspect(): InspectorReport {
  const rows: InspectorRow[] = []
  const dock = readDock()

  const plugins: Array<{ id: string; label: string }> = [
    { id: 'dsh-scholar', label: 'dsh-papercover' },
    { id: 'dsh-trajectory', label: '研究主线 / Trajectory' },
    { id: 'server-dashboard', label: '算力看板 / Dashboard' },
  ]
  for (const p of plugins) {
    const fp = dock[p.id]
    rows.push({
      id: `dock:${p.id}`,
      label: p.label,
      ok: !!fp,
      detail: fp
        ? `dock ${fp.open ? 'open' : 'idle'} · ${Math.round(fp.width)}px`
        : '未发布停靠足迹（插件未加载或未挂载）',
    })
  }

  const g = globalThis as Record<PropertyKey, unknown>
  const hasInbox = !!g[Symbol.for('dsh.research.activityInbox.v1')]
  const inboxN = hasInbox ? getActivityInbox().getSnapshot().length : 0
  rows.push({
    id: 'protocol:inbox',
    label: 'Activity Inbox 总线',
    ok: hasInbox,
    detail: hasInbox ? `${inboxN} 条动态` : '总线未初始化',
  })

  rows.push({
    id: 'protocol:nav',
    label: 'research-nav 深链',
    ok: typeof window.dispatchEvent === 'function',
    detail: '事件名 dsh-research-nav（兼容 dsh-scholar-nav）',
  })

  const shell = window.__dshWorkbenchShell
  rows.push({
    id: 'shell:primary',
    label: 'Workbench Shell',
    ok: !!shell,
    detail: shell?.primary
      ? `primary=${shell.primary}`
      : shell
        ? '协调器待命'
        : '协调器未安装',
  })

  const slotsOk = !!(document.querySelector('[data-slot="sidebar.footer.action"], [data-slot]')
    || document.querySelector('[data-dsh-plugin="dsh-scholar"]'))
  rows.push({
    id: 'host:slots',
    label: 'DSH 槽位/插件 DOM',
    ok: slotsOk,
    detail: slotsOk ? '检测到插件挂载痕迹' : '页面上未见插件节点',
  })

  const ok = rows.filter((r) => r.ok).length
  return { at: Date.now(), rows, score: { ok, total: rows.length } }
}
