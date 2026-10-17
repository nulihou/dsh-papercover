import { useSyncExternalStore } from 'react';

/**
 * Cross-view navigation: drawer tab + optional paper/card focus.
 *
 * IMPORTANT: snapshots must be value-stable — useSyncExternalStore re-renders
 * only when getSnapshot() returns a NEW reference. Every mutation replaces the
 * whole state object; never mutate it in place.
 *
 * Tab + focus persist in localStorage so a relaunch reopens the same drawer view.
 */
export type TabId = 'papers' | 'graph' | 'cards' | 'projects';

export type TFunc = (key: string, params?: Record<string, unknown>) => string;

export interface NavState {
  tab: TabId;
  paperId: string | null;
  cardId: string | null;
  /** paper id prefilled for a new idea card (cross-view capture) */
  prefillPaperId: string | null;
}

const NAV_KEY = 'dsh-scholar:nav.v1';

function isTabId(value: unknown): value is TabId {
  return value === 'papers' || value === 'graph' || value === 'cards' || value === 'projects';
}

function loadNav(): NavState {
  const fallback: NavState = { tab: 'papers', paperId: null, cardId: null, prefillPaperId: null };
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(NAV_KEY);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw) as Partial<NavState>;
    return {
      tab: isTabId(parsed.tab) ? parsed.tab : 'papers',
      paperId: typeof parsed.paperId === 'string' && parsed.paperId.trim() ? parsed.paperId : null,
      cardId: typeof parsed.cardId === 'string' && parsed.cardId.trim() ? parsed.cardId : null,
      // Prefill is a one-shot capture gesture — never revive across launches.
      prefillPaperId: null,
    };
  } catch {
    return fallback;
  }
}

function saveNav(next: NavState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(NAV_KEY, JSON.stringify({
      tab: next.tab,
      paperId: next.paperId,
      cardId: next.cardId,
    }));
  } catch { /* quota / private */ }
}

let state: NavState = loadNav();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export const navBus = {
  getSnapshot: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  go(tab: TabId, paperId?: string | null, cardId?: string | null, prefillPaperId?: string | null) {
    const next: NavState = { tab, paperId: paperId ?? null, cardId: cardId ?? null, prefillPaperId: prefillPaperId ?? null };
    if (next.tab !== state.tab || next.paperId !== state.paperId || next.cardId !== state.cardId || next.prefillPaperId !== state.prefillPaperId) {
      state = next;
      saveNav(next);
      emit();
    }
  },
  consumePrefill() {
    if (state.prefillPaperId) {
      state = { ...state, prefillPaperId: null };
      emit();
    }
  },
  consumePaperId() {
    if (state.paperId) {
      state = { ...state, paperId: null };
      saveNav(state);
      emit();
    }
  },
  consumeCardId() {
    if (state.cardId) {
      state = { ...state, cardId: null };
      saveNav(state);
      emit();
    }
  },
};

export function useNav(): NavState {
  return useSyncExternalStore(navBus.subscribe, navBus.getSnapshot);
}
