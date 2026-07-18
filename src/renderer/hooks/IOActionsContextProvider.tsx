import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useSelector } from 'react-redux';

import { ipcApi } from '-/services/ipc-api';
import { joinPath, basename, parentDir } from '-/services/path-util';
import { normalizeSmartTags } from '../../shared/smart-tags';
import { RootState } from '-/reducers';
import { useCurrentLocationContext } from './CurrentLocationContextProvider';
import { useDirectoryContentContext } from './DirectoryContentContextProvider';
import { useDirectoryTreeRefresh } from './DirectoryTreeRefreshContextProvider';

/**
 * File operations scoped to the current directory. Every mutation runs, then
 * refreshes the listing. Failures REJECT up to the caller so it can surface an
 * error — we never optimistically update the UI on a failed IO (file-manager
 * mindset: the listing must reflect real disk state).
 *
 * Must sit BELOW both CurrentLocationContextProvider and
 * DirectoryContentContextProvider in the tree.
 */
export interface IOActionsContextValue {
  renameEntry: (oldPath: string, newName: string) => Promise<void>;
  moveEntry: (oldPath: string, destDirPath: string) => Promise<void>;
  copyEntry: (sourcePath: string, newName: string) => Promise<void>;
  deleteEntry: (targetPath: string) => Promise<void>;
  createFolder: (name: string, parentDir?: string) => Promise<void>;
  createFile: (name: string, content?: string, parentDir?: string) => Promise<void>;
  createTaggedEntry: (
    kind: 'file' | 'folder',
    name: string,
    tag: string
  ) => Promise<void>;
  /**
   * Import OS files (dropped in from the file manager) into the current
   * directory and optionally stamp them with a tag. Returns the imported
   * paths in the order they were created (de-duped against any `ipcApi`
   * rename-on-clash renames).
   *
   * Used by Kanban / Matrix / Gantt drop targets so an external drop on a
   * specific column / quadrant applies THAT column's tag (the bug we just
   * fixed: native drops used to bubble up to FileList's generic
   * `nativeDropRef`, which lost the column context and fell back to a
   * today-period tag). FileList itself calls this too for drops on empty
   * areas (no column under the cursor) — pass `null` for the tag in that
   * case.
   */
  importExternalFiles: (
    files: File[],
    options?: { tagToApply?: string | null }
  ) => Promise<{ importedPaths: string[]; copied: number; errors: string[] }>;
  openNative: (targetPath: string) => Promise<void>;
}

const IOActionsContext = createContext<IOActionsContextValue | null>(null);

export function useIOActionsContext(): IOActionsContextValue {
  const ctx = useContext(IOActionsContext);
  if (!ctx) {
    throw new Error(
      'useIOActionsContext must be used within IOActionsContextProvider'
    );
  }
  return ctx;
}

/**
 * Pure helper for the native-file-import + optional-tag-stamp pipeline.
 * Extracted from the `importExternalFiles` useCallback above so unit
 * tests can exercise the algorithm without standing up the React provider
 * tree (and the act()/cleanup() inter-test quirks that brings in jsdom).
 *
 * Contract:
 *   - `tagToApply === null` (or undefined) means: import only, do NOT
 *     stamp any tag (Triage semantics).
 *   - `tagToApply` is a non-empty string means: stamp that tag verbatim
 *     on every imported path. Best-effort — a sidecar-write failure is
 *     swallowed so a successful import isn't rolled back.
 *   - `sidecarWriter` and `importer` are injected so tests can swap in
 *     pure spies.
 *   - `onSuccess` runs after the tag loop, so the caller can refresh the
 *     directory listing (kept outside this helper so the helper stays
 *     synchronous-flow without React context).
 */
export interface ImportExternalCoreDeps {
  sources: string[];
  destDir: string;
  /** When omitted/null/empty: import only, no tag stamping (Triage). */
  tagToApply?: string | null;
  importer: (
    sources: string[],
    destDir: string
  ) => Promise<{ copied: number; errors: string[]; importedPaths: string[] }>;
  sidecarWriter: (filePath: string, tags: string[]) => Promise<void>;
  onSuccess?: () => void;
}

export async function importExternalCore(
  deps: ImportExternalCoreDeps
): Promise<{ importedPaths: string[]; copied: number; errors: string[] }> {
  const result = await deps.importer(deps.sources, deps.destDir);
  if (deps.tagToApply) {
    const normalized = normalizeSmartTags([deps.tagToApply]);
    for (const p of result.importedPaths ?? []) {
      // Best-effort: a sidecar-write failure must not undo the
      // successful import. The imported files stay; the tag simply
      // doesn't get stamped on the broken one. The caller can re-apply
      // tags later via the sidecar command.
      try {
        await deps.sidecarWriter(p, normalized);
      } catch {
        // swallowed — see comment above
      }
    }
  }
  deps.onSuccess?.();
  return result;
}

export function IOActionsContextProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { currentDirectoryPath, currentLocation } = useCurrentLocationContext();
  const { refresh } = useDirectoryContentContext();
  const { refreshTree } = useDirectoryTreeRefresh();
  const { t } = useTranslation();
  const deleteToTrash = useSelector(
    (s: RootState) => s.settings?.deleteToTrash ?? true
  );

  const runAndRefresh = useCallback(
    async (op: () => Promise<void>) => {
      // Read-only locations short-circuit every write — never a silent no-op.
      if (currentLocation?.isReadOnly) {
        throw new Error(t('readOnlyLocation'));
      }
      await op(); // rejects on failure -> caller shows error, no optimistic update
      await refresh();
    },
    [refresh, currentLocation, t]
  );

  const renameEntry = useCallback(
    (oldPath: string, newName: string) =>
      runAndRefresh(async () => {
        await ipcApi.rename(oldPath, joinPath(currentDirectoryPath, newName));
        refreshTree(currentDirectoryPath);
      }),
    [currentDirectoryPath, runAndRefresh, refreshTree]
  );

  const moveEntry = useCallback(
    (oldPath: string, destDirPath: string) =>
      runAndRefresh(async () => {
        await ipcApi.move(oldPath, joinPath(destDirPath, basename(oldPath)));
        refreshTree(parentDir(oldPath));
        refreshTree(destDirPath);
      }),
    [runAndRefresh, refreshTree]
  );

  const copyEntry = useCallback(
    (sourcePath: string, newName: string) =>
      runAndRefresh(async () => {
        await ipcApi.copy(sourcePath, joinPath(currentDirectoryPath, newName));
        refreshTree(currentDirectoryPath);
      }),
    [currentDirectoryPath, runAndRefresh, refreshTree]
  );

  const deleteEntry = useCallback(
    (targetPath: string) =>
      runAndRefresh(async () => {
        try {
          await ipcApi.deletePath(targetPath, deleteToTrash);
        } catch (e) {
          // shell.trashItem fails on UNC/network shares (Windows has no local
          // Recycle Bin for them) and other trash-unsupported locations. The
          // main process intentionally re-throws instead of silently escalating
          // to a permanent delete — but the user asked for recoverable removal
          // and it isn't available here, so offer a permanent delete with an
          // explicit confirm (still user-consented, never silent).
          if (!deleteToTrash) throw e;
          if (
            !window.confirm(
              t('confirmDeleteTrashFailed', { name: basename(targetPath) })
            )
          ) {
            throw e;
          }
          await ipcApi.deletePath(targetPath, false);
        }
        refreshTree(parentDir(targetPath));
      }),
    [runAndRefresh, deleteToTrash, refreshTree, t]
  );

  const createFolder = useCallback(
    (name: string, parentDir?: string) =>
      runAndRefresh(async () => {
        const parent = parentDir ?? currentDirectoryPath;
        await ipcApi.createDirectory(joinPath(parent, name));
        refreshTree(parent);
      }),
    [currentDirectoryPath, runAndRefresh, refreshTree]
  );

  const createFile = useCallback(
    (name: string, content = '', parentDir?: string) =>
      runAndRefresh(() =>
        ipcApi.createTextFile(
          joinPath(parentDir ?? currentDirectoryPath, name),
          content
        )
      ),
    [currentDirectoryPath, runAndRefresh]
  );

  const createTaggedEntry = useCallback(
    (kind: 'file' | 'folder', name: string, tag: string) =>
      runAndRefresh(async () => {
        const targetPath = joinPath(currentDirectoryPath, name);
        if (kind === 'folder') {
          await ipcApi.createDirectory(targetPath);
          refreshTree(currentDirectoryPath);
        } else {
          await ipcApi.createTextFile(targetPath, '');
        }
        await ipcApi.writeSidecar(targetPath, {
          tags: normalizeSmartTags([tag]),
        });
      }),
    [currentDirectoryPath, runAndRefresh, refreshTree]
  );

  // Native (OS file manager) → Whale directory import. The single entry
  // point used by:
  //   1. FileList's `nativeDropRef` for drops on empty view areas.
  //   2. KanbanView / MatrixView / GanttView per-column drop targets, where
  //      `tagToApply` is the column / quadrant / triage tag and the column
  //      owns the tag decision (no longer lost when the drop bubbles up to
  //      FileList's outer drop ref — that was the original bug).
  // Read-only locations never import — `runAndRefresh` short-circuits, but
  // we also short-circuit here so we don't try to read `dataTransfer.files`
  // and `getPathForFile` paths we can't use anyway.
  const importExternalFiles = useCallback(
    async (
      files: File[],
      options?: { tagToApply?: string | null }
    ): Promise<{
      importedPaths: string[];
      copied: number;
      errors: string[];
    }> => {
      if (!files?.length) {
        return { importedPaths: [], copied: 0, errors: [] };
      }
      if (currentLocation?.isReadOnly) {
        throw new Error(t('readOnlyLocationDrop'));
      }
      const sources = files
        .map((f) => ipcApi.getPathForFile(f))
        .filter((p): p is string => !!p);
      if (sources.length === 0) {
        return { importedPaths: [], copied: 0, errors: [] };
      }
      return importExternalCore({
        sources,
        destDir: currentDirectoryPath,
        tagToApply: options?.tagToApply ?? null,
        // importExternalCore swallows sidecar-write failures (best-effort
        // — a failed tag stamp mustn't roll back a successful import), so
        // the caller doesn't need its own .catch here.
        sidecarWriter: (filePath, tags) =>
          ipcApi.writeSidecar(filePath, { tags }),
        importer: ipcApi.importExternal,
        onSuccess: () => {
          void refresh();
        },
      });
    },
    [currentDirectoryPath, currentLocation?.isReadOnly, refresh, t]
  );

  const openNative = useCallback(
    (targetPath: string) => ipcApi.openNative(targetPath),
    []
  );

  const value = useMemo(
    () => ({
      renameEntry,
      moveEntry,
      copyEntry,
      deleteEntry,
      createFolder,
      createFile,
      createTaggedEntry,
      importExternalFiles,
      openNative,
    }),
    [
      renameEntry,
      moveEntry,
      copyEntry,
      deleteEntry,
      createFolder,
      createFile,
      createTaggedEntry,
      importExternalFiles,
      openNative,
    ]
  );

  return (
    <IOActionsContext.Provider value={value}>
      {children}
    </IOActionsContext.Provider>
  );
}
