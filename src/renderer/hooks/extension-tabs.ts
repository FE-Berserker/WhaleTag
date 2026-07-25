/**
 * Pure helpers for the multi-tab file viewer, extracted so they can be unit
 * tested without loading the React provider (which pulls in redux / ipc / the
 * extension registry). See `useUndoStack-impl.ts` for the same pattern.
 */

/** Maximum number of concurrently-open tabs. Opening a (MAX_TABS+1)th evicts
 *  the least-recently-used non-dirty tab (see `pickLruEvict`). Dirty tabs are
 *  never silently evicted — if every tab is dirty the limit is temporarily
 *  exceeded until one is cleaned up. */
export const MAX_TABS = 8;

/** Stable identity for a tab: the same file opened with the same extension is
 *  one tab (dedup); the same file opened via "Open with…" with a different
 *  extension is a separate tab. Also serves as the React list key. */
export function makeTabId(filePath: string, manifestId: string): string {
  return `${filePath}::${manifestId}`;
}

/** Minimal shape `pickLruEvict` inspects. */
export interface LruCandidate {
  id: string;
  lastAccessed: number;
  filePath: string;
}

/** Choose which tab to evict when adding `newTabId` would exceed MAX_TABS.
 *  Returns the id of the least-recently-used tab that is NOT dirty (and is
 *  not the tab being added), or null if every candidate is dirty (the caller
 *  then allows the limit to be temporarily exceeded).
 *
 *  `tabs` is expected newest-first ([0] = most recently used). Pure. */
export function pickLruEvict(
  tabs: ReadonlyArray<LruCandidate>,
  newTabId: string,
  dirtyPaths: Set<string>
): string | null {
  // Iterate oldest-first (last entry = LRU) and return the first non-dirty,
  // non-new victim.
  for (let i = tabs.length - 1; i >= 0; i -= 1) {
    const t = tabs[i];
    if (t.id === newTabId) continue;
    if (dirtyPaths.has(t.filePath)) continue;
    return t.id;
  }
  return null;
}
