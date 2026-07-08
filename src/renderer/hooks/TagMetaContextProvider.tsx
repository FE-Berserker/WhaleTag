import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useDispatch, useSelector } from 'react-redux';

import type { DirEntry } from '../../shared/ipc-types';
import type { SidecarMeta } from '../../shared/whale-meta';
import { ipcApi } from '-/services/ipc-api';
import {
  isPeriodTag,
  isStaleDateTag,
  smartFunctionalityOfTag,
} from '../../shared/smart-tags';
import { isGeoTag } from '../../shared/geo-tag';
import { RootState } from '-/reducers';
import { setTagColor } from '-/reducers/settings';
import { pickTagColor } from '../../shared/tag-colors';
import { useCurrentLocationContext } from './CurrentLocationContextProvider';
import { useDirectoryContentContext } from './DirectoryContentContextProvider';
import { useNow } from './useNow';

export interface TagCount {
  tag: string;
  count: number;
}

interface TagMetaContextValue {
  /** All tags in the current directory with counts (desc by count). */
  allTags: TagCount[];
  activeTag: string | null;
  setActiveTag: (tag: string | null) => void;
  /** Writes a file's sidecar and refreshes the directory cache. */
  save: (entry: DirEntry, meta: SidecarMeta) => Promise<void>;
  /**
   * Writes each entry's OWN sidecar in one batch. Each file may carry different
   * tags/description, so callers pass one {entry, meta} pair per file — never a
   * single shared meta (that would clobber every file's existing tags).
   */
  saveMany: (updates: { entry: DirEntry; meta: SidecarMeta }[]) => Promise<void>;
}

const TagMetaContext = createContext<TagMetaContextValue | null>(null);

export function useTagMetaContext(): TagMetaContextValue {
  const ctx = useContext(TagMetaContext);
  if (!ctx) {
    throw new Error(
      'useTagMetaContext must be used within TagMetaContextProvider'
    );
  }
  return ctx;
}

/**
 * Loads `.whale/<file>.json` sidecars for the current directory and merges them
 * with filename-embedded tags. Exposes the merged tag view, a tag-with-count
 * list (for the TagLibrary), the active filter tag, and save().
 *
 * Must sit below CurrentLocationContextProvider and DirectoryContentContextProvider.
 */
export function TagMetaContextProvider({ children }: { children: ReactNode }) {
  // H.24 R1/R2: tagsByName/descByName/geoByName are now owned by
  // DirectoryContentContext (path-keyed, single source of truth). This
  // provider only owns the meta layer: active filter tag + sidecar writes.
  const { tagsByName } = useDirectoryContentContext();
  const { currentDirectoryPath } = useCurrentLocationContext();
  // Phase 3: stale-date fold relies on a freshness check; the hook ticks once
  // a minute so a directory open across midnight correctly re-aggregates the
  // `日期` chip on the next render.
  const now = useNow();
  const dispatch = useDispatch();
  const tagColors = useSelector(
    (s: RootState) => s.settings?.tagColors ?? {}
  );
  const [activeTag, setActiveTag] = useState<string | null>(null);

  // Reset the filter when navigating to another directory.
  useEffect(() => {
    setActiveTag(null);
  }, [currentDirectoryPath]);

  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tags of tagsByName.values()) {
      // Track whether THIS file contributed to the period: / date: folds
      // (each file counts +1 per fold, not per tag — see docs/03-tagging.md
      // §5 + §8).
      let fileHasPeriod = false;
      let fileHasStaleDate = false;
      for (const tag of tags) {
        // Fold all geo coordinate tags (geo:lat,lng) into a single "geo:"
        // entry so the library shows one "location" row instead of one row
        // per coordinate — mirroring how smart-tag variants are folded.
        if (isGeoTag(tag)) {
          counts.set('geo:', (counts.get('geo:') ?? 0) + 1);
          continue;
        }
        // Period tags form their own fold ("period:") — independent family
        // from smart dates. Mark the file as having at least one; the actual
        // count for "period:" is set below by counting files (not tags).
        if (isPeriodTag(tag)) {
          fileHasPeriod = true;
          continue;
        }
        // Stale smart date tags (e.g. `today-20251223` when today is past)
        // fold into a single "date:" chip with the text "日期" — captures
        // every historical date stamp regardless of original functionality
        // (today / yesterday / month / year / now / nextWeek).
        if (isStaleDateTag(tag, now)) {
          fileHasStaleDate = true;
          continue;
        }
        // Fold active smart-tag variants (today-20260704, today-20260705, …)
        // into a single "smart:<fn>" entry so the library isn't flooded with
        // one row per timestamp. Stale variants were handled above and never
        // reach this branch.
        const fn = smartFunctionalityOfTag(tag, now);
        const key = fn ? `smart:${fn}` : tag;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      if (fileHasPeriod) {
        counts.set('period:', (counts.get('period:') ?? 0) + 1);
      }
      if (fileHasStaleDate) {
        counts.set('date:', (counts.get('date:') ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort(
        (a, b) => b.count - a.count || a.tag.localeCompare(b.tag)
      );
  }, [tagsByName, now]);

  // Auto-assign colors to newly seen tags (least-used palette color first).
  useEffect(() => {
    for (const { tag } of allTags) {
      if (!tagColors[tag]) {
        dispatch(setTagColor(tag, pickTagColor(tag, tagColors)));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTags, tagColors, dispatch]);

  // save/saveMany write to disk and then trigger a DirectoryContentContext
  // refresh so the path-keyed tagsByName/descByName/geoByName projections
  // pick up the new sidecar state.
  const { refresh: refreshDirectory } = useDirectoryContentContext();

  const save = useCallback(
    async (entry: DirEntry, meta: SidecarMeta) => {
      await ipcApi.writeSidecar(entry.path, meta);
      await refreshDirectory();
    },
    [refreshDirectory]
  );

  const saveMany = useCallback(
    async (updates: { entry: DirEntry; meta: SidecarMeta }[]) => {
      await Promise.all(
        updates.map((u) => ipcApi.writeSidecar(u.entry.path, u.meta))
      );
      await refreshDirectory();
    },
    [refreshDirectory]
  );

  const value = useMemo(
    () => ({
      allTags,
      activeTag,
      setActiveTag,
      save,
      saveMany,
    }),
    [allTags, activeTag, save, saveMany]
  );

  return (
    <TagMetaContext.Provider value={value}>{children}</TagMetaContext.Provider>
  );
}
