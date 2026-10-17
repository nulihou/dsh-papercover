/**
 * Paper lifecycle helpers: derive from legacy signals, sync readStatus, advance.
 */
import type { Paper, PaperLifecycle, ReadStatus } from './shared/types.js';
import { PAPER_LIFECYCLES } from './shared/types.js';

const ORDER = new Map(PAPER_LIFECYCLES.map((k, i) => [k, i]));

/** Map lifecycle → coarse readStatus. */
export function readStatusFromLifecycle(lc: PaperLifecycle): ReadStatus {
  if (lc === 'inbox' || lc === 'saved' || lc === 'pdf_verified') return 'want';
  // `annotated` means highlights exist — still in progress, not finished.
  if (lc === 'reading' || lc === 'annotated') return 'reading';
  return 'done';
}

/** Best-effort derive when lifecycle is missing (migration / first open). */
export function deriveLifecycle(paper: Paper, hints?: {
  hasAnnotations?: boolean;
  hasCards?: boolean;
  linkedToProject?: boolean;
}): PaperLifecycle {
  if (paper.lifecycle && PAPER_LIFECYCLES.includes(paper.lifecycle)) return paper.lifecycle;
  if (hints?.linkedToProject) return 'linked';
  if (paper.summary?.trim() || hints?.hasCards) return 'distilled';
  // Highlights alone never imply "finished" — stay at reading / pdf_verified.
  if (paper.readStatus === 'done') return 'read';
  if (paper.readStatus === 'reading' || hints?.hasAnnotations) return 'reading';
  if (paper.pdfPath?.trim()) return 'pdf_verified';
  if (paper.title?.trim()) return 'saved';
  return 'inbox';
}

/** Apply lifecycle and keep readStatus in sync. */
export function withLifecycle(paper: Paper, lifecycle: PaperLifecycle, now = Date.now()): Paper {
  const lc = PAPER_LIFECYCLES.includes(lifecycle) ? lifecycle : 'saved';
  return {
    ...paper,
    lifecycle: lc,
    readStatus: readStatusFromLifecycle(lc),
    updatedAt: now,
  };
}

/** Advance only forward (or equal); never demote unless force. */
export function advanceLifecycle(
  paper: Paper,
  target: PaperLifecycle,
  opts?: { force?: boolean; now?: number },
): Paper {
  const cur = deriveLifecycle(paper);
  const curI = ORDER.get(cur) ?? 0;
  const tgtI = ORDER.get(target) ?? 0;
  if (!opts?.force && tgtI < curI) return paper;
  if (tgtI === curI && paper.lifecycle === target) return paper;
  return withLifecycle(paper, target, opts?.now ?? Date.now());
}

export function isPaperLifecycle(v: unknown): v is PaperLifecycle {
  return typeof v === 'string' && (PAPER_LIFECYCLES as readonly string[]).includes(v);
}
