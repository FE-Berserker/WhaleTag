/**
 * Pure helpers for the TagCloud perspective.
 *
 * The tag cloud counts how often each tag appears across a set of files and
 * sizes the rendered text by that frequency. echarts-wordcloud maps a datum's
 * `value` *linearly* onto its `sizeRange` font-size band, so to get the
 * recommended square-root sizing (which compresses high-frequency tags and
 * lifts the long tail) we pre-scale the sizing channel with `Math.sqrt` and
 * keep the raw `count` alongside for tooltips and sorting.
 *
 * React/Electron-free so the counting and scaling can be unit-tested in
 * isolation (tagcloud.test.ts).
 */

import { isQuadrantTag, isRatingTag, isWorkflowTag } from '../../shared/smart-tags';
import { isGeoTag } from './geo-tag';
import { dateTagDayKey } from './calendar';

export interface TagCount {
  tag: string;
  count: number;
}

/**
 * Coarse classification used to filter out smart tags that carry no meaning in
 * a frequency cloud / mind map (workflow status, priority quadrant, calendar
 * dates, geo coordinates). `plain` is an ordinary user/library tag.
 */
export type TagCategory = 'rating' | 'workflow' | 'priority' | 'date' | 'geo' | 'plain';

/**
 * Coarse date-shape predicate used by `tagCategory` to keep "is this a date
 * tag?" independent of freshness. A bare or prefixed YYYYMMDD / YYYYMM / YYYY /
 * YYYYMMDDTHHMM tag is "date" regardless of whether it currently maps to a
 * smart functionality (which is time-dependent via `smartFunctionalityOfTag`).
 *
 * Distinct from `smartFunctionalityOfTag`: that one says "is this an active
 * smart date tag RIGHT NOW"; this one says "does this look like a date".
 */
function isDateShapeTag(tag: string): boolean {
  if (dateTagDayKey(tag) !== null) return true; // 8-digit day / datetime / period
  // Month- and year-resolution shapes (don't have a day key).
  if (/^(?:month-)?\d{6}$/.test(tag)) return true;
  if (/^(?:year-)?\d{4}$/.test(tag)) return true;
  return false;
}

/** Classify a single tag value into a {@link TagCategory}. */
export function tagCategory(tag: string): TagCategory {
  if (isRatingTag(tag)) return 'rating';
  if (isWorkflowTag(tag)) return 'workflow';
  if (isQuadrantTag(tag)) return 'priority';
  if (isGeoTag(tag)) return 'geo';
  // Date-family: any active smart date tag OR any date-shaped value (stale
  // smart tags still count as "date" for cloud exclusion purposes �?the user
  // wants to filter them out regardless of freshness).
  if (isDateShapeTag(tag)) return 'date';
  return 'plain';
}

export interface TagCloudDatum {
  /** The raw tag value (storage form, e.g. `5star`). */
  name: string;
  /** Sizing channel handed to echarts-wordcloud (= sqrt(count) by default). */
  value: number;
  /** Raw occurrence count, for tooltips and sort order. */
  count: number;
}

export type SizeScale = 'sqrt' | 'linear' | 'log';

/** Apply the chosen frequency→size scale to a raw count. */
export function scaleCount(count: number, scale: SizeScale = 'sqrt'): number {
  if (count <= 0) return 0;
  switch (scale) {
    case 'linear':
      return count;
    case 'log':
      // log1p keeps count=1 �?~0.69 (> 0) so single-use tags still render.
      return Math.log1p(count);
    case 'sqrt':
    default:
      return Math.sqrt(count);
  }
}

/**
 * Count tag occurrences across a list of per-file tag arrays. A tag is counted
 * once per file that carries it (duplicates within one file collapse). Returns
 * counts sorted by frequency (desc) then tag name (asc) for stable ordering.
 *
 * Geo tags are *not* unconditionally skipped here; callers that want to hide
 * them pass `exclude: ['geo']` to {@link tagCloudData}. This keeps the counter
 * reusable for views that optionally surface coordinate tags.
 */
export function countTags(tagLists: Iterable<readonly string[] | undefined>): TagCount[] {
  const counts = new Map<string, number>();
  for (const tags of tagLists) {
    if (!tags || tags.length === 0) continue;
    const seen = new Set<string>();
    for (const raw of tags) {
      const tag = raw.trim();
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * Build echarts-wordcloud series data from per-file tag arrays.
 *
 * - `scale` chooses the frequency→font-size curve (default `sqrt`).
 * - `exclude` drops tags whose {@link tagCategory} is listed (e.g. hide
 *   workflow/priority/date smart tags that are noise in a cloud).
 * - `limit` keeps the top-N most frequent tags *after* the category filter
 *   (0/undefined = all). Because exclusion happens first, the result may be
 *   fewer than `limit` even when more tags exist. The tag cloud gets unreadable
 *   past a few hundred words, so callers should cap.
 *
 * H.22 §P2-4: categorize each *distinct* tag once (after counting) instead of
 * filtering every per-file array up front. The old path spread `tagLists` and
 * ran `tagCategory` per occurrence �?O(files × tags); this runs it once per
 * distinct tag, so a 10k-file × 10k-tag directory no longer stalls a frame.
 */
export function tagCloudData(
  tagLists: Iterable<readonly string[] | undefined>,
  options: { scale?: SizeScale; limit?: number; exclude?: Iterable<TagCategory> } = {}
): TagCloudDatum[] {
  const { scale = 'sqrt', limit, exclude } = options;
  const skip = new Set(exclude ?? []);
  let counts = countTags(tagLists);
  if (skip.size) counts = counts.filter((c) => !skip.has(tagCategory(c.tag)));
  if (limit && limit > 0) counts = counts.slice(0, limit);
  return counts.map(({ tag, count }) => ({
    name: tag,
    value: scaleCount(count, scale),
    count,
  }));
}

export interface TagCooccurrenceMatrix {
  /** Tags forming both axes, ordered by frequency (desc) then name (asc). */
  tags: string[];
  /** `matrix[i][j]` = number of files that carry both `tags[i]` and `tags[j]`.
   *  The diagonal holds each tag's own file count. */
  matrix: number[][];
  /** Number of files that contributed at least one tag to the matrix. */
  totalFiles: number;
}

/**
 * Build a tag co-occurrence matrix from per-file tag arrays.
 *
 * The matrix is square and symmetric: cell (i, j) counts how many files carry
 * both `tags[i]` and `tags[j]`. The diagonal stores each tag's individual file
 * count. Tags are sorted by frequency (desc) then name (asc), optionally capped
 * by `limit` and filtered by `exclude` categories.
 *
 * The implementation is O(files × tags²_per_file) in the worst case, but in
 * practice each file carries only a handful of tags, and `limit` bounds the
 * matrix size so rendering stays cheap.
 */
export function tagCooccurrenceMatrix(
  tagLists: Iterable<readonly string[] | undefined>,
  options: { limit?: number; exclude?: Iterable<TagCategory> } = {}
): TagCooccurrenceMatrix {
  const { limit, exclude } = options;
  const skip = new Set(exclude ?? []);
  const lists = Array.from(tagLists);

  // First pass: count per-tag frequencies so we can rank the axis labels.
  let counts = countTags(lists);
  if (skip.size) counts = counts.filter((c) => !skip.has(tagCategory(c.tag)));
  if (limit && limit > 0) counts = counts.slice(0, limit);

  const tags = counts.map((c) => c.tag);
  const indexByTag = new Map(tags.map((t, i) => [t, i]));
  const n = tags.length;
  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));

  // Second pass: count pairwise co-occurrences within the selected tag set.
  let totalFiles = 0;
  for (const fileTags of lists) {
    if (!fileTags || fileTags.length === 0) continue;
    const indices: number[] = [];
    const seen = new Set<string>();
    for (const raw of fileTags) {
      const tag = raw.trim();
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      const idx = indexByTag.get(tag);
      if (idx !== undefined) indices.push(idx);
    }
    if (indices.length === 0) continue;
    totalFiles += 1;
    for (let a = 0; a < indices.length; a += 1) {
      for (let b = a; b < indices.length; b += 1) {
        const i = indices[a];
        const j = indices[b];
        matrix[i][j] += 1;
        if (i !== j) matrix[j][i] += 1;
      }
    }
  }

  // Overwrite the diagonal with each tag's own file count so it matches the
  // cloud sizing and tooltip expectations.
  for (let i = 0; i < n; i += 1) {
    const count = counts.find((c) => c.tag === tags[i])?.count ?? 0;
    matrix[i][i] = count;
  }

  return { tags, matrix, totalFiles };
}
