import { useMemo } from 'react';
import type { MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfirm } from '-/components/ConfirmDialogProvider';

import type { DirEntry } from '../../shared/ipc-types';
import { ipcApi } from '-/services/ipc-api';
import { joinPath, isSameOrDescendant } from '-/services/path-util';
import {
  resolveSmartTag,
  type SmartFunctionality,
} from '../../shared/smart-tags';

/** Shape returned by `useNewExcalidraw()` / `useNewDrawio()` — duplicated
 *  inline (no exported type) so this hook doesn't pull those two for
 *  typing alone. Keeping it structural avoids cross-module type churn. */
type NewEntryHook = {
  create: () => Promise<void>;
  available: boolean;
  canCreate: boolean;
};

/**
 * Bundle of inputs that `useListCommands` reads. Kept as a single object so
 * the caller (FileList) can build it via `useMemo` after P0-2 lands, and so
 * the hook can `useMemo`-key it cleanly. Every dep is read at command-fire
 * time, so there's no stale-closure risk as long as the caller passes a
 * fresh `deps` object each render.
 *
 * H.23 P0-1: extracted from FileList.tsx. The hook doesn't own state — all
 * setters flow in via `deps` so FileList remains the authority on UI/dialog
 * state.
 */
export interface ListCommandsDeps {
  // —— IO ——
  renameEntry: (path: string, name: string) => Promise<void>;
  moveEntry: (path: string, dest: string) => Promise<void>;
  copyEntry: (path: string, name: string) => Promise<void>;
  deleteEntry: (path: string) => Promise<void>;
  createFolder: (name: string) => Promise<void>;
  createFile: (name: string) => Promise<void>;
  createTaggedEntry: (
    kind: 'file' | 'folder',
    name: string,
    tag: string
  ) => Promise<void>;
  // —— Sidecar / tagging ——
  save: (
    entry: DirEntry,
    meta: { tags: string[]; description?: string }
  ) => Promise<void>;
  saveMany: (
    updates: {
      entry: DirEntry;
      meta: { tags: string[]; description?: string };
    }[]
  ) => Promise<void>;
  tagsByName: Map<string, string[]>;
  descByName: Map<string, string>;
  normalize: (tags: string[]) => string[];
  // —— Selection state (P0-3 done: Set selection lives in `useRef<Set>` in
  //  FileList, mutated in place; `commandsDeps.setSelected` is the upserter that
  //  triggers `bumpSelection` on the ref. We intentionally don't pass the Set
  //  itself — every consumer of "is X selected?" should derive its own read.)  ——
  selectedEntries: DirEntry[];
  setSelected: (updater: (prev: Set<string>) => Set<string>) => void;
  clearSelection: () => void;
  // H.23 P3-1: P3-1's `handleInvertSelection` mutates the ref in place
  // (the same pattern as `selectRow` / `clearSelection`); we expose both the
  // ref and the `bumpSelection` tick-bump callback so the inversion is one
  // ref mutation + one rerender, not N.
  selectedPathsRef: MutableRefObject<Set<string>>;
  bumpSelection: () => void;
  // —— FileList-owned UI sinks ——
  // Severity is carried explicitly (default error) — never inferred from the
  // localized text downstream.
  showNotice: (
    msg: string,
    severity?: 'success' | 'info' | 'warning' | 'error',
    opts?: { openTrash?: boolean }
  ) => void;
  setPackageOpen: (open: boolean) => void;
  setCreateKind: (kind: 'folder' | 'file' | null) => void;
  setCreateWithTag: (
    v: { kind: 'folder' | 'file'; tag: string } | null
  ) => void;
  refresh: () => Promise<void>;
  // —— Location / settings ——
  currentLocation?: { isReadOnly?: boolean } | null;
  currentDirectoryPath: string;
  deleteToTrash: boolean;
  // —— New entry factories ——
  newExcalidraw: NewEntryHook;
  newDrawio: NewEntryHook;
  // —— Pending "createWithTag" param, read at handleCreateTagged fire-time ——
  createWithTag: { kind: 'folder' | 'file'; tag: string } | null;
}

/**
 * The action bundle returned by `useListCommands`. Each handler closes over
 * the latest `deps` snapshot; the bundle itself is `useMemo`-stable for the
 * duration of equal-`deps` renders (so P0-2 can hand it straight to Row's
 * `cellData` without React.memo thrash).
 */
export interface ListCommands {
  // —— Single-row / per-entry ——
  handleDelete: (entry: DirEntry) => Promise<void>;
  handleMove: (entry: DirEntry) => Promise<void>;
  removeTagFromEntry: (entry: DirEntry, tag: string) => Promise<void>;
  removeAllTags: (entry: DirEntry) => Promise<void>;
  /**
   * H.23 P2-5: bulk tag removal. Strips `tag` from each entry's sidecar
   * tags; entries that don't currently have `tag` are skipped (no-op write).
   * Uses `saveMany` for a single round-trip IPC. Returns the count of
   * entries actually written (so the menu can show "Removed from N files").
   */
  removeTagFromMany: (entries: DirEntry[], tag: string) => Promise<number>;
  /**
   * H.23 P3-1: invert selection against a list of candidate entries.
   * Each entry currently in `selected` is removed; each entry NOT in
   * `selected` is added. Use to bulk-toggle a filter result without losing
   * the rest of the current selection (caller should pass a filtered slice,
   * not the full visible list, when the user wants to scope the invert).
   * No-op when `visible.length === 0`.
   */
  handleInvertSelection: (visible: readonly DirEntry[]) => void;
  handleDropTag: (
    entry: DirEntry,
    tag: string,
    functionality?: string
  ) => Promise<void>;
  handleDropFiles: (target: DirEntry, sources: DirEntry[]) => Promise<void>;
  // —— Bulk (multi-select) ——
  handleBulkDelete: () => Promise<void>;
  handleBulkMove: () => Promise<void>;
  handlePackageConfirm: (name: string) => Promise<void>;
  handleDeleteSelected: () => Promise<void>;
  // —— New entry ——
  /** Caller passes the kind explicitly (folder/file) since `createKind` lives
   *  in FileList's dialog state. Reset your dialog inside the onClick wrapper. */
  handleCreate: (
    kind: 'folder' | 'file',
    name: string
  ) => Promise<void>;
  handleCreateTagged: (name: string) => Promise<void>;
  handleNewExcalidraw: () => Promise<void>;
  handleNewDrawio: () => Promise<void>;
}

/**
 * Build the action bundle. Memoized on the deps reference so callers can
 * hand a stable deps after P0-2 (e.g. wrapped in `useMemo`).
 */
export function useListCommands(deps: ListCommandsDeps): ListCommands {
  const { t } = useTranslation();
  const confirm = useConfirm();

  return useMemo<ListCommands>(() => {
    const d = deps;

    const handleDelete: ListCommands['handleDelete'] = async (entry) => {
      const msg = d.deleteToTrash
        ? t('confirmDeleteTrash', { name: entry.name })
        : t('confirmDelete', { name: entry.name });
      if (!(await confirm({ message: msg, confirmLabel: t('delete'), danger: true }))) return;
      try {
        await d.deleteEntry(entry.path);
        d.setSelected((prev) => {
          const next = new Set(prev);
          next.delete(entry.path);
          return next;
        });
        if (d.deleteToTrash) {
          d.showNotice(t('movedToTrash'), 'success', { openTrash: true });
        } else {
          d.showNotice(t('deletedPermanently'), 'warning');
        }
      } catch (e) {
        d.showNotice(e instanceof Error ? e.message : String(e));
      }
    };

    const handleMove: ListCommands['handleMove'] = async (entry) => {
      try {
        const dest = await ipcApi.openDirectoryDialog();
        if (!dest) return;
        await d.moveEntry(entry.path, dest);
      } catch (e) {
        d.showNotice(e instanceof Error ? e.message : String(e));
      }
    };

    const removeTagFromEntry: ListCommands['removeTagFromEntry'] = async (
      entry,
      tag
    ) => {
      const current = d.tagsByName.get(entry.path) ?? [];
      if (!current.includes(tag)) return;
      try {
        const description = d.descByName.get(entry.path);
        await d.save(entry, {
          tags: current.filter((tg) => tg !== tag),
          ...(description ? { description } : {}),
        });
      } catch (e) {
        d.showNotice(e instanceof Error ? e.message : String(e));
      }
    };

    const removeTagFromMany: ListCommands['removeTagFromMany'] = async (
      entries,
      tag
    ) => {
      // Build the updates list — only entries that currently carry `tag`
      // need a write; the rest are no-ops the user implicitly intended
      // (clicking "Remove from N files" is forgiving about partial state).
      const updates: {
        entry: DirEntry;
        meta: { tags: string[]; description?: string };
      }[] = [];
      for (const entry of entries) {
        const current = d.tagsByName.get(entry.path) ?? [];
        if (!current.includes(tag)) continue;
        const description = d.descByName.get(entry.path);
        updates.push({
          entry,
          meta: {
            tags: current.filter((tg) => tg !== tag),
            ...(description ? { description } : {}),
          },
        });
      }
      if (updates.length === 0) return 0;
      try {
        await d.saveMany(updates);
        return updates.length;
      } catch (e) {
        d.showNotice(e instanceof Error ? e.message : String(e));
        return 0;
      }
    };

    const removeAllTags: ListCommands['removeAllTags'] = async (entry) => {
      if ((d.tagsByName.get(entry.path) ?? []).length === 0) return;
      try {
        const description = d.descByName.get(entry.path);
        await d.save(entry, {
          tags: [],
          ...(description ? { description } : {}),
        });
      } catch (e) {
        d.showNotice(e instanceof Error ? e.message : String(e));
      }
    };

    const handleDropTag: ListCommands['handleDropTag'] = async (
      entry,
      tag,
      functionality
    ) => {
      // P0 (Gallery 打标入口补齐,2026-07-02):守 readOnly,与兄弟
      // handleDropFiles/handleAddTag/handleRemoveTag/handleDeleteSelected 同型。
      // 这是个跨 list/grid/Gallery 的统一守卫;drop target 的 `canDrop` 是
      // 视觉短路,这里是最后一道防线。
      if (d.currentLocation?.isReadOnly) return;
      const resolved = functionality
        ? resolveSmartTag(functionality as SmartFunctionality, new Date()) ??
          tag
        : tag;
      const current = d.tagsByName.get(entry.path) ?? [];
      if (current.includes(resolved)) return;
      try {
        const description = d.descByName.get(entry.path);
        await d.save(entry, {
          tags: d.normalize([...current, resolved]),
          ...(description ? { description } : {}),
        });
        d.showNotice(t('tagsApplied', { count: 1 }), 'success');
      } catch (e) {
        d.showNotice(e instanceof Error ? e.message : String(e));
      }
    };

    const handleDropFiles: ListCommands['handleDropFiles'] = async (
      target,
      sources
    ) => {
      if (!target.isDirectory || sources.length === 0) return;
      if (d.currentLocation?.isReadOnly) return;
      let ok = 0;
      for (const src of sources) {
        if (
          src.path === target.path ||
          isSameOrDescendant(src.path, target.path)
        )
          continue;
        try {
          await d.moveEntry(src.path, target.path);
          ok += 1;
        } catch (e) {
          d.showNotice(e instanceof Error ? e.message : String(e));
        }
      }
      if (ok > 0) {
        d.showNotice(t('movedItems', { count: ok }), 'success');
        d.clearSelection();
      }
    };

    const handleBulkDelete: ListCommands['handleBulkDelete'] = async () => {
      const targets = d.selectedEntries;
      if (targets.length === 0) return;
      if (
        !(await confirm({
          message: t('confirmDeleteMany', { count: targets.length }),
          confirmLabel: t('delete'),
          danger: true,
        }))
      )
        return;
      let ok = 0;
      for (const entry of targets) {
        try {
          await d.deleteEntry(entry.path);
          ok += 1;
        } catch (e) {
          d.showNotice(e instanceof Error ? e.message : String(e));
        }
      }
      if (ok > 0) {
        if (d.deleteToTrash) {
          d.showNotice(t('movedToTrash'), 'success', { openTrash: true });
        } else {
          d.showNotice(t('deletedPermanently'), 'warning');
        }
      }
      d.clearSelection();
    };

    // H.23 P3-1: invert the selection against a candidate list. Each entry
    // currently selected (anywhere in the global `selectedPathsRef`) is
    // removed; each entry NOT in the selection is added. We mutate the ref
    // in place and bump `selectedTick` once at the end. Caller passes a
    // filtered subset (`visible` for "all visible rows", or a tag-filtered
    // list for scope-limited invert) so the user controls the surface.
    const handleInvertSelection: ListCommands['handleInvertSelection'] = (
      visibleToToggle
    ) => {
      if (visibleToToggle.length === 0) return;
      const set = d.selectedPathsRef.current;
      let mutated = false;
      for (const entry of visibleToToggle) {
        if (set.has(entry.path)) {
          set.delete(entry.path);
        } else {
          set.add(entry.path);
        }
        mutated = true;
      }
      if (mutated) {
        d.bumpSelection();
      }
    };

    const handleBulkMove: ListCommands['handleBulkMove'] = async () => {
      const targets = d.selectedEntries;
      if (targets.length === 0) return;
      try {
        const dest = await ipcApi.openDirectoryDialog();
        if (!dest) return;
        for (const entry of targets) {
          try {
            await d.moveEntry(entry.path, dest);
          } catch (e) {
            d.showNotice(e instanceof Error ? e.message : String(e));
          }
        }
        d.clearSelection();
      } catch (e) {
        d.showNotice(e instanceof Error ? e.message : String(e));
      }
    };

    const handlePackageConfirm: ListCommands['handlePackageConfirm'] =
      async (name) => {
        d.setPackageOpen(false);
        const targets = d.selectedEntries;
        const clean = name.trim().replace(/\.zip$/i, '');
        if (targets.length === 0 || !clean) return;
        try {
          const zipPath = joinPath(d.currentDirectoryPath, `${clean}.zip`);
          await ipcApi.zipEntries(
            targets.map((e) => e.path),
            zipPath
          );
          await d.refresh();
          d.showNotice(t('packaged', { count: targets.length }), 'success');
          d.clearSelection();
        } catch (e) {
          d.showNotice(e instanceof Error ? e.message : String(e));
        }
      };

    const handleDeleteSelected: ListCommands['handleDeleteSelected'] =
      async () => {
        if (d.currentLocation?.isReadOnly) return;
        const targets = d.selectedEntries;
        if (targets.length === 0) return;
        if (targets.length === 1) {
          await handleDelete(targets[0]);
        } else {
          await handleBulkDelete();
        }
      };

    const handleCreate: ListCommands['handleCreate'] = async (kind, name) => {
      if (!name) return;
      try {
        if (kind === 'folder') await d.createFolder(name);
        else await d.createFile(name);
      } catch (e) {
        d.showNotice(e instanceof Error ? e.message : String(e));
      }
    };

    const handleCreateTagged: ListCommands['handleCreateTagged'] = async (
      name
    ) => {
      // The createWithTag dialog state is read at fire-time via a parallel
      // snapshot in FileList; we receive just the resolved params here via
      // a callback-driven flow:
      //   - The caller reads `createWithTag` state
      //   - Resets it via `setCreateWithTag(null)`
      //   - Calls us with name only after substituting kind/tag through deps
      // For P0-1 simplicity, we read it directly here too:
      const params = d.createWithTag;
      d.setCreateWithTag(null);
      if (!name || !params) return;
      try {
        await d.createTaggedEntry(params.kind, name, params.tag);
      } catch (e) {
        d.showNotice(e instanceof Error ? e.message : String(e));
      }
    };

    const handleNewExcalidraw: ListCommands['handleNewExcalidraw'] =
      async () => {
        if (!d.newExcalidraw.canCreate) return;
        try {
          await d.newExcalidraw.create();
        } catch (e) {
          d.showNotice(e instanceof Error ? e.message : String(e));
        }
      };

    const handleNewDrawio: ListCommands['handleNewDrawio'] = async () => {
      if (!d.newDrawio.canCreate) return;
      try {
        await d.newDrawio.create();
      } catch (e) {
        d.showNotice(e instanceof Error ? e.message : String(e));
      }
    };

    // Suppress unused warnings on deps we're referencing only as types.
    void d.renameEntry;
    void d.copyEntry;
    void d.saveMany;

    return {
      handleDelete,
      handleMove,
      removeTagFromEntry,
      removeAllTags,
      removeTagFromMany,
      handleDropTag,
      handleDropFiles,
      handleBulkDelete,
      handleBulkMove,
      handlePackageConfirm,
      handleDeleteSelected,
      handleCreate,
      handleCreateTagged,
      handleNewExcalidraw,
      handleNewDrawio,
      handleInvertSelection,
    };
  }, [deps, t, confirm]);
}

export type { DirEntry };
