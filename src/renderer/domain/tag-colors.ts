/**
 * Tag color palette and auto-assignment utilities. Colors are global to the
 * app (stored in settings.tagColors) and assigned automatically the first time
 * a tag appears.
 */

import type { TagGroup } from './tag-library';
import {
  isPeriodTag,
  isRatingTag,
  isWorkflowTag,
  isQuadrantTag,
  RATING_COLOR,
  WORKFLOW_COLOR,
  WORKFLOW_COLORS,
  QUADRANT_COLORS,
  PERIOD_COLOR,
} from '../../shared/smart-tags';
import { isGeoTag, parseGeoTag } from './geo-tag';

export { RATING_COLOR, PERIOD_COLOR };

/** Accent color for geo coordinate tags (`geo:lat,lng`). */
export const GEO_TAG_COLOR = '#1976d2'; // blue

/**
 * Accent color for the `date:` fold chip in the tag library �?captures every
 * stale (no-longer-active) smart date tag (Phase 3 / §9 user-approved).
 * Neutral grey (Material Grey 500) so it doesn't compete with the date /
 * period / rating / workflow / quadrant / geo accent families.
 */
export const STALE_DATE_FOLD_COLOR = '#9e9e9e'; // grey

/** High-contrast palette used for geo tags and map markers. Colors are spaced
 *  across the hue wheel so nearby locations remain distinguishable. */
export const GEO_MARKER_PALETTE = [
  '#ef4444', // red
  '#22c55e', // green
  '#3b82f6', // blue
  '#f59e0b', // amber
  '#a855f7', // purple
  '#06b6d4', // cyan
  '#f43f5e', // rose
  '#84cc16', // lime
  '#0ea5e9', // sky
  '#ec4899', // pink
];

/** Deterministic color for a lat/lng coordinate, cycling through the geo
 *  marker palette by hashing the rounded coordinate. */
export function getGeoColor(lat: number, lng: number): string {
  const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash << 5) - hash + key.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % GEO_MARKER_PALETTE.length;
  return GEO_MARKER_PALETTE[index];
}

/** Default tag color palette (Tailwind 500 scale). */
export const TAG_PALETTE = [
  '#ef4444', // red
  '#f97316', // orange
  '#f59e0b', // amber
  '#eab308', // yellow
  '#84cc16', // lime
  '#22c55e', // green
  '#10b981', // emerald
  '#14b8a6', // teal
  '#06b6d4', // cyan
  '#0ea5e9', // sky
  '#3b82f6', // blue
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#a855f7', // purple
  '#d946ef', // fuchsia
  '#ec4899', // pink
  '#f43f5e', // rose
  '#64748b', // slate
];

/**
 * Picks a color for `tag`. If `tag` already has a color, that color is returned
 * unchanged. Otherwise the next palette color is chosen round-robin based on
 * the current size of `existingColors`, so back-to-back additions always get a
 * different color (repeating only after `TAG_PALETTE.length` assignments).
 *
 * Round-robin was chosen over "least used" because least-used collapses to the
 * same first-palette color for the first 18 uncolored tags �?a user adding
 * several tags in a row would see them all pick the same color, which violates
 * the "each new tag gets a different color" requirement.
 */
export function pickTagColor(
  tag: string,
  existingColors: Record<string, string>
): string {
  const current = existingColors[tag];
  if (current) return current;
  const index = Object.keys(existingColors).length % TAG_PALETTE.length;
  return TAG_PALETTE[index];
}

/**
 * Resolves a tag's display color with fallback tiers:
 *  1. a rating value (`1star`..`5star`) -> the built-in gold (RATING_COLOR),
 *     always uniform and not overridable by per-tag or group colors
 *  2. a period tag (`YYYYMMDD-YYYYMMDD`) -> the built-in violet PERIOD_COLOR
 *     (overridable by per-tag / group �?different from rating's "always uniform"
 *     behavior, so users can pick their own period accent)
 *  3. an explicit per-tag color the user set (settings.tagColors)
 *  4. the color of the group the tag belongs to (inherited)
 *  5. a workflow value (`not-started`..`planned`) -> its per-state color
 *     (WORKFLOW_COLORS �?gray/blue/red/green/amber by convention)
 *  6. a quadrant value -> its per-state color
 *  7. a geo tag -> coordinate-derived color (or GEO_TAG_COLOR fallback)
 *  8. undefined -> the caller renders a neutral default
 *
 * Pure; reused by TagLibrary, TagGroups, and the file-row chips so a tag's
 * color is consistent everywhere it appears.
 */
export function getTagColor(
  tag: string,
  tagColors: Record<string, string>,
  groups: readonly TagGroup[]
): string | undefined {
  // Ratings are always uniform gold; user/group overrides must not split
  // 1star..5star into different colors (e.g. 5star accidentally inheriting
  // a blue group color).
  if (isRatingTag(tag)) return RATING_COLOR;

  if (tagColors[tag]) return tagColors[tag];
  for (const g of groups) {
    if (g.color && g.tags.includes(tag)) return g.color;
  }
  // Built-in smart-tag defaults (user/group color above still wins if set).
  if (isPeriodTag(tag)) return PERIOD_COLOR;
  if (isWorkflowTag(tag)) return WORKFLOW_COLORS[tag] ?? WORKFLOW_COLOR;
  if (isQuadrantTag(tag)) return QUADRANT_COLORS[tag];
  if (isGeoTag(tag)) {
    const point = parseGeoTag(tag);
    if (point) return getGeoColor(point.lat, point.lng);
    return GEO_TAG_COLOR;
  }
  return undefined;
}

/**
 * Returns a readable text color (dark or white) for labels placed on top of a
 * solid `hex` background, via perceptual luminance. Tolerant of #rgb / #rrggbb.
 */
export function readableTextOn(hex: string): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return '#ffffff';
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? '#1f2937' : '#ffffff';
}

/**
 * sx for a "filled" tag chip: the resolved color becomes the solid background
 * with a contrasting text color. Returns undefined when no color is resolved
 * (caller falls back to the default outlined chip).
 */
export function filledTagSx(
  color: string | undefined
): { bgcolor: string; color: string; border: string } | undefined {
  if (!color) return undefined;
  return { bgcolor: color, color: readableTextOn(color), border: 'none' };
}

/** The outline/silhouette of a tag chip. Global, set in the tag manager. */
export type TagShape = 'rounded' | 'square' | 'tag' | 'flag' | 'bookmark' | 'hexagon' | 'shield';

/** The selectable shapes, in display order (for the manager's shape picker). */
export const TAG_SHAPES: TagShape[] = ['rounded', 'square', 'tag', 'flag', 'bookmark', 'hexagon', 'shield'];

/**
 * sx fragment giving a chip its global shape. `tag` is a luggage-tag silhouette
 * (pointed right edge) via clip-path, with extra right padding so the label
 * clears the point. Merged into chipSx so it applies to every tag chip.
 */
export function tagShapeSx(shape: TagShape): Record<string, unknown> {
  switch (shape) {
    case 'square':
      return { borderRadius: 0 };
    case 'tag':
      return {
        borderRadius: 0,
        clipPath:
          'polygon(0 0, calc(100% - 8px) 0, 100% 50%, calc(100% - 8px) 100%, 0 100%)',
        '& .MuiChip-label': { pr: 1.25 },
      };
    case 'flag':
      return {
        borderRadius: 0,
        clipPath:
          'polygon(8px 0, calc(100% - 8px) 0, 100% 50%, calc(100% - 8px) 100%, 8px 100%, 0 50%)',
        '& .MuiChip-label': { px: 1 },
      };
    case 'bookmark':
      return {
        borderRadius: 0,
        clipPath:
          'polygon(0 0, 100% 0, 100% calc(100% - 5px), 50% 100%, 0 calc(100% - 5px))',
        '& .MuiChip-label': { pb: 0.25 },
      };
    case 'hexagon':
      return {
        borderRadius: 0,
        clipPath:
          'polygon(6px 0, calc(100% - 6px) 0, 100% 40%, 100% 60%, calc(100% - 6px) 100%, 6px 100%, 0 60%, 0 40%)',
        '& .MuiChip-label': { px: 1 },
      };
    case 'shield':
      return {
        borderRadius: 0,
        clipPath:
          'polygon(0 0, 100% 0, 100% 65%, 50% 100%, 0 65%)',
        '& .MuiChip-label': { pb: 0.25 },
      };
    case 'rounded':
    default:
      return { borderRadius: 1 };
  }
}

/**
 * Extra padding for non-Chip tag boxes (TagLibrary, WorkflowManagerDialog) so
 * that pointed shapes don't clip their text. Box components don't have a
 * `.MuiChip-label` child, so the label padding from `tagShapeSx` doesn't apply.
 */
export function tagShapeBoxPadding(shape: TagShape): Record<string, unknown> {
  switch (shape) {
    case 'tag':
      return { pr: 1.75 };
    case 'flag':
    case 'hexagon':
      return { px: 1 };
    case 'bookmark':
    case 'shield':
      return { pb: 0.5 };
    default:
      return {};
  }
}

/** Pastel preview backgrounds for the Settings tag-shape dropdown. */
export const TAG_SHAPE_PREVIEW_COLORS: Record<TagShape, string> = {
  rounded: '#e2e8f0',
  square: '#fecaca',
  tag: '#fed7aa',
  flag: '#fef08a',
  bookmark: '#bbf7d0',
  hexagon: '#a5f3fc',
  shield: '#e9d5ff',
};
