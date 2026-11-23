import type { DirEntry } from '../../../shared/ipc-types';
import type { TrayFilter, TraySort } from './constants';

/**
 * P3-5: great-circle distance between two WGS-84 points in kilometers.
 * Used by the `distance` tray sort to order rows by proximity to the
 * current map center. Inputs must already be in WGS-84 (no datum shift).
 */
export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 6371; // mean Earth radius, km
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Sidecar shape consumed by `domain/mapique` (`isGeoCandidate` / `geoEntries`). */
export interface GeoTagSidecar {
  tags?: string[];
}

/**
 * Builds the `name → sidecar` map from the merged tag list. The `geo:lat,lng`
 * tag is the single source of truth (no parallel sidecar lat/lng field); the
 * map is keyed by entry NAME because `mapique.ts` looks sidecars up by
 * `entry.name`, while `tagsByName` is path-keyed — re-keying via `entries`
 * bridges the two.
 */
export function buildSidecars(
  entries: DirEntry[],
  tagsByName: Map<string, string[]>
): Record<string, GeoTagSidecar> {
  const map: Record<string, GeoTagSidecar> = {};
  for (const e of entries) {
    const tags = tagsByName.get(e.path);
    if (!tags || tags.length === 0) continue;
    map[e.name] = { tags };
  }
  return map;
}

export interface SortTrayEntriesOptions {
  locatedPaths: Set<string>;
  traySort: TraySort;
  geoByName: Map<string, { lat: number; lng: number } | null>;
  /** Reference point for the `distance` sort (live viewport center). */
  center: { lat: number; lng: number };
}

/**
 * Sorts the file tray. Default `name` order surfaces located entries first;
 * `modified` is newest-first; `distance` re-orders by proximity to the given
 * map center (unlocated rows fall to the end, name-tied).
 */
export function sortTrayEntries(
  entries: DirEntry[],
  { locatedPaths, traySort, geoByName, center }: SortTrayEntriesOptions
): DirEntry[] {
  return entries.slice().sort((a, b) => {
    if (traySort === 'modified') {
      // Newest first; tie-break by name.
      const am = Date.parse(a.modified) || 0;
      const bm = Date.parse(b.modified) || 0;
      if (am !== bm) return bm - am;
      return a.name.localeCompare(b.name);
    }
    if (traySort === 'distance') {
      const ap = geoByName.get(a.path);
      const bp = geoByName.get(b.path);
      if (ap && bp) {
        const da = haversineKm(center, ap);
        const db = haversineKm(center, bp);
        if (da !== db) return da - db;
      } else if (ap) return -1;
      else if (bp) return 1;
      // Both unlocated: fall through to name order.
      return a.name.localeCompare(b.name);
    }
    // traySort === 'name' (default): located first, then alphabetical.
    const al = locatedPaths.has(a.path) ? 1 : 0;
    const bl = locatedPaths.has(b.path) ? 1 : 0;
    if (al !== bl) return bl - al;
    return a.name.localeCompare(b.name);
  });
}

export interface FilterTrayEntriesOptions {
  trayFilter: TrayFilter;
  locatedPaths: Set<string>;
  /** P3-1: case-insensitive substring on the file name (composes with the filter). */
  nameQuery: string;
}

/**
 * H.26 P0-3 / P3-1: filters the tray to all / located / unlocated, then by an
 * optional case-insensitive name query. Both filters compose (AND).
 */
export function filterTrayEntries(
  trayEntries: DirEntry[],
  { trayFilter, locatedPaths, nameQuery }: FilterTrayEntriesOptions
): DirEntry[] {
  const byFilter =
    trayFilter === 'all'
      ? trayEntries
      : trayEntries.filter((e) =>
          trayFilter === 'located'
            ? locatedPaths.has(e.path)
            : !locatedPaths.has(e.path)
        );
  const q = nameQuery.trim().toLowerCase();
  if (!q) return byFilter;
  return byFilter.filter((e) => e.name.toLowerCase().includes(q));
}
