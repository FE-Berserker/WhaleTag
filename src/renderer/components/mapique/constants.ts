import type { TagGroup } from '../../domain/tag-library';

// Gaode/AutoNavi tiles — reachable in mainland China (OSM tile servers usually
// are not), GCJ-02 datum.
export const GAODE_TILE_URL =
  'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}';
export const GAODE_TILE_SUBDOMAINS = ['1', '2', '3', '4'];
export const GAODE_TILE_ATTRIBUTION = '&copy; <a href="https://amap.com">高德地图 AutoNavi</a>';
// OpenStreetMap (the classic Leaflet tile source), WGS-84 datum.
export const OSM_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
export const OSM_TILE_SUBDOMAINS = ['a', 'b', 'c'];
export const OSM_TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

export const PANEL_WIDTH = 300;
export const PREVIEW_HEIGHT = 120;

// P0-3 (perf audit): stable empty defaults. The `tagColors` / `groups`
// props default to these constants (not inline `{}` / `[]`, which would be a
// fresh reference each render) so the React.memo'd <GeoMarker> children that
// receive them can bail out on unrelated re-renders. In practice FileList
// passes shallow-stable values from useShallowEqualSelector anyway; this is
// defense for the no-arg / test path.
export const EMPTY_TAG_COLORS: Record<string, string> = {};
export const EMPTY_GROUPS: TagGroup[] = [];

// H.26 P1-1: per-location persisted preferences for Mapique.
export type TrayFilter = 'all' | 'located' | 'unlocated';
// P3-5: tray sort key. `distance` is dynamic — it re-orders as the user
// pans the map, so the closest-to-center rows surface first.
export type TraySort = 'name' | 'modified' | 'distance';
export interface MapiquePrefs {
  panelOpen?: boolean;
  trayFilter?: TrayFilter;
  traySort?: TraySort;
}
