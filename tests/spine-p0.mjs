/**
 * Domain unit checks for P0 spine: lifecycle derive/advance + evidence/project link invariants.
 * Run: node --experimental-strip-types tests/spine-p0.mjs  (or via smoke after build)
 */
import assert from 'node:assert/strict';
import { deriveLifecycle, advanceLifecycle, readStatusFromLifecycle, withLifecycle } from '../src/lifecycle.ts';
import { createEvidence, createProject, applyProjectPatch, createCard, createPaper } from '../src/domain.ts';
import type { Paper } from '../src/shared/types.ts';

function basePaper(over: Partial<Paper> = {}): Paper {
  return {
    id: 'p1',
    title: 'Test Paper',
    authors: [],
    tags: [],
    source: 'manual',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

// lifecycle derive
assert.equal(deriveLifecycle(basePaper()), 'saved');
assert.equal(deriveLifecycle(basePaper({ pdfPath: 'attachments/x.pdf' })), 'pdf_verified');
assert.equal(deriveLifecycle(basePaper({ readStatus: 'reading' })), 'reading');
assert.equal(deriveLifecycle(basePaper({ readStatus: 'done' })), 'read');
assert.equal(deriveLifecycle(basePaper({ summary: 'one line' })), 'distilled');
assert.equal(deriveLifecycle(basePaper(), { hasAnnotations: true }), 'annotated');
assert.equal(deriveLifecycle(basePaper(), { linkedToProject: true }), 'linked');

assert.equal(readStatusFromLifecycle('inbox'), 'want');
assert.equal(readStatusFromLifecycle('reading'), 'reading');
assert.equal(readStatusFromLifecycle('linked'), 'done');

const advanced = advanceLifecycle(basePaper({ lifecycle: 'saved' }), 'read');
assert.equal(advanced.lifecycle, 'read');
assert.equal(advanced.readStatus, 'done');

// never demote without force
const kept = advanceLifecycle(basePaper({ lifecycle: 'distilled' }), 'reading');
assert.equal(kept.lifecycle, 'distilled');

const forced = advanceLifecycle(basePaper({ lifecycle: 'distilled' }), 'reading', { force: true });
assert.equal(forced.lifecycle, 'reading');

const synced = withLifecycle(basePaper(), 'annotated');
assert.equal(synced.lifecycle, 'annotated');
assert.equal(synced.readStatus, 'done');

// evidence + project link invariants
const ev = createEvidence({ claim: 'X improves Y', paperId: 'p1', confidence: 4 });
assert.ok(ev.id.startsWith('ev_'));
assert.equal(ev.kind, 'author_claim');
assert.equal(ev.confidence, 4);

const proj = createProject({
  title: 'Depth anything',
  researchQuestions: ['Q1'],
  paperIds: ['p1'],
  evidenceIds: [ev.id],
});
assert.ok(proj.id.startsWith('proj_'));
assert.deepEqual(proj.paperIds, ['p1']);

const linked = applyProjectPatch(proj, {
  paperIds: [...proj.paperIds, 'p1', 'p2'],
  evidenceIds: [...proj.evidenceIds, ev.id],
  ideaCardIds: ['c1'],
});
// dedupe
assert.deepEqual(linked.paperIds, ['p1', 'p2']);
assert.deepEqual(linked.evidenceIds, [ev.id]);
assert.deepEqual(linked.ideaCardIds, ['c1']);

const card = createCard({
  title: 'Idea',
  insight: 'Try X',
  paperId: 'p1',
  hypothesis: 'X beats baseline',
  researchQuestion: 'Does X help?',
  evidenceIds: [ev.id],
});
assert.equal(card.hypothesis, 'X beats baseline');
assert.deepEqual(card.evidenceIds, [ev.id]);

const paper = createPaper({ title: 'New', authors: [], tags: [], importance: 3 });
assert.equal(paper.lifecycle, 'saved');
assert.equal(paper.readStatus, 'want');

console.log('spine-p0: ok');
