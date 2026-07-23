import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { useShallowEqualSelector } from '-/hooks/useShallowEqualSelector';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  Snackbar,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  List as VirtualList,
  Grid as VirtualGrid,
} from 'react-window';
import { useDrop } from 'react-dnd';
import { NativeTypes } from 'react-dnd-html5-backend';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';

import type { DirEntry } from '../../shared/ipc-types';
import type { ViewMode, SidecarMeta } from '../../shared/whale-meta';
import { COMMAND_PATH_BLOCKED } from '../../shared/shell-types';
import { RootState } from '-/reducers';
import { todayKey, periodTagFromRange } from '../domain/gantt';
import {
  setTrayVisible,
  setTrayWidth,
  setListRowDensity,
  setListColumnWidths,
  setListHiddenColumns,
  setListZebra,
  setListDateFormat,
  setGalleryShowTags,
  type ListRowDensity,
} from '-/reducers/settings';
import { useCurrentLocationContext } from '-/hooks/CurrentLocationContextProvider';
import {
  useDirectoryContentContext,
  type SortKey,
} from '-/hooks/DirectoryContentContextProvider';
import { useIOActionsContext } from '-/hooks/IOActionsContextProvider';
import { useTagMetaContext } from '-/hooks/TagMetaContextProvider';
import { useExtensionContext } from '-/hooks/ExtensionContextProvider';
import { useFileSelectionContext } from '-/hooks/FileSelectionContextProvider';
import { getCompatibleExtensions, selectExtension } from '-/services/extension-dispatch';
import PromptDialog from '-/components/PromptDialog';
import GridCell, {
  GRID_CELL_FOOTER,
  GRID_CELL_GAP,
} from '-/components/GridCell';
import Row from '-/components/Row';
import MediaLightbox from '-/components/MediaLightbox';
// Perspective views are lazy-loaded so the heavy viz libs they transitively
// pull in (echarts via Calendar/TagCloud/FolderViz, leaflet via Mapique,
// @xyflow/react via KnowledgeGraph) load on demand when the user switches to
// that view — not on first paint. Each is rendered behind exactly one
// `viewMode` branch in the switch below (wrapped in <Suspense>).
const GalleryView = lazy(() => import('./GalleryView'));
const TaskView = lazy(() => import('./TaskView'));
const CalendarView = lazy(() => import('./CalendarView'));
const FolderVizView = lazy(() => import('./FolderVizView'));
const TagCloudView = lazy(() => import('./TagCloudView'));
const KnowledgeGraphView = lazy(() => import('./KnowledgeGraphView'));
const MapiqueView = lazy(() => import('./MapiqueView'));

/** Suspense fallback shown while a lazy perspective view's chunk loads. */
const PerspectiveFallback = (
  <Box
    sx={{
      flex: 1,
      minHeight: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}
  >
    <CircularProgress />
  </Box>
);
import PropertiesTray from '-/components/PropertiesTray';
import FileListHeader, { RowColumnLabels } from '-/components/FileListHeader';
import EntryContextMenu, { TagChipContextMenu } from '-/components/EntryContextMenu';
import { isImageFile } from '../../shared/whale-meta';
import { isMediaEntry, mediaPlaylist } from '../domain/gallery';
import { tagsAfterMove } from '../domain/kanban';
import { formatGeoTag, withoutGeoTags, isGeoTag } from '../domain/geo-tag';
import { isDateTypedTag } from '../domain/calendar';
import { resolveAction, nextView, DEFAULT_KEYBINDINGS } from '../domain/keybindings';
import type { FileCellData } from '-/components/file-cell';
import { splitNameExt } from '-/services/tags';
import { basename } from '-/services/path-util';
import { useNewExcalidraw } from '-/hooks/useNewExcalidraw';
import { useNewDrawio } from '-/hooks/useNewDrawio';
import { useListCommands } from '-/hooks/useListCommands';
import { ipcApi } from '-/services/ipc-api';
import {
  smartFunctionalityOfTag,
  withSingleRating,
  withSingleQuadrant,
  withSingleFromValues,
  withSingleDateTag,
  withSinglePeriodTag,
  normalizeSmartTags,
  isPeriodTag,
  isStaleDateTag,
  resolveInputTag,
  type SmartFunctionality,
} from '../../shared/smart-tags';
import { useNow } from '-/hooks/useNow';

const SORT_KEYS: SortKey[] = ['name', 'size', 'modified', 'extension'];

/**
 * Sentinel for the `visible` memo's `now` dependency: filters that never
 * classify tag freshness (plain tag / `geo:` / `period:`) use this frozen
 * Date so the per-minute `useNow` tick neither recomputes the filter nor
 * re-renders the visible rows (docs/01 §12). Only the `date:` / `smart:*`
 * fold filters see the live tick — their freshness classification genuinely
 * depends on wall-clock boundaries.
 */
const FROZEN_NOW = new Date(0);

function copyDefaultName(name: string, suffix: string): string {
  const { base, ext } = splitNameExt(name);
  return `${base} ${suffix}${ext || ''}`;
}

/** H.23 P1-3: density preset → px row height. Single source of truth. */
const rowHeightFromDensity = (
  d: 'compact' | 'normal' | 'comfortable'
): number => (d === 'compact' ? 32 : d === 'comfortable' ? 72 : 56);

/**
 * H.23 P1-5: per-column resize bounds (px). Bounds are applied at the call
 * site (FileList's `setColumnWidth` wrapper) so the header component
 * doesn't have to know the per-column limits. Keep generous on `name` (left
 * column absorbs mass renaming) and tight on `size` (max 128 px prevents the
 * column from eating screen real estate).
 */
const LIST_COLUMN_BOUNDS: Record<
  'name' | 'size' | 'modified',
  { min: number; max: number }
> = {
  name: { min: 120, max: 600 },
  size: { min: 48, max: 128 },
  modified: { min: 64, max: 200 },
};

/** Edge length of a list row's thumbnail / icon area (px). Mirrored by
 *  `Row.ROW_THUMB_SIZE`; keep in sync. The list column header reserves
 *  `ROW_THUMB_SIZE + 8` px to align with the row's icon slot. */
const ROW_THUMB_SIZE = 40;

/** Grid cell-size zoom bounds + step (px). */
const MIN_ENTRY_SIZE = 96;
const MAX_ENTRY_SIZE = 280;
const ENTRY_SIZE_STEP = 32;

/**
 * The file/folder list. Features:
 * - Tags come from TagMetaContext (filename-embedded ∪ sidecar).
 * - Per-tag colors from settings.tagColors.
 * - Multi-select via checkbox for batch tagging.
 * - Single-row tag editor writes sidecar (`.whale/<file>.json`).
 */
export default function FileList() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const { navigateTo, goBack, canGoBack, currentLocation, currentDirectoryPath } =
    useCurrentLocationContext();
  const {
    entries,
    loading,
    error,
    recursiveTruncated,
    sort,
    setSort,
    refresh,
    viewMode,
    entrySize,
    setViewMode,
    setEntrySize,
    tagsByName,
    descByName,
    geoByName,
  } = useDirectoryContentContext();
  const {
    renameEntry,
    moveEntry,
    copyEntry,
    deleteEntry,
    createFolder,
    createFile,
    createTaggedEntry,
    importExternalFiles,
    openNative,
  } = useIOActionsContext();
  // H.24 R1: tagsByName / descByName / geoByName moved to DirectoryContentContext
  // (path-keyed, single source of truth). TagMetaContext now only owns
  // activeTag / setActiveTag / save / saveMany / allTags.
  const { activeTag, setActiveTag, save, saveMany } = useTagMetaContext();
  // Phase 3 / §3: freshness classification for the `date:` / `smart:*` fold
  // filters. Refreshes once a minute via the shared useNow hook — but only
  // reaches the `visible` memo when such a filter is active (see `nowTick`).
  const now = useNow();
  const tagColors = useShallowEqualSelector(
    (s: RootState) => s.settings?.tagColors ?? {}
  );
  const deleteToTrash = useShallowEqualSelector(
    (s: RootState) => s.settings?.deleteToTrash ?? true
  );
  const mapTileUrl = useShallowEqualSelector(
    (s: RootState) => s.settings?.mapTileUrl ?? ''
  );
  const mapProvider = useShallowEqualSelector(
    (s: RootState) => s.settings?.mapProvider ?? 'gaode'
  );
  const userCommands = useShallowEqualSelector(
    (s: RootState) => s.settings?.userCommands ?? []
  );
  const trayVisible = useShallowEqualSelector(
    (s: RootState) => s.settings?.trayVisible ?? true
  );
  const trayWidth = useShallowEqualSelector(
    (s: RootState) => s.settings?.trayWidth ?? 300
  );
  // H.23 P1-3: list-row density preset (compact 32 / normal 56 / comfortable
  // 72 px). Drives `rowHeight` below; the user toggles it from the list
  // header's 3-state button group.
  const listRowDensity = useShallowEqualSelector(
    (s: RootState) => s.settings?.listRowDensity ?? 'normal'
  );
  const rowHeight = rowHeightFromDensity(listRowDensity);

  // H.23 P2-1: zebra striping toggle. Off by default; when on, even-indexed
  // rows get an `action.hover` background tint to aid horizontal scanning.
  const listZebra = useShallowEqualSelector(
    (s: RootState) => s.settings?.listZebra ?? false
  );
  // H.23 P2-3: date format preset (absolute / relative) for the modified
  // column. Default 'absolute' matches the pre-P2-3 look.
  const listDateFormat = useShallowEqualSelector(
    (s: RootState) => s.settings?.listDateFormat ?? 'absolute'
  );
  // Gallery tag overlay toggle.
  const galleryShowTags = useShallowEqualSelector(
    (s: RootState) => s.settings?.galleryShowTags ?? true
  );
  // Key→action bindings (Settings ▸ Keyboard). Plain reference equality is
  // correct: the reducer returns a fresh object only on SET_KEYBINDING /
  // RESET_KEYBINDINGS, so unrelated dispatches skip this re-render and any
  // binding change re-renders FileList (cheap — handleKeyDown reads it inline).
  // `?? DEFAULT_KEYBINDINGS` covers the pre-rehydration first render.
  const keybindings = useShallowEqualSelector(
    (s: RootState) =>
      s.settings?.keybindings
        ? { ...DEFAULT_KEYBINDINGS, ...s.settings.keybindings }
        : DEFAULT_KEYBINDINGS
  );

  // H.23 P1-5: per-column width overrides + hidden column list.
  // Consumed by Row (cell width) and RowColumnLabels (header width + menu).
  // Defaults are first-class so an older persisted store doesn't break:
  //   name=240, size=64, modified=96 — matches the pre-P1-5 hardcoded
  // values, so the user sees no visual change on first launch.
  const listColumnWidthsState = useShallowEqualSelector(
    (s: RootState) => s.settings?.listColumnWidths
  );
  const listHiddenColumnsState = useShallowEqualSelector(
    (s: RootState) => s.settings?.listHiddenColumns
  );

  const columnWidths = useMemo(
    () => ({
      name: listColumnWidthsState?.name ?? 240,
      size: listColumnWidthsState?.size ?? 64,
      modified: listColumnWidthsState?.modified ?? 96,
    }),
    [
      listColumnWidthsState?.name,
      listColumnWidthsState?.size,
      listColumnWidthsState?.modified,
    ]
  );
  const hiddenColumns = useMemo<readonly string[]>(
    () => listHiddenColumnsState ?? [],
    [listHiddenColumnsState]
  );

  // H.23 P2-1: zebra toggle callback. `useCallback` so FileListHeader's
  // `IconButton.onClick` reference is stable across renders (otherwise the
  // header would re-render on every parent tick).
  const onToggleListZebra = useCallback(
    () => dispatch(setListZebra(!listZebra)),
    [dispatch, listZebra]
  );
  const onToggleListDateFormat = useCallback(
    () =>
      dispatch(
        setListDateFormat(listDateFormat === 'absolute' ? 'relative' : 'absolute')
      ),
    [dispatch, listDateFormat]
  );
  const onToggleGalleryShowTags = useCallback(
    () => dispatch(setGalleryShowTags(!galleryShowTags)),
    [dispatch, galleryShowTags]
  );
  // Stable column/density handlers shared by the FileListHeader render. Were
  // inline closures — a fresh identity every FileList render, which defeated
  // React.memo on FileListHeader (the whole header re-rendered on every
  // selection / scroll tick).
  const handleColumnWidth = useCallback(
    (id: string, px: number) => {
      const bounds = LIST_COLUMN_BOUNDS[id];
      const clamped = Math.max(
        bounds.min,
        Math.min(bounds.max, Math.round(px))
      );
      dispatch(setListColumnWidths({ [id]: clamped } as Record<string, number>));
    },
    [dispatch]
  );
  const handleToggleColumn = useCallback(
    (columnId: string) => {
      const next = hiddenColumns.includes(columnId)
        ? hiddenColumns.filter((id) => id !== columnId)
        : [...hiddenColumns, columnId];
      dispatch(setListHiddenColumns(next));
    },
    [dispatch, hiddenColumns]
  );
  const handleChangeListRowDensity = useCallback(
    (d: ListRowDensity) => dispatch(setListRowDensity(d)),
    [dispatch]
  );

  const groups = useShallowEqualSelector(
    (s: RootState) => s.taglibrary?.groups ?? []
  );
  const workflowStages = useShallowEqualSelector(
    (s: RootState) => s.workflow?.stages ?? []
  );
  // Workflow tag tokens (the Kanban board axis); also the mutually-exclusive set
  // enforced on save, so applying one workflow status replaces any previous one.
  const workflowValues = useMemo(
    () => workflowStages.map((s) => s.value),
    [workflowStages]
  );
  // Enforce the per-file smart-tag invariants with the CURRENT (customizable)
  // workflow set — at most one rating, one workflow status, one quadrant,
  // one date tag, one period tag. Replaces the static normalizeSmartTags so
  // user-defined stage tokens are deduped too; `withSingleDateTag` consumes
  // `now` from closure so互斥 is fresh against today's date stamp.
  const normalize = useCallback(
    (tags: string[]) =>
      withSinglePeriodTag(
        withSingleDateTag(
          withSingleQuadrant(
            withSingleFromValues(withSingleRating(tags), workflowValues)
          ),
          now
        )
      ),
    [workflowValues, now]
  );

  // P0-3: H.23 P0-3 — selected selection is `useRef<Set>` instead of
  // `useState<Set>`. We mutate the Set in place and trigger re-render by
  // bumping `selectedTick`. Rationale: every prior `setSelected(prev => new
  // Set(prev))` allocated a fresh Set on every interaction; for a 1k-row
  // directory with Ctrl+Shift multi-toggle, that's O(n) GC churn per
  // gesture. Same Set identity → child rows can cache lookups (used by
  // Row.dragItem via `cellData.selectedPaths`).
  const selectedPathsRef = useRef<Set<string>>(new Set());
  const [selectedTick, setSelectedTick] = useState(0);
  const bumpSelection = useCallback(
    () => setSelectedTick((x) => (x + 1) & 0xffff),
    []
  );

  // H.23 P1-1 keyboard navigation: focusIndex is the row index the user is
  // currently focused on (via ↑↓ / Home / End / click). Row visuals + the
  // ref-based keyboard handler both read this. Storing in state (not just
  // ref) so Row can react with its own outline / auto-focus when the parent
  // toggles focus programmatically.
  const [focusIndex, setFocusIndexState] = useState<number | null>(null);
  const setFocusIndex = useCallback((i: number | null) => {
    setFocusIndexState(i);
  }, []);

  // Back-compat shim: a few call sites (notably `useListCommands`) update
  // selection by passing an `updater: (prev) => Set<string>` callback. We
  // keep that contract by reading the current ref, computing `next`, and
  // aliasing iff changed. No allocation when the updater returns the same
  // Set (e.g. no-op click handlers).
  const setSelected = useCallback(
    (updater: (prev: Set<string>) => Set<string>) => {
      const prev = selectedPathsRef.current;
      const next = updater(prev);
      if (next === prev) return;
      selectedPathsRef.current = next;
      bumpSelection();
    },
    [bumpSelection]
  );
  // NOTE: an earlier version bumped a `mapiqueVersion` counter on every
  // `geoByName` change and used it as `<MapiqueView key=...>` to force a full
  // remount. That rebuilt the Leaflet map (tiles reload, view reset) on every
  // add/remove-tag — a jarring "page refresh". MapiqueView now handles sidecar
  // mutations in place: its `forceRender` (on geoByName/tagsByName change)
  // re-renders markers/tray, and it drops a stale `activeEntry` when the entry
  // leaves `entries`. No remount is needed.
  // Thumbnail data-URL cache (path|mtime -> url). Survives row unmount during
  // scroll so re-mounts don't re-read from disk; cleared on directory change.
  const thumbCache = useRef(new Map<string, string>());
  useEffect(() => {
    thumbCache.current.clear();
  }, [currentDirectoryPath]);
  const [renameTarget, setRenameTarget] = useState<DirEntry | null>(null);
  const [copyTarget, setCopyTarget] = useState<DirEntry | null>(null);
  const [packageOpen, setPackageOpen] = useState(false);
  // Structured notice: severity is decided at the call site, never inferred
  // from the localized text (prefix-matching translations mislabeled error
  // toasts as success in ja/ko and success toasts as errors in en/zh).
  const [notice, setNotice] = useState<{
    text: string;
    severity: 'success' | 'info' | 'warning' | 'error';
    /** Show the "open trash" action button. */
    openTrash?: boolean;
  } | null>(null);
  // Reporter for success/warning/info + every error path (`showNotice(msg)`
  // defaults to error). `setNotice` itself stays for the close handlers.
  const showNotice = useCallback(
    (
      text: string,
      severity: 'success' | 'info' | 'warning' | 'error' = 'error',
      opts?: { openTrash?: boolean }
    ) => setNotice({ text, severity, ...opts }),
    []
  );
  // Context menu: entry === null means a right-click on blank space.
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    entry: DirEntry | null;
  } | null>(null);
  const [createKind, setCreateKind] = useState<'folder' | 'file' | null>(null);
  // Perspective-aware creation: Kanban column / Calendar day cell pre-selects a tag.
  const [createWithTag, setCreateWithTag] = useState<{
    kind: 'folder' | 'file';
    tag: string;
  } | null>(null);
  // Per-tag context menu (right-click a tag chip on a row): remove that tag.
  const [tagCtx, setTagCtx] = useState<{
    x: number;
    y: number;
    entry: DirEntry;
    tag: string;
  } | null>(null);
  // Measured grid viewport width (px), set by the Grid's onResize. Columns are
  // derived from it and entrySize, so zooming reflows without a resize event.
  const [gridWidth, setGridWidth] = useState(0);
  const gridContainerRef = useRef<HTMLDivElement | null>(null);
  // The main file-list container needs to be focusable so it can receive the
  // Delete key when the user has selected entries. Child cards/rows also get
  // tabIndex={-1} so their keydown events bubble here.
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Watch the grid container ourselves so column count updates immediately when
  // the properties tray opens/closes or is resized.
  useEffect(() => {
    const el = gridContainerRef.current;
    if (!el || viewMode !== 'grid') return undefined;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setGridWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewMode]);

  // Full-screen media lightbox state.
  const [lightboxEntry, setLightboxEntry] = useState<DirEntry | null>(null);

  // Only the `date:` / `smart:*` fold filters classify tag freshness against
  // wall-clock — gate the memo's `now` dependency on them so the per-minute
  // `useNow` tick doesn't recompute (and re-render all visible rows) for
  // plain tag / `geo:` / `period:` filters (docs/01 §12).
  const freshnessFilter = activeTag === 'date:' || (activeTag?.startsWith('smart:') ?? false);
  const nowTick = freshnessFilter ? now : FROZEN_NOW;

  const visible = useMemo(() => {
    if (!activeTag) return entries;
    // Folded geo filter ("geo:") matches every file carrying a coordinate tag.
    if (activeTag === 'geo:') {
      return entries.filter((e) =>
        (tagsByName.get(e.path) ?? []).some(isGeoTag)
      );
    }
    // Folded period filter ("period:") matches every file carrying a
    // YYYYMMDD-YYYYMMDD period tag (the fold key 'period:' itself is never
    // stored on a file — see docs/03-tagging.md §5 / §8).
    if (activeTag === 'period:') {
      return entries.filter((e) =>
        (tagsByName.get(e.path) ?? []).some(isPeriodTag)
      );
    }
    // Folded stale-date filter ("date:") matches every file carrying a date-
    // shaped tag that is currently stale (out of any of the 7 freshness
    // windows). Wrapped in useNow-derived `now` so day / month / year
    // boundaries correctly re-classify at click time.
    if (activeTag === 'date:') {
      return entries.filter((e) =>
        (tagsByName.get(e.path) ?? []).some((tg) => isStaleDateTag(tg, nowTick))
      );
    }
    // Folded smart-tag filter ("smart:today") matches every variant of that fn.
    if (activeTag.startsWith('smart:')) {
      const fn = activeTag.slice(6) as SmartFunctionality;
      return entries.filter((e) =>
        (tagsByName.get(e.path) ?? []).some(
          (tg) => smartFunctionalityOfTag(tg, nowTick) === fn
        )
      );
    }
    return entries.filter((e) =>
      (tagsByName.get(e.path) ?? []).includes(activeTag)
    );
  }, [entries, activeTag, tagsByName, nowTick]);

  const selectedEntries = useMemo(
    () => visible.filter((e) => selectedPathsRef.current.has(e.path)),
    [visible, selectedTick]
  );

  // Mirror the selection into FileSelectionContext so siblings (the AI panel)
  // can read the current selection without reaching into FileList's internals.
  const { setSelectedEntries: setSelectedEntriesCtx } =
    useFileSelectionContext();
  useEffect(() => {
    setSelectedEntriesCtx(selectedEntries);
  }, [selectedEntries, setSelectedEntriesCtx]);

  // `isSelected` reads the mutated-in-place selection ref (P0-3), but its
  // identity is keyed on `selectedTick` deliberately: react-window v2 already
  // memoizes each row with a shallow-compare, so a selection change must flip
  // SOME cellData field's identity to make rows re-render and re-evaluate
  // `isSelected(entry)`. Without `selectedTick` here the callback would be
  // stable forever and checkboxes would go stale. (This replaces the prior
  // hand-written `arePropsEqual` + in-body `React.memo` layer, which was both
  // redundant with react-window's built-in memo and broken — see F1/F4 in the
  // H.23 review.)
  const isSelected = useCallback(
    (entry: DirEntry) => selectedPathsRef.current.has(entry.path),
    [selectedTick]
  );

  // P0-4: lookup table for `cellData.resolveEntry` — drop targets use it to
  // turn dragged paths into full DirEntry objects without scanning `visible`
  // per-row. Built once per `visible` change; O(n) one-shot, then O(1) per
  // probe.
  const visibleByPath = useMemo(
    () => new Map(visible.map((e) => [e.path, e])),
    [visible]
  );
  const resolveEntry = useCallback(
    (path: string) => visibleByPath.get(path),
    [visibleByPath]
  );

  // Anchor row for Shift range-selection (the last row toggled without Shift).
  const selectAnchorRef = useRef<number | null>(null);

  /**
   * Selection gesture on the visible row at `index`:
   *  - Shift: add the inclusive range from the anchor to here (easy multi-pick).
   *  - Ctrl / Cmd: toggle just this row and make it the new anchor.
   *  - Plain click: select only this row (so the properties tray updates).
   * Range uses `visible` so it matches exactly what the user sees (post-filter).
   *
   * P0-3: the Set is mutated in place; rerender is triggered by `bumpSelection`.
   * This keeps the Set identity stable across toggles, which downstream of
   * `cellData.selectedPaths` (P0-4) means Row's dragItem memo doesn't churn on
   * every click.
   */
  const selectRow = useCallback((
    index: number,
    mods: { shift: boolean; toggle: boolean }
  ) => {
    const entry = visible[index];
    if (!entry) return;
    // H.23 P1-1: every click also moves keyboard focus to the same row,
    // so subsequent arrow nav starts from where the user clicked.
    setFocusIndex(index);
    // Clicking a file/folder should always bring the properties tray back —
    // the user having closed it once shouldn't suppress it for every later
    // click. (A toggle-off that empties the selection still hides the tray via
    // the `selectedEntries.length > 0` render guard, so this is safe to set
    // unconditionally on any selection gesture.)
    if (!trayVisible) dispatch(setTrayVisible(true));
    const set = selectedPathsRef.current;
    let mutated = false;
    if (mods.shift && selectAnchorRef.current !== null) {
      const a = selectAnchorRef.current;
      const [lo, hi] = a < index ? [a, index] : [index, a];
      for (let i = lo; i <= hi; i += 1) {
        const p = visible[i].path;
        if (!set.has(p)) {
          set.add(p);
          mutated = true;
        }
      }
      // anchor is preserved so a follow-up Shift-click re-extends from it.
    } else if (mods.toggle) {
      if (set.has(entry.path)) set.delete(entry.path);
      else set.add(entry.path);
      selectAnchorRef.current = index;
      mutated = true;
    } else {
      // Plain click: single-select the row.
      if (set.size !== 1 || !set.has(entry.path)) {
        set.clear();
        set.add(entry.path);
        mutated = true;
      }
      selectAnchorRef.current = index;
    }
    if (mutated) bumpSelection();
  },
  [
    visible,
    trayVisible,
    dispatch,
    setFocusIndex,
    bumpSelection,
  ]);

  const clearSelection = useCallback(() => {
    const set = selectedPathsRef.current;
    if (set.size === 0) return;
    set.clear();
    selectAnchorRef.current = null;
    bumpSelection();
  }, [bumpSelection]);

  // Tri-state select-all for the list-view column header. Compared against the
  // CURRENT `visible` array so the header always reflects what the user sees
  // (post-filter / post-search). When the user switches filters we keep any
  // out-of-visible selections so Shift-range gestures remain valid.
  const selectAllState = useMemo<'checked' | 'indeterminate' | 'unchecked'>(
    () => {
      const size = selectedPathsRef.current.size;
      if (size === 0 || visible.length === 0) return 'unchecked';
      if (size >= visible.length) return 'checked';
      return 'indeterminate';
    },
    // ticking on `selectedTick` would also work, but reading ref.current here
    // means the memo body runs once per deps change and never observes a stale
    // Set. The `visible.length` dep is enough to catch directory resizes.
    [visible.length, selectedTick]
  );
  const toggleSelectAll = useCallback(() => {
    if (selectAllState === 'checked') {
      // Fully checked → clear every selection (visible or not).
      clearSelection();
      return;
    }
    // Unchecked / indeterminate → fill every visible entry, preserving any
    // out-of-visible selections.
    const set = selectedPathsRef.current;
    let mutated = false;
    for (const e of visible) {
      if (!set.has(e.path)) {
        set.add(e.path);
        mutated = true;
      }
    }
    // After a fill, the shift-range anchor no longer points at a sensible row.
    selectAnchorRef.current = null;
    if (mutated) bumpSelection();
  }, [selectAllState, visible, clearSelection, bumpSelection]);

  const trayAppliesToView = (mode: ViewMode) =>
    mode === 'list' || mode === 'grid' || mode === 'gallery';

  const handleSelectForGallery = useCallback(
    (entry: DirEntry, mods: { shift: boolean; toggle: boolean }) => {
      // P1-1: index is resolved by path (mirrors how list/grid Rows already
      // pass their own index); the same `selectRow` that powers Row clicks
      // now also powers GalleryView tile clicks, so Shift range / Ctrl
      // toggle behave identically across perspectives.
      const index = visible.findIndex((e) => e.path === entry.path);
      if (index >= 0) selectRow(index, mods);
    },
    [visible, selectRow]
  );

  const { openWithExtension, registry, userDefaults, enabledOverrides } =
    useExtensionContext();
  const newExcalidraw = useNewExcalidraw();
  const newDrawio = useNewDrawio();

  // P0-1d wire-up: deps bag for `useListCommands`. Stable across renders so the
  // hook can `useMemo`-key on identity. After P0-2 this becomes even more
  // important (handlers feed into `cellData`'s React.memo comparator).
  const commandsDeps = useMemo(
    () => ({
      renameEntry,
      moveEntry,
      // `useListCommands` doesn't read `selected` directly — it just needs the
      // `bumpSelection` + ref pair to mutate-in-place (P0-3). After the refactor
      // we removed the `selected: Set<string>` field from `ListCommandsDeps`.
      copyEntry,
      deleteEntry,
      createFolder,
      createFile,
      createTaggedEntry,
      save,
      saveMany,
      tagsByName,
      descByName,
      normalize,
      selectedEntries,
      setSelected,
      clearSelection,
      // H.23 P3-1: handleInvertSelection mutates the ref directly (single
      // mutation + one tick bump), so we expose both the ref and the
      // bump fn to the hook. Avoids an O(n) re-derive per click.
      selectedPathsRef,
      bumpSelection,
      showNotice,
      currentLocation,
      currentDirectoryPath,
      deleteToTrash,
      refresh,
      setPackageOpen,
      setCreateKind,
      setCreateWithTag,
      newExcalidraw,
      newDrawio,
      createWithTag,
    }),
    // deps are stable callbacks/Set refs we already memoize; listing them by
    // identity keeps the bag itself stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      renameEntry,
      moveEntry,
      copyEntry,
      deleteEntry,
      createFolder,
      createFile,
      createTaggedEntry,
      save,
      saveMany,
      tagsByName,
      descByName,
      normalize,
      selectedEntries,
      deleteToTrash,
      refresh,
      currentLocation,
      // H.23 P3-1: deps mirror of the inline object — P3-1 hook
      // implementation mutates the ref directly + bumps the tick once
      // for the whole inversion.
      selectedPathsRef,
      bumpSelection,
      currentDirectoryPath,
      newExcalidraw,
      newDrawio,
      createWithTag,
    ]
  );
  const commands = useListCommands(commandsDeps);

  // H.25 (video dispatch fix): video files route to the media-player extension
  // (rich player with playlist / prev-next / loop / shuffle / speed / progress
  // memory) instead of MediaLightbox. Images still go through MediaLightbox for
  // the zoom / pan / filmstrip single-image preview. Matches the checklist
  // §media-player rule "双击视频/音频播放" and sidesteps a class of MediaLightbox
  // codec issues (e.g. formats Chromium can't decode end up showing
  // "无法打开 X").
  const handleOpen = useCallback((entry: DirEntry) => {
    if (entry.isDirectory) {
      navigateTo(entry.path);
    } else if (isImageFile(entry.name)) {
      setLightboxEntry(entry);
    } else {
      const manifest = selectExtension(entry, {
        registry,
        userDefaults,
        enabledOverrides,
      });
      if (manifest) {
        openWithExtension(entry, manifest).catch((e: unknown) =>
          showNotice(e instanceof Error ? e.message : String(e))
        );
      } else {
        openNative(entry.path).catch((e: unknown) =>
          showNotice(e instanceof Error ? e.message : String(e))
        );
      }
    }
  }, [
    navigateTo,
    setLightboxEntry,
    registry,
    userDefaults,
    enabledOverrides,
    openWithExtension,
    openNative,
  ]);

  // handleDelete + handleMove moved to `useListCommands` (P0-1d).

  const handleRenameConfirm = async (newName: string) => {
    const target = renameTarget;
    setRenameTarget(null);
    if (!target) return;
    try {
      await renameEntry(target.path, newName);
    } catch (e) {
      showNotice(e instanceof Error ? e.message : String(e));
    }
  };

  // H.23 P1-4 inline rename. Local state: the entry currently being
  // renamed in-place. Only one row can be in edit mode at a time across
  // the whole list — keeping it here (not per-row) prevents two rows from
  // showing TextFields simultaneously.
  const [inlineRenameEntry, setInlineRenameEntry] = useState<DirEntry | null>(
    null
  );
  const startInlineRename = useCallback(
    (entry: DirEntry) => {
      setInlineRenameEntry(entry);
    },
    []
  );
  const cancelInlineRename = useCallback(() => {
    setInlineRenameEntry(null);
  }, []);
  const commitInlineRename = useCallback(
    async (entry: DirEntry, newName: string) => {
      setInlineRenameEntry(null);
      if (!newName || newName === entry.name) return;
      try {
        await renameEntry(entry.path, newName);
      } catch (e) {
        showNotice(e instanceof Error ? e.message : String(e));
      }
    },
    [renameEntry]
  );

  const handleCopyConfirm = async (newName: string) => {
    const target = copyTarget;
    setCopyTarget(null);
    if (!target) return;
    try {
      await copyEntry(target.path, newName);
    } catch (e) {
      showNotice(e instanceof Error ? e.message : String(e));
    }
  };

  // Drop one or more entries onto a folder cell to move them inside it.
  // External files dragged in from outside the app (OS file manager): copy them
  // into the current directory. Never overwrites (main auto-renames on clash).
  //
  // In task perspective (Kanban / Matrix / Gantt), the per-column / per-
  // quadrant / per-tray drop targets ALSO accept native files (see
  // KanbanView / MatrixView / GanttView) and stamp the column's tag.
  // This outer `handleExternalDrop` is the **fallback** for drops that
  // don't land on a specific column / quadrant — e.g., the toolbar area,
  // the toggle row, the PropertiesTray gutter, or the empty space in
  // list / grid view. The today-period auto-tag is still applied for
  // task view so an imported file appears on the Gantt timeline.
  const handleExternalDrop = async (files: File[]) => {
    if (!files?.length || !currentDirectoryPath) return;
    let tagToApply: string | null = null;
    if (viewMode === 'task') {
      const today = todayKey();
      tagToApply = periodTagFromRange({ startKey: today, endKey: today });
    }
    try {
      const { copied, errors } = await importExternalFiles(files, {
        tagToApply,
      });
      if (copied > 0) {
        showNotice(t('importedItems', { count: copied }), 'success');
      } else if (errors.length) showNotice(errors[0]);
    } catch (e) {
      showNotice(e instanceof Error ? e.message : String(e));
    }
  };

  // Drop target for OS files dragged into the file area (NativeTypes.FILE).
  const [{ isFileOver }, nativeDropRef] = useDrop<
    { files: File[] },
    unknown,
    { isFileOver: boolean }
  >(
    () => ({
      accept: [NativeTypes.FILE],
      canDrop: () => !currentLocation?.isReadOnly,
      drop: (item) => {
        void handleExternalDrop(item.files);
      },
      collect: (monitor) => ({
        isFileOver: monitor.isOver() && monitor.canDrop(),
      }),
    }),
    [currentLocation?.isReadOnly, currentDirectoryPath]
  );

  // handleDropFiles / removeTagFromEntry / removeAllTags / handleDropTag moved
  // to `useListCommands` (P0-1d).

  // Kanban: drop card(s) into a column. Applies mutually-exclusive group
  // semantics — replace the file's tags from `groupTags` with `targetTag`
  // (null = the untagged column → clear the group). Non-group tags untouched.
  // H.25 P0-3: wrap in useCallback so `cellData.onMoveToColumn` is a stable
  // reference; without it the FileCellData bag would re-allocate on every
  // render and break any future React.memo(Row, arePropsEqual) savings.
  const handleMoveToColumn = useCallback(
    (sources: DirEntry[], targetTag: string | null, groupTags: string[]) => {
      if (currentLocation?.isReadOnly) return;
      const updates = sources
        .map((entry) => {
          const current = tagsByName.get(entry.path) ?? [];
          const next = tagsAfterMove(current, groupTags, targetTag);
          // Skip files already in the target column (no tag change).
          if (
            next.length === current.length &&
            next.every((tg) => current.includes(tg))
          ) {
            return null;
          }
          const description = descByName.get(entry.path);
          return {
            entry,
            meta: {
              tags: normalize(next),
              ...(description ? { description } : {}),
            },
          };
        })
        .filter(Boolean) as { entry: DirEntry; meta: SidecarMeta }[];
      if (updates.length === 0) return;
      void saveMany(updates).catch((e: unknown) =>
        showNotice(e instanceof Error ? e.message : String(e))
      );
    },
    [
      currentLocation?.isReadOnly,
      tagsByName,
      descByName,
      normalize,
      saveMany,
    ]
  );

  const handleGpsFound = useCallback(
    (entry: DirEntry, lat: number, lng: number) => {
      const tags = tagsByName.get(entry.path) ?? [];
      const description = descByName.get(entry.path);
      // EXIF-extracted coordinates flow through a `geo:lat,lng` tag — the
      // sidecar has no parallel lat/lng field (removed 2026-06-30). Strip any
      // stale geo tag before appending the new one so we never end up with
      // duplicates. Mirror `handleSetGeo`'s failure surfacing so a save error
      // doesn't silently lose the extracted coordinate.
      const nextTags = withoutGeoTags(tags);
      // Skip the save when the EXIF coords match what's already tagged — common
      // case on directory re-scans where EXIF is re-extracted for every file.
      if (nextTags.length === tags.length && tags.some(isGeoTag)) {
        return;
      }
      void save(entry, {
        tags: normalize([...nextTags, formatGeoTag(lat, lng)]),
        ...(description ? { description } : {}),
      }).catch((e: unknown) =>
        showNotice(e instanceof Error ? e.message : String(e))
      );
    },
    [tagsByName, descByName, normalize, save]
  );

  // Mapique single-entry editing: set/clear a file's location and add/remove
  // tags directly from the map's detail panel.
  //
  // The location is stored exclusively as a `geo:lat,lng` tag inside the
  // sidecar's `tags` array — single source of truth. No parallel sidecar
  // lat/lng field (removed 2026-06-30; legacy sidecars are migrated on read
  // by `TagMetaContextProvider`).
  const handleSetGeo = useCallback(
    (entry: DirEntry, lat: number, lng: number) => {
      if (currentLocation?.isReadOnly) return;
      const current = tagsByName.get(entry.path) ?? [];
      const description = descByName.get(entry.path);
      void save(entry, {
        tags: normalize([...withoutGeoTags(current), formatGeoTag(lat, lng)]),
        ...(description ? { description } : {}),
      }).catch((e: unknown) =>
        showNotice(e instanceof Error ? e.message : String(e))
      );
    },
    [currentLocation, tagsByName, descByName, normalize, save]
  );

  const handleClearGeo = useCallback(
    (entry: DirEntry) => {
      if (currentLocation?.isReadOnly) return;
      const current = tagsByName.get(entry.path) ?? [];
      const description = descByName.get(entry.path);
      void save(entry, {
        tags: withoutGeoTags(current),
        ...(description ? { description } : {}),
      }).catch((e: unknown) =>
        showNotice(e instanceof Error ? e.message : String(e))
      );
    },
    [currentLocation, tagsByName, descByName, save]
  );

  const handleAddTag = useCallback(
    (entry: DirEntry, tag: string) => {
      if (currentLocation?.isReadOnly) return;
      // Resolve user input to its stored form FIRST: `today` → `20260704`,
      // `month-202606` → `202606`, `in-progress` → unchanged, plain tags
      // unchanged. Without this step the互斥 chain below can't recognize
      // the freshly-typed tag (it sees the raw template name, not the
      // resolved shape), and the raw template would land in the sidecar.
      const resolved = resolveInputTag(tag, now);
      const current = tagsByName.get(entry.path) ?? [];
      if (current.includes(resolved)) return;
      const description = descByName.get(entry.path);
      void save(entry, {
        tags: normalize([...current, resolved]),
        ...(description ? { description } : {}),
      }).catch((e: unknown) =>
        showNotice(e instanceof Error ? e.message : String(e))
      );
    },
    [currentLocation, tagsByName, descByName, normalize, save, now]
  );

  const handleRemoveTag = useCallback(
    (entry: DirEntry, tag: string) => {
      if (currentLocation?.isReadOnly) return;
      const current = tagsByName.get(entry.path) ?? [];
      if (!current.includes(tag)) return;
      const description = descByName.get(entry.path);
      void save(entry, {
        tags: current.filter((tg) => tg !== tag),
        ...(description ? { description } : {}),
      }).catch((e: unknown) =>
        showNotice(e instanceof Error ? e.message : String(e))
      );
    },
    [currentLocation, tagsByName, descByName, save]
  );

  // H.24 P0-1: rewrite the file's date-typed tag (replaces any prior date tag).
  // Mirrors `handleAddTag`/`handleRemoveTag` for the date-tag category: keep
  // every non-date tag, swap in the new one. Returns early on read-only.
  const handleSetEntryDateTag = useCallback(
    (entry: DirEntry, dateKey: string) => {
      if (currentLocation?.isReadOnly) return;
      const current = tagsByName.get(entry.path) ?? [];
      const kept = current.filter((tg) => !isDateTypedTag(tg));
      const description = descByName.get(entry.path);
      void save(entry, {
        tags: normalizeSmartTags([...kept, dateKey]),
        ...(description ? { description } : {}),
      }).catch((e: unknown) =>
        showNotice(e instanceof Error ? e.message : String(e))
      );
    },
    [currentLocation, tagsByName, descByName, save]
  );

  // H.24 P0-1: strip every date-typed tag from the file's sidecar. Companion
  // to `handleSetEntryDateTag`.
  const handleRemoveEntryDateTag = useCallback(
    (entry: DirEntry) => {
      if (currentLocation?.isReadOnly) return;
      const current = tagsByName.get(entry.path) ?? [];
      const kept = current.filter((tg) => !isDateTypedTag(tg));
      // No-op when there's nothing to remove -- avoid an unnecessary sidecar
      // write (and the i18n notice roundtrip).
      if (kept.length === current.length) return;
      const description = descByName.get(entry.path);
      void save(entry, {
        tags: normalizeSmartTags(kept),
        ...(description ? { description } : {}),
      }).catch((e: unknown) =>
        showNotice(e instanceof Error ? e.message : String(e))
      );
    },
    [currentLocation, tagsByName, descByName, save]
  );

  // handleBulkDelete / handleBulkMove / handlePackageConfirm / handleCreate /
  // handleNewExcalidraw / handleNewDrawio / handleCreateTagged moved to
  // `useListCommands` (P0-1d). `changeSort` moved to `FileListHeader`.

  // Returns true for text-entry surfaces (TextField, textarea, contenteditable)
  // so shortcuts like Delete / F2 / arrows don't fire while the user is typing
  // in a search box, InlineTagInput, the inline rename TextField, or a
  // PromptDialog.
  //
  // Checkboxes are intentionally NOT treated as input-like. The row's
  // selection Checkbox is a common focus target after a click — if we bailed
  // on it here, F2 rename / Space toggle / ↑↓ nav would all be silently
  // swallowed (the user reported F2 doing nothing after clicking a row's
  // checkbox). The Checkbox's native behavior is already suppressed by being
  // controlled (`checked={isSelected(entry)}` with no onChange), so letting
  // our keydown handler run is a strict UX improvement, not a regression.
  const isInputLike = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName.toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'input' && (target as HTMLInputElement).type !== 'checkbox') {
      return true;
    }
    if (target.isContentEditable) return true;
    return false;
  };

  // H.23 keyboard navigation. Single attachment point (the outer container
  // `onKeyDown`). Skips when focus is on an input-like element so typing in
  // PromptDialog / InlineTagInput / the search bar never steals keys — this
  // also means Tab inside the rename TextField still moves focus normally.
  //
  // Keys resolve to actions via the user-configurable keybindings map
  // (Settings ▸ Keyboard; defaults in `renderer/domain/keybindings`). `resolveAction`
  // ignores modifiers on purpose — Shift-range-extend stays inside the
  // navigate cases. The bindings apply in list/grid; GalleryView etc. own
  // their own focused-container keydown.
  //
  // Default scheme: ↑/↓ navigate (Shift = range), → open, ← back (history),
  // Tab cycle view, Enter open, Space toggle, Esc clear, F2 rename,
  // Delete delete, Home/End jump.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isInputLike(e.target)) return;

    const action = resolveAction(keybindings, e);

    // Delete runs before the empty-list guard, matching the pre-refactor
    // ordering (the standalone `Delete` branch returned before `last` was
    // ever computed, so Delete worked even on an empty list).
    if (action === 'delete') {
      e.preventDefault();
      void commands.handleDeleteSelected();
      return;
    }

    const last = visible.length - 1;
    if (last < 0) return;
    const cur = focusIndex === null ? -1 : Math.min(focusIndex, last);
    const stepIndex = (target: number) =>
      Math.max(0, Math.min(target, last));

    switch (action) {
      case 'navigateDown':
        e.preventDefault();
        if (cur >= last) return;
        // Shift-extend stays INSIDE the case (resolveAction ignores mods).
        selectRow(stepIndex(cur + 1), { shift: e.shiftKey, toggle: false });
        break;
      case 'navigateUp':
        e.preventDefault();
        if (cur <= 0) return;
        selectRow(stepIndex(cur - 1), { shift: e.shiftKey, toggle: false });
        break;
      case 'jumpHome':
        e.preventDefault();
        selectRow(0, { shift: false, toggle: false });
        break;
      case 'jumpEnd':
        e.preventDefault();
        selectRow(last, { shift: false, toggle: false });
        break;
      case 'open': {
        e.preventDefault();
        const entry = visible[cur];
        if (entry) handleOpen(entry);
        break;
      }
      // F2 starts in-place rename on the focused row. When the user is
      // already in inline edit mode, the row's TextField owns the keystrokes
      // (Enter commits, Esc cancels) so this is a no-op then.
      //
      // Fallback chain (B1, 2026-07-03): `visible[cur]` can be undefined
      // even when the user *thinks* they have a focused row. Three common
      // ways that happens:
      //   1. User just opened the app and pressed F2 before any click / ↑↓.
      //   2. User clicked a tag chip — `EntryTagChips` calls
      //      `e.stopPropagation()` on its click handler, so the row's
      //      `onClick` → `onSelectRow` → `setFocusIndex` never runs.
      //   3. User applied a search / tag filter after navigating, and the
      //      previously-focused index is now out of `visible` range.
      // Previously we silently no-op'd; the user saw F2 do nothing. Now we
      // walk a fallback chain — single selection, then first visible row —
      // and only show a notice when the list is truly empty of any target.
      case 'rename': {
        e.preventDefault();
        let target: DirEntry | undefined = visible[cur];
        if (!target && selectedPathsRef.current.size === 1) {
          const [selectedPath] = selectedPathsRef.current;
          target = visible.find((entry) => entry.path === selectedPath);
        }
        if (!target) target = visible[0];
        if (!target) {
          showNotice(t('noRowToRename'), 'info');
          return;
        }
        // Keep the keyboard cursor on the row we just started renaming so
        // a follow-up Esc/Enter still lands on the right row.
        if (focusIndex === null || focusIndex !== visible.indexOf(target)) {
          setFocusIndex(visible.indexOf(target));
        }
        startInlineRename(target);
        break;
      }
      case 'toggleSelect':
        e.preventDefault();
        if (cur < 0) return;
        selectRow(cur, { shift: false, toggle: true });
        break;
      case 'clearSelection':
        e.preventDefault();
        clearSelection();
        break;
      case 'back':
        // History-LRU back (toolbar ← semantics). No-op at the location root
        // where `canGoBack === false`.
        if (canGoBack) {
          e.preventDefault();
          goBack();
        }
        break;
      case 'switchView':
        // The only case that swallows Tab — mapping Tab to 'none' makes
        // `resolveAction` return null, so we fall through to `default` and the
        // browser keeps its native focus traversal.
        e.preventDefault();
        setViewMode(nextView(viewMode));
        break;
      case 'none':
      default:
        break;
    }
  };

  // react-window v2 already wraps `rowComponent`/`cellComponent` in its OWN
  // internal `memo(...)` with a shallow comparator, keyed on the component
  // reference. Two consequences:
  //   1. We pass `Row`/`GridCell` directly (module-scope, stable refs). An
  //      earlier version wrapped them in `React.memo(...)` *inside the render
  //      body*; that minted a fresh memo type every render, which made
  //      react-window rebuild its internal memo and unmount+remount every
  //      visible row/cell on each parent render.
  //   2. Our job is therefore just to keep `cellData` field identities stable
  //      (handlers via `useCallback`, immutable maps via `useMemo`) so
  //      react-window's shallow compare short-circuits to "no change" on
  //      unrelated renders. Selection still propagates because `isSelected`
  //      is keyed on `selectedTick` (see its definition above).

  // P0-2: stable-ify the four set-state arrows so they don't change identity
  // whenever `cellData` is rebuilt. Together with the commands handlers (which
  // are reference-stable via `useListCommands` memo) and `isSelected` (keyed
  // on `selectedTick`), this is what lets react-window v2's built-in per-row
  // shallow memo short-circuit unrelated parent rerenders.
  const onClickTag = useCallback(
    (tag: string) => setActiveTag(activeTag === tag ? null : tag),
    [activeTag]
  );
  const onTagContextMenu = useCallback(
    (entry: DirEntry, tag: string, x: number, y: number) =>
      setTagCtx({ entry, tag, x, y }),
    []
  );
  const onContextEntry = useCallback(
    (entry: DirEntry, x: number, y: number) => setCtxMenu({ x, y, entry }),
    []
  );
  const onCreateTagged = useCallback(
    (kind: 'folder' | 'file', tag: string) =>
      setCreateWithTag({ kind, tag }),
    []
  );
  // ── UX shortcuts to existing location-level features ───────────────
  // Both actions live on the current location, not the right-clicked
  // entry; they were previously reachable only via separate Settings /
  // AddLocationDialog surfaces. The file / kanban / agenda context menus
  // pass them down verbatim; here they funnel to their canonical sinks.
  //
  // Task-reminder shortcut: point the existing
  // `settings.taskReminderLocationId` at the current location and turn
  // the reminder on (settings.taskReminderEnabled). If this location is
  // already the configured reminder, the action toggles it OFF (clears
  // the id back to `null` and disables the reminder) so the right-click
  // menu is reversible without leaving the page.
  // One handler bag, shared verbatim by the list rows and the grid cells, so
  // both views behave identically (selection, tagging, context menus). After
  // P0-1d the IO-bound handlers come from `commands`; P0-2 wraps the bag in
  // `useMemo` (every dep below is reference-stable) so react-window v2's
  // per-row shallow compare short-circuits to "no change" while no real input
  // changed.
  const cellData = useMemo<FileCellData>(
    () => ({
      entries: visible,
      thumbCache: thumbCache.current,
      tagsByName,
      descByName,
      activeTag,
      tagColors,
      groups,
      readOnly: !!currentLocation?.isReadOnly,
      t,
      isSelected,
      onSelectRow: selectRow,
      onOpen: handleOpen,
      onClickTag,
      onTagContextMenu,
      onCopy: setCopyTarget,
      onMove: commands.handleMove,
      onRename: setRenameTarget,
      onDelete: commands.handleDelete,
      onDropTag: commands.handleDropTag,
      onDropFiles: commands.handleDropFiles,
      onContextEntry,
      onCreateTagged,
      // H.24 P0-1: date-tag setters for the Calendar right-click menu.
      onSetEntryDateTag: handleSetEntryDateTag,
      onRemoveEntryDateTag: handleRemoveEntryDateTag,
      // H.25 P0-1: Kanban right-click menu handlers. Move/Add/Remove are
      // backed by the existing IO handlers above; `onMoreFileActions` simply
      // re-uses the generic `onContextEntry` so the "More file actions" item
      // in KanbanEntryMenu pops the same EntryContextMenu the list/grid
      // would show.
      onMoveToColumn: handleMoveToColumn,
      onAddTag: handleAddTag,
      onRemoveTag: handleRemoveTag,
      onMoreFileActions: (entry: DirEntry, x: number, y: number) =>
        onContextEntry(entry, x, y),
      // P0-4 plumbing:
      selectedPaths: selectedPathsRef.current,
      resolveEntry,
      // H.23 P1-5 column plumbing:
      columnWidths,
      hiddenColumns,
      // H.23 P2-1 zebra striping toggle (default off).
      listZebra,
      // H.23 P2-3 date format preset (default 'absolute').
      listDateFormat,
      // H.23 P1-1: keyboard focus index. Row uses it to (1) render a focus
      // outline and (2) auto-focus its own ListItemButton on match. Read here
      // instead of taking a separate prop on `<VirtualList>` to keep all
      // per-row input in one bag.
      focusIndex,
      // H.23 P1-4: in-place rename state. Row swaps the name Typography for
      // a TextField when this entry's path matches `inlineRenameEntry.path`.
      inlineRenameEntry,
      startInlineRename,
      cancelInlineRename,
      commitInlineRename,
    }),
    [
      visible,
      thumbCache.current,
      tagsByName,
      descByName,
      activeTag,
      tagColors,
      groups,
      currentLocation?.isReadOnly,
      t,
      isSelected,
      selectRow,
      handleOpen,
      commands,
      onClickTag,
      onTagContextMenu,
      onContextEntry,
      onCreateTagged,
      handleSetEntryDateTag,
      handleRemoveEntryDateTag,
      // H.25 P0-3: include the new Kanban handlers in the deps so the bag
      // re-allocates when any of them changes identity. `handleMoveToColumn`
      // is now a useCallback (was an arrow before), so its identity tracks
      // the underlying IO state.
      handleMoveToColumn,
      handleAddTag,
      handleRemoveTag,
      selectedPathsRef,
      visibleByPath,
      resolveEntry,
      focusIndex,
      columnWidths,
      hiddenColumns,
      listZebra,
      listDateFormat,
      inlineRenameEntry,
      startInlineRename,
      cancelInlineRename,
      commitInlineRename,
    ]
  );

  const gridRowHeight = entrySize + GRID_CELL_FOOTER;
  // Columns reflow on viewport resize (gridWidth) or zoom (entrySize). The
  // `+ GRID_CELL_GAP` term accounts for the 8px gutter between cards so the
  // last column doesn't overflow horizontally. The actual rendered column
  // width is then stretched to fill the viewport, eliminating the trailing
  // blank strip on the right when the window is maximized.
  const gridColumns = Math.max(
    1,
    Math.floor((gridWidth + GRID_CELL_GAP) / (entrySize + GRID_CELL_GAP))
  );
  const gridColumnWidth = gridWidth > 0 ? Math.floor(gridWidth / gridColumns) : entrySize;

  return (
    <Box
      ref={(node: HTMLDivElement | null) => {
        nativeDropRef(node);
        containerRef.current = node;
      }}
      tabIndex={-1}
      onMouseDown={() => containerRef.current?.focus()}
      onKeyDown={handleKeyDown}
      onContextMenu={(e) => {
        e.preventDefault();
        setCtxMenu({ x: e.clientX, y: e.clientY, entry: null });
      }}
      sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative', outline: 'none' }}
    >
      {/* Overlay shown while dragging external files over the area. */}
      {isFileOver ? (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 5,
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: 'action.hover',
            border: 2,
            borderStyle: 'dashed',
            borderColor: 'primary.main',
            borderRadius: 1,
          }}
        >
          <Typography variant="h6" color="primary">
            {t('dropToImport')}
          </Typography>
        </Box>
      ) : null}
      {recursiveTruncated ? (
        <Alert severity="warning" sx={{ borderRadius: 0 }}>
          {t('recursiveEntriesTruncated')}
        </Alert>
      ) : null}
      <FileListHeader
        sort={sort}
        setSort={setSort}
        sortKeys={SORT_KEYS}
        viewMode={viewMode}
        setViewMode={setViewMode}
        entrySize={entrySize}
        setEntrySize={setEntrySize}
        minEntrySize={MIN_ENTRY_SIZE}
        maxEntrySize={MAX_ENTRY_SIZE}
        entrySizeStep={ENTRY_SIZE_STEP}
        // H.23 P1-3 row-density preset (compact / normal / comfortable).
        listRowDensity={listRowDensity}
        onChangeListRowDensity={handleChangeListRowDensity}
        selectedCount={selectedPathsRef.current.size}
        onClearSelection={clearSelection}
        listSelectAllState={selectAllState}
        onToggleSelectAll={toggleSelectAll}
        visibleCount={visible.length}
        rowThumbSize={ROW_THUMB_SIZE}
        // H.23 P1-5 column plumbing: pass-through the persisted widths +
        // hidden-column list, plus the dispatchers the resize handle and
        // right-click menu call. Width bounds live at the call site so the
        // clamp logic isn't hidden inside the header.
        columnWidths={columnWidths}
        hiddenColumns={hiddenColumns}
        setColumnWidth={handleColumnWidth}
        toggleColumn={handleToggleColumn}
        // H.23 P2-1 zebra toggle.
        listZebra={listZebra}
        onToggleListZebra={onToggleListZebra}
        // H.23 P2-3 date format toggle.
        listDateFormat={listDateFormat}
        onToggleListDateFormat={onToggleListDateFormat}
        // Gallery tag overlay toggle.
        galleryShowTags={galleryShowTags}
        onToggleGalleryShowTags={onToggleGalleryShowTags}
        columnLabels={{
          name: t('name'),
          tags: t('tags'),
          size: t('size'),
          modified: t('modified'),
        }}
      />

      {loading && entries.length === 0 ? (
        <Stack sx={{ py: 6, alignItems: 'center' }}>
          <CircularProgress />
        </Stack>
      ) : error ? (
        <Stack sx={{ p: 2 }}>
          <Alert severity="error">{error}</Alert>
        </Stack>
      ) : visible.length === 0 && (viewMode === 'list' || viewMode === 'grid') ? (
        <Stack sx={{ py: 6, alignItems: 'center' }}>
          <Typography color="text.secondary">
            {entries.length === 0 ? t('empty') : t('noMatchingTag')}
          </Typography>
        </Stack>
      ) : (
        <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
          <Box ref={gridContainerRef} sx={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', position: 'relative', display: 'flex', flexDirection: 'column' }}>
            {/* List-view column header (tri-state select-all + 5 column
                captions). Mirrors the Row layout so labels align with cells.
                Rendered only when the list view is active. */}
            {viewMode === 'list' ? (
              <RowColumnLabels
                selectAllState={selectAllState}
                onToggleSelectAll={toggleSelectAll}
                disabled={visible.length === 0}
                thumbSize={ROW_THUMB_SIZE}
                // H.23 P1-2: pass `sort / setSort` down so the column header
                // is a Button-driven sort UI in addition to the auxiliary
                // `Sort` menu at the top of the toolbar.
                sort={sort}
                setSort={setSort}
                // H.23 P1-5: column-width + visibility plumbing.
                columnWidths={columnWidths}
                hiddenColumns={hiddenColumns}
                setColumnWidth={(id, px) => {
                  const bounds = LIST_COLUMN_BOUNDS[id];
                  const clamped = Math.max(
                    bounds.min,
                    Math.min(bounds.max, Math.round(px))
                  );
                  dispatch(
                    setListColumnWidths({ [id]: clamped } as Record<
                      string,
                      number
                    >)
                  );
                }}
                toggleColumn={(columnId) => {
                  const next = hiddenColumns.includes(columnId)
                    ? hiddenColumns.filter((id) => id !== columnId)
                    : [...hiddenColumns, columnId];
                  dispatch(setListHiddenColumns(next));
                }}
                labels={{
                  name: t('name'),
                  tags: t('tags'),
                  size: t('size'),
                  modified: t('modified'),
                }}
              />
            ) : null}
            <Suspense fallback={PerspectiveFallback}>{viewMode === 'task' ? (
              // H.29: Task perspective is a thin container that hosts a
              // Kanban / Matrix sub-switch. Both child views are imported
              // here only as type references — TaskView owns the actual
              // mount + sub-switch UX, so the child components don't
              // appear directly in this render chain.
              <TaskView
                data={cellData}
                stages={workflowStages}
                onMoveToColumn={handleMoveToColumn}
              />
            ) : viewMode === 'calendar' ? (
              <CalendarView data={cellData} />
            ) : viewMode === 'folderviz' ? (
              <FolderVizView data={cellData} />
            ) : viewMode === 'tagcloud' ? (
              <TagCloudView data={cellData} />
            ) : viewMode === 'knowledge-graph' ? (
              <KnowledgeGraphView data={cellData} />
            ) : viewMode === 'mapique' ? (
              <MapiqueView
                entries={visible}
                geoByName={geoByName}
                tagsByName={tagsByName}
                loading={loading}
                thumbCache={thumbCache.current}
                onGpsFound={handleGpsFound}
                onOpen={handleOpen}
                onDelete={commands.handleDeleteSelected}
                provider={mapProvider}
                tileUrl={mapTileUrl}
                readOnly={currentLocation?.isReadOnly}
                onSetGeo={handleSetGeo}
                onClearGeo={handleClearGeo}
                onAddTag={handleAddTag}
                onRemoveTag={handleRemoveTag}
                tagColors={tagColors}
                groups={groups}
              />
            ) : viewMode === 'gallery' ? (
              <GalleryView
                entries={visible}
                thumbCache={thumbCache.current}
                entrySize={entrySize}
                selected={selectedPathsRef.current}
                onSelect={handleSelectForGallery}
                onOpen={handleOpen}
                tagsByName={tagsByName}
                tagColors={tagColors}
                groups={groups}
                // §2 P0 拖拽打标 (2026-07-02): wire the same handleDropTag
                // command that list/grid rows use, plus the location's readOnly
                // so a drag-over on a read-only tile doesn't even show the
                // dashed outline. command-layer defense also lives in
                // `commands.handleDropTag` (see useListCommands.ts).
                onDropTag={commands.handleDropTag}
                onContextEntry={onContextEntry}
                readOnly={!!currentLocation?.isReadOnly}
                showTags={galleryShowTags}
              />
            ) : viewMode === 'grid' ? (
              <VirtualGrid
                style={{ width: '100%', height: '100%' }}
                columnCount={gridColumns}
                columnWidth={gridColumnWidth}
                rowCount={Math.ceil(visible.length / gridColumns)}
                rowHeight={gridRowHeight}
                cellComponent={GridCell}
                onResize={({ width }) => {
                  setGridWidth((prev) => (prev === width ? prev : width));
                }}
                cellProps={{
                  ...cellData,
                  columnCount: gridColumns,
                  entrySize,
                  cellWidth: gridColumnWidth,
                }}
              />
            ) : (
              <Box sx={{ flex: 1, minHeight: 0 }}>
                <VirtualList
                  style={{ height: '100%' }}
                  rowCount={visible.length}
                  rowHeight={rowHeight}
                  rowComponent={Row}
                  rowProps={cellData}
                />
              </Box>
            )}</Suspense>

            {!trayVisible && selectedEntries.length > 0 && trayAppliesToView(viewMode) && (
              <Tooltip title={t('showProperties')}>
                <IconButton
                  size="small"
                  onClick={() => dispatch(setTrayVisible(true))}
                  sx={{
                    position: 'absolute',
                    top: 12,
                    right: 12,
                    zIndex: 10,
                    bgcolor: 'background.paper',
                    boxShadow: 1,
                    '&:hover': { bgcolor: 'background.paper' },
                  }}
                >
                  <ChevronLeftIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          </Box>

          {trayVisible && selectedEntries.length > 0 && trayAppliesToView(viewMode) && (
            <PropertiesTray
              entries={selectedEntries}
              thumbCache={thumbCache.current}
              readOnly={!!currentLocation?.isReadOnly}
              width={trayWidth}
              onClose={() => dispatch(setTrayVisible(false))}
              onWidthChange={(w) => dispatch(setTrayWidth(w))}
              onOpen={handleOpen}
              onDelete={commands.handleDelete}
              onError={(msg) => showNotice(msg)}
            />
          )}
        </Box>
      )}

      <PromptDialog
        open={renameTarget !== null}
        title={t('rename')}
        label={t('name')}
        defaultValue={renameTarget?.name ?? ''}
        onConfirm={handleRenameConfirm}
        onClose={() => setRenameTarget(null)}
      />

      <PromptDialog
        open={copyTarget !== null}
        title={t('copy')}
        label={t('name')}
        defaultValue={copyTarget ? copyDefaultName(copyTarget.name, t('copySuffix')) : ''}
        onConfirm={handleCopyConfirm}
        onClose={() => setCopyTarget(null)}
      />

      <PromptDialog
        open={createKind !== null}
        title={createKind === 'folder' ? t('newFolder') : t('newFile')}
        label={t('name')}
        onConfirm={(name) => {
          const kind = createKind;
          setCreateKind(null);
          if (!kind || !name) return;
          // H.39: in task perspective (Gantt/Kanban/Matrix), auto-tag new
          // files/folders with a today-period tag so they appear on the Gantt
          // timeline (or in the "No schedule" tray for Kanban/Matrix) without
          // requiring an extra drag step.
          if (viewMode === 'task') {
            const today = todayKey();
            const tag = periodTagFromRange({ startKey: today, endKey: today });
            void createTaggedEntry(kind, name, tag);
          } else {
            void commands.handleCreate(kind, name);
          }
        }}
        onClose={() => setCreateKind(null)}
      />

      <PromptDialog
        open={createWithTag !== null}
        title={
          createWithTag
            ? `${createWithTag.kind === 'folder' ? t('newFolder') : t('newFile')} (${createWithTag.tag})`
            : ''
        }
        label={t('name')}
        onConfirm={commands.handleCreateTagged}
        onClose={() => setCreateWithTag(null)}
      />

      <PromptDialog
        open={packageOpen}
        title={t('package')}
        label={t('name')}
        defaultValue={basename(currentDirectoryPath) || 'archive'}
        onConfirm={commands.handlePackageConfirm}
        onClose={() => setPackageOpen(false)}
      />

      <Snackbar
        open={notice !== null}
        autoHideDuration={6000}
        onClose={() => setNotice(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {/* Snackbar keeps its child mounted while closed (exit transition),
            so every read here must be null-safe even though `open` is false. */}
        <Alert
          severity={notice?.severity ?? 'info'}
          variant="filled"
          onClose={() => setNotice(null)}
          action={
            notice?.openTrash ? (
              <Button
                color="inherit"
                size="small"
                onClick={() => ipcApi.openTrash()}
              >
                {t('openTrash')}
              </Button>
            ) : undefined
          }
        >
          {notice?.text ?? ''}
        </Alert>
      </Snackbar>

      <EntryContextMenu
        ctx={ctxMenu}
        isInBulkContext={(e) =>
          selectedPathsRef.current.has(e.path) && selectedEntries.length > 1
        }
        onClose={() => setCtxMenu(null)}
        readOnly={!!currentLocation?.isReadOnly}
        tagsByName={tagsByName}
        thumbCacheClear={() => thumbCache.current.clear()}
        showError={(msg) => showNotice(msg)}
        setCreateKind={setCreateKind}
        refresh={refresh}
        revealCurrentDir={async () => {
          await ipcApi.revealPath(currentDirectoryPath);
        }}
        // H.23 P1-7: switch "Reveal in Explorer" to highlight + select the
        // file/folder in its parent (replaces the prior open-parent-only
        // behavior). The IPC layer (`shell:revealAndSelect`) handles the
        // platform branch internally.
        revealEntry={async (e) => {
          try {
            await ipcApi.revealAndSelect(e.path);
          } catch {
            // best-effort: reveal failure is non-fatal
          }
        }}
        // H.23 P1-7: copy absolute entry path to the OS clipboard. Some
        // sandboxed renderers deny `navigator.clipboard`; in that case
        // `showError` surfaces a localized message and the menu closes
        // so the user can retry / use the toolbar Copy-Past instead.
        copyPath={(e) => {
          if (!navigator.clipboard) {
            showNotice(t('clipboardUnavailable'));
            return;
          }
          navigator.clipboard.writeText(e.path).catch(() => {
            // Permission denied / sandbox rejected the write — surface the
            // same localized notice as the no-clipboard branch rather than
            // a raw English error string (H.23 P1-7 clipboard checklist).
            showNotice(t('clipboardUnavailable'));
          });
        }}
        newExcalidrawAvailable={newExcalidraw.available}
        handleNewExcalidraw={commands.handleNewExcalidraw}
        newDrawioAvailable={newDrawio.available}
        handleNewDrawio={commands.handleNewDrawio}
        handleBulkMove={commands.handleBulkMove}
        handleBulkDelete={commands.handleBulkDelete}
        openPackageDialog={() => setPackageOpen(true)}
        // H.23 P3-1: bulk "Invert selection" handler — flip every visible
        // row's selection through `commands.handleInvertSelection`.
        onInvertSelection={() => commands.handleInvertSelection(visible)}
        handleOpen={handleOpen}
        openWithExtension={openWithExtension}
        openNative={openNative}
        setViewMode={(m) => setViewMode(m)}
        setFolderThumbnail={async (e) => {
          const src = await ipcApi.openImageFileDialog();
          if (!src) return;
          await ipcApi.setFolderThumbnail(e.path, src);
          thumbCache.current.clear();
          showNotice(t('folderThumbnailSet'), 'success');
        }}
        setFolderBackground={async (e) => {
          const src = await ipcApi.openImageFileDialog();
          if (!src) return;
          await ipcApi.setFolderBackground(e.path, src);
          showNotice(t('folderBackgroundSet'), 'success');
        }}
        clearFolderThumbnail={async (e) => {
          await ipcApi.clearFolderThumbnail(e.path);
          thumbCache.current.clear();
          showNotice(t('folderThumbnailCleared'), 'success');
        }}
        clearFolderBackground={async (e) => {
          await ipcApi.clearFolderBackground(e.path);
          showNotice(t('folderBackgroundCleared'), 'success');
        }}
        removeAllTags={commands.removeAllTags}
        // H.27 P0-1: inline "Edit tags" editor inside the file/folder
        // right-click menu (EntryContextMenu single-entry branch). Reuses
        // the same handlers that Kanban's per-card menu uses so the
        // smart-tag resolution + sidecar write behaviour stays consistent
        // across surfaces. Not surfaced on Sidebar (locations) or
        // DirectoryTree (tree folders) — both stay out of scope here.
        onAddTag={handleAddTag}
        onRemoveTag={handleRemoveTag}
        setCopyTarget={setCopyTarget}
        handleMove={commands.handleMove}
        setRenameTarget={setRenameTarget}
        handleDelete={commands.handleDelete}
        registry={registry}
        userDefaults={userDefaults}
        enabledOverrides={enabledOverrides}
        getCompatibleExtensions={getCompatibleExtensions}
        userCommands={userCommands}
        onRunCommand={(entry, cmd) => {
          ipcApi.runCommand(cmd.template, entry.path).catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            // The main process throws Error(COMMAND_PATH_BLOCKED) when the path
            // can't be safely substituted (e.g. `%` in a filename on Windows);
            // map that sentinel to a localized message instead of raw English.
            showNotice(msg === COMMAND_PATH_BLOCKED ? t('commandPathBlocked') : msg);
          });
        }}
      />

      {/* Per-tag context menu: right-click a row's tag chip → remove that tag. */}
      <TagChipContextMenu
        ctx={tagCtx}
        readOnly={!!currentLocation?.isReadOnly}
        onClose={() => setTagCtx(null)}
        onRemoveTag={commands.removeTagFromEntry}
        // H.23 P2-5 bulk variant — when the right-clicked chip's row is part
        // of a multi-selection, also offer "Remove from N files". The handler
        // uses `commands.removeTagFromMany` (single saveMany round-trip).
        isInBulkContext={(e) =>
          selectedPathsRef.current.has(e.path) && selectedEntries.length > 1
        }
        selectedEntries={selectedEntries}
        onRemoveTagFromMany={(entries, tag) =>
          commands.removeTagFromMany(entries, tag)
        }
      />
      {/* Full-screen media lightbox for double-clicking media in list/grid. */}
      {lightboxEntry !== null
        ? (() => {
            const playlist = mediaPlaylist(visible);
            const idx = playlist.findIndex(
              (e) => e.path === lightboxEntry.path
            );
            if (idx < 0) {
              // Entry isn't in the current visible list — happens when
              // opening a media file from FolderViz where the file lives
              // in a subdirectory that list/grid isn't showing. Fall back
              // to a single-entry playlist so the preview still opens.
              if (isMediaEntry(lightboxEntry)) {
                return (
                  <MediaLightbox
                    open
                    entries={[lightboxEntry]}
                    initialIndex={0}
                    onClose={() => setLightboxEntry(null)}
                    thumbCache={thumbCache.current}
                  />
                );
              }
              return null;
            }
            return (
              <MediaLightbox
                open
                entries={playlist}
                initialIndex={idx}
                onClose={() => setLightboxEntry(null)}
                thumbCache={thumbCache.current}
              />
            );
          })()
        : null}
    </Box>
  );
}
