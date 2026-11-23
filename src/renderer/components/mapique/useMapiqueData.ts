import { useMemo, useRef, type MutableRefObject } from 'react';

import type { DirEntry } from '../../../shared/ipc-types';
import { getGeoColor } from '../../domain/tag-colors';
import { fitBounds, geoEntries, isGeoCandidate, type GeoEntry } from '../../domain/mapique';
import type { TrayFilter, TraySort } from './constants';
import {
  buildSidecars,
  filterTrayEntries,
  sortTrayEntries,
  type GeoTagSidecar,
} from './tray-data';

export interface MapiqueDataParams {
  entries: DirEntry[];
  tagsByName: Map<string, string[]>;
  geoByName: Map<string, { lat: number; lng: number } | null>;
  traySort: TraySort;
  trayFilter: TrayFilter;
  nameQuery: string;
  /** P3-5: live viewport center used by the `distance` sort (null before first pan). */
  mapCenter: { lat: number; lng: number } | null;
  /** WGS-84 → tile datum shift for the initial map center. */
  toDisplay: (lat: number, lng: number) => [number, number];
}

export interface MapiqueData {
  sidecars: Record<string, GeoTagSidecar>;
  candidates: DirEntry[];
  knownGeo: GeoEntry[];
  locatedPaths: Set<string>;
  geoColorMap: Map<string, string>;
  /** Every entry in the folder, sorted by `traySort`. */
  trayEntries: DirEntry[];
  /** `trayEntries` after the located/unlocated filter + name search. */
  visibleTrayEntries: DirEntry[];
  /** P0-3: latest tray snapshots, read by the referentially stable `selectRow`. */
  visibleTrayEntriesRef: MutableRefObject<DirEntry[]>;
  /** Unfiltered tray: markers whose row the filter hid are still activatable. */
  allTrayEntriesRef: MutableRefObject<DirEntry[]>;
  trayIndexByPathRef: MutableRefObject<Map<string, number>>;
  /** WGS-84 → tile datum map center fitted to the known GPS points. */
  center: [number, number];
  zoom: number;
}

/**
 * Data layer for MapiqueView: sidecars / geo candidates / located set / marker
 * colours / tray ordering + filtering, plus the refs that keep `selectRow` and
 * the map-marker click handler referentially stable (perf audit P0-3).
 *
 * Pure derivation is delegated to `tray-data.ts` so it can be unit-tested
 * without React; this hook owns only the memoization/dep wiring.
 */
export function useMapiqueData({
  entries,
  tagsByName,
  geoByName,
  traySort,
  trayFilter,
  nameQuery,
  mapCenter,
  toDisplay,
}: MapiqueDataParams): MapiqueData {
  const sidecars = useMemo(
    () => buildSidecars(entries, tagsByName),
    [entries, tagsByName]
  );

  const candidates = useMemo(
    () => entries.filter((e) => isGeoCandidate(e, sidecars)),
    [entries, sidecars]
  );

  const knownGeo = useMemo(
    () => geoEntries(entries, sidecars),
    [entries, sidecars]
  );

  const locatedPaths = useMemo(
    () => new Set(knownGeo.map((g) => g.entry.path)),
    [knownGeo]
  );

  // Consistent color for each geo-located entry, shared between map markers
  // and the file tray indicators. Entries with the exact same coordinates
  // share the same color so they visually group together.
  const geoColorMap = useMemo(() => {
    const map = new Map<string, string>();
    knownGeo.forEach((g) => {
      map.set(g.entry.path, getGeoColor(g.lat, g.lng));
    });
    return map;
  }, [knownGeo]);

  // Tray: every entry in the folder so any file or folder can be located
  // without leaving the map view. The `distance` sort uses the live viewport
  // center (pushed from `MapMoveTracker`), falling back to the initial
  // fitBounds centroid until the first pan.
  const trayEntries = useMemo(() => {
    const fit = fitBounds(knownGeo.map((g) => ({ lat: g.lat, lng: g.lng })));
    const fitCenter = { lat: fit.center[0], lng: fit.center[1] };
    const center = mapCenter ?? fitCenter;
    return sortTrayEntries(entries, {
      locatedPaths,
      traySort,
      geoByName,
      center,
    });
  }, [entries, locatedPaths, traySort, knownGeo, geoByName, mapCenter]);

  // H.26 P0-3: filter the tray to all / located / unlocated; P3-1 adds the
  // name search. Selection and select-all operate on the visible subset.
  const visibleTrayEntries = useMemo(
    () => filterTrayEntries(trayEntries, { trayFilter, locatedPaths, nameQuery }),
    [trayEntries, trayFilter, locatedPaths, nameQuery]
  );

  // P0-3 (perf audit): hold the latest tray snapshot + path→index map in refs
  // so `selectRow` (used by BOTH tray rows and map markers) can be
  // referentially stable. Without this, `selectRow` rebuilds on every
  // `setMapCenter` — a `moveend` recomputes `trayEntries` for the `distance`
  // sort (mapCenter is in its dep list), so `visibleTrayEntries` and
  // `selectRow` get fresh identities on every pan. The marker click handler
  // built on `selectRow` would then bust <GeoMarker>'s React.memo on every
  // pan, rebuilding every Leaflet marker (the exact cost P0-3 removes).
  const visibleTrayEntriesRef = useRef(visibleTrayEntries);
  visibleTrayEntriesRef.current = visibleTrayEntries;
  // Unfiltered tray: a marker whose row the tray filter hid still has to be
  // activatable from the map (the click used to be a silent no-op).
  const allTrayEntriesRef = useRef(trayEntries);
  allTrayEntriesRef.current = trayEntries;
  const trayIndexByPath = useMemo(() => {
    const m = new Map<string, number>();
    for (let i = 0; i < visibleTrayEntries.length; i += 1) {
      m.set(visibleTrayEntries[i].path, i);
    }
    return m;
  }, [visibleTrayEntries]);
  const trayIndexByPathRef = useRef(trayIndexByPath);
  trayIndexByPathRef.current = trayIndexByPath;

  const { center, zoom } = useMemo(() => {
    const fit = fitBounds(knownGeo.map((g) => ({ lat: g.lat, lng: g.lng })));
    // fitBounds works in WGS-84; shift the center to the tile datum so the map
    // aligns with the (also-shifted) markers.
    const [cLat, cLng] = toDisplay(fit.center[0], fit.center[1]);
    return { center: [cLat, cLng] as [number, number], zoom: fit.zoom };
  }, [knownGeo, toDisplay]);

  return {
    sidecars,
    candidates,
    knownGeo,
    locatedPaths,
    geoColorMap,
    trayEntries,
    visibleTrayEntries,
    visibleTrayEntriesRef,
    allTrayEntriesRef,
    trayIndexByPathRef,
    center,
    zoom,
  };
}
