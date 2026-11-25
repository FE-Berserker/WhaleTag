import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch } from 'react-redux';
import { useShallowEqualSelector } from '-/hooks/useShallowEqualSelector';
import {
  Alert,
  Box,
  CircularProgress,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import type { GridImperativeAPI, ListImperativeAPI } from 'react-window';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';

import type { DirEntry } from '../../shared/ipc-types';
import type { ViewMode } from '../../shared/whale-meta';
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
import { selectExtension } from '-/services/extension-dispatch';
import { GRID_CELL_FOOTER, GRID_CELL_GAP } from '-/components/GridCell';
import PropertiesTray from '-/components/PropertiesTray';
import { SidecarIssuesAlert } from './file-list/SidecarIssuesAlert';
import type { CorruptSidecarIssue } from './file-list/SidecarIssuesAlert';
import { createKeyDownHandler } from './file-list/keyboard';
import { useFileListSelection } from './file-list/useFileListSelection';
import { useFileListTagActions } from './file-list/useFileListTagActions';
import { useExternalFileDrop } from './file-list/useExternalFileDrop';
import { useCommandsDeps } from './file-list/useCommandsDeps';
import { useFileListCellData } from './file-list/useFileListCellData';
import FileListView from './file-list/FileListView';
import FolderBackground from './file-list/FolderBackground';
import FileListDialogs from './file-list/FileListDialogs';
import FileListEntryContextMenu from './file-list/FileListEntryContextMenu';
import FileListLightbox from './file-list/FileListLightbox';
import FileListNoticeSnackbar from './file-list/FileListNotice';
import type { FileListNotice } from './file-list/FileListNotice';
// Re-exported for FileListSidecarIssues.test.tsx, which loads this module and
// expects the named export to live here.
export { SidecarIssuesAlert };
import FileListHeader, {
  LIST_COLUMN_BOUNDS,
  RowColumnLabels,
} from '-/components/FileListHeader';
import { TagChipContextMenu } from '-/components/EntryContextMenu';
import { isImageFile } from '../../shared/whale-meta';
import { mediaPlaylist } from '../domain/gallery';
import { filterEntriesByTag } from '../domain/file-list-filter';
import { DEFAULT_KEYBINDINGS } from '../domain/keybindings';
import { basename } from '-/services/path-util';
import { useNewExcalidraw } from '-/hooks/useNewExcalidraw';
import { useNewDrawio } from '-/hooks/useNewDrawio';
import { ipcApi } from '-/services/ipc-api';
import {
  withSingleRating,
  withSingleQuadrant,
  withSingleFromValues,
  withSingleDateTag,
  withSinglePeriodTag,
} from '../../shared/smart-tags';
import { useListCommands } from '-/hooks/useListCommands';
import { useNow } from '-/hooks/useNow';
import { useListColumnLabels } from '-/hooks/useListColumnLabels';
import { useFolderBackground } from '-/hooks/useFolderBackground';

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

/** H.23 P1-3: density preset → px row height. Single source of truth. */
const rowHeightFromDensity = (
  d: 'compact' | 'normal' | 'comfortable'
): number => (d === 'compact' ? 32 : d === 'comfortable' ? 72 : 56);

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
  const { backgroundUrl, reloadFolderBackground } = useFolderBackground(
    currentDirectoryPath
  );
  const {
    entries,
    loading,
    error,
    recursiveTruncated,
    sidecarIssues = [],
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
    refreshTree,
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
      const bounds = LIST_COLUMN_BOUNDS[id as keyof typeof LIST_COLUMN_BOUNDS];
      if (!bounds) return;
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
  // P2-2: stable column captions. The JSX used to inline
  // `{ name: t('name'), ... }` twice (FileListHeader + RowColumnLabels), i.e. a
  // fresh object on every FileList render (selection tick, scroll, thumbnail)
  // that defeated the `memo` on both header components. Identity now only
  // changes when the language does.
  const columnLabels = useListColumnLabels(t);

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
  // user-defined stage tokens are deduped too. Date-shape exclusivity is
  // time-independent, so this memo does not need to track the wall clock.
  const normalize = useCallback(
    (tags: string[]) =>
      withSinglePeriodTag(
        withSingleDateTag(
          withSingleQuadrant(
            withSingleFromValues(withSingleRating(tags), workflowValues)
          )
        )
      ),
    [workflowValues]
  );

  // Keyboard focus must also SCROLL: `<Row>` focuses with
  // `{ preventScroll: true }` and react-window only mounts visible rows, so
  // arrowing past the viewport left focus on an unmounted index — no visible
  // caret and no scrolling. These refs drive the imperative scrolls below.
  const listRef = useRef<ListImperativeAPI | null>(null);
  const gridRef = useRef<GridImperativeAPI | null>(null);

  // NOTE: an earlier version bumped a `mapiqueVersion` counter on every
  // `geoByName` change and used it as `<MapiqueView key=...>` to force a full
  // remount. That rebuilt the Leaflet map (tiles reload, view reset) on every
  // add/remove-tag — a jarring "page refresh". The `key` prop and the counter
  // are gone; MapiqueView renders from props and drops a stale `activeEntry`
  // when the entry leaves `entries` (P2-5: it does NOT bump its own render).
  // Thumbnail data-URL cache (path|mtime -> url). Survives row unmount during
  // scroll so re-mounts don't re-read from disk; cleared on directory change
  // and bounded at the write site (`THUMB_CACHE_LIMIT` in ThumbIcon) so a long
  // photo scroll can't retain every image for the session.
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
  // The shape lives with the snackbar in ./file-list/FileListNotice.
  const [notice, setNotice] = useState<FileListNotice | null>(null);
  // Reporter for success/warning/info + every error path (`showNotice(msg)`
  // defaults to error). `setNotice` itself stays for the close handlers.
  const showNotice = useCallback(
    (
      text: string,
      severity: 'success' | 'info' | 'warning' | 'error' = 'error',
      opts?: { openTrash?: boolean; backupPath?: string }
    ) => setNotice({ text, severity, ...opts }),
    []
  );
  const handleRecoverSidecar = useCallback(
    async (issue: CorruptSidecarIssue) => {
      try {
        const result = await ipcApi.recoverCorruptSidecar({
          dirPath: issue.dirPath,
          expectedSha256: issue.sha256,
        });
        if (result.status === 'recovered') {
          showNotice(t('sidecarRecovered'), 'success', {
            backupPath: result.backupPath,
          });
        } else if (result.status === 'conflict') {
          showNotice(t('sidecarRecoverConflict'), 'warning');
        } else {
          showNotice(t('sidecarRecoverNotCorrupt'), 'info');
        }
        // Success, conflict, and not-corrupt all re-read the authoritative state.
        await refresh();
      } catch (e) {
        // Do not clear or refresh away the persistent warning on a failed write.
        const detail = e instanceof Error ? e.message : String(e);
        showNotice(`${t('sidecarRecoverFailed')} ${detail}`, 'error');
      }
    },
    [refresh, showNotice, t]
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

  // Allow other UI (the directory tree) to request the lightbox without a ref
  // into FileList: it dispatches a `whale:open-lightbox` CustomEvent whose
  // detail is the DirEntry to show (images only — see openEntryInTab).
  useEffect(() => {
    const handler = (e: Event) => {
      const entry = (e as CustomEvent<DirEntry>).detail;
      if (entry && !entry.isDirectory) setLightboxEntry(entry);
    };
    window.addEventListener('whale:open-lightbox', handler);
    return () => window.removeEventListener('whale:open-lightbox', handler);
  }, []);

  // Only the `date:` / `smart:*` fold filters classify tag freshness against
  // wall-clock — gate the memo's `now` dependency on them so the per-minute
  // `useNow` tick doesn't recompute (and re-render all visible rows) for
  // plain tag / `geo:` / `period:` filters (docs/01 §12).
  const freshnessFilter = activeTag === 'date:' || (activeTag?.startsWith('smart:') ?? false);
  const nowTick = freshnessFilter ? now : FROZEN_NOW;

  const visible = useMemo(
    () => filterEntriesByTag(entries, tagsByName, activeTag, nowTick),
    [entries, activeTag, tagsByName, nowTick]
  );

  // Selection + keyboard focus (P0-3 / H.23 P1-1) live in
  // ./file-list/useFileListSelection: the Set is mutated in place, a tick
  // counter drives the memos, and `ensureTrayVisible` keeps selectRow's
  // identity-churn timing identical to the previous inline implementation.
  const ensureTrayVisible = useCallback(() => {
    if (!trayVisible) dispatch(setTrayVisible(true));
  }, [trayVisible, dispatch]);
  const {
    selectedPathsRef,
    bumpSelection,
    setSelected,
    isSelected,
    selectedEntries,
    selectAllState,
    toggleSelectAll,
    clearSelection,
    selectRow,
    focusIndex,
    setFocusIndex,
  } = useFileListSelection({ visible, currentDirectoryPath, ensureTrayVisible });

  // Keep both playlist identities stable across unrelated FileList renders.
  // MediaLightbox also memoizes its filtered playlist, so this completes the
  // chain instead of rebuilding `mediaPlaylist(visible)` in the JSX body.
  const lightboxPlaylist = useMemo(() => mediaPlaylist(visible), [visible]);
  const lightboxFallbackPlaylist = useMemo(
    () => (lightboxEntry ? [lightboxEntry] : []),
    [lightboxEntry]
  );

  // Mirror the selection into FileSelectionContext so sibling surfaces
  // can read the current selection without reaching into FileList's internals.
  const { setSelectedEntries: setSelectedEntriesCtx } =
    useFileSelectionContext();
  useEffect(() => {
    setSelectedEntriesCtx(selectedEntries);
  }, [selectedEntries, setSelectedEntriesCtx]);

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

  // P2-8: same one-shot table for the *index* of a path. `onSelectRow` takes a
  // linear index; the calendar / kanban cards used to recover it with
  // `entries.findIndex(...)` on every click and every Space keypress (O(N) per
  // interaction on large listings). Built with the same pass as `visibleByPath`.
  const indexByPath = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < visible.length; i += 1) map.set(visible[i].path, i);
    return map;
  }, [visible]);
  const entryIndex = useCallback(
    (path: string) => indexByPath.get(path) ?? -1,
    [indexByPath]
  );

  const trayAppliesToView = (mode: ViewMode) =>
    mode === 'list' || mode === 'grid' || mode === 'gallery';

  const handleSelectForGallery = useCallback(
    (entry: DirEntry, mods: { shift: boolean; toggle: boolean }) => {
      // P1-1: index is resolved by path (mirrors how list/grid Rows already
      // pass their own index); the same `selectRow` that powers Row clicks
      // now also powers GalleryView tile clicks, so Shift range / Ctrl
      // toggle behave identically across perspectives. `entryIndex` is the
      // O(1) path → index map built next to `visibleByPath` above.
      const index = entryIndex(entry.path);
      if (index >= 0) selectRow(index, mods);
    },
    [entryIndex, selectRow]
  );

  const { openWithExtension, registry, userDefaults, enabledOverrides } =
    useExtensionContext();
  const newExcalidraw = useNewExcalidraw();
  const newDrawio = useNewDrawio();

  // P0-1d wire-up: deps bag for `useListCommands`, assembled by
  // ./file-list/useCommandsDeps. `useStableBag` compares the bag's own fields,
  // so no hand-maintained dependency array can drift; a missing required field
  // is a type error, and unchanged fields keep `commands` reference-stable.
  const commandsDeps = useCommandsDeps({
    io: {
      moveEntry,
      deleteEntry,
      createFolder,
      createFile,
      createTaggedEntry,
    },
    tagMeta: { save, saveMany, tagsByName, descByName, normalize },
    selection: {
      selectedEntries,
      setSelected,
      clearSelection,
      selectedPathsRef,
      bumpSelection,
    },
    ui: {
      showNotice,
      setPackageOpen,
      setCreateKind,
      setCreateWithTag,
      createWithTag,
    },
    location: {
      currentLocation,
      currentDirectoryPath,
      deleteToTrash,
      refresh,
      refreshTree,
    },
    factories: { newExcalidraw, newDrawio },
  });
  const commands = useListCommands(commandsDeps);

  // Images open in MediaLightbox for the zoom / pan / filmstrip single-image
  // preview; everything else dispatches through the extension registry and
  // falls back to the OS default app when no extension claims the type.
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
    showNotice,
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
    [renameEntry, showNotice]
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

  const handleCreateConfirm = (name: string) => {
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
  };

  // OS-file drag-and-drop lives in ./file-list/useExternalFileDrop: the
  // native FILE drop target plus the copy-into-current-directory fallback
  // (task view stamps a today-period tag so the import reaches the Gantt
  // timeline). The hook's useDrop deps match the pre-extraction array.
  const { isFileOver, nativeDropRef } = useExternalFileDrop({
    viewMode,
    currentDirectoryPath,
    readOnly: !!currentLocation?.isReadOnly,
    importExternalFiles,
    showNotice,
    t,
  });

  // Tag / geo / date sidecar writes live in
  // ./file-list/useFileListTagActions: read-only gate + failure surfacing per
  // handler, with the dependency arrays of the pre-extraction inline callbacks
  // (so cellData's reference stability is unchanged).
  const tagActions = useFileListTagActions({
    currentLocation,
    tagsByName,
    descByName,
    normalize,
    save,
    saveMany,
    showNotice,
    now,
  });
  const {
    handleMoveToColumn,
    handleGpsFound,
    handleSetGeo,
    handleClearGeo,
    handleAddTag,
    handleRemoveTag,
  } = tagActions;

  // H.23 keyboard navigation lives in ./file-list/keyboard.ts: one attachment
  // point (the outer container's `onKeyDown`), input-like targets skipped, and
  // keys resolved through the user-configurable bindings map. Shift-range stays
  // inside the navigate cases; Delete runs before the empty-list guard.
  const handleKeyDown = createKeyDownHandler({
    keybindings,
    visible,
    focusIndex,
    setFocusIndex,
    selectRow,
    clearSelection,
    selectedPathsRef,
    onOpen: handleOpen,
    onStartInlineRename: startInlineRename,
    onDeleteSelected: commands.handleDeleteSelected,
    showNotice,
    noRowToRename: t('noRowToRename'),
    canGoBack,
    goBack,
    viewMode,
    setViewMode,
    // While the lightbox is open it owns the keyboard (see isWithinDialog).
    modalOpen: lightboxEntry !== null,
  });

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
    [activeTag, setActiveTag]
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
  // P0-1d the IO-bound handlers come from `commands`; P2-10 replaces the
  // 39-entry hand-maintained `useMemo` dependency array with `useStableBag`,
  // which compares the bag's own fields (every value below is reference-stable)
  // so react-window v2's per-row shallow compare short-circuits to "no change"
  // while no real input changed — and a new field can never be forgotten.
  const handleMoreFileActions = useCallback(
    (entry: DirEntry, x: number, y: number) => onContextEntry(entry, x, y),
    [onContextEntry]
  );
  // P0-2 / P0-4: the shared cell bag is assembled by
  // ./file-list/useFileListCellData. Every value is reference-stable, so
  // react-window v2's per-row shallow memo short-circuits unrelated parent
  // renders; `selectedPaths` stays the live, mutated-in-place Set.
  const cellData = useFileListCellData({
    visible,
    thumbCache: thumbCache.current,
    tagsByName,
    descByName,
    activeTag,
    tagColors,
    groups,
    readOnly: !!currentLocation?.isReadOnly,
    t,
    onOpen: handleOpen,
    selection: {
      isSelected,
      onSelectRow: selectRow,
      selectedPaths: selectedPathsRef.current,
    },
    commands,
    tagActions,
    cellActions: {
      onClickTag,
      onTagContextMenu,
      onContextEntry,
      onCreateTagged,
      onMoreFileActions: handleMoreFileActions,
    },
    setters: { onCopy: setCopyTarget, onRename: setRenameTarget },
    lookups: { resolveEntry, entryIndex },
    layout: {
      columnWidths,
      hiddenColumns,
      listZebra,
      listDateFormat,
      focusIndex,
    },
    inlineRename: {
      inlineRenameEntry,
      startInlineRename,
      cancelInlineRename,
      commitInlineRename,
    },
  });

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
  const handleGridResize = useCallback(
    (width: number) => setGridWidth((prev) => (prev === width ? prev : width)),
    []
  );

  // Keep the keyboard-focused row/cell inside the viewport. `Row` focuses with
  // `preventScroll: true` (it must not yank the page while clicking), and
  // react-window unmounts off-screen rows — so without this the caret could
  // walk past the last visible row and disappear.
  useEffect(() => {
    if (focusIndex === null) return;
    if (viewMode === 'grid') {
      gridRef.current?.scrollToCell({
        rowIndex: Math.floor(focusIndex / gridColumns),
        columnIndex: focusIndex % gridColumns,
        rowAlign: 'smart',
        columnAlign: 'smart',
        behavior: 'auto',
      });
      return;
    }
    if (viewMode === 'list') {
      listRef.current?.scrollToRow({
        index: focusIndex,
        align: 'smart',
        behavior: 'auto',
      });
    }
  }, [focusIndex, viewMode, gridColumns]);

  return (
    <Box
      ref={(node: HTMLDivElement | null) => {
        nativeDropRef(node);
        containerRef.current = node;
      }}
      data-testid="file-list"
      tabIndex={-1}
      onMouseDown={() => containerRef.current?.focus()}
      onKeyDown={handleKeyDown}
      onContextMenu={(e) => {
        e.preventDefault();
        setCtxMenu({ x: e.clientX, y: e.clientY, entry: null });
      }}
      sx={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        isolation: 'isolate',
        outline: 'none',
      }}
    >
      <FolderBackground url={backgroundUrl} />
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
      <SidecarIssuesAlert
        issues={sidecarIssues}
        readOnly={!!currentLocation?.isReadOnly}
        onNavigate={navigateTo}
        onRecover={handleRecoverSidecar}
      />
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
        // Bulk commands consume selectedEntries, so the primary count must
        // describe that same visible set. Selections hidden by the active
        // filter remain intact but are called out separately, never silently
        // included in delete/move/package operations.
        selectedCount={selectedEntries.length}
        hiddenSelectedCount={Math.max(
          0,
          selectedPathsRef.current.size - selectedEntries.length
        )}
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
        columnLabels={columnLabels}
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
                // P2-2: reuse the stable handlers + captions instead of inline
                // closures/literals; `RowColumnLabels` is memoized, so fresh
                // identities here would re-render the whole header strip on
                // every selection tick.
                setColumnWidth={handleColumnWidth}
                toggleColumn={handleToggleColumn}
                labels={columnLabels}
              />
            ) : null}
            <FileListView
              viewMode={viewMode}
              data={cellData}
              selectedPaths={selectedPathsRef.current}
              entrySize={entrySize}
              rowHeight={rowHeight}
              gridRowHeight={gridRowHeight}
              gridColumns={gridColumns}
              gridColumnWidth={gridColumnWidth}
              onGridResize={handleGridResize}
              listRef={listRef}
              gridRef={gridRef}
              stages={workflowStages}
              onMoveToColumn={handleMoveToColumn}
              onSelectGallery={handleSelectForGallery}
              onDeleteSelected={commands.handleDeleteSelected}
              geoByName={geoByName}
              mapProvider={mapProvider}
              mapTileUrl={mapTileUrl}
              loading={loading}
              galleryShowTags={galleryShowTags}
              onGpsFound={handleGpsFound}
              onSetGeo={handleSetGeo}
              onClearGeo={handleClearGeo}
              onAddTag={handleAddTag}
              onRemoveTag={handleRemoveTag}
            />

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

      <FileListDialogs
        t={t}
        renameTarget={renameTarget}
        copyTarget={copyTarget}
        createKind={createKind}
        createWithTag={createWithTag}
        packageOpen={packageOpen}
        packageDefaultName={basename(currentDirectoryPath) || 'archive'}
        onRenameConfirm={handleRenameConfirm}
        onRenameClose={() => setRenameTarget(null)}
        onCopyConfirm={handleCopyConfirm}
        onCopyClose={() => setCopyTarget(null)}
        onCreateConfirm={handleCreateConfirm}
        onCreateClose={() => setCreateKind(null)}
        onCreateWithTagConfirm={commands.handleCreateTagged}
        onCreateWithTagClose={() => setCreateWithTag(null)}
        onPackageConfirm={commands.handlePackageConfirm}
        onPackageClose={() => setPackageOpen(false)}
      />

      <FileListNoticeSnackbar
        notice={notice}
        onClose={() => setNotice(null)}
        showNotice={showNotice}
        t={t}
      />

      <FileListEntryContextMenu
        ctx={ctxMenu}
        onClose={() => setCtxMenu(null)}
        selectedEntries={selectedEntries}
        selectedPathsRef={selectedPathsRef}
        tagsByName={tagsByName}
        thumbCache={thumbCache}
        showNotice={showNotice}
        setCreateKind={setCreateKind}
        setPackageOpen={setPackageOpen}
        setCopyTarget={setCopyTarget}
        setRenameTarget={setRenameTarget}
        refresh={refresh}
        visible={visible}
        commands={commands}
        handleOpen={handleOpen}
        setViewMode={setViewMode}
        onAddTag={handleAddTag}
        onRemoveTag={handleRemoveTag}
        onFolderBackgroundChange={reloadFolderBackground}
        userCommands={userCommands}
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
        showError={(msg) => showNotice(msg)}
      />
      {/* Full-screen media lightbox for double-clicking media in list/grid. */}
      <FileListLightbox
        entry={lightboxEntry}
        playlist={lightboxPlaylist}
        fallbackPlaylist={lightboxFallbackPlaylist}
        thumbCache={thumbCache.current}
        onClose={() => setLightboxEntry(null)}
      />
    </Box>
  );
}
