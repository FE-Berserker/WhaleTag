import type { FulltextHit } from '../../shared/ipc-types';
import { ipcApi } from '-/services/ipc-api';

/** Cap on total hits aggregated across all enabled full-text roots. */
const MAX_TOTAL_HITS = 100;

/**
 * Runs a content search across every enabled full-text root and merges the
 * results. Roots are searched concurrently; hits are de-duplicated by absolute
 * path (a file under two overlapping roots would otherwise appear twice) and
 * capped. A root with no index (or an error) contributes nothing.
 */
export async function searchAllFulltext(
  paths: string[],
  query: string
): Promise<FulltextHit[]> {
  const q = query.trim();
  if (!q || paths.length === 0) return [];

  const perRoot = await Promise.all(
    paths.map((p) => ipcApi.searchFulltext(p, q).catch(() => [] as FulltextHit[]))
  );

  const seen = new Set<string>();
  const merged: FulltextHit[] = [];
  for (const hits of perRoot) {
    for (const hit of hits) {
      if (seen.has(hit.path)) continue;
      seen.add(hit.path);
      merged.push(hit);
      if (merged.length >= MAX_TOTAL_HITS) return merged;
    }
  }
  return merged;
}
