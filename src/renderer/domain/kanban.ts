/**
 * Pure helpers for the Kanban (tag-board) perspective. React/Electron-free so the
 * bucketing and tag-mutation logic can be unit-tested in isolation (kanban.test.ts).
 *
 * A board is driven by one tag group: each tag in the group is a column, plus a
 * trailing "untagged" column for files carrying none of the group's tags. A file
 * lands in the column of the FIRST group tag it has (group order), so it never
 * appears in two columns. Drops are mutually-exclusive within the group (see
 * tagsAfterMove).
 */

import type { DirEntry } from '../../shared/ipc-types';

/** Sentinel column key for files that carry none of the board group's tags. */
export const UNTAGGED_COLUMN = ' untagged';

/**
 * Buckets `entries` into columns keyed by group tag (in `groupTags` order), with
 * a trailing `UNTAGGED_COLUMN`. Each file goes to the first group tag it carries;
 * files with no group tag go to `UNTAGGED_COLUMN`. Every column key is present in
 * the returned map (empty array if no files), so callers can render empty columns.
 */
export function bucketEntries(
  entries: DirEntry[],
  groupTags: string[],
  tagsByName: Map<string, string[]>
): Map<string, DirEntry[]> {
  const buckets = new Map<string, DirEntry[]>();
  for (const tag of groupTags) buckets.set(tag, []);
  buckets.set(UNTAGGED_COLUMN, []);

  for (const entry of entries) {
    // H.24 R1: tagsByName is path-keyed (two same-named files in different
    // subdirs keep independent tags), so look up by full path, not basename.
    const tags = tagsByName.get(entry.path) ?? [];
    const hit = groupTags.find((gt) => tags.includes(gt));
    buckets.get(hit ?? UNTAGGED_COLUMN)!.push(entry);
  }
  return buckets;
}

/**
 * The new tag list for a file moved into a column, with mutually-exclusive group
 * semantics: drop all of the file's tags that belong to `groupTags`, then (when
 * `targetTag` is non-null) add `targetTag`. Tags outside the group are preserved.
 * `targetTag === null` means the "untagged" column (clear the group entirely).
 * Order of surviving non-group tags is preserved; the target tag goes last.
 */
export function tagsAfterMove(
  currentTags: string[],
  groupTags: string[],
  targetTag: string | null
): string[] {
  const groupSet = new Set(groupTags);
  const kept = currentTags.filter((t) => !groupSet.has(t));
  if (targetTag !== null && !kept.includes(targetTag)) kept.push(targetTag);
  return kept;
}
