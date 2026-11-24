import { useCallback } from 'react';

import type { DirEntry } from '../../../shared/ipc-types';
import type { SidecarMeta } from '../../../shared/whale-meta';
import {
  normalizeSmartTags,
  resolveInputTag,
} from '../../../shared/smart-tags';
import type { ListCommandsDeps } from '-/hooks/useListCommands';
import {
  removeDateTagsFromEntries,
  setDateTagForEntries,
} from '-/hooks/useListCommands';
import { tagsAfterMove } from '../../domain/kanban';
import { formatGeoTag, withoutGeoTags } from '../../domain/geo-tag';
import { isDateTypedTag } from '../../domain/calendar';

/**
 * The sidecar-writing handlers `FileList` used to define inline (P2 FileList
 * split). They all follow the same shape — read the current tags/description,
 * compute the next tag set, persist through `save` / `saveMany`, and surface
 * failures through `showNotice`. Read-only locations are a hard no-op, exactly
 * like the pre-extraction code.
 *
 * Kept as a hook (not free functions) so each handler's `useCallback` identity
 * churn matches the original dependency arrays: `cellData` / `commandsDeps`
 * feed react-window's per-row shallow compare, so a changed identity on an
 * unrelated render re-renders every visible row.
 */
export interface UseFileListTagActionsOptions
  extends Pick<
    ListCommandsDeps,
    'currentLocation' | 'tagsByName' | 'descByName' | 'normalize' | 'showNotice'
  > {
  /**
   * Sidecar writers from TagMetaContext. Typed with `SidecarMeta` (whose
   * `tags` is optional) rather than `ListCommandsDeps`' narrower shape: this
   * hook also writes a `description` through the same call, and the batch
   * date-tag helpers accept these broader signatures contravariantly.
   */
  save: (entry: DirEntry, meta: SidecarMeta) => Promise<void>;
  saveMany: (
    updates: { entry: DirEntry; meta: SidecarMeta }[]
  ) => Promise<void>;
  /** Wall clock used to resolve `today` / `month-YYYYMM` template input. */
  now: Date;
}

export interface FileListTagActions {
  handleMoveToColumn: (
    sources: DirEntry[],
    targetTag: string | null,
    groupTags: string[]
  ) => void;
  handleGpsFound: (entry: DirEntry, lat: number, lng: number) => void;
  handleSetGeo: (entry: DirEntry, lat: number, lng: number) => void;
  handleClearGeo: (entry: DirEntry) => void;
  handleAddTag: (entry: DirEntry, tag: string) => void;
  handleRemoveTag: (entry: DirEntry, tag: string) => void;
  handleSetEntryDateTag: (entry: DirEntry, dateKey: string) => void;
  handleRemoveEntryDateTag: (entry: DirEntry) => void;
  handleSetEntryDateTags: (entries: DirEntry[], dateKey: string) => void;
  handleRemoveEntryDateTags: (entries: DirEntry[]) => void;
}

export function useFileListTagActions({
  currentLocation,
  tagsByName,
  descByName,
  normalize,
  save,
  saveMany,
  showNotice,
  now,
}: UseFileListTagActionsOptions): FileListTagActions {
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
      showNotice,
    ]
  );

  const handleGpsFound = useCallback(
    (entry: DirEntry, lat: number, lng: number) => {
      // EXIF extraction is a background sidecar write: a read-only location
      // refuses it, so do not even try (same gate as `handleSetGeo`).
      if (currentLocation?.isReadOnly) return;
      const tags = tagsByName.get(entry.path) ?? [];
      const description = descByName.get(entry.path);
      // EXIF-extracted coordinates flow through a `geo:lat,lng` tag — the
      // sidecar has no parallel lat/lng field (removed 2026-06-30). Strip any
      // stale geo tag before appending the new one so we never end up with
      // duplicates. Mirror `handleSetGeo`'s failure surfacing so a save error
      // doesn't silently lose the extracted coordinate.
      // Skip the save when the EXIF coords match what is already tagged — the
      // common case when "Refresh EXIF cache" re-extracts every file.
      const geoTag = formatGeoTag(lat, lng);
      if (tags.includes(geoTag)) return;
      void save(entry, {
        tags: normalize([...withoutGeoTags(tags), geoTag]),
        ...(description ? { description } : {}),
      }).catch((e: unknown) =>
        showNotice(e instanceof Error ? e.message : String(e))
      );
    },
    [currentLocation?.isReadOnly, tagsByName, descByName, normalize, save, showNotice]
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
    [currentLocation, tagsByName, descByName, normalize, save, showNotice]
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
    [currentLocation, tagsByName, descByName, save, showNotice]
  );

  const handleAddTag = useCallback(
    (entry: DirEntry, tag: string) => {
      if (currentLocation?.isReadOnly) return;
      // Resolve user input to its stored form FIRST: `today` → `20260704`,
      // `month-202606` → `202606`, `in-progress` → unchanged, plain tags
      // unchanged. Without this step the exclusion chain below can't recognize
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
    [currentLocation, tagsByName, descByName, normalize, save, now, showNotice]
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
    [currentLocation, tagsByName, descByName, save, showNotice]
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
    [currentLocation, tagsByName, descByName, save, showNotice]
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
    [currentLocation, tagsByName, descByName, save, showNotice]
  );

  // P1-2 (gui-audit 2026-11): batch companions for the two date-tag handlers
  // above. A Calendar day-cell / Gantt Triage drop carries N paths; one
  // `saveMany` round-trip replaces the previous N × single-entry `save` calls
  // (each of which separately re-read the sidecar and recomputed the listing).
  // Read-only gate + failure surfacing mirror the single-entry paths exactly;
  // `setDateTagForEntries` keeps the single-target `save` API, while
  // `removeDateTagsFromEntries` skips entries that carry no date tag (so an
  // all-already-clean drop writes nothing).
  const handleSetEntryDateTags = useCallback(
    (entries: DirEntry[], dateKey: string) => {
      if (currentLocation?.isReadOnly) return;
      void setDateTagForEntries(entries, dateKey, {
        save,
        saveMany,
        tagsByName,
        descByName,
        normalize: normalizeSmartTags,
      }).catch((e: unknown) =>
        showNotice(e instanceof Error ? e.message : String(e))
      );
    },
    [currentLocation, tagsByName, descByName, save, saveMany, showNotice]
  );

  const handleRemoveEntryDateTags = useCallback(
    (entries: DirEntry[]) => {
      if (currentLocation?.isReadOnly) return;
      void removeDateTagsFromEntries(entries, {
        save,
        saveMany,
        tagsByName,
        descByName,
        normalize: normalizeSmartTags,
      }).catch((e: unknown) =>
        showNotice(e instanceof Error ? e.message : String(e))
      );
    },
    [currentLocation, tagsByName, descByName, save, saveMany, showNotice]
  );

  return {
    handleMoveToColumn,
    handleGpsFound,
    handleSetGeo,
    handleClearGeo,
    handleAddTag,
    handleRemoveTag,
    handleSetEntryDateTag,
    handleRemoveEntryDateTag,
    handleSetEntryDateTags,
    handleRemoveEntryDateTags,
  };
}
