import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useSelector } from 'react-redux';

import type { DirEntry } from '../../shared/ipc-types';
import {
  META_DIR,
  isHiddenName,
  migrateViewMode,
  type ViewMode,
} from '../../shared/whale-meta';
import type { SidecarMeta } from '../../shared/whale-meta';
import { extractTags } from '-/services/tags';
import { geoPointFromTags } from '../../shared/geo-tag';
import { MAX_RECURSIVE_ENTRIES } from '../../shared/recursive-entries';
import type { RootState } from '-/reducers';
import { ipcApi } from '-/services/ipc-api';
import { useCurrentLocationContext } from './CurrentLocationContextProvider';

export type SortKey = 'name' | 'size' | 'modified' | 'extension';
export type SortDir = 'asc' | 'desc';
export interface SortState {
  key: SortKey;
  dir: SortDir;
}

export interface DirectoryContentContextValue {
  /** Sorted, display-ready file entries for the current directory (or recursive scan). */
  entries: DirEntry[];
  /** Directory entries for the current directory (or recursive scan). R3: split from
   *  `entries` so depth>1 flat views don't show subdirectory rows. */
  dirs: DirEntry[];
  loading: boolean;
  error: string | null;
  sort: SortState;
  setSort: (sort: SortState) => void;
  refresh: () => Promise<void>;
  /** Effective view for the current folder (its wsm.json override ?? global default). */
  viewMode: ViewMode;
  /** Effective grid cell edge (px) for the current folder (override ?? global default). */
  entrySize: number;
  /** Persist this folder's view to its `.whale/wsm.json` and apply immediately. */
  setViewMode: (mode: ViewMode) => void;
  /** Persist this folder's grid cell size (debounced) and apply immediately. */
  setEntrySize: (px: number) => void;
  // H.24 R1/R2/R3: path-keyed projections so the same name in two subdirs
  // (depth > 1) keeps its own tags / description / GPS without clobbering.
  tagsByName: Map<string, string[]>;
  descByName: Map<string, string>;
  geoByName: Map<string, { lat: number; lng: number } | null>;
  /** True when the last recursive scan was truncated by `MAX_RECURSIVE_ENTRIES`. */
  recursiveTruncated: boolean;
}

// Exported for component tests (CalendarView.test.tsx) to stub without standing
// up the real provider (which depends on Redux + ipcApi). Production uses the hook.
export const DirectoryContentContext =
  createContext<DirectoryContentContextValue | null>(null);

const EMPTY_MAPS = {
  tagsByName: new Map<string, string[]>(),
  descByName: new Map<string, string>(),
  geoByName: new Map<string, { lat: number; lng: number } | null>(),
};

export function useDirectoryContentContext(): DirectoryContentContextValue {
  const ctx = useContext(DirectoryContentContext);
  if (!ctx) {
    throw new Error(
      'useDirectoryContentContext must be used within DirectoryContentContextProvider'
    );
  }
  return ctx;
}

/** Folders always group before files, then sort by the active key/direction. */
function compareEntries(a: DirEntry, b: DirEntry, sort: SortState): number {
  if (a.isDirectory !== b.isDirectory) {
    return a.isDirectory ? -1 : 1;
  }
  let cmp = 0;
  switch (sort.key) {
    case 'size':
      cmp = a.size - b.size;
      break;
    case 'modified':
      cmp = a.modified.localeCompare(b.modified);
      break;
    case 'extension':
      cmp = a.extension.localeCompare(b.extension);
      break;
    case 'name':
    default:
      cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  }
  return sort.dir === 'asc' ? cmp : -cmp;
}

export function DirectoryContentContextProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { currentDirectoryPath } = useCurrentLocationContext();
  const defaultViewMode = useSelector(
    (s: RootState) => s.settings?.defaultViewMode ?? 'list'
  );
  const defaultEntrySize = useSelector(
    (s: RootState) => s.settings?.defaultEntrySize ?? 160
  );
  const showHiddenFiles = useSelector(
    (s: RootState) => s.settings?.showHiddenFiles ?? false
  );
  // H.24: viewDepth controls the recursion depth for entry collection.
  // `1` = current dir only (today's default, zero behavior change).
  // `2..5` = listDirectoryRecursive with that maxDepth. The value is clamped
  // at the reducer (settings.ts `clampViewDepth`) and debounced below so
  // dragging the slider fires one scan, not five.
  const viewDepth = useSelector(
    (s: RootState) => s.settings?.viewDepth ?? 1
  );
  // H.24 G1: debounce the depth so dragging the global slider 1→5 fires one
  // recursive scan instead of five. The slider stays responsive (it reads
  // `viewDepth` from settings directly); only the expensive `load()` is held
  // back until the value settles for 200ms. `debouncedDepth` is what `load`
  // and its triggering effect actually depend on.
  const [debouncedDepth, setDebouncedDepth] = useState(viewDepth);
  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedDepth(viewDepth), 200);
    return () => window.clearTimeout(handle);
  }, [viewDepth]);

  const [rawFiles, setRawFiles] = useState<DirEntry[]>([]);
  const [rawDirs, setRawDirs] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' });
  // H.24 R1/R2: sidecarsByPath is the single source of truth keyed by
  // FULL path. Both the depth=1 fast path (`ipcApi.readSidecards`) and
  // the depth>1 path (`ipcApi.readSidecardsForPaths`) feed into this.
  const [sidecarsByPath, setSidecarsByPath] = useState<
    ReadonlyMap<string, SidecarMeta | undefined>
  >(new Map());
  const [recursiveTruncated, setRecursiveTruncated] = useState(false);
  // Per-folder view overrides from `.whale/wsm.json`; undefined → use the global
  // default. Reloaded on every directory change.
  const [folderView, setFolderView] = useState<ViewMode | undefined>(undefined);
  const [folderEntrySize, setFolderEntrySize] = useState<number | undefined>(
    undefined
  );

  const load = useCallback(
    async (dirPath: string) => {
      if (!dirPath) {
        setRawFiles([]);
        setRawDirs([]);
        setSidecarsByPath(new Map());
        setRecursiveTruncated(false);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        if (debouncedDepth <= 1) {
          // Fast path: current dir only. Same behavior as before H.24.
          const list = await ipcApi.listDirectory(dirPath);
          const visible = list.filter(
            (e) =>
              showHiddenFiles || (!isHiddenName(e.name) && e.name !== META_DIR)
          );
          setRawFiles(visible.filter((e) => !e.isDirectory));
          setRawDirs(visible.filter((e) => e.isDirectory));
          setRecursiveTruncated(false);

          // Read sidecars via the existing per-dir IPC. Result is keyed by
          // basename; remap to full path so consumers can `get(entry.path)`.
          const names = visible.map((e) => e.name);
          let sidecarMap: Record<string, SidecarMeta> = {};
          try {
            sidecarMap = await ipcApi.readSidecars(dirPath, names);
          } catch {
            // Best-effort: missing/unreadable wsd.json → empty sidecar map.
          }
          const byPath = new Map<string, SidecarMeta | undefined>();
          for (const e of visible) {
            const meta = sidecarMap[e.name];
            if (meta) byPath.set(e.path, meta);
          }
          setSidecarsByPath(byPath);
        } else {
          // Recursive scan. The IPC returns files AND directories in
          // scan order; we split by isDirectory for the R3 separation.
          let scan: DirEntry[] = [];
          try {
            scan = await ipcApi.listDirectoryRecursive(dirPath, {
              maxDepth: debouncedDepth,
            });
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setRawFiles([]);
            setRawDirs([]);
            setSidecarsByPath(new Map());
            setRecursiveTruncated(false);
            return;
          }
          setRecursiveTruncated(scan.length >= MAX_RECURSIVE_ENTRIES);
          const files = scan.filter(
            (e) =>
              !e.isDirectory &&
              (showHiddenFiles ||
                (!isHiddenName(e.name) && e.name !== META_DIR))
          );
          const dirs = scan.filter(
            (e) =>
              e.isDirectory &&
              (showHiddenFiles ||
                (!isHiddenName(e.name) && e.name !== META_DIR))
          );
          setRawFiles(files);
          setRawDirs(dirs);

          // Batch read sidecars for ALL entries in one IPC. Result is
          // already keyed by full path (R1 / PR2), so no remapping needed.
          const allPaths = scan.map((e) => e.path);
          const byPath = new Map<string, SidecarMeta | undefined>();
          try {
            const map = await ipcApi.readSidecardsForPaths(allPaths);
            // Filter to existing definitions only (skip undefined).
            for (const [k, v] of Object.entries(map)) {
              if (v) byPath.set(k, v);
            }
          } catch {
            // Best-effort: empty sidecar map.
          }
          setSidecarsByPath(byPath);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setRawFiles([]);
        setRawDirs([]);
        setSidecarsByPath(new Map());
        setRecursiveTruncated(false);
      } finally {
        setLoading(false);
      }
    },
    [debouncedDepth, showHiddenFiles]
  );

  // Reload whenever the current directory or depth changes.
  useEffect(() => {
    void load(currentDirectoryPath);
  }, [currentDirectoryPath, debouncedDepth, load]);

  // Load this folder's view overrides (perspective / entrySize) from wsm.json.
  // Reset to "no override" first so a slow read can't leak the previous folder's
  // view onto this one.
  useEffect(() => {
    setFolderView(undefined);
    setFolderEntrySize(undefined);
    if (!currentDirectoryPath) return;
    let cancelled = false;
    void (async () => {
      try {
        const meta = await ipcApi.readFolderMeta(currentDirectoryPath);
        if (cancelled) return;
        // Forward-migrate the perspective literal in case the folder's
        // `.whale/wsm.json` still carries the pre-H.19 `'mindmap'` value.
        setFolderView(migrateViewMode(meta.perspective));
        setFolderEntrySize(meta.entrySize);
      } catch {
        // Missing/unreadable wsm.json → keep defaults (best-effort).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentDirectoryPath]);

  const viewMode: ViewMode = folderView ?? defaultViewMode;
  const entrySize = folderEntrySize ?? defaultEntrySize;

  const setViewMode = useCallback(
    (mode: ViewMode) => {
      setFolderView(mode); // optimistic, instant switch
      if (!currentDirectoryPath) return;
      void ipcApi
        .writeFolderMeta(currentDirectoryPath, { perspective: mode })
        .catch(() => undefined); // view pref is non-critical; ignore write failure
    },
    [currentDirectoryPath]
  );

  // Debounce the entrySize write: dragging the zoom fires many steps, but only
  // the settled value needs to hit disk. The UI updates instantly regardless.
  const entrySizeWriteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setEntrySize = useCallback(
    (px: number) => {
      setFolderEntrySize(px);
      if (!currentDirectoryPath) return;
      if (entrySizeWriteTimer.current) clearTimeout(entrySizeWriteTimer.current);
      entrySizeWriteTimer.current = setTimeout(() => {
        void ipcApi
          .writeFolderMeta(currentDirectoryPath, { entrySize: px })
          .catch(() => undefined);
      }, 400);
    },
    [currentDirectoryPath]
  );

  const refresh = useCallback(
    () => load(currentDirectoryPath),
    [currentDirectoryPath, load]
  );

  // H.24 R3: the list shows BOTH files and directories at any depth. `dirs`
  // is also exposed separately so FolderViz can rebuild its tree from the
  // recursive scan; the other 8 views just render `entries` like before.
  const entries = useMemo(
    () =>
      [...rawFiles, ...rawDirs].sort((a, b) => compareEntries(a, b, sort)),
    [rawFiles, rawDirs, sort]
  );

  const dirs = useMemo(
    () => [...rawDirs].sort((a, b) => compareEntries(a, b, sort)),
    [rawDirs, sort]
  );

  // H.24 R1/R2: build path-keyed tag/desc/geo projections from sidecarsByPath.
  // Filename-embedded tags are merged in too (same logic as the old
  // TagMetaContext, but keyed by path).
  const tagsByName = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const e of entries) {
      const fileTags = extractTags(e.name);
      const sideTags = sidecarsByPath.get(e.path)?.tags ?? [];
      const merged = [...new Set([...fileTags, ...sideTags])];
      if (merged.length > 0) map.set(e.path, merged);
    }
    return map;
  }, [entries, sidecarsByPath]);

  const descByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of entries) {
      const desc = sidecarsByPath.get(e.path)?.description;
      if (desc) map.set(e.path, desc);
    }
    return map;
  }, [entries, sidecarsByPath]);

  const geoByName = useMemo(() => {
    const map = new Map<string, { lat: number; lng: number } | null>();
    for (const e of entries) {
      const tags = sidecarsByPath.get(e.path)?.tags;
      map.set(e.path, tags ? geoPointFromTags(tags) : null);
    }
    return map;
  }, [entries, sidecarsByPath]);

  const value = useMemo(
    () => ({
      entries,
      dirs,
      loading,
      error,
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
      recursiveTruncated,
    }),
    [
      entries,
      dirs,
      loading,
      error,
      sort,
      refresh,
      viewMode,
      entrySize,
      setViewMode,
      setEntrySize,
      tagsByName,
      descByName,
      geoByName,
      recursiveTruncated,
    ]
  );

  return (
    <DirectoryContentContext.Provider value={value}>
      {children}
    </DirectoryContentContext.Provider>
  );
}

// Re-export the constant for tests / external callers; not part of the
// public context value shape.
export { MAX_RECURSIVE_ENTRIES } from '../../shared/recursive-entries';
// Re-export EMPTY_MAPS so legacy callers (e.g. TagMetaContext during the
// cut-over window) can fall back to the same shape without a new allocation.
export { EMPTY_MAPS };
