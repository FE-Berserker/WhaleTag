import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  Button,
  CircularProgress,
  Divider,
  IconButton,
  Snackbar,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { MapContainer, TileLayer } from 'react-leaflet';
import MarkerClusterGroup from 'react-leaflet-cluster';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';

import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';

import type { DirEntry, ExifProcessedRecord } from '../../shared/ipc-types';
import type { TagGroup } from '../domain/tag-library';
import { getGeoColor } from '../domain/tag-colors';
import { entriesNeedingExif, type GeoEntry } from '../domain/mapique';
import { wgs84ToGcj02, gcj02ToWgs84 } from '../domain/gcj02';
import type { MapProvider } from '-/reducers/settings';
import { ipcApi } from '-/services/ipc-api';
import { parentDir } from '-/services/path-util';
import { useCurrentLocationContext } from '-/hooks/CurrentLocationContextProvider';
import { useImageExport, type ClipboardKind } from '-/hooks/useImageExport';
import { useUndoStack } from '-/hooks/useUndoStack';
import { readPrefs, writePrefs } from '../domain/perspective-prefs';
import LoadingOverlay from './perspective/LoadingOverlay';
import EmptyHint from './perspective/EmptyHint';
import ErrorBanner from './perspective/ErrorBanner';
import MapiqueContextMenu, {
  type MapiqueContext,
} from './MapiqueContextMenu';
import MapiqueTray from './MapiqueTray';
import { useMapiqueData } from './mapique/useMapiqueData';
import MapiqueToolbar from './mapique/MapiqueToolbar';
import MapiqueFilterBar from './mapique/MapiqueFilterBar';
import MapiqueDetailPanel from './mapique/MapiqueDetailPanel';

import { cssAttrValue } from './mapique/pin-icon';
import GeoMarker from './mapique/GeoMarker';
import {
  AutoResize,
  FitBounds,
  InvalidateOnChange,
  MapClickHandler,
  MapContextMenuHandler,
  MapMoveTracker,
} from './mapique/MapInterop';
import {
  EMPTY_GROUPS,
  EMPTY_TAG_COLORS,
  GAODE_TILE_ATTRIBUTION,
  GAODE_TILE_SUBDOMAINS,
  GAODE_TILE_URL,
  OSM_TILE_ATTRIBUTION,
  OSM_TILE_SUBDOMAINS,
  OSM_TILE_URL,
  PANEL_WIDTH,
  type MapiquePrefs,
  type TrayFilter,
  type TraySort,
} from './mapique/constants';

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
  // P2-5: this view does NOT keep a local render bump for `geoByName` /
  // `tagsByName`. React already re-renders on a prop-identity change, and
  // `TagMetaContextProvider` re-derives both maps on every `setSidecars`
  // (post-save), so the props are exactly the signal. A `useEffect` that
  // called a reducer with those maps as deps made any tag/geo edit render
  // twice (once for the prop change, once for the bump), and the comment used
  // to claim a matching `key` prop existed on the FileList render site — it
  // never did. Keep the single mechanism: props in, render out.
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
  // WGS-84 鈫?tile datum for placing markers; `fromDisplay` shifts a map click
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
  // P3-2: tray row hover 鈫?bouncing marker. Transient UI state, not persisted.
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
  // Anchor of a shift-range selection, stored as a PATH rather than an index:
  // the tray reorders on pan/sort/filter and shrinks when the listing changes,
  // and a stale index used to read `tray[i].path` off the end of the array
  // (TypeError, whole view crashed). A path that is no longer in the tray is
  // simply treated as "no anchor".
  const selectAnchorRef = useRef<string | null>(null);

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

  const {
    allTrayEntriesRef,
    candidates,
    center,
    geoColorMap,
    knownGeo,
    locatedPaths,
    sidecars,
    trayIndexByPathRef,
    visibleTrayEntries,
    visibleTrayEntriesRef,
    zoom,
  } = useMapiqueData({
    entries,
    tagsByName,
    geoByName,
    traySort,
    trayFilter,
    nameQuery,
    mapCenter,
    toDisplay,
  });

  // P3-2: apply/remove the bounce class on the corresponding Leaflet marker
  // DOM element. Markers are not React-rendered DOM, so we mutate via querySelector.
  // Re-runs on `knownGeo` change so the class survives marker re-creation.
  useEffect(() => {
    document.querySelectorAll('.whale-pin-bounce').forEach((el) => {
      el.classList.remove('whale-pin-bounce');
    });
    if (hoveredPath) {
      const escaped = cssAttrValue(hoveredPath);
      const el = document.querySelector(`[data-entry-path="${escaped}"]`);
      if (el) el.classList.add('whale-pin-bounce');
    }
  }, [hoveredPath, knownGeo]);


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
        const anchorIndex =
          selectAnchorRef.current === null
            ? -1
            : tray.findIndex((e) => e.path === selectAnchorRef.current);
        if (mods.shift && anchorIndex >= 0) {
          const [lo, hi] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex];
          for (let i = lo; i <= hi; i += 1) {
            const row = tray[i];
            // The tray can shrink between two clicks (filter / listing change):
            // read defensively instead of crashing the whole view on a hole.
            if (row) next.add(row.path);
          }
        } else if (mods.ctrl) {
          if (next.has(entry.path)) next.delete(entry.path);
          else next.add(entry.path);
          selectAnchorRef.current = entry.path;
        } else {
          next.clear();
          next.add(entry.path);
          selectAnchorRef.current = entry.path;
        }
        return next;
      });
      setActiveEntry(entry);
    },
    // P0-3: the tray snapshot is read through a ref on purpose; depending on
    // it would rebuild this callback (and every memo'd marker) on each pan /
    // sort, which is exactly the cost P0-3 removes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // The range anchor indexes the OLD tray; drop it so the next shift-click
    // starts a fresh range instead of spanning rows that just disappeared.
    selectAnchorRef.current = null;
  }, [trayFilter]);

  // P3-1: also clear selection when the name query changes — same rationale
  // as `trayFilter`: don't keep rows selected that are no longer visible.
  useEffect(() => {
    setSelected(new Set());
    selectAnchorRef.current = null;
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


  // Lazy EXIF extraction for media candidates without GPS.
  useEffect(() => {
    // A read-only location refuses every sidecar write, so extracting here
    // would only raise one "read-only" notice per photo. Viewing the map and
    // placing markers by hand keep working.
    if (readOnly) return;
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
  }, [candidates, sidecars, onGpsFound, exifRefreshKey, currentLocation?.path, readOnly]);

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
    void ipcApi.revealAndSelect(entry.path).catch((e) => {
      // Nothing happened visually when the native reveal failed (path gone,
      // permission) — say so instead of leaving a dead click.
      setNotice({ message: e instanceof Error ? e.message : String(e) });
    });
  }, []);

  const selectedEntries = useMemo(
    () => visibleTrayEntries.filter((e) => selected.has(e.path)),
    [visibleTrayEntries, selected]
  );
  const selectedCount = selected.size;

  // P3-3: wrap onSetGeo / onClearGeo so every mutation is recorded on the
  // undo stack. The actual `onSetGeo` / `onClearGeo` callbacks are still
  // called unchanged — the undo stack is purely additive metadata.
  const recordPrev = useCallback(
    (entry: DirEntry): { prevLat: number | null; prevLng: number | null } => {
      const prev = geoByName.get(entry.path);
      return {
        prevLat: prev ? prev.lat : null,
        prevLng: prev ? prev.lng : null,
      };
    },
    [geoByName]
  );
  const applySetGeo = useCallback(
    (entry: DirEntry, lat: number, lng: number) => {
      undoStack.push({ entry, ...recordPrev(entry) });
      onSetGeo?.(entry, lat, lng);
    },
    [recordPrev, onSetGeo, undoStack]
  );
  const applyClearGeo = useCallback(
    (entry: DirEntry) => {
      undoStack.push({ entry, ...recordPrev(entry) });
      onClearGeo?.(entry);
    },
    [recordPrev, onClearGeo, undoStack]
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

  // Click the map 鈫?set the location of all selected files, or the active file
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
      if (idx !== undefined) {
        selectRow(idx, mods);
        return;
      }
      // The tray filter / name query hid this row, but the marker is still on
      // the map. Activate it by path instead of dropping the click: the marker
      // highlights and the selection counts as out-of-tray (the tri-state
      // "select all" already accounts for those).
      const entry = allTrayEntriesRef.current.find((e) => e.path === path);
      if (!entry) return;
      setSelected((prev) => {
        const next = mods.ctrl ? new Set(prev) : new Set<string>();
        if (mods.ctrl && prev.has(path)) next.delete(path);
        else next.add(path);
        selectAnchorRef.current = path;
        return next;
      });
      setActiveEntry(entry);
    },
    // P0-3: both refs are read live so this handler stays stable for the
    // memo'd <GeoMarker>s.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      {/* P3-2: tray-row hover 鈫?bouncing marker. The class is toggled by an
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
      <MapiqueToolbar
        t={t}
        saving={saving}
        loadingRecursive={loadingRecursive}
        readOnly={readOnly}
        extractingActive={extractingActive}
        hasLocation={Boolean(currentLocation?.path)}
        onSave={handleSave}
        onSaveAs={handleSaveAs}
        onCopyMap={onCopyToClipboard}
        onRefreshExif={handleRefreshExifCache}
      />

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
          <MapiqueFilterBar
            t={t}
            nameQuery={nameQuery}
            onNameQueryChange={setNameQuery}
            selectAllState={selectAllState}
            onToggleSelectAll={toggleSelectAll}
            visibleCount={visibleTrayEntries.length}
            selectedCount={selectedCount}
            trayFilter={trayFilter}
            onTrayFilterChange={setTrayFilter}
            traySort={traySort}
            onTraySortChange={setTraySort}
            placeLocked={placeLocked}
            onTogglePlaceLocked={() => setPlaceLocked((v) => !v)}
            onCollapse={() => setPanelOpen(false)}
          />

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
          <MapiqueDetailPanel
            t={t}
            selectedCount={selectedCount}
            selectedEntries={selectedEntries}
            activeEntry={activeEntry}
            activeGeo={activeGeo}
            activeTags={activeTags}
            canEdit={canEdit}
            thumbCache={thumbCache}
            tagsByName={tagsByName}
            tagColors={tagColors}
            groups={groups}
            onOpen={handleOpen}
            onAddTag={onAddTag}
            onRemoveTag={onRemoveTag}
            onClearGeo={onClearGeo}
            applyClearGeo={applyClearGeo}
            setNotice={setNotice}
          />
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
        onDelete={onDelete}
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


