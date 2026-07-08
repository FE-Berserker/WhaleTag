/**
 * Geo tag helpers: coordinates encoded as tags like `geo:31.2304,121.4737`.
 *
 * React/Electron-free so parsing and formatting can be unit-tested in isolation.
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

export const GEO_TAG_PREFIX = 'geo:';

/** Matches `geo:` followed by two comma-separated decimal numbers. */
const GEO_TAG_RE = /^geo:\s*([-+]?\d+(?:\.\d+)?)\s*,\s*([-+]?\d+(?:\.\d+)?)\s*$/;

/** True when `tag` is a `geo:lat,lng` coordinate tag. */
export function isGeoTag(tag: string): boolean {
  return GEO_TAG_RE.test(tag);
}

/** Parse a `geo:lat,lng` tag into a GeoPoint, or null if invalid. */
export function parseGeoTag(tag: string): GeoPoint | null {
  const m = GEO_TAG_RE.exec(tag);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!isValidLatLng(lat, lng)) return null;
  return { lat, lng };
}

/** Build a `geo:lat,lng` tag from a coordinate. */
export function formatGeoTag(lat: number, lng: number): string {
  return `${GEO_TAG_PREFIX}${lat.toFixed(6)},${lng.toFixed(6)}`;
}

/** Scan a list of tags and return the first valid geo coordinate found. */
export function geoPointFromTags(tags: string[]): GeoPoint | null {
  for (const tag of tags) {
    const point = parseGeoTag(tag);
    if (point) return point;
  }
  return null;
}

/** Validate decimal-degree ranges. */
export function isValidLatLng(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/** Remove any existing `geo:.*` tags from a tag list. */
export function withoutGeoTags(tags: string[]): string[] {
  return tags.filter((tag) => !isGeoTag(tag));
}
