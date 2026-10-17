/**
 * Research project tab: list + detail (questions, linked papers/cards/evidence, open problems).
 */
import React, { useCallback, useEffect, useState } from 'react';
import type { Evidence, IdeaCard, Paper, ResearchProject } from '../shared/types';
import { api, qs } from './api';
import { getCurrentProjectId, setCurrentProjectId } from './currentProject';
import { navBus, type TFunc } from './nav';
import {
  Btn, Chip, EmptyState, Field, Icon, Icons, IconButton, Input, Modal, SchStyles,
  SearchInput, SkeletonCards, T, Textarea, truncate,
} from './ui';

export function ProjectView({ t }: { t: TFunc }) {
  const [projects, setProjects] = useState<ResearchProject[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [selected, setSelected] = useState<ResearchProject | null>(null);
  const [creating, setCreating] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [editQuestions, setEditQuestions] = useState('');
  const [editProblems, setEditProblems] = useState('');
  const [currentId, setCurrentId] = useState<string | null>(() => getCurrentProjectId());

  // Detail enrichment
  const [papers, setPapers] = useState<Paper[]>([]);
  const [cards, setCards] = useState<IdeaCard[]>([]);
  const [evidences, setEvidences] = useState<Evidence[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const r = await api<{ projects: ResearchProject[] }>(`/scholar/projects${qs({ q })}`);
      setProjects(r.projects ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [q]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    void (async () => {
      try {
        const [pr, cr, er] = await Promise.all([
          selected.paperIds.length
            ? api<{ papers: Paper[] }>('/scholar/papers').then((d) => (d.papers ?? []).filter((p) => selected.paperIds.includes(p.id)))
            : Promise.resolve([] as Paper[]),
          selected.ideaCardIds.length
            ? api<{ cards: IdeaCard[] }>('/scholar/cards').then((d) => (d.cards ?? []).filter((c) => selected.ideaCardIds.includes(c.id)))
            : Promise.resolve([] as IdeaCard[]),
          api<{ evidences: Evidence[] }>(`/scholar/evidences${qs({ projectId: selected.id })}`)
            .then((d) => d.evidences ?? [])
            .catch(() => [] as Evidence[]),
        ]);
        if (!alive) return;
        setPapers(pr);
        setCards(cr);
        setEvidences(er);
      } catch { /* best-effort enrichment */ }
    })();
    return () => { alive = false; };
  }, [selected]);

  const openDetail = (p: ResearchProject) => {
    setSelected(p);
    setEditTitle(p.title);
    setEditSummary(p.summary ?? '');
    setEditQuestions((p.researchQuestions ?? []).join('\n'));
    setEditProblems((p.openProblems ?? []).join('\n'));
  };

  const createProject = async () => {
    const title = editTitle.trim();
    if (!title) return;
    try {
      const r = await api<{ project: ResearchProject }>('/scholar/projects', {
        method: 'POST',
        body: JSON.stringify({
          title,
          summary: editSummary.trim(),
          researchQuestions: editQuestions.split('\n').map((x) => x.trim()).filter(Boolean),
          openProblems: editProblems.split('\n').map((x) => x.trim()).filter(Boolean),
        }),
      });
      setCreating(false);
      setEditTitle(''); setEditSummary(''); setEditQuestions(''); setEditProblems('');
      await load();
      if (r.project) openDetail(r.project);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const saveDetail = async () => {
    if (!selected) return;
    try {
      const r = await api<{ project: ResearchProject }>(`/scholar/projects/${encodeURIComponent(selected.id)}`, {
        method: 'PUT',
        body: JSON.stringify({
          title: editTitle.trim(),
          summary: editSummary.trim(),
          researchQuestions: editQuestions.split('\n').map((x) => x.trim()).filter(Boolean),
          openProblems: editProblems.split('\n').map((x) => x.trim()).filter(Boolean),
        }),
      });
      setSelected(r.project);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const removeProject = async (id: string) => {
    if (!window.confirm(t('common.confirmDelete'))) return;
    try {
      await api(`/scholar/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (currentId === id) {
        setCurrentProjectId(null);
        setCurrentId(null);
      }
      if (selected?.id === id) setSelected(null);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const markCurrent = (id: string) => {
    setCurrentProjectId(id);
    setCurrentId(id);
  };

  if (selected) {
    return (
      <div className="sch-scroll sch-fade" style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', padding: '10px 12px 28px', fontSize: 12 }}>
        <SchStyles />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Btn onClick={() => setSelected(null)}><Icon d={Icons.back} size={12} /> {t('common.back')}</Btn>
          <span style={{ flex: 1 }} />
          {currentId === selected.id
            ? <Chip label={t('project.current')} color="var(--sch-accent)" />
            : <Btn tone="soft" onClick={() => markCurrent(selected.id)}>{t('project.setCurrent')}</Btn>}
          <IconButton label={t('common.delete')} color={T.danger} onClick={() => void removeProject(selected.id)} icon={<Icon d={Icons.trash} size={14} />} />
        </div>
        {err && <div role="alert" style={{ color: T.danger, marginBottom: 8 }}>{err}</div>}
        <Field label={t('project.form.title')}>
          <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
        </Field>
        <Field label={t('project.form.summary')}>
          <Textarea value={editSummary} onChange={(e) => setEditSummary(e.target.value)} />
        </Field>
        <Field label={t('project.form.questions')}>
          <Textarea rows={3} value={editQuestions} onChange={(e) => setEditQuestions(e.target.value)} placeholder={t('project.form.questionsPh')} style={{ minHeight: 64 }} />
        </Field>
        <Field label={t('project.form.openProblems')}>
          <Textarea rows={3} value={editProblems} onChange={(e) => setEditProblems(e.target.value)} placeholder={t('project.form.openProblemsPh')} style={{ minHeight: 64 }} />
        </Field>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <Btn onClick={() => void saveDetail()}>{t('common.save')}</Btn>
        </div>

        <SectionBlock title={t('project.papers', { count: String(papers.length) })}>
          {papers.length === 0 && <span style={{ color: T.caption }}>{t('common.empty')}</span>}
          {papers.map((p) => (
            <button key={p.id} type="button" className="sch-btn sch-btn--soft" style={{
              display: 'flex', width: '100%', textAlign: 'left', marginBottom: 4,
              whiteSpace: 'normal', height: 'auto', minHeight: 32, justifyContent: 'flex-start',
              lineHeight: 1.4, overflowWrap: 'anywhere', padding: '6px 10px', boxSizing: 'border-box',
            }}
              onClick={() => navBus.go('papers', p.id)}>
              {p.title}
            </button>
          ))}
        </SectionBlock>

        <SectionBlock title={t('project.cards', { count: String(cards.length) })}>
          {cards.length === 0 && <span style={{ color: T.caption }}>{t('common.empty')}</span>}
          {cards.map((c) => (
            <button key={c.id} type="button" className="sch-btn sch-btn--soft" style={{
              display: 'flex', width: '100%', textAlign: 'left', marginBottom: 4,
              whiteSpace: 'normal', height: 'auto', minHeight: 32, justifyContent: 'flex-start',
              lineHeight: 1.4, overflowWrap: 'anywhere', padding: '6px 10px', boxSizing: 'border-box',
            }}
              onClick={() => navBus.go('cards', null, c.id)}>
              {c.title}
              {c.hypothesis ? <span style={{ color: T.caption, marginLeft: 6 }}>· {t('card.hypothesis')}</span> : null}
            </button>
          ))}
        </SectionBlock>

        <SectionBlock title={t('project.evidences', { count: String(evidences.length) })}>
          {evidences.length === 0 && <span style={{ color: T.caption }}>{t('common.empty')}</span>}
          {evidences.map((e) => (
            <div key={e.id} style={{ padding: '6px 8px', marginBottom: 4, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: T.cardBg }}>
              <div style={{ fontWeight: 600 }}>{e.claim}</div>
              <div style={{ fontSize: 10.5, color: T.caption, marginTop: 2 }}>{e.kind} · ★{e.confidence}{e.page ? ` · p.${e.page}` : ''}</div>
            </div>
          ))}
        </SectionBlock>
      </div>
    );
  }

  return (
    <div className="sch-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 12px 14px', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <SchStyles />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <SearchInput value={q} onChange={setQ} placeholder={t('project.searchPh')} />
        <Btn onClick={() => { setCreating(true); setEditTitle(''); setEditSummary(''); setEditQuestions(''); setEditProblems(''); }}>
          <Icon d={Icons.plus} size={14} /> {t('project.add')}
        </Btn>
      </div>
      {err && <div role="alert" style={{ color: T.danger }}>{err}</div>}
      {loading && <SkeletonCards count={3} />}
      {!loading && projects.length === 0 && (
        <EmptyState icon={<Icon d={Icons.stack} size={28} />} title={t('project.empty')} hint={t('project.emptyHint')} />
      )}
      {!loading && projects.map((p) => (
        <div
          key={p.id}
          style={{
            display: 'flex', alignItems: 'stretch', gap: 4, width: '100%',
            borderRadius: 10, border: '1px solid var(--dsw-alias-border-l2)', background: T.cardBg,
          }}
        >
          <button
            type="button"
            onClick={() => openDetail(p)}
            style={{
              textAlign: 'left', cursor: 'pointer', flex: 1, minWidth: 0, padding: '10px 12px',
              border: 0, borderRadius: 10, background: 'transparent', color: 'inherit',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>{p.title}</span>
              {currentId === p.id && <Chip label={t('project.current')} color="var(--sch-accent)" />}
            </div>
            {p.summary && <div className="sch-prose" style={{ marginTop: 4, fontSize: 11.5, color: T.secondary, lineHeight: 1.5 }}>{truncate(p.summary, 120)}</div>}
            <div style={{ marginTop: 6, fontSize: 10.5, color: T.caption }}>
              {t('project.meta', {
                papers: String(p.paperIds.length),
                cards: String(p.ideaCardIds.length),
                evidences: String(p.evidenceIds.length),
                questions: String(p.researchQuestions.length),
              })}
            </div>
          </button>
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingRight: 6, gap: 2 }}>
            <IconButton
              label={t('project.rename')}
              size={26}
              onClick={() => {
                const next = window.prompt(t('project.form.titlePh'), p.title);
                if (next == null) return;
                const title = next.trim();
                if (!title || title === p.title) return;
                void (async () => {
                  try {
                    await api(`/scholar/projects/${encodeURIComponent(p.id)}`, {
                      method: 'PUT',
                      body: JSON.stringify({ title }),
                    });
                    await load();
                  } catch (e) {
                    setErr(e instanceof Error ? e.message : String(e));
                  }
                })();
              }}
              icon={<Icon d={Icons.edit} size={13} />}
            />
          </div>
        </div>
      ))}

      {creating && (
        <Modal title={t('project.new')} onClose={() => setCreating(false)} width={440}>
          <Field label={t('project.form.title')}>
            <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} placeholder={t('project.form.titlePh')} />
          </Field>
          <Field label={t('project.form.summary')}>
            <Textarea value={editSummary} onChange={(e) => setEditSummary(e.target.value)} />
          </Field>
          <Field label={t('project.form.questions')}>
            <Textarea rows={3} value={editQuestions} onChange={(e) => setEditQuestions(e.target.value)} placeholder={t('project.form.questionsPh')} style={{ minHeight: 64 }} />
          </Field>
          <Field label={t('project.form.openProblems')}>
            <Textarea rows={2} value={editProblems} onChange={(e) => setEditProblems(e.target.value)} placeholder={t('project.form.openProblemsPh')} style={{ minHeight: 48 }} />
          </Field>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn onClick={() => setCreating(false)}>{t('common.cancel')}</Btn>
            <Btn onClick={() => void createProject()}>{t('common.save')}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

function SectionBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 10, fontWeight: 650, letterSpacing: '.06em', textTransform: 'uppercase', color: T.caption, marginBottom: 6 }}>
        {title}
      </div>
      {children}
    </div>
  );
}
