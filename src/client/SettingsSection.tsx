import React, { useCallback, useEffect, useState } from 'react';
import type { ScholarConfig, ScholarStats, ZoteroSyncResult, ZoteroSyncStatus } from '../shared/types';
import { api } from './api';
import type { TFunc } from './nav';
import { Btn, Field, Icon, Icons, Input, SchStyles, Select, T } from './ui';
import { RuntimeInspector } from './RuntimeInspector';

type LlmCatalogModel = { id: string; name: string };
type LlmCatalogProvider = { id: string; name: string; models: LlmCatalogModel[] };
type LlmCatalogResponse = {
  providers: LlmCatalogProvider[];
  configured: { provider: string; model: string };
  agentDefault: { provider: string; model: string } | null;
  effective: { provider: string; model: string };
  source: 'config' | 'agent-default' | 'none';
};

export function ScholarSettings({ t }: { t: TFunc }) {
  const [config, setConfig] = useState<ScholarConfig>({ paperDir: '' });
  const [catalog, setCatalog] = useState<LlmCatalogResponse | null>(null);
  const [stats, setStats] = useState<ScholarStats | null>(null);
  const [zStatus, setZStatus] = useState<ZoteroSyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [normalizing, setNormalizing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [obsSyncing, setObsSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<ZoteroSyncResult | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [probing, setProbing] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [c, s, cat] = await Promise.all([
        api<{ config: ScholarConfig }>('/scholar/config'),
        api<ScholarStats>('/scholar/stats'),
        api<LlmCatalogResponse>('/scholar/llm-catalog').catch(() => null),
      ]);
      setConfig(c.config);
      setStats(s);
      setCatalog(cat);
      setError('');
      try {
        const st = await api<ZoteroSyncStatus>('/scholar/zotero/status');
        setZStatus(st);
        if (st.lastSync) setLastSync(st.lastSync);
      } catch {
        setZStatus(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    try {
      setSaving(true);
      const result = await api<{
        ok: boolean;
        config: ScholarConfig;
        migrate?: { migrated: boolean; message: string; moved: number; skipped: number };
      }>('/scholar/config', {
        method: 'PUT',
        body: JSON.stringify({
          paperDir: config.paperDir,
          defaultTags: (config.defaultTags ?? []).filter((x) => x.trim()),
          fetchProxy: config.fetchProxy ?? '',
          openalexEmail: config.openalexEmail ?? '',
          researchFocus: config.researchFocus ?? '',
          llmProvider: config.llmProvider ?? '',
          llmModel: config.llmModel ?? '',
          preferFallback: config.preferFallback !== false,
          jevDecide: config.jevDecide === true,
          preferProvider: config.preferProvider ?? '',
          preferModel: config.preferModel ?? '',
          preferBaseURL: config.preferBaseURL ?? '',
          preferApiKeyEnv: config.preferApiKeyEnv ?? '',
          vlmFigures: config.vlmFigures ?? 'auto',
          zoteroSyncEnabled: config.zoteroSyncEnabled ?? false,
          zoteroBaseUrl: config.zoteroBaseUrl ?? 'http://127.0.0.1:23119/api',
          zoteroLibrary: config.zoteroLibrary ?? 'user/0',
          zoteroApiKey: config.zoteroApiKey ?? '',
          zoteroServerId: config.zoteroServerId ?? '',
          obsidianVault: config.obsidianVault ?? '',
          obsidianSubdir: config.obsidianSubdir ?? 'Scholar',
        }),
      });
      if (result.migrate?.migrated) {
        setMessage(t('settings.paperDirMigrated', { message: result.migrate.message }));
      } else {
        setMessage(t('settings.saved'));
      }
      setError('');
      setTimeout(() => setMessage(''), result.migrate?.migrated ? 6000 : 2500);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const normalizeAttachments = async () => {
    try {
      setNormalizing(true);
      const r = await api<NonNullable<ScholarStats['attachmentNormalize']>>('/scholar/attachments/normalize', {
        method: 'POST',
        body: '{}',
      });
      setMessage(t('settings.attachNormDone', {
        renamed: r.renamed,
        linked: r.linked,
        conflicts: r.conflicts,
      }));
      setError('');
      setTimeout(() => setMessage(''), 4000);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setNormalizing(false);
    }
  };

  const authorize = async () => {
    try {
      setAuthorizing(true);
      setError('');
      await api('/scholar/zotero/authorize', { method: 'POST', body: '{}' });
      setMessage(t('settings.zoteroAuthOk'));
      setTimeout(() => setMessage(''), 3000);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAuthorizing(false);
    }
  };

  const sync = async (direction: 'pull' | 'push' | 'both') => {
    try {
      setSyncing(true);
      setError('');
      const r = await api<ZoteroSyncResult>('/scholar/zotero/sync', {
        method: 'POST',
        body: JSON.stringify({ direction }),
      });
      setLastSync(r);
      if (r.ok) {
        setMessage(t('settings.zoteroSyncDone', {
          pulled: Object.values(r.pulled).reduce((a, b) => a + b, 0),
          pushed: Object.values(r.pushed).reduce((a, b) => a + b, 0),
          conflicts: r.conflicts,
        }));
        setTimeout(() => setMessage(''), 5000);
      } else if (r.errors.length) {
        setError(r.errors.slice(0, 3).join(' · '));
        setMessage('');
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  const syncObsidian = async () => {
    try {
      setObsSyncing(true);
      setError('');
      const r = await api<{ written: number; skipped: number; errors: string[] }>('/scholar/obsidian/sync', {
        method: 'POST',
        body: '{}',
      });
      setMessage(t('settings.obsidianDone', { written: r.written, errors: r.errors.length }));
      setTimeout(() => setMessage(''), 4000);
      if (r.errors.length) setError(r.errors.slice(0, 2).join(' · '));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setObsSyncing(false);
    }
  };

  const fillJevDefaults = () => {
    setConfig({
      ...config,
      jevDecide: true,
      preferProvider: (config.preferProvider ?? '').trim() || 'dev',
      preferModel: (config.preferModel ?? '').trim() || 'jev-1.13.0',
      preferBaseURL: (config.preferBaseURL ?? '').trim(),
      preferApiKeyEnv: (config.preferApiKeyEnv ?? '').trim() || 'DEV_API_KEY',
    });
  };

  const probeJev = async () => {
    try {
      setProbing(true);
      setError('');
      const r = await api<{
        ok: boolean;
        value?: unknown;
        provider?: string;
        model?: string;
        role?: string;
        error?: string;
      }>('/scholar/jev-probe', {
        method: 'POST',
        body: JSON.stringify({ text: 'Scholar settings probe for Jev System One.' }),
      });
      if (r.ok) {
        const value = typeof r.value === 'object' && r.value !== null
          ? JSON.stringify(r.value)
          : String(r.value ?? '');
        setMessage(t('settings.jevProbeOk', {
          value,
          provider: r.provider ?? '—',
          model: r.model ?? '—',
          role: r.role ?? 'prefer',
        }));
      } else {
        setError(t('settings.jevProbeFail', { error: r.error || 'unknown' }));
        setMessage(t('settings.jevProbeDone'));
      }
      setTimeout(() => setMessage(''), 5000);
    } catch (e) {
      setError(t('settings.jevProbeFail', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setProbing(false);
    }
  };

  const syncStamp = lastSync ?? zStatus?.lastSync ?? null;
  const formatSyncTime = (ms?: number) => {
    if (!ms) return '—';
    try {
      return new Date(ms).toLocaleString();
    } catch {
      return String(ms);
    }
  };
  const syncBadge = (() => {
    if (!syncStamp) return { color: T.caption, text: t('settings.zoteroNever') };
    const time = formatSyncTime(syncStamp.finishedAt);
    if (syncStamp.ok) return { color: T.success, text: t('settings.zoteroLastOk', { time }) };
    if ((syncStamp.pulled.papers + syncStamp.pushed.papers) > 0 || syncStamp.conflicts > 0) {
      return { color: '#d97706', text: t('settings.zoteroLastPartial', { time, n: syncStamp.errors.length }) };
    }
    return { color: T.danger, text: t('settings.zoteroLastFail', { time }) };
  })();

  return (
    <div style={{ padding: '14px 18px', fontSize: 12, maxWidth: 560 }}>
      <SchStyles />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontWeight: 700, fontSize: 13.5 }}>{t('settings.title')}</span>
        <span style={{ flex: 1 }} />
        {message && <span style={{ color: T.success, fontSize: 11.5 }}>✓ {message}</span>}
        <Btn tone="primary" onClick={() => void save()} disabled={saving || loading}>
          {t('settings.save')}
        </Btn>
      </div>

      {loading && <div style={{ color: T.caption }}>{t('common.loading')}</div>}
      {error && <div style={{ color: T.danger, marginBottom: 8 }}>{error}</div>}

      {!loading && (
        <>
          <Field label={t('settings.paperDir')} hint={t('settings.paperDirHint')}>
            <Input value={config.paperDir} onChange={(e) => setConfig({ ...config, paperDir: e.target.value })} />
          </Field>

          <Field label={t('settings.defaultTags')} hint={t('settings.defaultTagsHint')}>
            <Input
              value={(config.defaultTags ?? []).join(', ')}
              onChange={(e) => setConfig({
                ...config,
                defaultTags: e.target.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
              })}
            />
          </Field>

          <Field label={t('settings.fetchProxy')} hint={t('settings.fetchProxyHint')}>
            <Input
              value={config.fetchProxy ?? ''}
              placeholder="http://127.0.0.1:7890"
              onChange={(e) => setConfig({ ...config, fetchProxy: e.target.value })}
            />
          </Field>

          <Field label={t('settings.openalexEmail')} hint={t('settings.openalexEmailHint')}>
            <Input
              value={config.openalexEmail ?? ''}
              placeholder="you@example.com"
              onChange={(e) => setConfig({ ...config, openalexEmail: e.target.value })}
            />
          </Field>

          <Field label={t('settings.researchFocus')} hint={t('settings.researchFocusHint')}>
            <Input
              value={config.researchFocus ?? ''}
              placeholder={t('settings.researchFocusPlaceholder')}
              onChange={(e) => setConfig({ ...config, researchFocus: e.target.value })}
            />
          </Field>

          <Field label={t('settings.llmModel')} hint={t('settings.llmModelHint')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Select
                value={config.llmProvider ?? ''}
                onChange={(e) => {
                  const provider = e.target.value;
                  const first = catalog?.providers.find((p) => p.id === provider)?.models[0]?.id ?? '';
                  setConfig({ ...config, llmProvider: provider, llmModel: provider ? first : '' });
                }}
                style={{ width: '100%' }}
              >
                <option value="">{t('settings.llmFollowDefault')}</option>
                {(catalog?.providers ?? []).map((p) => (
                  <option key={p.id} value={p.id}>{p.name || p.id}</option>
                ))}
              </Select>
              <Select
                value={config.llmModel ?? ''}
                disabled={!(config.llmProvider ?? '').trim()}
                onChange={(e) => setConfig({ ...config, llmModel: e.target.value })}
                style={{ width: '100%' }}
              >
                <option value="">{t('settings.llmPickModel')}</option>
                {(catalog?.providers.find((p) => p.id === (config.llmProvider ?? ''))?.models ?? []).map((m) => (
                  <option key={m.id} value={m.id}>{m.name || m.id}</option>
                ))}
              </Select>
              {catalog?.effective?.provider && catalog.effective.model ? (
                <div style={{ color: T.caption, fontSize: 11, lineHeight: 1.45 }}>
                  {t('settings.llmEffective', {
                    model: `${catalog.effective.provider} / ${catalog.effective.model}`,
                    source: catalog.source === 'config'
                      ? t('settings.llmSourceConfig')
                      : catalog.source === 'agent-default'
                        ? t('settings.llmSourceDefault')
                        : t('settings.llmSourceNone'),
                  })}
                </div>
              ) : null}
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: T.secondary }}>
                <input
                  type="checkbox"
                  checked={config.preferFallback !== false}
                  onChange={(e) => setConfig({ ...config, preferFallback: e.target.checked })}
                />
                <span>{t('settings.preferFallback')}</span>
              </label>
              <div style={{ color: T.caption, fontSize: 11, lineHeight: 1.45 }}>{t('settings.preferFallbackHint')}</div>
            </div>
          </Field>

          <Field label={t('settings.jevSection')} hint={t('settings.jevSectionHint')}>
            <div style={{
              display: 'flex', flexDirection: 'column', gap: 8,
              padding: '10px 12px', borderRadius: 10,
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'color-mix(in srgb, var(--sch-fill-strong) 35%, transparent)',
            }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600 }}>
                <input
                  type="checkbox"
                  checked={config.jevDecide === true}
                  onChange={(e) => setConfig({ ...config, jevDecide: e.target.checked })}
                />
                <span>{t('settings.jevDecide')}</span>
              </label>
              <Field label={t('settings.jevProvider')}>
                <Input
                  value={config.preferProvider ?? ''}
                  placeholder="dev"
                  disabled={config.jevDecide !== true}
                  onChange={(e) => setConfig({ ...config, preferProvider: e.target.value })}
                />
              </Field>
              <Field label={t('settings.jevModel')}>
                <Input
                  value={config.preferModel ?? ''}
                  placeholder="jev-1.13.0"
                  disabled={config.jevDecide !== true}
                  onChange={(e) => setConfig({ ...config, preferModel: e.target.value })}
                />
              </Field>
              <Field label={t('settings.jevBaseURL')} hint={t('settings.jevBaseURLHint')}>
                <Input
                  value={config.preferBaseURL ?? ''}
                  placeholder="https://api.example.com/v1"
                  disabled={config.jevDecide !== true}
                  onChange={(e) => setConfig({ ...config, preferBaseURL: e.target.value })}
                />
              </Field>
              <Field label={t('settings.jevApiKeyEnv')} hint={t('settings.jevApiKeyEnvHint')}>
                <Input
                  value={config.preferApiKeyEnv ?? ''}
                  placeholder="DEV_API_KEY"
                  disabled={config.jevDecide !== true}
                  onChange={(e) => setConfig({ ...config, preferApiKeyEnv: e.target.value })}
                />
              </Field>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Btn tone="soft" onClick={fillJevDefaults}>
                  {t('settings.jevFillDefaults')}
                </Btn>
                <Btn
                  tone="soft"
                  disabled={probing || config.jevDecide !== true || !(config.preferProvider ?? '').trim() || !(config.preferModel ?? '').trim()}
                  onClick={() => void probeJev()}
                >
                  {probing ? t('settings.jevProbing') : t('settings.jevProbe')}
                </Btn>
              </div>
            </div>
          </Field>

          <Field label={t('settings.vlmFigures')} hint={t('settings.vlmFiguresHint')}>
            <div style={{ display: 'inline-flex', gap: 6 }}>
              {(['auto', 'off'] as const).map((v) => {
                const active = (config.vlmFigures ?? 'auto') === v;
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setConfig({ ...config, vlmFigures: v })}
                    className="sch-press"
                    style={{
                      fontSize: 11, padding: '3px 12px', borderRadius: 8, cursor: 'pointer',
                      border: `1px solid ${active ? 'var(--sch-hairline-strong)' : 'var(--dsw-alias-border-l2)'}`,
                      background: active ? 'var(--sch-fill-strong)' : 'transparent',
                      color: active ? 'var(--dsw-alias-label-primary)' : T.secondary,
                      fontWeight: active ? 600 : 400,
                    }}
                  >{t(v === 'auto' ? 'settings.vlmAuto' : 'settings.vlmOff')}</button>
                );
              })}
            </div>
          </Field>

          <Field label={t('settings.obsidian')} hint={t('settings.obsidianHint')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Input
                value={config.obsidianVault ?? ''}
                placeholder={t('settings.obsidianPlaceholder')}
                onChange={(e) => setConfig({ ...config, obsidianVault: e.target.value })}
              />
              <Input
                value={config.obsidianSubdir ?? 'Scholar'}
                placeholder="Scholar"
                onChange={(e) => setConfig({ ...config, obsidianSubdir: e.target.value })}
              />
              <Btn
                tone="soft"
                disabled={obsSyncing || !(config.obsidianVault ?? '').trim()}
                onClick={() => void syncObsidian()}
              >
                {obsSyncing ? t('settings.obsidianSyncing') : t('settings.obsidianSync')}
              </Btn>
            </div>
          </Field>

          <Field label={t('settings.zotero')} hint={t('settings.zoteroHint')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 11, color: T.secondary }}>
                {zStatus?.reachable
                  ? t('settings.zoteroOnline', {
                    ver: zStatus.zoteroVersion || '—',
                    key: zStatus.hasWriteKey ? t('settings.zoteroKeyYes') : t('settings.zoteroKeyNo'),
                  })
                  : t('settings.zoteroOffline', { msg: zStatus?.error || '—' })}
              </div>
              <div style={{
                fontSize: 11.5, fontWeight: 600, color: syncBadge.color,
                padding: '6px 10px', borderRadius: 8,
                border: `1px solid color-mix(in srgb, ${syncBadge.color} 35%, transparent)`,
                background: `color-mix(in srgb, ${syncBadge.color} 10%, transparent)`,
              }}>
                {syncBadge.text}
              </div>
              {syncStamp && !syncStamp.ok && syncStamp.errors[0] && (
                <div style={{ fontSize: 11, color: T.danger, lineHeight: 1.45 }}>
                  {syncStamp.errors.length > 1
                    ? t('settings.zoteroLastErrorMore', { msg: syncStamp.errors[0], n: syncStamp.errors.length - 1 })
                    : t('settings.zoteroLastError', { msg: syncStamp.errors[0] })}
                </div>
              )}
              {zStatus?.mapCounts && (
                <div style={{ fontSize: 10.5, color: T.caption }}>
                  {t('settings.zoteroMapped', {
                    papers: zStatus.mapCounts.papers,
                    collections: zStatus.mapCounts.collections,
                  })}
                </div>
              )}
              <Input
                value={config.zoteroBaseUrl ?? 'http://127.0.0.1:23119/api'}
                onChange={(e) => setConfig({ ...config, zoteroBaseUrl: e.target.value })}
                placeholder="http://127.0.0.1:23119/api"
              />
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <Btn tone="soft" onClick={() => void authorize()} disabled={authorizing || syncing}>
                  {authorizing ? t('common.loading') : t('settings.zoteroAuth')}
                </Btn>
                <Btn tone="primary" onClick={() => void sync('both')} disabled={syncing || authorizing}>
                  {syncing ? t('settings.zoteroSyncing') : t('settings.zoteroSyncBoth')}
                </Btn>
                <Btn onClick={() => void sync('pull')} disabled={syncing}>{t('settings.zoteroPull')}</Btn>
                <Btn onClick={() => void sync('push')} disabled={syncing}>{t('settings.zoteroPush')}</Btn>
              </div>
              {syncStamp && (
                <div style={{ fontSize: 10.5, color: T.caption, lineHeight: 1.45 }}>
                  {t('settings.zoteroSyncDetail', {
                    pp: syncStamp.pulled.papers,
                    pc: syncStamp.pulled.collections,
                    pdf: syncStamp.pulled.pdfs,
                    up: syncStamp.pushed.papers,
                    uc: syncStamp.pushed.collections,
                    conflicts: syncStamp.conflicts,
                    ms: syncStamp.durationMs,
                  })}
                </div>
              )}
            </div>
          </Field>

          {stats && (
            <div style={{
              marginTop: 14, display: 'flex', alignItems: 'center', gap: 8,
              border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10,
              background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))',
              padding: '9px 12px', flexWrap: 'wrap',
            }}>
              <Icon d={Icons.book} size={13} color={T.business} />
              <span style={{ fontSize: 11, color: T.secondary }}>
                {t('settings.statsLine', {
                  papers: stats.papers,
                  cards: stats.cards,
                  nodes: stats.nodes,
                  edges: stats.edges,
                })}
              </span>
              <span style={{
                flex: 1, minWidth: 60, textAlign: 'right',
                fontSize: 10, color: T.caption, overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }} title={stats.dir}>
                {stats.dir}
              </span>
            </div>
          )}

          <Field label={t('settings.attachNorm')} hint={t('settings.attachNormHint')}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Btn tone="soft" onClick={() => void normalizeAttachments()} disabled={normalizing || loading}>
                <Icon d={Icons.refresh} size={13} /> {t('settings.attachNormRun')}
              </Btn>
              {stats?.attachmentNormalize && (
                <span style={{ fontSize: 11, color: T.caption }}>
                  {(stats.attachmentNormalize.renamed + stats.attachmentNormalize.linked + stats.attachmentNormalize.conflicts) > 0
                    ? t('settings.attachNormDone', {
                      renamed: stats.attachmentNormalize.renamed,
                      linked: stats.attachmentNormalize.linked,
                      conflicts: stats.attachmentNormalize.conflicts,
                    })
                    : t('settings.attachNormIdle')}
                </span>
              )}
            </div>
          </Field>
        </>
      )}

      <RuntimeInspector t={t} />
    </div>
  );
}
