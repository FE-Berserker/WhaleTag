import type { DirEntry } from '../../shared/ipc-types';
import type { SidecarMeta } from '../../shared/whale-meta';
import { extractTags } from '-/services/tags';
import { geoPointFromTags } from './geo-tag';

/**
 * Shared types and constants for the recursive-entries pipeline (plan §H.24).
 *
 * `aggregateRecursiveEntries` used to be bundled with a React hook in
 * `src/renderer/hooks/useRecursiveEntries.ts`. H.24 R4 removed that hook and
 * moved the recursion into `DirectoryContentContextProvider` (single source
 * of truth �?no more two data flows), leaving this pure function here so it
 * can be unit-tested without IPC / DOM mocking and reused by the context
 * provider.
 */

/**
 * Maximum number of entries returned by a single recursive scan. Defensive
 * cap: a 100k+ file engineering root (e.g. `node_modules`) would otherwise
 * produce IPC payloads and renderer allocations that freeze the UI. When the
 * scan overflows this cap the data layer truncates and surfaces an
 * `<ErrorBanner>` (i18n `recursiveEntriesTruncated`) so the user knows the
 * view is a sample, not the whole tree.
 *
 * The number is a starting point and may be tuned; tag-chip / file-cell
 * virtual scrolling (react-window v2) keeps the rendered DOM count bounded
 * regardless, so 10k is a safe upper bound for one scan.
 */
export const MAX_RECURSIVE_ENTRIES = 10000;

export interface AggregatedRecursiveEntries {
  /** Files AND directories from the recursive scan, in scan order. */
  entries: DirEntry[];
  /** Per-entry merged (filename �?sidecar) tags, keyed by full path (R1). */
  tagsByName: Map<string, string[]>;
  /** Per-entry GPS coordinates, keyed by full path (R1); `null` = known to have none. */
  geoByName: Map<string, { lat: number; lng: number } | null>;
}

/**
 * Pure aggregation: given the flat entry list from `listDirectoryRecursive`
 * and a path �?sidecar map, build the `tagsByName` / `geoByName` projections
 * and return them alongside the entries. Files AND directories are kept �?a
 * previous version of this hook dropped directories here, which made the
 * MapiqueView's right-side tray show only files at depth > 1 and prevented
 * users from navigating into a subdirectory from within the map view.
 *
 * Keys are FULL file paths, not basenames (R1). Two same-named files in
 * different subdirs (e.g. `a/notes.md` and `b/notes.md`) therefore get
 * independent tag / geo projections, instead of clobbering each other the
 * way the legacy name-keyed aggregation did.
 *
 * Safe to import from non-React code (the directory provider + the unit
 * tests both rely on this).
 */
export function aggregateRecursiveEntries(
  visible: readonly DirEntry[],
  sidecarsByEntry: ReadonlyMap<string, SidecarMeta | undefined>
): AggregatedRecursiveEntries {
  const tagsByName = new Map<string, string[]>();
  const geoByName = new Map<string, { lat: number; lng: number } | null>();

  for (const entry of visible) {
    const meta = sidecarsByEntry.get(entry.path);
    const fileTags = extractTags(entry.name);
    const sideTags = meta?.tags ?? [];
    const merged = [...new Set([...fileTags, ...sideTags])];
    if (merged.length > 0) tagsByName.set(entry.path, merged);

    let point: { lat: number; lng: number } | null = null;
    // Geo location is read exclusively from the `geo:lat,lng` tag �?single
    // source of truth. No parallel sidecar lat/lng field.
    if (meta?.tags) {
      point = geoPointFromTags(meta.tags);
    }
    geoByName.set(entry.path, point);
  }

  return { entries: visible.slice(), tagsByName, geoByName };
}
