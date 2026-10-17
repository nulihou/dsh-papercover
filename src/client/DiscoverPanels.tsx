/**
 * OpenAlex discovery + BibTeX import panels (paper library toolbar).
 */
import React, { useRef, useState } from 'react';
import type { Paper } from '../shared/types';
import { api } from './api';
import type { TFunc } from './nav';
import { Btn, Icon, Icons, Input, Modal, T, Textarea, truncate } from './ui';

interface SearchHit {
  openalexId: string;
  title: string;
  year?: number;
  venue?: string;
  doi?: string;
  arxivId?: string;
  citedBy: number;
  authors: string[];
  abstract?: string;
  url?: string;
  libraryPaperId?: string;
}

export function DiscoverModal({
  t, onClose, onIngested,
}: {
  t: TFunc;
  onClose: () => void;
  onIngested: () => void;
}) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Map<string, string>>(new Map());

  const run = async () => {
    if (!q.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ results: SearchHit[]; note?: string }>(
        `/scholar/search?q=${encodeURIComponent(q.trim())}&limit=12`,
      );
      setHits(r.results ?? []);
      setNote(r.note ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const ingest = async (h: SearchHit) => {
    if (saving.has(h.openalexId)) return;
    setSaving((cur) => new Set(cur).add(h.openalexId));
    try {
      const r = await api<{ created: boolean; paper: Paper }>('/scholar/search', {
        method: 'POST',
        body: JSON.stringify({
          title: h.title,
          authors: h.authors,
          year: h.year,
          venue: h.venue,
          doi: h.doi,
          arxivId: h.arxivId,
          url: h.url,
          abstract: h.abstract,
          fetchPdf: true,
        }),
      });
      setAdded((cur) => new Map(cur).set(h.openalexId, r.paper.id));
      onIngested();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving((cur) => {
        const n = new Set(cur);
        n.delete(h.openalexId);
        return n;
      });
    }
  };

  return (
    <Modal title={t('paper.discover')} onClose={onClose} width={560}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('paper.discoverPh')}
          onKeyDown={(e) => { if (e.key === 'Enter') void run(); }}
          style={{ flex: 1 }}
        />
        <Btn tone="primary" disabled={busy || !q.trim()} onClick={() => void run()}>
          {busy ? '…' : t('paper.discoverRun')}
        </Btn>
      </div>
      {error && <div style={{ color: T.danger, fontSize: 11, marginBottom: 8 }}>{error}</div>}
      {!hits.length && !busy && (
        <div style={{ color: T.caption, fontSize: 11.5 }}>{note || t('paper.discoverEmpty')}</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 360, overflow: 'auto' }}>
        {hits.map((h) => {
          const libId = h.libraryPaperId ?? added.get(h.openalexId);
          return (
            <div
              key={h.openalexId}
              style={{
                display: 'flex', gap: 8, alignItems: 'flex-start',
                border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 9, padding: '8px 10px',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.4 }}>{h.title}</div>
                <div style={{ fontSize: 10, color: T.caption, marginTop: 2 }}>
                  {(h.authors ?? []).slice(0, 3).join(', ')}
                  {h.year ? ` · ${h.year}` : ''}
                  {h.venue ? ` · ${truncate(h.venue, 28)}` : ''}
                  {h.arxivId ? ` · arXiv:${h.arxivId}` : ''}
                </div>
                {h.abstract && (
                  <div style={{
                    fontSize: 10.5, color: T.secondary, marginTop: 4, lineHeight: 1.45,
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                  }}>{h.abstract}</div>
                )}
              </div>
              {libId ? (
                <span style={{ flex: 'none', fontSize: 10, color: T.success, padding: '3px 8px' }}>
                  {t('paper.discoverIngested')}
                </span>
              ) : (
                <Btn
                  tone="soft"
                  disabled={saving.has(h.openalexId)}
                  onClick={() => void ingest(h)}
                >
                  {t('paper.discoverIngest')}
                </Btn>
              )}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

export function BibtexImportModal({
  t, onClose, onImported,
}: {
  t: TFunc;
  onClose: () => void;
  onImported: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (file: File | null) => {
    if (!file) return;
    try {
      setText(await file.text());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const run = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError('');
    setResult('');
    try {
      const r = await api<{ imported: number; duplicates: number; skipped: number; errors: string[] }>(
        '/scholar/bibtex/import',
        { method: 'POST', body: JSON.stringify({ bibtex: text }) },
      );
      setResult(t('paper.bibtexImportDone', {
        imported: r.imported,
        duplicates: r.duplicates,
        skipped: r.skipped,
      }));
      if (r.errors?.length) setError(r.errors.slice(0, 3).join(' · '));
      if (r.imported > 0) onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('paper.bibtexImport')} onClose={onClose} width={520}>
      <div style={{ fontSize: 11, color: T.caption, marginBottom: 8 }}>{t('paper.bibtexImportHint')}</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <Btn onClick={() => fileRef.current?.click()}>
          <Icon d={Icons.doc} size={12} /> .bib
        </Btn>
        <input
          ref={fileRef}
          type="file"
          accept=".bib,text/plain"
          style={{ display: 'none' }}
          onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
        />
      </div>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={12}
        placeholder="@article{...}"
        style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 11 }}
      />
      {error && <div style={{ color: T.danger, fontSize: 11, marginTop: 8 }}>{error}</div>}
      {result && <div style={{ color: T.success, fontSize: 11, marginTop: 8 }}>{result}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <Btn onClick={onClose}>{t('common.cancel')}</Btn>
        <Btn tone="primary" disabled={busy || !text.trim()} onClick={() => void run()}>
          {busy ? '…' : t('paper.bibtexImportRun')}
        </Btn>
      </div>
    </Modal>
  );
}
