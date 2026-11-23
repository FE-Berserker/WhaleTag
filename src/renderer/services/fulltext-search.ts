import type { FulltextHit } from '../../shared/ipc-types';
import { ipcApi } from '-/services/ipc-api';

/** Cap on total hits aggregated across all enabled full-text roots. */
const MAX_TOTAL_HITS = 100;

export interface FulltextSearchResult {
  hits: FulltextHit[];
  /** Roots whose search failed — the caller must surface a partial-failure warning. */
  failedRoots: string[];
}

/**
 * Runs a content search across every enabled full-text root and merges the
 * results. Roots are searched concurrently; hits are de-duplicated by absolute
 * path (a file under two overlapping roots would otherwise appear twice) and
 * capped. A root with no index contributes nothing; a root whose search fails
 * is reported through `failedRoots` instead of being silently dropped, so the
 * UI can tell the user the results are incomplete.
 */
export async function searchAllFulltext(
  paths: string[],
  query: string
): Promise<FulltextSearchResult> {
  const q = query.trim();
  if (!q || paths.length === 0) return { hits: [], failedRoots: [] };

  const failedRoots: string[] = [];
  const perRoot = await Promise.all(
    paths.map((p) =>
      ipcApi.searchFulltext(p, q).catch((error: unknown) => {
        failedRoots.push(p);
        console.warn('[fulltext-search] root search failed:', p, error);
        return [] as FulltextHit[];
      })
    )
  );

  const seen = new Set<string>();
  const merged: FulltextHit[] = [];
  for (const hits of perRoot) {
    for (const hit of hits) {
      if (seen.has(hit.path)) continue;
      seen.add(hit.path);
      merged.push(hit);
      if (merged.length >= MAX_TOTAL_HITS) return { hits: merged, failedRoots };
    }
  }
  return { hits: merged, failedRoots };
}
