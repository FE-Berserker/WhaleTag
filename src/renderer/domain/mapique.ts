/**
 * Pure helpers for the Mapique (map) perspective.
 *
 * React/Electron-free so the geo-filtering and bounds-fitting logic can be
 * unit-tested in isolation.
 */

import type { DirEntry } from '../../shared/ipc-types';
import type { SidecarMeta } from '../../shared/whale-meta';
import { isImageFile, isVideoFile } from '../../shared/whale-meta';
import { geoPointFromTags, isGeoTag } from './geo-tag';

export interface GeoEntry {
  entry: DirEntry;
  lat: number;
  lng: number;
  /**
   * Where the coordinate came from. Since the geo:lat,lng tag is the single
   * source of truth (no parallel sidecar lat/lng field), this is always `'tag'`.
   * Kept as a literal-union field rather than collapsing to a constant so
   * call sites that branch on provenance (debug UI, future EXIF-vs-manual
   * distinction) don't need to change when we add a new source.
   */
  source: 'tag';
}

/** True if the entry is a file that might carry GPS metadata or already has a geo tag. */
export function isGeoCandidate(
  entry: DirEntry,
  sidecars?: Record<string, SidecarMeta>
): boolean {
  if (!entry.isFile) return false;
  if (isImageFile(entry.name) || isVideoFile(entry.name)) return true;
  const meta = sidecars?.[entry.name];
  if (meta?.tags?.some(isGeoTag)) return true;
  return false;
}

/**
 * Returns the subset of `entries` that carry a `geo:lat,lng` tag in their
 * sidecar. The tag is the single source of truth �?there is no parallel
 * sidecar lat/lng field (removed 2026-06-30; legacy sidecars are migrated on
 * read by `TagMetaContextProvider`).
 */
export function geoEntries(
  entries: DirEntry[],
  sidecars: Record<string, SidecarMeta>
): GeoEntry[] {
  const result: GeoEntry[] = [];
  for (const entry of entries) {
    const tags = sidecars[entry.name]?.tags;
    if (!tags) continue;
    const point = geoPointFromTags(tags);
    if (point) {
      result.push({ entry, lat: point.lat, lng: point.lng, source: 'tag' });
    }
  }
  return result;
}

/**
 * Returns geo-candidate entries whose sidecar does NOT yet carry a `geo:lat,lng`
 * tag. These are the files that need lazy EXIF extraction.
 */
export function entriesNeedingExif(
  entries: DirEntry[],
  sidecars: Record<string, SidecarMeta>
): DirEntry[] {
  return entries.filter((entry) => {
    if (!isGeoCandidate(entry)) return false;
    const tags = sidecars[entry.name]?.tags;
    if (tags && geoPointFromTags(tags)) return false;
    return true;
  });
}

/**
 * Computes a center and zoom level that shows all points. Empty input falls
 * back to a city-level view (so the road network is visible on entry instead
 * of a blank low-zoom world); a single point uses a sensible default zoom.
 *
 * The zoom value is an approximation suitable for Leaflet's `zoom` prop.
 */
export function fitBounds(points: Array<{ lat: number; lng: number }>): {
  center: [number, number];
  zoom: number;
} {
  if (points.length === 0) {
    // Default to a whole-of-China overview rather than a washed-out world
    // view. Centered on China's approximate geographic center.
    return { center: [35.8617, 104.1954], zoom: 4 };
  }
  if (points.length === 1) {
    return { center: [points[0].lat, points[0].lng], zoom: 10 };
  }

  let minLat = points[0].lat;
  let maxLat = points[0].lat;
  let minLng = points[0].lng;
  let maxLng = points[0].lng;

  for (let i = 1; i < points.length; i += 1) {
    const { lat, lng } = points[i];
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }

  const centerLat = (minLat + maxLat) / 2;
  const centerLng = (minLng + maxLng) / 2;

  // Approximate Leaflet zoom from lat/lng span. Clamp to sane bounds.
  const latSpan = Math.max(0.0001, maxLat - minLat);
  const lngSpan = Math.max(0.0001, maxLng - minLng);
  const zoomFromLat = Math.log2(180 / latSpan);
  const zoomFromLng = Math.log2(360 / lngSpan);
  const zoom = Math.max(2, Math.min(18, Math.floor(Math.min(zoomFromLat, zoomFromLng) - 1)));

  return { center: [centerLat, centerLng], zoom };
}

/**
 * Drop selection paths that are no longer in the current listing. Returns a
 * new Set when something was removed (so React re-renders) or the original
 * Set reference when nothing changed (avoid a needless re-render). O(prev.size)
 * �?replaces an O(prev.size × listing.size) scan that did the comparison via
 * `Array.some()` per path. Plan §H.21 P2-2.
 */
export function pruneSelection(
  selected: Set<string>,
  validPaths: ReadonlySet<string>
): Set<string> {
  let changed = false;
  const next = new Set(selected);
  for (const path of selected) {
    if (!validPaths.has(path)) {
      next.delete(path);
      changed = true;
    }
  }
  return changed ? next : selected;
}
