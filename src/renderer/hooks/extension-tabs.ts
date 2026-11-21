/**
 * Pure helpers for the multi-tab file viewer, extracted so they can be unit
 * tested without loading the React provider (which pulls in redux / ipc / the
 * extension registry). See `useUndoStack-impl.ts` for the same pattern.
 */

import { isSameOrDescendant } from '-/services/path-util';

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

/** Path equality with the same separator/case normalization used by the file
 * watcher. A watcher path need not be byte-for-byte identical to the path that
 * opened the tab. */
export function sameFile(a: string, b: string): boolean {
  return isSameOrDescendant(a, b) && isSameOrDescendant(b, a);
}

/** Resolve a watcher/reload path without confusing two case-distinct files on
 * a case-sensitive filesystem. Exact identity always wins; the normalized
 * fallback is used only when it identifies one unambiguous open tab. */
export function findTabForFile<T extends { filePath: string }>(
  tabs: readonly T[],
  filePath: string
): T | undefined {
  const exact = tabs.find((tab) => tab.filePath === filePath);
  if (exact) return exact;
  const normalized = tabs.filter((tab) => sameFile(tab.filePath, filePath));
  return normalized.length === 1 ? normalized[0] : undefined;
}

/** Synchronize readOnly only for tabs opened from the affected location.
 * Untouched tabs (and an unchanged tab array) retain their identities. */
export function syncLocationReadOnly<
  T extends { locationId: string | null; readOnly: boolean },
>(tabs: T[], locationId: string | null, readOnly: boolean): T[] {
  let changed = false;
  const next = tabs.map((tab) => {
    if (tab.locationId !== locationId || tab.readOnly === readOnly) return tab;
    changed = true;
    return { ...tab, readOnly };
  });
  return changed ? next : tabs;
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
