import type { TFunction } from 'i18next';
import {
  filledTagSx,
  tagShapeSx,
  type TagShape,
} from '../domain/tag-colors';
import {
  ratingOfTag,
  workflowFunctionalityOfTag,
  quadrantFunctionalityOfTag,
  smartFunctionalityOfTag,
  smartTagI18nKey,
  isPeriodTag,
  type SmartFunctionality,
} from '../../shared/smart-tags';
import { isGeoTag } from '../domain/geo-tag';
import { dateTagRangeKey } from '../domain/calendar';

/**
 * Shared tag-chip presentation used by both the list rows and the grid cells.
 * Keeps the displayed label and the chip styling identical across views.
 */

/**
 * Smart-tag functionalities whose stored values look like a date. With the
 * freshness rule (§3) the stored value is just the date itself (compact form
 * `20260704` or datetime `20260704T1430`); the label is the i18n template name
 * for that functionality. `now` is special-cased below to render the actual
 * timestamp string instead of the i18n label.
 */
const DATE_FUNCTIONALITIES: ReadonlySet<SmartFunctionality> = new Set([
  'today',
  'yesterday',
  'tomorrow',
  'nextWeek',
  'currentMonth',
  'currentYear',
]);

/**
 * Format a compact `YYYYMMDDTHHMM` value as a human-readable
 * `YYYY-MM-DD HH:MM` string. Used for active `now` smart tags (per §7).
 */
function formatActiveNowLabel(compact: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})$/.exec(compact);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

/**
 * Extract the canonical compact form (8-digit day / 6-digit month / 4-digit year
 * / `YYYYMMDDTHHMM` datetime) from a smart date tag, with or without the
 * legacy template prefix. Returns null if `tag` doesn't match any date shape.
 */
function dateTagCanonical(tag: string): string | null {
  let m = /^(?:today|yesterday|tomorrow|week)-(\d{8})$/.exec(tag);
  if (m) return m[1];
  m = /^month-(\d{6})$/.exec(tag);
  if (m) return m[1];
  m = /^year-(\d{4})$/.exec(tag);
  if (m) return m[1];
  m = /^now-(\d{8}T\d{4})$/.exec(tag);
  if (m) return m[1];
  if (/^\d{8}$/.test(tag)) return tag;
  if (/^\d{6}$/.test(tag)) return tag;
  if (/^\d{4}$/.test(tag)) return tag;
  if (/^\d{8}T\d{4}$/.test(tag)) return tag;
  return null;
}

/**
 * Display label for an applied tag: ratings → "N Stars"/"N 星", workflow values
 * → their localized status, **active** date smart tags → "今天"/"this month"/…,
 * **active** `now` → `YYYY-MM-DD HH:MM` timestamp (§7), **period** tags
 * → `2026-07-01 – 2026-07-03` style range (i18n `tagPeriodRange`),
 * **stale** date smart tags fall through to the raw stored value (the `日期`
 * fold chip in the tag library takes over display responsibility).
 *
 * `now` is optional and defaults to `new Date()` so existing callers without
 * time-awareness still work; freshness-aware callers should pass
 * `useNow()` (see src/renderer/hooks/useNow.ts).
 *
 * Geo coordinate tags are NOT special-cased here — they render as a frameless
 * location icon in the chip components instead of a text label. Views that
 * draw tags as plain text (wordcloud, knowledge-graph) call
 * {@link geoTagDisplayLabel} first and fall back to this function.
 */
export function tagDisplayLabel(
  tag: string,
  t: TFunction,
  now: Date = new Date()
): string {
  const rating = ratingOfTag(tag);
  if (rating) return t('ratingStars', { count: rating });
  const wfFn = workflowFunctionalityOfTag(tag);
  if (wfFn) return t(smartTagI18nKey(wfFn));
  const qFn = quadrantFunctionalityOfTag(tag);
  if (qFn) return t(smartTagI18nKey(qFn));

  // Period tags render as a compact "YYYY-MM-DD – YYYY-MM-DD" range, regardless
  // of freshness (a period's "freshness" is not date-of-application like the
  // smart-date family; it's a fixed user-entered range).
  if (isPeriodTag(tag)) {
    const range = dateTagRangeKey(tag);
    if (range) {
      return t('tagPeriodRange', { start: range.startKey, end: range.endKey });
    }
  }

  // Use the freshness-aware lookup: a stale smart date tag returns null and
  // falls through to the raw string (the `日期` fold chip owns display in the
  // library; per-tag chips outside the library still see the raw date).
  const dateFn = smartFunctionalityOfTag(tag, now);
  if (dateFn) {
    // `now` is special: render the actual timestamp instead of the i18n label
    // (per §7, the live "now" tag is short-lived; users want to see the time).
    if (dateFn === 'now') {
      const canonical = dateTagCanonical(tag);
      if (canonical) {
        const formatted = formatActiveNowLabel(canonical);
        if (formatted) return formatted;
      }
    }
    if (DATE_FUNCTIONALITIES.has(dateFn)) {
      return t(smartTagI18nKey(dateFn));
    }
  }
  return tag;
}

/**
 * Format a `geo:lat,lng` tag for display in surfaces that don't already render
 * geo as a location icon (e.g. wordcloud labels, knowledge-graph tag nodes).
 * Returns null for non-geo tags so callers can chain with `tagDisplayLabel`:
 *
 *     geoTagDisplayLabel(raw, t) ?? tagDisplayLabel(raw, t)
 *
 * Coordinates are passed through verbatim (after stripping the `geo:` prefix).
 * The emoji + format string lives in the i18n dictionary (`tagCloudGeoLabel`)
 * so non-CJK / a11y locales can swap the glyph or remove it without code edits.
 */
export function geoTagDisplayLabel(tag: string, t: TFunction): string | null {
  if (!isGeoTag(tag)) return null;
  return t('tagCloudGeoLabel', { coords: tag.slice('geo:'.length) });
}

/**
 * Applies the per-tag color as a filled background (contrasting text), falling
 * back to the active-filter primary highlight. Compact sizing keeps chips small.
 * `shape` (global, from settings) gives every chip the same silhouette.
 */
export function chipSx(
  color: string | undefined,
  active: boolean,
  shape: TagShape = 'rounded'
) {
  // Split the shape's optional label-padding override so it merges with (rather
  // than clobbers) the compact base label padding.
  const { '& .MuiChip-label': shapeLabel, ...shapeRest } = tagShapeSx(shape) as {
    '& .MuiChip-label'?: Record<string, unknown>;
  } & Record<string, unknown>;
  const label = { px: 0.5, py: 0, ...(shapeLabel ?? {}) };
  const base = { height: 20, fontSize: 11 };
  if (active) return { ...base, ...shapeRest, '& .MuiChip-label': label };
  return {
    ...base,
    ...(filledTagSx(color) ?? {}),
    ...shapeRest,
    '& .MuiChip-label': label,
  };
}

/**
 * Outlined counterpart of {@link chipSx} for the "tag-shaped button" surfaces
 * that don't represent an APPLIED tag — the PropertiesTray's smart / rating /
 * workflow / quadrant quick-add rows, and the unselected state of the per-tag
 * color picker. They share the global silhouette (rounded / square / tag)
 * with applied tag chips but stay hollow with a transparent background so
 * they read as "click to add" rather than "this tag is set".
 *
 * Pass `accent` to tint the border + text (kept transparent fill) — used by
 * the rating / workflow / quadrant rows whose accent color should still come
 * through even when outlined.
 */
export function outlinedTagChipSx(
  accent: string | undefined,
  shape: TagShape = 'rounded'
) {
  const { '& .MuiChip-label': shapeLabel, ...shapeRest } = tagShapeSx(shape) as {
    '& .MuiChip-label'?: Record<string, unknown>;
  } & Record<string, unknown>;
  return {
    height: 20,
    fontSize: 11,
    ...shapeRest,
    '& .MuiChip-label': { px: 0.5, py: 0, ...(shapeLabel ?? {}) },
    ...(accent
      ? { borderColor: accent, color: accent, bgcolor: 'transparent' }
      : {}),
  };
}
