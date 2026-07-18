import {
  memo,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useCallback,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  InputAdornment,
  Link,
  MenuItem,
  Select,
  Snackbar,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  MapContainer,
  Marker,
  Popup,
  TileLayer,
  useMap,
  useMapEvents,
} from 'react-leaflet';
import L from 'leaflet';
import MarkerClusterGroup from 'react-leaflet-cluster';
import LocationOnIcon from '@mui/icons-material/LocationOn';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import SaveIcon from '@mui/icons-material/Save';
import DriveFileMoveIcon from '@mui/icons-material/DriveFileMove';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import SearchIcon from '@mui/icons-material/Search';
import ClearIcon from '@mui/icons-material/Close';
import RefreshIcon from '@mui/icons-material/Refresh';
import LockIcon from '@mui/icons-material/Lock';
import LockOpenIcon from '@mui/icons-material/LockOpen';

import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';

import type { TFunction } from 'i18next';
import type { DirEntry, ExifProcessedRecord } from '../../shared/ipc-types';
import type { TagGroup } from '../domain/tag-library';
import { getTagColor, getGeoColor } from '../domain/tag-colors';
import {
  entriesNeedingExif,
  fitBounds,
  geoEntries,
  isGeoCandidate,
  type GeoEntry,
} from '../domain/mapique';
import { wgs84ToGcj02, gcj02ToWgs84 } from '../domain/gcj02';
import type { MapProvider } from '-/reducers/settings';
import { useSelector } from 'react-redux';
import { chipSx, tagDisplayLabel } from '-/services/tag-display';
import type { RootState } from '-/reducers';
import { ipcApi } from '-/services/ipc-api';
import { parentDir } from '-/services/path-util';
import { useCurrentLocationContext } from '-/hooks/CurrentLocationContextProvider';
import { useImageExport, type ClipboardKind } from '-/hooks/useImageExport';
import { useUndoStack } from '-/hooks/useUndoStack';
import { readPrefs, writePrefs } from '../domain/perspective-prefs';
import LoadingOverlay from './perspective/LoadingOverlay';
import EmptyHint from './perspective/EmptyHint';
import ErrorBanner from './perspective/ErrorBanner';
import ThumbIcon from './ThumbIcon';
import InlineTagInput from './InlineTagInput';
import MapiqueContextMenu, {
  type MapiqueContext,
} from './MapiqueContextMenu';
import MapiqueTray from './MapiqueTray';

// Gaode/AutoNavi tiles — reachable in mainland China (OSM tile servers usually
// are not), GCJ-02 datum.
const GAODE_TILE_URL =
  'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}';
const GAODE_TILE_SUBDOMAINS = ['1', '2', '3', '4'];
const GAODE_TILE_ATTRIBUTION = '&copy; <a href="https://amap.com">高德地图 AutoNavi</a>';
// OpenStreetMap (the classic Leaflet tile source), WGS-84 datum.
const OSM_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_TILE_SUBDOMAINS = ['a', 'b', 'c'];
const OSM_TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const PANEL_WIDTH = 300;
const PREVIEW_HEIGHT = 120;

// P0-3 (perf audit): stable empty defaults. The `tagColors` / `groups`
// props default to these constants (not inline `{}` / `[]`, which would be a
// fresh reference each render) so the React.memo'd <GeoMarker> children that
// receive them can bail out on unrelated re-renders. In practice FileList
// passes shallow-stable values from useShallowEqualSelector anyway; this is
// defense for the no-arg / test path.
const EMPTY_TAG_COLORS: Record<string, string> = {};
const EMPTY_GROUPS: TagGroup[] = [];

export interface MapiqueViewProps {
  entries: DirEntry[];
  geoByName: Map<string, { lat: number; lng: number } | null>;
  tagsByName: Map<string, string[]>;
  thumbCache: Map<string, string>;
  onGpsFound: (entry: DirEntry, lat: number, lng: number) => void;
  onOpen?: (entry: DirEntry) => void;
  /**
   * Delete handler for the current tray selection (or active entry). Wired
   * up by FileList to the shared `handleDeleteSelected` (H.16) so the
   * Delete-key behavior in the tray matches list / grid / kanban.
   * Plan §H.21 P1-1.
   */
  onDelete?: (entries: DirEntry[]) => void;
  /** Map source; decides default tiles and whether GCJ-02 transform applies. */
  provider?: MapProvider;
  /** Optional custom tile URL that overrides the provider's default tiles. */
  tileUrl?: string;
  readOnly?: boolean;
  /** True while the directory content (incl. the recursive scan) is loading. */
  loading?: boolean;
  // Tag/coordinate editing for the active file (single-entry operations).
  onSetGeo?: (entry: DirEntry, lat: number, lng: number) => void;
  onClearGeo?: (entry: DirEntry) => void;
  onAddTag?: (entry: DirEntry, tag: string) => void;
  onRemoveTag?: (entry: DirEntry, tag: string) => void;
  tagColors?: Record<string, string>;
  groups?: TagGroup[];
}

// H.26 P1-1: per-location persisted preferences for Mapique.
type TrayFilter = 'all' | 'located' | 'unlocated';
// P3-5: tray sort key. `distance` is dynamic — it re-orders as the user
// pans the map, so the closest-to-center rows surface first.
type TraySort = 'name' | 'modified' | 'distance';
interface MapiquePrefs {
  panelOpen?: boolean;
  trayFilter?: TrayFilter;
  traySort?: TraySort;
}

/**
 * Mapique perspective: a single-view workspace combining an interactive map
 * with a right-hand detail panel. Coordinates come from sidecar / geo tags /
 * EXIF; missing EXIF GPS is extracted lazily and persisted.
 *
 * All operations happen here without leaving the view: pick a file from the
 * tray (or click a marker) to make it active, click the map to set its
 * location (drag the marker to fine-tune), and add/remove tags inline.
 */
export default function MapiqueView({
  entries,
  geoByName,
  tagsByName,
  thumbCache,
  onGpsFound,
  onOpen,
  onDelete,
  provider = 'gaode',
  tileUrl,
  readOnly = false,
  loading = false,
  onSetGeo,
  onClearGeo,
  onAddTag,
  onRemoveTag,
  tagColors = EMPTY_TAG_COLORS,
  groups = EMPTY_GROUPS,
}: MapiqueViewProps) {
  // Re-render whenever the parent's `geoByName` / `tagsByName` props change
  // identity, even if React's normal prop-diff path doesn't take effect for
  // some reason in this view. TagMetaContextProvider re-derives these maps
  // on every `setSidecars` (post-save), so any sidecar mutation triggers a
  // fresh identity and this bump. Belt-and-braces with the `key` prop on
  // the rendering site in FileList — either path alone is enough; together
  // they cover the case where the parent render is skipped but the props
  // (and therefore the deps here) are still being read fresh.
  //
  // P3-6 fix: also re-render when `thumbCacheVersion` bumps. The shared
  // thumb cache is a ref-held Map that mutates silently (no React
  // signal); the version counter is bumped by `onThumbLoaded` from the
  // tray's ThumbIcons so marker icons (which read the cache directly)
  // re-render with the fresh data URL.
  const [, forceRender] = useReducer((x: number) => x + 1, 0);
  const { t } = useTranslation();
  const {
    currentLocation,
    currentDirectoryPath,
    navigateTo,
  } = useCurrentLocationContext();
  const mapWrapperRef = useRef<HTMLDivElement>(null);

  const PREFS_KEY_PREFIX = 'whale.mapique.';

  const [ctxMenu, setCtxMenu] = useState<MapiqueContext | null>(null);
  const [trayFilter, setTrayFilter] = useState<TrayFilter>('all');
  // P3-5: tray row sort key. Persisted per-location (P1-1) so a returning
  // user keeps their preferred order across sessions.
  const [traySort, setTraySort] = useState<TraySort>('name');
  // P3-1: tray name search (local state, not persisted across sessions).
  const [nameQuery, setNameQuery] = useState('');
  const [panelOpen, setPanelOpen] = useState(true);
  // P3-3: notices can be plain (e.g. "Coordinates copied") or undoable
  // (e.g. "Location updated" with a Snackbar action button).
  type Notice = { message: string; undoable?: boolean };
  const [notice, setNotice] = useState<Notice | null>(null);

  // P3-3: undo stack for geo mutations. Each entry records the previous
  // coordinates (or null = none) so a single `undo()` re-applies them.
  type GeoOp = {
    entry: DirEntry;
    prevLat: number | null;
    prevLng: number | null;
  };
  const undoStack = useUndoStack<GeoOp>();
  // H.24 R4: depth now comes from the global `viewDepth` setting; entries /
  // tagsByName / geoByName props already reflect that scan, and `loading`
  // covers the in-flight state. No more local slider / per-view recursion.
  const loadingRecursive = loading;

  // Resolve tiles + datum from the chosen provider. A custom tileUrl overrides
  // only the URL; the datum still follows the provider (so a custom GCJ-02 tile
  // server can be used under "gaode").
  const isGcj02 = provider === 'gaode';
  const resolvedTileUrl = tileUrl || (isGcj02 ? GAODE_TILE_URL : OSM_TILE_URL);
  const tileSubdomains = isGcj02 ? GAODE_TILE_SUBDOMAINS : OSM_TILE_SUBDOMAINS;
  const tileAttribution = isGcj02 ? GAODE_TILE_ATTRIBUTION : OSM_TILE_ATTRIBUTION;
  // Stored coordinates are WGS-84; Gaode renders in GCJ-02. `toDisplay` shifts
  // WGS-84 → tile datum for placing markers; `fromDisplay` shifts a map click
  // back to WGS-84 before storing.
  const toDisplay = useCallback(
    (lat: number, lng: number): [number, number] => {
      if (!isGcj02) return [lat, lng];
      const g = wgs84ToGcj02(lat, lng);
      return [g.lat, g.lng];
    },
    [isGcj02]
  );
  const fromDisplay = useCallback(
    (lat: number, lng: number): { lat: number; lng: number } =>
      isGcj02 ? gcj02ToWgs84(lat, lng) : { lat, lng },
    [isGcj02]
  );

  // When opening a file from a subdirectory, navigate the file list to that
  // directory first so the selection is visible.
  const handleOpen = useCallback(
    (entry: DirEntry) => {
      if (currentDirectoryPath && parentDir(entry.path) !== currentDirectoryPath) {
        navigateTo(parentDir(entry.path));
      } else {
        onOpen?.(entry);
      }
    },
    [currentDirectoryPath, navigateTo, onOpen]
  );

  // True while one or more EXIF-extraction batches are still running. Tracked
  // via a counter ref so the spinner clears reliably even when the effect
  // re-runs (and cancels a prior batch) mid-extraction.
  const [extractingActive, setExtractingActive] = useState(false);
  const activeBatchesRef = useRef(0);
  // Files whose EXIF we have already attempted to extract (success or fail).
  // Cleared when the user navigates to a different directory — EXIF reads are
  // cheap and re-extracting is safer than caching a stale "already tried"
  // flag forever (P0-3 from plan §H.21).
  const processedRef = useRef<Set<string>>(new Set());
  // Timestamp (ms) of the most recent marker dragend. Used to suppress the
  // map's own `click` event that Leaflet fires immediately after — without
  // this guard, dragging a marker to a new spot would write the new
  // coordinates via `dragend`, then *also* write the (possibly different)
  // map-plane click coordinate from the same mouseup via `MapClickHandler`,
  // leaving the marker at the wrong spot (plan §H.21 P2 / Bug #2).
  const lastDragEndAtRef = useRef(0);
  const [activeEntry, setActiveEntry] = useState<DirEntry | null>(null);
  // Place-lock (default ON): clicking the map does NOT place/move markers,
  // preventing accidental geo edits while panning/zooming/browsing. Toggle off
  // to place the selected/active entry.
  const [placeLocked, setPlaceLocked] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // P3-2: tray row hover → bouncing marker. Transient UI state, not persisted.
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  // P3-4: bump to re-trigger EXIF extraction (e.g. after "Refresh" button
  // clears the persisted cache). Refs alone don't trigger the lazy-EXIF
  // effect, so a state bump is the simplest re-entry hook.
  const [exifRefreshKey, setExifRefreshKey] = useState(0);
  // P3-5: live viewport center for the `distance` sort. Pushed from the
  // Leaflet `moveend` event so panning/zooming immediately reorders the
  // tray (closest-to-center rows surface first). Starts null; falls back
  // to the initial fitBounds centroid until the user actually pans.
  const [mapCenter, setMapCenter] = useState<{ lat: number; lng: number } | null>(null);
  const selectAnchorRef = useRef<number | null>(null);

  // Re-render whenever the parent's `geoByName` / `tagsByName` props change
  // identity (TagMetaContextProvider re-derives them on every `setSidecars`,
  // so any sidecar mutation triggers a fresh identity and this bump), and
  // Re-render whenever the parent's `geoByName` / `tagsByName` props change
  // identity, even if React's normal prop-diff path doesn't take effect for
  // some reason in this view. TagMetaContextProvider re-derives these maps
  // on every `setSidecars` (post-save), so any sidecar mutation triggers a
  // fresh identity and this bump. Belt-and-braces with the `key` prop on
  // the rendering site in FileList — either path alone is enough; together
  // they cover the case where the parent render is skipped but the props
  // (and therefore the deps here) are still being read fresh.
  useEffect(() => {
    forceRender();
  }, [geoByName, tagsByName]);

  // H.26 P1-1: load per-location prefs (panel open state + tray filter + sort).
  useEffect(() => {
    const id = currentLocation?.id;
    if (!id) return;
    const prefs = readPrefs<MapiquePrefs>(PREFS_KEY_PREFIX + id);
    if (prefs?.panelOpen !== undefined) setPanelOpen(prefs.panelOpen);
    if (
      prefs?.trayFilter &&
      ['all', 'located', 'unlocated'].includes(prefs.trayFilter)
    ) {
      setTrayFilter(prefs.trayFilter);
    }
    if (
      prefs?.traySort &&
      ['name', 'modified', 'distance'].includes(prefs.traySort)
    ) {
      setTraySort(prefs.traySort);
    }
  }, [currentLocation?.id]);

  // H.26 P1-1: persist per-location prefs with a small debounce.
  useEffect(() => {
    const id = currentLocation?.id;
    if (!id) return;
    const timer = setTimeout(() => {
      writePrefs<MapiquePrefs>(PREFS_KEY_PREFIX + id, {
        panelOpen,
        trayFilter,
        traySort,
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [currentLocation?.id, panelOpen, trayFilter, traySort]);

  const sidecars = useMemo(() => {
    // Built only from the merged tag list — the `geo:lat,lng` tag is the
    // single source of truth (no parallel sidecar lat/lng field). Keyed by
    // entry NAME because mapique.ts (isGeoCandidate / geoEntries) looks
    // sidecars up by `entry.name`; tagsByName is path-keyed (H.24 R1), so we
    // re-key via `entries` to bridge the two.
    const map: Record<string, { tags?: string[] }> = {};
    for (const e of entries) {
      const tags = tagsByName.get(e.path);
      if (!tags || tags.length === 0) continue;
      map[e.name] = { tags };
    }
    return map;
  }, [entries, tagsByName]);

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

  // P3-2: apply/remove the bounce class on the corresponding Leaflet marker
  // DOM element. Markers are not React-rendered DOM, so we mutate via querySelector.
  // Re-runs on `knownGeo` change so the class survives marker re-creation.
  useEffect(() => {
    document.querySelectorAll('.whale-pin-bounce').forEach((el) => {
      el.classList.remove('whale-pin-bounce');
    });
    if (hoveredPath) {
      const escaped = hoveredPath.replace(/"/g, '\\"');
      const el = document.querySelector(`[data-entry-path="${escaped}"]`);
      if (el) el.classList.add('whale-pin-bounce');
    }
  }, [hoveredPath, knownGeo]);

  // Tray: every entry in the folder so any file or folder can be located
  // without leaving the map view. Located entries first (green indicator),
  // then alphabetical. P3-5: the secondary key is now `traySort` — the
  // user can switch to "modified" (newest first) or "distance" (closest
  // to the current map center first) for spatial browsing. The `distance`
  // center is the live viewport center (pushed from `MapMoveTracker`),
  // falling back to the initial fitBounds centroid until the first pan.
  const trayEntries = useMemo(() => {
    const fit = fitBounds(knownGeo.map((g) => ({ lat: g.lat, lng: g.lng })));
    const fitCenter = { lat: fit.center[0], lng: fit.center[1] };
    const center = mapCenter ?? fitCenter;
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
  }, [entries, locatedPaths, traySort, knownGeo, geoByName, mapCenter]);

  // H.26 P0-3: filter the tray to all / located / unlocated. Selection and
  // select-all operate on the visible subset. P3-1: also apply a name search
  // (case-insensitive substring) so the user can quickly locate a file in
  // large folders; both filters compose (AND).
  const visibleTrayEntries = useMemo(() => {
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
  }, [trayEntries, trayFilter, locatedPaths, nameQuery]);

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
  const trayIndexByPath = useMemo(() => {
    const m = new Map<string, number>();
    for (let i = 0; i < visibleTrayEntries.length; i += 1) {
      m.set(visibleTrayEntries[i].path, i);
    }
    return m;
  }, [visibleTrayEntries]);
  const trayIndexByPathRef = useRef(trayIndexByPath);
  trayIndexByPathRef.current = trayIndexByPath;

  const selectRow = useCallback(
    (index: number, mods: { shift: boolean; ctrl: boolean }) => {
      // P0-3: read the tray through a ref so this callback never changes
      // identity when the tray reorders (pan / sort / filter) — see the refs
      // above. Behaves identically to the prior closure-over-array version.
      const tray = visibleTrayEntriesRef.current;
      const entry = tray[index];
      if (!entry) return;
      setSelected((prev) => {
        const next = new Set(prev);
        if (mods.shift && selectAnchorRef.current !== null) {
          const a = selectAnchorRef.current;
          const [lo, hi] = a < index ? [a, index] : [index, a];
          for (let i = lo; i <= hi; i += 1) next.add(tray[i].path);
        } else if (mods.ctrl) {
          if (next.has(entry.path)) next.delete(entry.path);
          else next.add(entry.path);
          selectAnchorRef.current = index;
        } else {
          next.clear();
          next.add(entry.path);
          selectAnchorRef.current = index;
        }
        return next;
      });
      setActiveEntry(entry);
    },
    []
  );

  // H.4 (plan §H.4) extended for Mapique: an honest 3-state select-all that
  // doesn't lie when the user has out-of-tray selections (e.g. mid depth
  // change, or paths remembered from a previous directory).
  const inTraySelectedCount = useMemo(() => {
    let n = 0;
    for (const e of visibleTrayEntries) if (selected.has(e.path)) n += 1;
    return n;
  }, [visibleTrayEntries, selected]);
  const outOfTraySelectedCount = selected.size - inTraySelectedCount;
  const selectAllState = useMemo<'checked' | 'indeterminate' | 'unchecked'>(
    () => {
      if (selected.size === 0 || visibleTrayEntries.length === 0) return 'unchecked';
      if (inTraySelectedCount === visibleTrayEntries.length) return 'checked';
      return 'indeterminate';
    },
    [selected.size, inTraySelectedCount, visibleTrayEntries.length]
  );
  const toggleSelectAll = useCallback(() => {
    if (selectAllState === 'checked') {
      if (outOfTraySelectedCount > 0) {
        setSelected((prev) => {
          const next = new Set(prev);
          for (const e of visibleTrayEntries) next.delete(e.path);
          return next;
        });
      } else {
        setSelected(new Set());
      }
      selectAnchorRef.current = null;
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      for (const e of visibleTrayEntries) next.add(e.path);
      return next;
    });
    selectAnchorRef.current = null;
  }, [selectAllState, visibleTrayEntries, outOfTraySelectedCount]);

  // Clear selection when the filter changes so invisible items don't stay selected.
  useEffect(() => {
    setSelected(new Set());
  }, [trayFilter]);

  // P3-1: also clear selection when the name query changes — same rationale
  // as `trayFilter`: don't keep rows selected that are no longer visible.
  useEffect(() => {
    setSelected(new Set());
  }, [nameQuery]);

  // Drop the active entry / selection if they left the current listing.
  useEffect(() => {
    if (activeEntry && !entries.some((e) => e.path === activeEntry.path)) {
      setActiveEntry(null);
    }
    setSelected((prev) => {
      const next = new Set(prev);
      for (const path of prev) {
        if (!entries.some((e) => e.path === path)) next.delete(path);
      }
      return next;
    });
  }, [entries, activeEntry]);

  // P0-3 from plan §H.21: clear the EXIF "already tried" cache when the user
  // navigates to a different directory. Without this, deleting a sidecar's
  // lat/lng manually (or switching between two photo folders with the same
  // filenames) would never trigger re-extraction — `processedRef` would keep
  // blocking it for the component's lifetime.
  //
  // P3-4: replace the pure-clear effect with a clear-then-load. The clear
  // happens synchronously so the lazy-EXIF effect below doesn't fire with a
  // stale `processedRef`, then the persisted cache is rehydrated from
  // `index.db` to skip files we've already proven have no GPS.
  useEffect(() => {
    const rootPath = currentLocation?.path;
    processedRef.current = new Set();
    if (!rootPath) return;
    let cancelled = false;
    (async () => {
      try {
        const records = await ipcApi.loadExifProcessed(rootPath);
        if (cancelled) return;
        const next = new Set<string>();
        for (const r of records) next.add(r.path);
        processedRef.current = next;
      } catch {
        // If the load fails (db missing, permission, etc.) leave the
        // in-memory set empty — extraction will re-attempt the work, and
        // the user can still hit Refresh to retry.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentDirectoryPath, currentLocation?.path]);

  // P3-4: wipe the persisted EXIF cache and re-trigger extraction. The
  // state bump feeds the lazy-EXIF effect below (refs alone don't).
  const handleRefreshExifCache = useCallback(async () => {
    const rootPath = currentLocation?.path;
    if (!rootPath) return;
    try {
      await ipcApi.clearExifProcessed(rootPath);
    } catch {
      // Best-effort; the in-memory clear + refresh still helps the user.
    }
    processedRef.current = new Set();
    setExifRefreshKey((k) => k + 1);
    setNotice({ message: t('mapiqueExifCacheCleared') });
  }, [currentLocation?.path, t]);

  // P3-3: clear the undo stack on directory change. Mutations from the
  // previous directory reference entry paths that no longer apply.
  useEffect(() => {
    undoStack.clear();
  }, [currentDirectoryPath, undoStack]);

  const { center, zoom } = useMemo(() => {
    const fit = fitBounds(knownGeo.map((g) => ({ lat: g.lat, lng: g.lng })));
    // fitBounds works in WGS-84; shift the center to the tile datum so the map
    // aligns with the (also-shifted) markers.
    const [cLat, cLng] = toDisplay(fit.center[0], fit.center[1]);
    return { center: [cLat, cLng] as [number, number], zoom: fit.zoom };
  }, [knownGeo, toDisplay]);

  // Lazy EXIF extraction for media candidates without GPS.
  useEffect(() => {
    const rootPath = currentLocation?.path;
    const missing = entriesNeedingExif(candidates, sidecars).filter(
      (e) => !processedRef.current.has(e.path)
    );
    if (missing.length === 0) return;

    // Only mark a path as "processed" once extraction has actually succeeded
    // (or definitively returned null). Marking upfront would permanently cache
    // transient failures (file lock, IO error, malformed EXIF) and prevent
    // re-attempts — plan §H.21 P0-2.
    const markProcessed = (path: string) => processedRef.current.add(path);

    // P3-4: persist the result so reopening this directory skips the file.
    // The try/catch is intentionally broad: a SQLite write failure must
    // never block the in-memory processedRef (which already short-circuits
    // the re-attempt within this session).
    // Batch EXIF results into one IPC (one transaction + fsync per batch)
    // instead of one IPC per image — a folder of N photos used to fire N
    // fsyncs on the main thread. Flushed when the batch fills and on completion.
    const EXIF_BATCH = 25;
    const pending: ExifProcessedRecord[] = [];
    const flushExif = (): void => {
      if (!rootPath || pending.length === 0) return;
      const batch = pending.splice(0, pending.length);
      ipcApi.markExifProcessedMany(rootPath, batch).catch(() => {
        // best-effort: swallow — in-memory processedRef is still correct.
      });
    };
    const persistExif = (path: string, gps: { lat: number; lng: number } | null) => {
      pending.push({
        path,
        status: gps ? 'ok' : 'none',
        lat: gps ? gps.lat : null,
        lng: gps ? gps.lng : null,
        triedAt: Date.now(),
      });
      if (pending.length >= EXIF_BATCH) flushExif();
    };

    let cancelled = false;
    const CONCURRENCY = 8;
    const queue = [...missing];

    activeBatchesRef.current += 1;
    setExtractingActive(true);

    async function worker() {
      while (!cancelled && queue.length > 0) {
        const entry = queue.shift()!;
        try {
          const gps = await ipcApi.extractGps(entry.path);
          if (cancelled) return;
          if (gps) onGpsFound(entry, gps.lat, gps.lng);
          // gps === null means "no GPS data" (definitively), not a transient
          // failure — cache that too so we don't rescan the same file forever.
          markProcessed(entry.path);
          persistExif(entry.path, gps);
        } catch {
          // Transient failure: leave the path out of `processedRef` so the
          // next time this effect runs (e.g. after a sidecar refresh or
          // location change) we'll try again.
        }
      }
    }

    // `.finally` always runs — even when this batch was cancelled by a
    // dependency change — so the active-batch counter never gets stuck.
    void Promise.all(Array.from({ length: CONCURRENCY }, worker)).finally(() => {
      // Flush records collected since the last size-triggered flush (also runs
      // on cancel, so completed extractions aren't lost on a dep change).
      flushExif();
      activeBatchesRef.current = Math.max(0, activeBatchesRef.current - 1);
      if (activeBatchesRef.current === 0) setExtractingActive(false);
    });

    return () => {
      cancelled = true;
    };
    // exifRefreshKey is the re-entry hook for the "Refresh EXIF cache"
    // button (P3-4): bumping it re-runs this effect with an empty
    // processedRef so every file gets re-extracted.
  }, [candidates, sidecars, onGpsFound, exifRefreshKey, currentLocation?.path]);

  const canEdit = !readOnly;

  const captureMap = useCallback(async (): Promise<string | null> => {
    const el = mapWrapperRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return ipcApi.captureRegion({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  }, []);

  const {
    saving,
    error,
    handleSave,
    handleSaveAs,
    handleCopyToClipboard,
  } = useImageExport({
    capture: captureMap,
    prefix: `mapique-${currentLocation?.id ?? 'default'}`,
  });

  // H.26 P1-4: copy the rendered map image to the clipboard. The hook tells us
  // whether the OS accepted a real PNG blob or whether we fell back to base64.
  const onCopyToClipboard = useCallback(async () => {
    try {
      const kind: ClipboardKind = await handleCopyToClipboard();
      setNotice({ message: kind === 'image' ? t('tagCloudCopied') : t('tagCloudCopiedAsBase64') });
    } catch (e) {
      setNotice({ message: e instanceof Error ? e.message : String(e) });
    }
  }, [handleCopyToClipboard, t]);

  // H.26 P0-1: copy coordinates to the OS clipboard and surface a notice.
  const onCopyCoordinates = useCallback(
    async (lat: number, lng: number) => {
      try {
        await navigator.clipboard.writeText(`${lat.toFixed(6)}, ${lng.toFixed(6)}`);
        setNotice({ message: t('mapiqueCopiedCoordinates') });
      } catch (e) {
        setNotice({ message: e instanceof Error ? e.message : String(e) });
      }
    },
    [t]
  );

  // H.26 P0-1: map-level blank right-click. Leaflet's `contextmenu` event
  // supplies the clicked lat/lng; we convert to WGS-84 before storing.
  const handleMapContextMenu = useCallback(
    (lat: number, lng: number, x: number, y: number) => {
      setCtxMenu({ x, y, type: 'blank', lat, lng });
    },
    []
  );

  // H.26 P0-1: tray-row right-click surfaces the same entry menu as a marker.
  // Coordinates come from the parent-supplied geoByName map, falling back to
  // a `geo:` tag so the menu works even when the parent hasn't pre-resolved
  // coordinates (e.g. in tests that only supply tagsByName).
  const handleTrayContextMenu = useCallback(
    (entry: DirEntry, x: number, y: number) => {
      let point = geoByName.get(entry.path);
      if (!point) {
        const tags = tagsByName.get(entry.path);
        const geoTag = tags?.find((t) => t.startsWith('geo:'));
        if (geoTag) {
          const [lat, lng] = geoTag.slice(4).split(',').map(Number);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            point = { lat, lng };
          }
        }
      }
      setCtxMenu({
        x,
        y,
        type: 'tray',
        entry,
        lat: point?.lat,
        lng: point?.lng,
      });
    },
    [geoByName, tagsByName]
  );

  // H.26 P0-1: make the tray entry active and open the detail panel so the user
  // can edit tags inline.
  const handleEditTags = useCallback((entry: DirEntry) => {
    setActiveEntry(entry);
    setPanelOpen(true);
  }, []);

  // H.26 P0-1: reveal the entry in the OS file manager.
  const handleReveal = useCallback((entry: DirEntry) => {
    void ipcApi.revealAndSelect(entry.path);
  }, []);

  const selectedEntries = useMemo(
    () => visibleTrayEntries.filter((e) => selected.has(e.path)),
    [visibleTrayEntries, selected]
  );
  const selectedCount = selected.size;

  // P3-3: wrap onSetGeo / onClearGeo so every mutation is recorded on the
  // undo stack. The actual `onSetGeo` / `onClearGeo` callbacks are still
  // called unchanged — the undo stack is purely additive metadata.
  const recordPrev = (entry: DirEntry): { prevLat: number | null; prevLng: number | null } => {
    const prev = geoByName.get(entry.path);
    return {
      prevLat: prev ? prev.lat : null,
      prevLng: prev ? prev.lng : null,
    };
  };
  const applySetGeo = useCallback(
    (entry: DirEntry, lat: number, lng: number) => {
      undoStack.push({ entry, ...recordPrev(entry) });
      onSetGeo?.(entry, lat, lng);
    },
    [geoByName, onSetGeo, undoStack]
  );
  const applyClearGeo = useCallback(
    (entry: DirEntry) => {
      undoStack.push({ entry, ...recordPrev(entry) });
      onClearGeo?.(entry);
    },
    [geoByName, onClearGeo, undoStack]
  );

  // P3-3: handle the Snackbar's Undo button — pop the most recent geo op
  // and re-apply the previous coordinates (or clear, if it had none).
  const handleUndo = useCallback(() => {
    const op = undoStack.undo();
    if (!op) return;
    if (op.prevLat !== null && op.prevLng !== null) {
      onSetGeo?.(op.entry, op.prevLat, op.prevLng);
    } else {
      onClearGeo?.(op.entry);
    }
    setNotice(null);
  }, [onSetGeo, onClearGeo, undoStack]);

  // H.26 P0-1: set the location of all selected files from a blank-map click.
  const handleSetLocationForSelection = useCallback(
    (lat: number, lng: number) => {
      if (!canEdit || selectedCount === 0) return;
      const wgs = fromDisplay(lat, lng);
      selectedEntries.forEach((entry) => applySetGeo(entry, wgs.lat, wgs.lng));
      setNotice({
        message:
          selectedCount === 1
            ? t('mapiqueGeoUpdated')
            : t('mapiqueGeoUpdatedMulti', { count: selectedCount }),
        undoable: true,
      });
    },
    [canEdit, selectedCount, selectedEntries, fromDisplay, applySetGeo, t]
  );

  // H.26 P0-1: clear the location of all selected files.
  const handleClearLocationForSelection = useCallback(() => {
    if (!canEdit || selectedCount === 0) return;
    selectedEntries.forEach((entry) => applyClearGeo(entry));
    setNotice({
      message:
        selectedCount === 1
          ? t('mapiqueGeoUpdated')
          : t('mapiqueGeoUpdatedMulti', { count: selectedCount }),
      undoable: true,
    });
  }, [canEdit, selectedCount, selectedEntries, applyClearGeo, t]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, type: 'blank' });
  }, []);

  // H.26 P0-3: when the tray filter changes, reset the keyboard focus anchor.
  // (Selection is already cleared in a dedicated effect above.)

  // Click the map → set the location of all selected files, or the active file
  // when nothing is selected (WGS-84).
  const handleMapClick = useCallback(
    (lat: number, lng: number) => {
      if (!canEdit || placeLocked) return;
      const wgs = fromDisplay(lat, lng);
      let changed = 0;
      if (selectedCount > 0) {
        selectedEntries.forEach((entry) => {
          applySetGeo(entry, wgs.lat, wgs.lng);
          changed += 1;
        });
      } else if (activeEntry) {
        applySetGeo(activeEntry, wgs.lat, wgs.lng);
        changed = 1;
      }
      if (changed > 0) {
        setNotice({
          message:
            changed === 1
              ? t('mapiqueGeoUpdated')
              : t('mapiqueGeoUpdatedMulti', { count: changed }),
          undoable: true,
        });
      }
    },
    [
      canEdit,
      placeLocked,
      activeEntry,
      selectedCount,
      selectedEntries,
      fromDisplay,
      applySetGeo,
      t,
    ]
  );

  // P0-3 (perf audit): map-marker interaction handlers, kept referentially
  // stable so the React.memo'd <GeoMarker> children bail out on panning /
  // sorting / unrelated state instead of rebuilding every Leaflet marker
  // (fresh DivIcon + react-leaflet event rebind) each render. Volatile data
  // (tray index, applySetGeo) is read through refs so the handler identities
  // never change.
  const applySetGeoRef = useRef(applySetGeo);
  applySetGeoRef.current = applySetGeo;

  const handleMarkerClick = useCallback(
    (path: string, mods: { shift: boolean; ctrl: boolean }) => {
      const idx = trayIndexByPathRef.current.get(path);
      if (idx === undefined) return;
      selectRow(idx, mods);
    },
    [selectRow]
  );

  const handleMarkerContextMenu = useCallback(
    (geo: GeoEntry, x: number, y: number) => {
      setCtxMenu({
        x,
        y,
        type: 'marker',
        entry: geo.entry,
        lat: geo.lat,
        lng: geo.lng,
      });
    },
    []
  );

  const handleMarkerDragEnd = useCallback(
    (geo: GeoEntry, lat: number, lng: number) => {
      const wgs = fromDisplay(lat, lng);
      lastDragEndAtRef.current = Date.now();
      applySetGeoRef.current(geo.entry, wgs.lat, wgs.lng);
      setNotice({ message: t('mapiqueGeoUpdated'), undoable: true });
    },
    [fromDisplay, t]
  );

  const activeGeo = activeEntry ? geoByName.get(activeEntry.path) ?? null : null;
  const activeTags = activeEntry ? tagsByName.get(activeEntry.path) ?? [] : [];

  const emptyHint =
    !extractingActive && knownGeo.length === 0
      ? candidates.length === 0
        ? t('noGeoMedia')
        : t('noGpsData')
      : null;

  return (
    <Box
      onContextMenu={handleContextMenu}
      sx={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}
    >
      {/* P3-2: tray-row hover → bouncing marker. The class is toggled by an
          effect above on the corresponding Leaflet marker DOM element. */}
      <style>
        {`@keyframes whalePinBounce {
            0%, 100% { transform: translateY(0); }
            50%      { transform: translateY(-6px); }
          }
          .whale-pin-bounce {
            animation: whalePinBounce 200ms ease-out 2;
          }`}
      </style>
      <Stack
        direction="row"
        sx={{
          alignItems: 'center',
          gap: 2,
          flexShrink: 0,
          flexWrap: 'wrap',
          px: 1.5,
          py: 0.75,
        }}
      >
        <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
          {t('mapique')}
        </Typography>
        <Box sx={{ flex: 1 }} />

        <Tooltip title={t('saveImage')}>
          <span>
            <IconButton
              size="small"
              onClick={() => void handleSave()}
              disabled={saving || loadingRecursive || readOnly}
              aria-label={t('saveImage')}
            >
              <SaveIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip title={t('saveImageAs')}>
          <span>
            <IconButton
              size="small"
              onClick={() => void handleSaveAs()}
              disabled={saving || loadingRecursive || readOnly}
              aria-label={t('saveImageAs')}
            >
              <DriveFileMoveIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip title={t('mapiqueCopyMap')}>
          <span>
            <IconButton
              size="small"
              onClick={() => void onCopyToClipboard()}
              disabled={saving || loadingRecursive}
              aria-label={t('mapiqueCopyMap')}
            >
              <ContentCopyIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        {/* P3-4: wipe the persisted EXIF cache and re-trigger extraction.
            Useful after sidecar / GPS-tag edits that the cache would
            otherwise mask. Disabled while a batch is mid-flight. */}
        <Tooltip title={t('mapiqueRefreshExifTooltip')}>
          <span>
            <IconButton
              size="small"
              onClick={() => void handleRefreshExifCache()}
              disabled={extractingActive || loadingRecursive || !currentLocation?.path}
              aria-label={t('mapiqueRefreshExif')}
            >
              <RefreshIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      {error ? <ErrorBanner message={error} /> : null}

      <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Map area */}
        <Box ref={mapWrapperRef} sx={{ flex: 1, minWidth: 0, position: 'relative', bgcolor: 'background.paper' }}>
          <MapContainer
            center={center}
            zoom={zoom}
          style={{
            height: '100%',
            width: '100%',
            cursor: canEdit && activeEntry && !placeLocked ? 'crosshair' : 'grab',
          }}
        >
          <TileLayer
            attribution={tileAttribution}
            url={resolvedTileUrl}
            subdomains={tileSubdomains}
          />
          <FitBounds geo={knownGeo} toDisplay={toDisplay} />
          <AutoResize />
          <InvalidateOnChange trigger={panelOpen} />
          {/* P3-5: push the live viewport center back to the parent so the
              `distance` sort reorders as the user pans / zooms. */}
          <MapMoveTracker onMoveEnd={setMapCenter} />
          <MapClickHandler onClick={handleMapClick} lastDragEndAtRef={lastDragEndAtRef} />
          <MapContextMenuHandler onContextMenu={handleMapContextMenu} />
          <MarkerClusterGroup
            chunkedLoading
            showCoverageOnHover={false}
            spiderfyOnMaxZoom
          >
            {knownGeo.map((geo) => {
              const isActive = activeEntry?.path === geo.entry.path;
              const isSel = selected.has(geo.entry.path);
              const color =
                geoColorMap.get(geo.entry.path) ?? getGeoColor(geo.lat, geo.lng);
              const [dLat, dLng] = toDisplay(geo.lat, geo.lng);
              return (
                <GeoMarker
                  key={geo.entry.path}
                  geo={geo}
                  color={color}
                  state={isActive ? 'active' : isSel ? 'selected' : 'normal'}
                  draggable={canEdit && isActive}
                  displayLat={dLat}
                  displayLng={dLng}
                  onSelect={handleMarkerClick}
                  onContextMenu={handleMarkerContextMenu}
                  onDragEnd={handleMarkerDragEnd}
                  thumbCache={thumbCache}
                  tagsByName={tagsByName}
                  tagColors={tagColors}
                  groups={groups}
                  t={t}
                  provider={provider}
                  onOpen={handleOpen}
                />
              );
            })}
          </MarkerClusterGroup>
        </MapContainer>

        {/* Recursive scan progress. `pointer-events: none` so the chip doesn't
              swallow map clicks — same rationale as the EXIF progress
              overlay below. */}
        {loadingRecursive && (
          <Stack
            direction="row"
            spacing={1}
            sx={{
              position: 'absolute',
              top: 12,
              left: 12,
              zIndex: 1000,
              bgcolor: 'background.paper',
              borderRadius: 1,
              px: 1.5,
              py: 0.75,
              boxShadow: 1,
              alignItems: 'center',
              pointerEvents: 'none',
            }}
          >
            <CircularProgress size={18} thickness={5} />
            <Typography variant="caption" color="text.secondary">{t('loading')}</Typography>
          </Stack>
        )}

        {/* Extraction progress (top-right) */}
        {extractingActive && (
          <Stack
            direction="row"
            spacing={1}
            sx={{
              position: 'absolute',
              top: 12,
              right: 12,
              zIndex: 1000,
              bgcolor: 'background.paper',
              borderRadius: 1,
              px: 1.5,
              py: 0.75,
              boxShadow: 1,
              alignItems: 'center',
            }}
          >
            <CircularProgress size={18} thickness={5} />
            <Typography variant="caption" color="text.secondary">
              {t('extractingGps')} ({knownGeo.length}/{candidates.length})
            </Typography>
          </Stack>
        )}

        {/* Re-open panel button when collapsed */}
        {!panelOpen && (
          <Tooltip title={t('panelOpen')}>
            <IconButton
              size="small"
              onClick={() => setPanelOpen(true)}
              sx={{
                position: 'absolute',
                top: 12,
                right: 12,
                zIndex: 1000,
                bgcolor: 'background.paper',
                boxShadow: 1,
                '&:hover': { bgcolor: 'background.paper' },
              }}
            >
              <ChevronLeftIcon />
            </IconButton>
          </Tooltip>
        )}

        {emptyHint && (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              zIndex: 1000,
              pointerEvents: 'none',
            }}
          >
            <EmptyHint message={emptyHint} />
          </Box>
        )}
      </Box>

      {/* Detail panel */}
      {panelOpen && (
        <Box
          sx={{
            width: PANEL_WIDTH,
            flexShrink: 0,
            borderLeft: 1,
            borderColor: 'divider',
            bgcolor: 'background.paper',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          {/* File tray */}
          {/* P3-1: Name search — composes with `trayFilter` (located/unlocated) so
              the user can locate a file in large folders without leaving the
              map view. Search query is local state; cleared on view remount. */}
          <Box sx={{ px: 1.5, pt: 0.75, pb: 0.5 }}>
            <TextField
              size="small"
              fullWidth
              value={nameQuery}
              onChange={(e) => setNameQuery(e.target.value)}
              placeholder={t('mapiqueSearchPlaceholder')}
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" sx={{ color: 'text.disabled' }} />
                    </InputAdornment>
                  ),
                  endAdornment: nameQuery ? (
                    <InputAdornment position="end">
                      <Tooltip title={t('mapiqueClearSearch')}>
                        <IconButton
                          size="small"
                          edge="end"
                          onClick={() => setNameQuery('')}
                          aria-label={t('mapiqueClearSearch')}
                        >
                          <ClearIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </InputAdornment>
                  ) : null,
                },
              }}
            />
          </Box>

          <Stack
            direction="row"
            sx={{ px: 1.5, py: 0.5, alignItems: 'center', gap: 1 }}
          >
            <Checkbox
              size="small"
              checked={selectAllState === 'checked'}
              indeterminate={selectAllState === 'indeterminate'}
              onChange={toggleSelectAll}
              disabled={visibleTrayEntries.length === 0}
              slotProps={{ input: { 'aria-label': t('selectAll') } }}
              sx={{ p: 0, mr: 0.5 }}
            />
            <Typography variant="overline" sx={{ flex: 1, fontSize: 10, lineHeight: 1.25 }} color="text.secondary">
              {t('files')} ({visibleTrayEntries.length})
              {selectedCount > 0 ? ` · ${selectedCount} ${t('selected')}` : ''}
            </Typography>

            <Select
              size="small"
              value={trayFilter}
              onChange={(e) => setTrayFilter(e.target.value as TrayFilter)}
              inputProps={{ 'aria-label': t('mapiqueFilterAll') }}
              sx={{ fontSize: 11, '& .MuiSelect-select': { py: 0.5 } }}
            >
              <MenuItem value="all" dense sx={{ fontSize: 12 }}>
                {t('mapiqueFilterAll')}
              </MenuItem>
              <MenuItem value="located" dense sx={{ fontSize: 12 }}>
                {t('mapiqueFilterLocated')}
              </MenuItem>
              <MenuItem value="unlocated" dense sx={{ fontSize: 12 }}>
                {t('mapiqueFilterUnlocated')}
              </MenuItem>
            </Select>

            {/* P3-5: tray row sort. Persisted per-location. `distance` is
                dynamic (re-orders as the map is panned). */}
            <Select
              size="small"
              value={traySort}
              onChange={(e) => setTraySort(e.target.value as TraySort)}
              inputProps={{ 'aria-label': t('mapiqueSort') }}
              sx={{ fontSize: 11, '& .MuiSelect-select': { py: 0.5 } }}
            >
              <MenuItem value="name" dense sx={{ fontSize: 12 }}>
                {t('mapiqueSortName')}
              </MenuItem>
              <MenuItem value="modified" dense sx={{ fontSize: 12 }}>
                {t('mapiqueSortModified')}
              </MenuItem>
              <MenuItem value="distance" dense sx={{ fontSize: 12 }}>
                {t('mapiqueSortDistance')}
              </MenuItem>
            </Select>

            <Tooltip title={placeLocked ? t('mapiquePlaceUnlock') : t('mapiquePlaceLock')}>
              <IconButton
                size="small"
                onClick={() => setPlaceLocked((v) => !v)}
                aria-label={placeLocked ? t('mapiquePlaceUnlock') : t('mapiquePlaceLock')}
                color={placeLocked ? 'default' : 'primary'}
              >
                {placeLocked ? (
                  <LockIcon fontSize="small" />
                ) : (
                  <LockOpenIcon fontSize="small" />
                )}
              </IconButton>
            </Tooltip>

            <Tooltip title={t('panelClose')}>
              <IconButton size="small" onClick={() => setPanelOpen(false)}>
                <ChevronRightIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>

          {loadingRecursive && visibleTrayEntries.length === 0 ? (
            <LoadingOverlay label={t('loading')} />
          ) : visibleTrayEntries.length === 0 ? (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: 'block', px: 1.5, py: 1 }}
            >
              {nameQuery.trim() ? t('mapiqueSearchEmpty') : t('mapiqueTrayEmptyFilter')}
            </Typography>
          ) : (
            <MapiqueTray
              entries={visibleTrayEntries}
              selected={selected}
              activeEntry={activeEntry}
              locatedPaths={locatedPaths}
              geoColorMap={geoColorMap}
              thumbCache={thumbCache}
              onSelectRow={selectRow}
              onOpen={handleOpen}
              onDelete={onDelete}
              onClearSelection={() => setSelected(new Set())}
              onSelectAll={toggleSelectAll}
              onContextMenu={handleTrayContextMenu}
              onHoverRow={setHoveredPath}
              filter={trayFilter}
              t={t}
            />
          )}

          <Divider />

          {/* Detail content */}
          <Box sx={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
            {selectedCount === 0 ? (
              <Box sx={{ p: 3, textAlign: 'center' }}>
                <Typography variant="body2" color="text.secondary">
                  {t('selectFileHint')}
                </Typography>
              </Box>
            ) : selectedCount > 1 ? (
              <BatchPanel
                entries={selectedEntries}
                tagColors={tagColors}
                groups={groups}
                t={t}
                canEdit={canEdit}
                onAddTag={onAddTag}
                onRemoveTag={onRemoveTag}
                onClearGeo={onClearGeo}
                tagsByName={tagsByName}
              />
            ) : (
              <Stack spacing={0}>
                <Box
                  sx={{
                    width: '100%',
                    height: PREVIEW_HEIGHT,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    bgcolor: 'action.hover',
                    cursor: onOpen ? 'pointer' : 'default',
                    overflow: 'hidden',
                    p: 1,
                    flexShrink: 0,
                  }}
                  onClick={() => activeEntry && handleOpen(activeEntry)}
                >
                  <ThumbIcon
                    entry={activeEntry!}
                    thumbCache={thumbCache}
                    size={PREVIEW_HEIGHT - 16}
                    rounded={4}
                    objectFit="contain"
                  />
                </Box>

                <Typography
                  variant="subtitle2"
                  noWrap
                  title={activeEntry?.name}
                  sx={{ px: 1.5, pt: 1, pb: 0.5, flexShrink: 0 }}
                >
                  {activeEntry?.name}
                </Typography>

                <Stack
                  direction="row"
                  spacing={1}
                  sx={{ px: 1.5, alignItems: 'center', flexShrink: 0 }}
                >
                  <LocationOnIcon
                    fontSize="small"
                    sx={{ color: activeGeo ? '#1976d2' : 'text.disabled' }}
                  />
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ flex: 1, fontSize: 12 }}
                  >
                    {activeGeo
                      ? `${activeGeo.lat.toFixed(6)}, ${activeGeo.lng.toFixed(6)}`
                      : t('noLocationSet')}
                  </Typography>
                  {activeGeo && canEdit && (
                    <Button
                      size="small"
                      onClick={() => {
                        if (selectedCount > 0) {
                          selectedEntries.forEach((e) => applyClearGeo(e));
                          setNotice({
                            message: t('mapiqueGeoUpdatedMulti', {
                              count: selectedCount,
                            }),
                            undoable: true,
                          });
                        } else {
                          applyClearGeo(activeEntry!);
                          setNotice({
                            message: t('mapiqueGeoUpdated'),
                            undoable: true,
                          });
                        }
                      }}
                    >
                      {t('clearLocation')}
                    </Button>
                  )}
                </Stack>

                {canEdit && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ px: 1.5, display: 'block', flexShrink: 0 }}
                  >
                    {t('clickMapToPlace')}
                  </Typography>
                )}

                <Divider sx={{ mt: 1, mb: 0.5, flexShrink: 0 }} />

                <InlineTagInput
                  tags={activeTags}
                  tagColors={tagColors}
                  groups={groups}
                  t={t}
                  onAdd={(tag) => onAddTag?.(activeEntry!, tag)}
                  onRemove={(tag) => onRemoveTag?.(activeEntry!, tag)}
                  readOnly={!canEdit}
                />
              </Stack>
            )}
          </Box>
        </Box>
      )}

      <MapiqueContextMenu
        ctx={ctxMenu}
        onClose={() => setCtxMenu(null)}
        t={t}
        onOpen={handleOpen}
        onReveal={handleReveal}
        onEditTags={handleEditTags}
        onClearGeo={onClearGeo}
        onCopyCoordinates={onCopyCoordinates}
        onSave={handleSave}
        onSaveAs={handleSaveAs}
        onCopyMap={onCopyToClipboard}
        onSetLocationForSelection={handleSetLocationForSelection}
        onClearLocationForSelection={handleClearLocationForSelection}
        selectedCount={selectedCount}
        canEdit={canEdit}
      />

      <Snackbar
        open={notice !== null}
        autoHideDuration={2000}
        onClose={(_, reason) => {
          if (reason === 'clickaway') return;
          setNotice(null);
        }}
        message={notice?.message}
        action={
          notice?.undoable ? (
            <Button
              color="primary"
              size="small"
              onClick={handleUndo}
              disabled={!undoStack.canUndo}
            >
              {t('mapiqueUndo')}
            </Button>
          ) : null
        }
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  </Box>
  );
}

/**
 * P0-3 (perf audit): a single geo marker, React.memo'd so it only re-renders
 * when its OWN inputs change (active/selected state, color, position,
 * draggable). The parent re-renders on every pan / select / hover / sort /
 * `setMapCenter`, but unchanged markers bail out entirely — no fresh
 * `makePinIcon` DivIcon (DOM rebuild) and no react-leaflet event rebind.
 *
 * Granularity matters: passing the primitive `state` ('normal' | 'selected'
 * | 'active') instead of the whole `selected` Set means a selection change
 * only re-renders the one marker whose state actually changed, not every
 * marker. The icon / position / event-handlers are each memoized inside so
 * that even when a re-render does occur, react-leaflet skips setIcon /
 * setPosition / (un)bind for the fields that didn't change.
 */
const GeoMarker = memo(function GeoMarker({
  geo,
  color,
  state,
  draggable,
  displayLat,
  displayLng,
  onSelect,
  onContextMenu,
  onDragEnd,
  thumbCache,
  tagsByName,
  tagColors,
  groups,
  t,
  provider,
  onOpen,
}: {
  geo: GeoEntry;
  color: string;
  state: 'normal' | 'selected' | 'active';
  draggable: boolean;
  displayLat: number;
  displayLng: number;
  onSelect: (path: string, mods: { shift: boolean; ctrl: boolean }) => void;
  onContextMenu: (geo: GeoEntry, x: number, y: number) => void;
  onDragEnd: (geo: GeoEntry, lat: number, lng: number) => void;
  thumbCache: Map<string, string>;
  tagsByName: Map<string, string[]>;
  tagColors?: Record<string, string>;
  groups?: TagGroup[];
  t: TFunction;
  provider?: MapProvider;
  onOpen?: (entry: DirEntry) => void;
}) {
  const icon = useMemo(
    () => makePinIcon(color, state, geo.entry.path),
    [color, state, geo.entry.path]
  );
  const position = useMemo<[number, number]>(
    () => [displayLat, displayLng],
    [displayLat, displayLng]
  );
  const eventHandlers = useMemo(
    () => ({
      click: (e: L.LeafletMouseEvent) => {
        const native = e.originalEvent as MouseEvent | undefined;
        onSelect(geo.entry.path, {
          shift: native?.shiftKey ?? false,
          ctrl: (native?.ctrlKey ?? false) || (native?.metaKey ?? false),
        });
      },
      contextmenu: (e: L.LeafletMouseEvent) => {
        const native = e.originalEvent as MouseEvent | undefined;
        if (!native) return;
        native.preventDefault();
        native.stopPropagation();
        onContextMenu(geo, native.clientX, native.clientY);
      },
      dragend: (e: L.DragEndEvent) => {
        const m = e.target as L.Marker;
        const ll = m.getLatLng();
        onDragEnd(geo, ll.lat, ll.lng);
      },
    }),
    [geo, onSelect, onContextMenu, onDragEnd]
  );
  return (
    <Marker
      position={position}
      icon={icon}
      draggable={draggable}
      eventHandlers={eventHandlers}
    >
      <Popup maxWidth={220} minWidth={180}>
        <MapPopup
          geo={geo}
          thumbCache={thumbCache}
          tags={tagsByName.get(geo.entry.path) ?? []}
          tagColors={tagColors}
          groups={groups}
          t={t}
          provider={provider}
          onOpen={onOpen}
        />
      </Popup>
    </Marker>
  );
});

/** H.26 P0-1: captures map blank right-clicks and forwards display coords. */
function MapContextMenuHandler({
  onContextMenu,
}: {
  onContextMenu: (lat: number, lng: number, x: number, y: number) => void;
}) {
  useMapEvents({
    contextmenu(e) {
      const native = e.originalEvent as MouseEvent | undefined;
      if (!native) return;
      native.preventDefault();
      native.stopPropagation();
      onContextMenu(e.latlng.lat, e.latlng.lng, native.clientX, native.clientY);
    },
  });
  return null;
}

/**
 * P3-5: pushes the live viewport center to the parent on every pan/zoom.
 * The `distance` tray sort uses this as its reference point (falling back
 * to the initial fitBounds centroid until the first user interaction).
 * `moveend` fires after both user drags and programmatic `setView`/`fitBounds`
 * calls, so "Fit to bounds" also re-orders the tray.
 */
function MapMoveTracker({
  onMoveEnd,
}: {
  onMoveEnd: (center: { lat: number; lng: number }) => void;
}) {
  const map = useMap();
  useMapEvents({
    moveend() {
      const c = map.getCenter();
      onMoveEnd({ lat: c.lat, lng: c.lng });
    },
  });
  return null;
}

/** Captures map clicks and forwards their coordinates. */
function MapClickHandler({
  onClick,
  lastDragEndAtRef,
}: {
  onClick: (lat: number, lng: number) => void;
  lastDragEndAtRef: React.MutableRefObject<number>;
}) {
  useMapEvents({
    click(e) {
      // Suppress the click Leaflet fires immediately after a marker dragend —
      // a drag already wrote the new coordinate via its own handler, and the
      // map-plane click would otherwise overwrite it with a different point
      // (plan §H.21 / Bug #2).
      if (Date.now() - lastDragEndAtRef.current < 100) return;
      onClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

/**
 * Forces Leaflet to recompute its size. A map created inside a flex/conditional
 * layout is frequently initialized before its container has settled to its
 * final dimensions; without this it renders blank (no tiles requested) until
 * the next manual resize. Runs after mount and on every container resize.
 */
function AutoResize() {
  const map = useMap();
  useEffect(() => {
    const invalidate = () => map.invalidateSize();
    const t1 = setTimeout(invalidate, 0);
    const t2 = setTimeout(invalidate, 250);
    const container = map.getContainer();
    const ro = new ResizeObserver(invalidate);
    ro.observe(container);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      ro.disconnect();
    };
  }, [map]);
  return null;
}

/** Recomputes map size whenever `trigger` changes (e.g. the panel toggles). */
function InvalidateOnChange({ trigger }: { trigger: unknown }) {
  const map = useMap();
  useEffect(() => {
    const t1 = setTimeout(() => map.invalidateSize(), 0);
    const t2 = setTimeout(() => map.invalidateSize(), 320);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [trigger, map]);
  return null;
}

/**
 * Re-centers/fits the map whenever the set of known GPS points changes.
 * Points are stored in WGS-84; `toDisplay` shifts them to the active tile
 * datum so the fitted bounds match the rendered markers.
 */
function FitBounds({
  geo,
  toDisplay,
}: {
  geo: GeoEntry[];
  toDisplay: (lat: number, lng: number) => [number, number];
}) {
  const map = useMap();
  const prevCountRef = useRef(geo.length);

  useEffect(() => {
    if (geo.length === 0) return;
    if (geo.length > prevCountRef.current) {
      const group = L.featureGroup(geo.map((g) => L.marker(toDisplay(g.lat, g.lng))));
      map.fitBounds(group.getBounds().pad(0.1));
    }
    prevCountRef.current = geo.length;
  }, [geo, map, toDisplay]);

  return null;
}

function MapPopup({
  geo,
  thumbCache,
  tags,
  tagColors,
  groups,
  t,
  provider,
  onOpen,
}: {
  geo: GeoEntry;
  thumbCache: Map<string, string>;
  /** P3-7 (reverted): tag list for this entry. Kept as an optional prop
   *  with the existing tag-chip rendering path so the parent doesn't have
   *  to change if a future iteration of the popup-exif feature ships. */
  tags?: string[];
  tagColors?: Record<string, string>;
  groups?: TagGroup[];
  /** Pre-bound i18n function (avoids re-calling useTranslation per popup). */
  t: TFunction;
  /**
   * Active map provider (mirrors Settings → Map source). When `'gaode'`,
   * the "open in OSM" button is relabeled "open in AMap" and points at
   * `uri.amap.com/marker` instead of `openstreetmap.org/?mlat=…` —
   * otherwise a Gaode-only user (mainland China, no OSM access) clicks
   * the button and gets a 451/timeout. Defaults to `'gaode'` to match
   * `reducers/settings.ts:315` — the existing default.
   */
  provider?: MapProvider;
  onOpen?: (entry: DirEntry) => void;
}) {
  const { entry, lat, lng } = geo;

  const handleOpen = useCallback(() => {
    onOpen?.(entry);
  }, [entry, onOpen]);

  // Provider-aware marker URL. AMap's `uri.amap.com/marker` opens the
  // web map at the marker (and `callnative=1` falls through to the
  // mobile app when available). `coordinate=wgs84` tells AMap the input
  // is WGS-84 so the marker lands on the right spot (MapiqueView
  // stores GPS lat/lng directly from EXIF, which is WGS-84).
  // OpenStreetMap uses the `?mlat=/mlon=&=#map=` hash scheme which is
  // stable across all OSM-hosted frontends.
  const mapUrl =
    provider === 'gaode'
      ? `https://uri.amap.com/marker?position=${lng},${lat}&src=WhaleTag&coordinate=wgs84&callnative=1`
      : `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
  const mapLabelKey =
    provider === 'gaode' ? 'openInGaode' : 'openInOsm';

  const showTags = tags && tags.length > 0;

  return (
    <Stack spacing={1} sx={{ minWidth: 180 }}>
      <Box
        sx={{
          width: '100%',
          height: 140,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'action.hover',
          borderRadius: 1,
          overflow: 'hidden',
          cursor: onOpen ? 'pointer' : 'default',
        }}
        onClick={handleOpen}
      >
        <ThumbIcon entry={entry} thumbCache={thumbCache} size={140} />
      </Box>

      <Typography variant="caption" noWrap title={entry.name} sx={{ fontWeight: 500 }}>
        {entry.name}
      </Typography>

      {showTags && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, pt: 0.25 }}>
          {tags!.map((tag) => (
            <Chip
              key={tag}
              label={tagDisplayLabel(tag, t)}
              size="small"
              sx={chipSx(
                getTagColor(tag, tagColors ?? {}, groups ?? []),
                false,
                'rounded'
              )}
            />
          ))}
        </Box>
      )}

      <Typography variant="caption" color="text.secondary">
        {lat.toFixed(5)}, {lng.toFixed(5)}
      </Typography>

      <Stack direction="row" spacing={1} sx={{ pt: 0.5, alignItems: 'center' }}>
        {onOpen && (
          <Button size="small" variant="outlined" onClick={handleOpen}>
            {t('openFile')}
          </Button>
        )}
        <Link href={mapUrl} target="_blank" rel="noopener noreferrer" underline="none">
          <Button size="small" variant="outlined">
            {t(mapLabelKey)}
          </Button>
        </Link>
      </Stack>
    </Stack>
  );
}

function BatchPanel({
  entries,
  tagsByName,
  tagColors,
  groups,
  t,
  canEdit,
  onAddTag,
  onRemoveTag,
  onClearGeo,
}: {
  entries: DirEntry[];
  tagsByName: Map<string, string[]>;
  tagColors: Record<string, string>;
  groups: TagGroup[];
  t: TFunction;
  canEdit: boolean;
  onAddTag?: (entry: DirEntry, tag: string) => void;
  onRemoveTag?: (entry: DirEntry, tag: string) => void;
  onClearGeo?: (entry: DirEntry) => void;
}) {
  const [input, setInput] = useState('');
  const tagShape = useSelector(
    (s: RootState) => s.settings?.tagShape ?? 'rounded'
  );

  // Tags common to every selected file (intersection).
  const commonTags = useMemo(() => {
    if (entries.length === 0) return [];
    const sets = entries.map((e) => new Set(tagsByName.get(e.path) ?? []));
    const first = sets[0];
    return [...first].filter((tag) => sets.every((s) => s.has(tag)));
  }, [entries, tagsByName]);

  const commit = () => {
    const tag = input.trim();
    if (!tag) return;
    entries.forEach((entry) => onAddTag?.(entry, tag));
    setInput('');
  };

  return (
    <Stack spacing={0} sx={{ py: 1 }}>
      <Typography variant="subtitle2" sx={{ px: 1.5, pb: 1 }}>
        {t('nSelected', { count: entries.length })}
      </Typography>

      {canEdit && (
        <Button
          size="small"
          variant="outlined"
          color="error"
          sx={{ mx: 1.5, mb: 1, alignSelf: 'flex-start' }}
          onClick={() => entries.forEach((e) => onClearGeo?.(e))}
        >
          {t('clearLocation')}
        </Button>
      )}

      {commonTags.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, px: 1.5, pb: 1 }}>
          {commonTags.map((tag) => (
            <Chip
              key={tag}
              label={tagDisplayLabel(tag, t)}
              size="small"
              onDelete={canEdit ? () => entries.forEach((e) => onRemoveTag?.(e, tag)) : undefined}
              sx={chipSx(getTagColor(tag, tagColors, groups), false, tagShape)}
            />
          ))}
        </Box>
      )}

      {canEdit && (
        <TextField
          size="small"
          fullWidth
          placeholder={t('addTagToSelection')}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              commit();
            }
          }}
          onBlur={() => input.trim() && commit()}
          sx={{ px: 1.5 }}
        />
      )}
    </Stack>
  );
}

/**
 * P3-5: great-circle distance between two WGS-84 points in kilometers.
 * Used by the `distance` tray sort to order rows by proximity to the
 * current map center. Inputs must already be in WGS-84 (no datum shift).
 */
function haversineKm(
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

/** Build a CSS-only pin marker. `color` is shared with the tray indicator;
 *  selected/active states keep the fill color and add a colored border.
 *  P3-2: the inner shape is wrapped in `.whale-pin-wrap` carrying
 *  `data-entry-path` so a parent effect can toggle `.whale-pin-bounce` to
 *  animate the pin when its tray row is hovered. */
function makePinIcon(
  color: string,
  state: 'normal' | 'selected' | 'active',
  entryPath?: string
): L.DivIcon {
  const isActive = state === 'active';
  const isSelected = state === 'selected';
  const size = isActive ? 30 : isSelected ? 26 : 24;
  const borderColor = isActive ? '#f44336' : isSelected ? '#ff9800' : '#fff';
  const borderWidth = isActive ? 3 : isSelected ? 3 : 2;
  const shadow = isActive
    ? '0 3px 6px rgba(0,0,0,0.5)'
    : '0 2px 4px rgba(0,0,0,0.4)';
  return L.divIcon({
    className: `whale-map-pin-${state}`,
    html: `<div class="whale-pin-wrap" data-entry-path="${entryPath ?? ''}" style="
      display: flex;
      align-items: center;
      justify-content: center;
      width: ${size}px;
      height: ${size}px;
    "><div style="
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border: ${borderWidth}px solid ${borderColor};
      border-radius: 50% 50% 50% 0;
      transform: rotate(-45deg);
      box-shadow: ${shadow};
    "></div></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size],
    popupAnchor: [0, -(size * 0.85)],
  });
}
