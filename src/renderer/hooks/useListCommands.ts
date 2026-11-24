import { useMemo } from 'react';
import type { MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfirm } from '-/components/ConfirmDialogProvider';

import type { DirEntry } from '../../shared/ipc-types';
import { ipcApi } from '-/services/ipc-api';
import { joinPath, isSameOrDescendant, parentDir } from '-/services/path-util';
import { isDateTypedTag } from '../domain/calendar';
import type { IOActionOptions } from './IOActionsContextProvider';
import type { TagMetaSaveManyError } from './TagMetaContextProvider';
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
  moveEntry: (
    path: string,
    dest: string,
    options?: IOActionOptions
  ) => Promise<void>;
  copyEntry: (path: string, name: string) => Promise<void>;
  deleteEntry: (path: string, options?: IOActionOptions) => Promise<void>;
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
  refreshTree: (path: string) => void;
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
    functionality?: string,
    targets?: readonly DirEntry[]
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

export interface BatchOperationOutcome<T> {
  succeeded: T[];
  errors: string[];
}

/** Keep notices bounded without losing the complete diagnostics in the log. */
export function summarizeBatchErrors(
  errors: readonly string[],
  andMore: (count: number) => string,
  logError: (...data: unknown[]) => void = console.error
): string {
  logError('[files] Batch operation errors:', errors);
  const visible = errors.slice(0, 3);
  if (errors.length > 3) visible.push(andMore(errors.length - 3));
  return visible.join('; ');
}

export interface BatchNotice {
  message: string;
  severity: 'success' | 'warning' | 'error';
}

/** Compose one truthful notice while keeping full diagnostics in the log. */
export function composeBatchNotice(
  successCount: number,
  successText: string,
  errors: readonly string[],
  translations: {
    andMore: (count: number) => string;
    operationFailed: (message: string) => string;
    partialFailure: (success: string, failure: string) => string;
  },
  successSeverity: 'success' | 'warning' = 'success',
  logError: (...data: unknown[]) => void = console.error
): BatchNotice | null {
  if (errors.length === 0) {
    return successCount > 0
      ? { message: successText, severity: successSeverity }
      : null;
  }
  const failureText = translations.operationFailed(
    summarizeBatchErrors(errors, translations.andMore, logError)
  );
  if (successCount === 0) return { message: failureText, severity: 'error' };
  return {
    message: translations.partialFailure(successText, failureText),
    severity: 'warning',
  };
}

/** Read the partial outcome attached by TagMetaContextProvider.saveMany. */
export function tagMetaSaveManyFailure(
  error: unknown
): TagMetaSaveManyError | null {
  if (!(error instanceof Error)) return null;
  const candidate = error as Partial<TagMetaSaveManyError>;
  if (
    typeof candidate.updatedCount !== 'number' ||
    !Number.isSafeInteger(candidate.updatedCount) ||
    candidate.updatedCount < 0 ||
    !Array.isArray(candidate.errors) ||
    candidate.errors.length === 0 ||
    !candidate.errors.every((detail) => typeof detail === 'string')
  ) {
    return null;
  }
  return error as TagMetaSaveManyError;
}

/** Reject self/descendant moves as item errors so mixed batches stay truthful. */
export function moveValidationError(
  source: DirEntry,
  targetPath: string,
  message: string
): string | null {
  return source.path === targetPath || isSameOrDescendant(source.path, targetPath)
    ? message
    : null;
}

/**
 * Run every item even after a failure, then reconcile the listing once. Both
 * item and refresh failures are returned to the caller for one truthful notice.
 */
export async function runBatchWithRefresh<T>(
  items: readonly T[],
  operation: (item: T) => Promise<void>,
  refresh: (succeeded: readonly T[]) => Promise<void>,
  label: (item: T) => string,
  refreshLabel: string
): Promise<BatchOperationOutcome<T>> {
  const succeeded: T[] = [];
  const errors: string[] = [];
  for (const item of items) {
    try {
      await operation(item);
      succeeded.push(item);
    } catch (error) {
      errors.push(
        `${label(item)}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  try {
    await refresh(succeeded);
  } catch (error) {
    errors.push(
      `${refreshLabel}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return { succeeded, errors };
}

/**
 * Tree paths affected by successful deletes, or moves when destinationDir is
 * supplied. Failed items contribute nothing; Set preserves first-use order.
 */
export function affectedTreePathsAfterBatch(
  succeeded: readonly DirEntry[],
  destinationDir?: string
): string[] {
  const paths = new Set<string>();
  for (const entry of succeeded) {
    paths.add(parentDir(entry.path));
    if (destinationDir !== undefined) paths.add(destinationDir);
  }
  return [...paths];
}

/** Remove only paths whose IO actually succeeded; failed/unrelated paths stay selected. */
export function selectionAfterBatch(
  previous: Set<string>,
  succeeded: readonly DirEntry[]
): Set<string> {
  if (succeeded.length === 0) return previous;
  const paths = new Set(succeeded.map((entry) => entry.path));
  const next = new Set(previous);
  let changed = false;
  for (const path of paths) {
    if (next.delete(path)) changed = true;
  }
  return changed ? next : previous;
}

/** Build and persist one logical tag drop, using saveMany for a multi-target drop. */
export async function saveTagToEntries(
  targets: readonly DirEntry[],
  resolvedTag: string,
  deps: Pick<
    ListCommandsDeps,
    'save' | 'saveMany' | 'tagsByName' | 'descByName' | 'normalize'
  >
): Promise<number> {
  const updates: {
    entry: DirEntry;
    meta: { tags: string[]; description?: string };
  }[] = [];
  for (const entry of targets) {
    const current = deps.tagsByName.get(entry.path) ?? [];
    if (current.includes(resolvedTag)) continue;
    const description = deps.descByName.get(entry.path);
    updates.push({
      entry,
      meta: {
        tags: deps.normalize([...current, resolvedTag]),
        ...(description ? { description } : {}),
      },
    });
  }
  if (updates.length === 0) return 0;
  if (targets.length === 1) {
    await deps.save(updates[0].entry, updates[0].meta);
  } else {
    await deps.saveMany(updates);
  }
  return updates.length;
}

/**
 * P1-2 (gui-audit 2026-11): persist one logical multi-entry date-tag drop
 * (Calendar day cell). Every target keeps its non-date tags and gets
 * `dateKey` swapped in — same rule as the single-entry
 * `handleSetEntryDateTag`. A multi-target drop is written with ONE
 * `saveMany` round-trip instead of N single-entry `save` calls (each of which
 * separately re-read the sidecar and recomputed the listing); the
 * single-target case keeps the plain `save` API.
 *
 * Returns the number of sidecars written (0 for an empty drop). Write
 * failures propagate to the caller so the host can surface the notice.
 */
export async function setDateTagForEntries(
  targets: readonly DirEntry[],
  dateKey: string,
  deps: Pick<
    ListCommandsDeps,
    'save' | 'saveMany' | 'tagsByName' | 'descByName' | 'normalize'
  >
): Promise<number> {
  const updates: {
    entry: DirEntry;
    meta: { tags: string[]; description?: string };
  }[] = [];
  for (const entry of targets) {
    const current = deps.tagsByName.get(entry.path) ?? [];
    const kept = current.filter((tag) => !isDateTypedTag(tag));
    const description = deps.descByName.get(entry.path);
    updates.push({
      entry,
      meta: {
        // No no-op skip here: setting the date is an explicit "make this the
        // date", matching the single-entry handler's behavior (idempotent
        // write). Non-date tags are preserved, exactly like the single path.
        tags: deps.normalize([...kept, dateKey]),
        ...(description ? { description } : {}),
      },
    });
  }
  if (updates.length === 0) return 0;
  if (targets.length === 1) {
    await deps.save(updates[0].entry, updates[0].meta);
  } else {
    await deps.saveMany(updates);
  }
  return updates.length;
}

/**
 * P1-2 (gui-audit 2026-11): batch companion of `setDateTagForEntries` for
 * drops that clear the date (Gantt Triage). Entries that carry no date tag
 * are skipped (no sidecar write), mirroring the single-entry
 * `handleRemoveEntryDateTag` no-op guard — a drop where every entry is
 * already clean writes nothing. Multi-target writes go through ONE
 * `saveMany`.
 */
export async function removeDateTagsFromEntries(
  targets: readonly DirEntry[],
  deps: Pick<
    ListCommandsDeps,
    'save' | 'saveMany' | 'tagsByName' | 'descByName' | 'normalize'
  >
): Promise<number> {
  const updates: {
    entry: DirEntry;
    meta: { tags: string[]; description?: string };
  }[] = [];
  for (const entry of targets) {
    const current = deps.tagsByName.get(entry.path) ?? [];
    const kept = current.filter((tag) => !isDateTypedTag(tag));
    if (kept.length === current.length) continue;
    const description = deps.descByName.get(entry.path);
    updates.push({
      entry,
      meta: {
        tags: deps.normalize(kept),
        ...(description ? { description } : {}),
      },
    });
  }
  if (updates.length === 0) return 0;
  if (targets.length === 1) {
    await deps.save(updates[0].entry, updates[0].meta);
  } else {
    await deps.saveMany(updates);
  }
  return updates.length;
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

    const finishBatch = (
      successCount: number,
      successText: string,
      errors: string[],
      successSeverity: 'success' | 'warning' = 'success',
      opts?: { openTrash?: boolean }
    ) => {
      const notice = composeBatchNotice(
        successCount,
        successText,
        errors,
        {
          andMore: (count) => t('andMoreFailures', { count }),
          operationFailed: (message) => t('operationFailed', { message }),
          partialFailure: (success, failure) =>
            t('partialFailure', { success, failure }),
        },
        successSeverity
      );
      if (notice) d.showNotice(notice.message, notice.severity, opts);
    };

    const retainFailedSelection = (succeeded: readonly DirEntry[]) => {
      d.setSelected((previous) => selectionAfterBatch(previous, succeeded));
    };

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
      functionality,
      targets
    ) => {
      // P0 (Gallery 打标入口补齐,2026-07-02):守 readOnly,与兄弟
      // handleDropFiles/handleAddTag/handleRemoveTag/handleDeleteSelected 同型。
      // 这是个跨 list/grid/Gallery 的统一守卫;drop target 的 `canDrop` 是
      // 视觉短路,这里是最后一道防线。
      if (d.currentLocation?.isReadOnly) {
        // Never a silent no-op: say why the drop did nothing.
        d.showNotice(t('readOnlyLocation'), 'warning');
        return;
      }
      const resolved = functionality
        ? resolveSmartTag(functionality as SmartFunctionality, new Date()) ??
          tag
        : tag;
      const dropTargets = targets ?? [entry];
      if (dropTargets.length === 0) return;
      try {
        const count = await saveTagToEntries(dropTargets, resolved, d);
        if (count > 0) d.showNotice(t('tagsApplied', { count }), 'success');
      } catch (e) {
        const failure = tagMetaSaveManyFailure(e);
        if (failure) {
          finishBatch(
            failure.updatedCount,
            t('tagsApplied', { count: failure.updatedCount }),
            failure.errors
          );
          return;
        }
        d.showNotice(e instanceof Error ? e.message : String(e));
      }
    };

    const handleDropFiles: ListCommands['handleDropFiles'] = async (
      target,
      sources
    ) => {
      if (!target.isDirectory || sources.length === 0) return;
      if (d.currentLocation?.isReadOnly) {
        // Never a silent no-op: say why the drop did nothing.
        d.showNotice(t('readOnlyLocation'), 'warning');
        return;
      }
      const outcome = await runBatchWithRefresh(
        sources,
        async (src) => {
          const validationError = moveValidationError(
            src,
            target.path,
            t('moveIntoSelfOrDescendant')
          );
          if (validationError) throw new Error(validationError);
          await d.moveEntry(src.path, target.path, {
            refresh: false,
            treeRefresh: false,
          });
        },
        async (succeeded) => {
          for (const path of affectedTreePathsAfterBatch(
            succeeded,
            target.path
          )) {
            d.refreshTree(path);
          }
          await d.refresh();
        },
        (src) => src.name,
        t('refresh')
      );
      retainFailedSelection(outcome.succeeded);
      finishBatch(
        outcome.succeeded.length,
        t('movedItems', { count: outcome.succeeded.length }),
        outcome.errors
      );
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
      const outcome = await runBatchWithRefresh(
        targets,
        (entry) =>
          d.deleteEntry(entry.path, { refresh: false, treeRefresh: false }),
        async (succeeded) => {
          for (const path of affectedTreePathsAfterBatch(succeeded)) {
            d.refreshTree(path);
          }
          await d.refresh();
        },
        (entry) => entry.name,
        t('refresh')
      );
      retainFailedSelection(outcome.succeeded);
      const successText = d.deleteToTrash
        ? t('trashedItems', { count: outcome.succeeded.length })
        : t('deletedItems', { count: outcome.succeeded.length });
      finishBatch(
        outcome.succeeded.length,
        successText,
        outcome.errors,
        d.deleteToTrash ? 'success' : 'warning',
        d.deleteToTrash ? { openTrash: true } : undefined
      );
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
      if (targets.length === 0 || d.currentLocation?.isReadOnly) return;
      let dest: string | null;
      try {
        dest = await ipcApi.openDirectoryDialog();
      } catch (e) {
        d.showNotice(e instanceof Error ? e.message : String(e), 'error');
        return;
      }
      if (!dest) return;
      const outcome = await runBatchWithRefresh(
        targets,
        async (entry) => {
          const validationError = moveValidationError(
            entry,
            dest,
            t('moveIntoSelfOrDescendant')
          );
          if (validationError) throw new Error(validationError);
          await d.moveEntry(entry.path, dest, {
            refresh: false,
            treeRefresh: false,
          });
        },
        async (succeeded) => {
          for (const path of affectedTreePathsAfterBatch(succeeded, dest)) {
            d.refreshTree(path);
          }
          await d.refresh();
        },
        (entry) => entry.name,
        t('refresh')
      );
      retainFailedSelection(outcome.succeeded);
      finishBatch(
        outcome.succeeded.length,
        t('movedItems', { count: outcome.succeeded.length }),
        outcome.errors
      );
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
