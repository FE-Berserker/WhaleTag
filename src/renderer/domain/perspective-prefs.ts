/**
 * Shared constants and localStorage helpers for the tag-based perspective views
 * (TagCloud, KnowledgeGraph) and the depth-driven FolderViz view.
 *
 * Before H.22 Â§P2-1 these constants were copy-pasted into each view; keeping one
 * source means a new smart-tag category or a depth-range change lands everywhere
 * at once. The `readPrefs`/`writePrefs` pair is the same best-effort,
 * never-throw pattern FolderViz pioneered (plan Â§H.20 D): preferences are
 * convenience, not core data, so a quota/parse/private-mode failure must never
 * break the view.
 */

import type { TagCategory } from './tagcloud';

/** Smart-tag categories the user can toggle on/off in tag-based perspectives.
 *  Plain (ordinary) tags always show and are not in this list. */
export const FILTERABLE_CATEGORIES: TagCategory[] = [
  'rating',
  'workflow',
  'priority',
  'date',
  'geo',
];

/** Shown by default â€?workflow/priority/date/geo are noise in a frequency cloud
 *  or relationship graph, so only ratings start visible. */
export const DEFAULT_SHOWN_CATEGORIES: TagCategory[] = ['rating'];

/** i18n key per category, shared by the TagCloud / KnowledgeGraph toggle rows. */
export const CATEGORY_LABEL_KEY: Record<TagCategory, string> = {
  rating: 'tagCloudCatRating',
  workflow: 'tagCloudCatWorkflow',
  priority: 'tagCloudCatPriority',
  date: 'tagCloudCatDate',
  geo: 'tagCloudCatGeo',
  plain: 'tagCloudCatPlain',
};

/** Recursive-depth slider bounds, shared by TagCloud / KnowledgeGraph / FolderViz. */
export const DEPTH_MIN = 1;
export const DEPTH_MAX = 5;
export const DEPTH_DEFAULT = 3;

/**
 * Coerce a persisted value into a valid category list, dropping anything not in
 * {@link FILTERABLE_CATEGORIES} (e.g. an old key that stored a since-removed
 * category). Returns null when the value isn't an array at all so callers can
 * distinguish "stored nothing usable" from "stored an empty selection".
 */
export function sanitizeShownCategories(value: unknown): TagCategory[] | null {
  if (!Array.isArray(value)) return null;
  const allowed = new Set<string>(FILTERABLE_CATEGORIES);
  return value.filter(
    (c): c is TagCategory => typeof c === 'string' && allowed.has(c)
  );
}

/** Clamp a persisted depth to [DEPTH_MIN, DEPTH_MAX]; null if out of range / NaN. */
export function sanitizeDepth(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < DEPTH_MIN || rounded > DEPTH_MAX) return null;
  return rounded;
}

/**
 * Best-effort localStorage read. Returns the parsed object (validation is the
 * caller's job via the field sanitizers) or null on miss / parse error.
 */
export function readPrefs<T>(key: string): Partial<T> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as Partial<T>;
  } catch {
    return null;
  }
}

/**
 * Best-effort localStorage write. Swallows quota / disabled-storage (private
 * mode) errors â€?a failed save must never surface to the user.
 */
export function writePrefs<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage full / disabled â€?prefs are convenience, not core data
  }
}
