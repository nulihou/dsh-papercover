/** Persist the "current research project" for quick-link actions from papers/rightbar. */
const KEY = 'dsh-scholar:current-project.v1';

export function getCurrentProjectId(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const v = localStorage.getItem(KEY);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

export function setCurrentProjectId(id: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (!id) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, id);
  } catch { /* quota */ }
}
