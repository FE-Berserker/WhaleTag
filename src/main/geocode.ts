import type { GeoSearchResult } from '../shared/ipc-types';

/**
 * Geocode a place-name query via OpenStreetMap Nominatim (docs/05 §10, B方案).
 * Returns **WGS-84** coordinates (the internal/storage system) — feed the
 * results straight to MapiqueView's `toDisplay`, which shifts to the active
 * tile datum (GCJ-02 for Gaode, identity for OSM) exactly like marker placement.
 *
 * Runs in the MAIN process on purpose: Nominatim requires a valid identifying
 * `User-Agent` (a browser `fetch` cannot set one), and the renderer CSP blocks
 * external domains. Local-first / no-telemetry: this only fires on an explicit
 * user search — never in the background.
 *
 * Nominatim usage policy: ≤1 req/s, valid UA, `limit=5`. The 400ms input
 * debounce in MapiqueView keeps interactive search within that.
 */

const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';

type FetchImpl = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Raw Nominatim jsonv2 `search` item (only the fields we read). */
interface NominatimItem {
  display_name?: string;
  lat?: string;
  lon?: string;
}

export async function geocodeNominatim(
  query: string,
  options: { userAgent: string; fetchImpl?: FetchImpl; signal?: AbortSignal }
): Promise<GeoSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const url =
    `${NOMINATIM_ENDPOINT}?format=jsonv2&limit=5&countrycodes=cn` +
    `&accept-language=zh&q=${encodeURIComponent(q)}`;
  const res = await (options.fetchImpl ?? (fetch as unknown as FetchImpl))(url, {
    headers: { 'User-Agent': options.userAgent },
    signal: options.signal,
  });
  if (!res.ok) {
    throw new Error(`Nominatim geocode failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as NominatimItem[];
  const results: GeoSearchResult[] = [];
  for (const item of data) {
    const lat = Number(item.lat);
    const lng = Number(item.lon);
    // Skip items with no usable coordinate / name (Nominatim always returns
    // both for `search`, but be defensive — a malformed item must not poison
    // the flyTo target).
    if (
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      typeof item.display_name === 'string' &&
      item.display_name.length > 0
    ) {
      results.push({ name: item.display_name, lat, lng });
    }
  }
  return results;
}
