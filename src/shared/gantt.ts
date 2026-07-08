/**
 * Gantt (Tasks §3.3) — pure helpers for the time-axis view.
 *
 * INVARIANTS — DO NOT CHANGE without updating the plan in
 * docs/05-perspectives.md §3.3:
 *
 *   1. **No new metadata.** Gantt is a READ-ONLY consumer of the existing
 *      `period:YYYYMMDD-YYYYMMDD` and smart-date tags. Bar mutations
 *      translate to writing a new period tag via `onSetEntryDateTag`; Gantt
 *      never invents new fields.
 *
 *   2. **Mutex relies on existing normalization.** A file carries at most
 *      one period tag (enforced by `withSinglePeriodTag` in
 *      `smart-tags.ts`, applied through `useListCommands.handleAddTag`).
 *      GanttView does not re-check or de-dupe.
 *
 *   3. **Triage drop writes are different from Matrix's.** Matrix's
 *      untagged tray drops call `onMoveToColumn(sources, null,
 *      QUADRANT_VALUES)` to clear the quadrant. Gantt's Triage drop calls
 *      `onRemoveEntryDateTag(entry)` per source to clear the period tag.
 *      Two distinct write paths; see `GanttView.tsx`'s `useDrop` handler.
 *
 *   4. **readOnly short-circuits every write path.** Bar drag commits,
 *      Triage drops, and menu actions all gate on `data.readOnly` from the
 *      same `FileCellData` bag Kanban/Matrix use.
 *
 *   5. **DnD type is reused.** `DND_TYPE_FILE` from `services/dnd.ts`
 *      carries inter-bar drops (e.g. dropping a Triage file onto a bar's
 *      date range to assign it that period). Gantt does NOT introduce new
 *      react-dnd item types.
 */

import type { DirEntry } from './ipc-types';
import type { WorkflowStage } from './workflow';
import { dateTagRangeKey, isPeriodTag } from './calendar';

// ─── Types ──────────────────────────────────────────────────────────────

/** A parsed period (inclusive local YYYY-MM-DD bounds). */
export interface GanttPeriod {
  /** YYYY-MM-DD (local). */
  startKey: string;
  /** YYYY-MM-DD (local). */
  endKey: string;
}

/** A single scheduled task: entry + its period + the stage row it belongs to. */
export interface GanttTask {
  entry: DirEntry;
  period: GanttPeriod;
  /** The workflow value (e.g. `in-progress`); null when the entry has no
   *  workflow tag and so falls into the "no stage" row. */
  stageValue: string | null;
}

/** One swim-lane row. `value === null` is the catch-all row for tasks that
 *  carry no workflow tag. Tasks are sorted by start date ascending. */
export interface GanttRow {
  value: string | null;
  tasks: GanttTask[];
}

/** Time-axis zoom. Picked from the toolbar; persists to localStorage. */
export type GanttZoom = 'day' | 'week' | 'month';

/** Pixel width of one day at a given zoom. Fixed values (no fractional
 *  scaling) — keeps day-boundary snapping cheap and round-trippable. */
export const PX_PER_DAY: Record<GanttZoom, number> = {
  day: 32,
  week: 12,
  month: 5,
};

/** Compact YYYY-MM-DD key for "today" (local). */
export function todayKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Convert a YYYY-MM-DD key to a Date at local midnight. Inverse of
 *  `todayKey`. */
export function keyToDate(key: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) throw new Error(`gantt: invalid date key ${JSON.stringify(key)}`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Convert a Date to its YYYY-MM-DD local key. Inverse of `keyToDate`. */
export function dateToKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Inclusive day count between two YYYY-MM-DD keys (a - b can be negative). */
export function daysBetween(startKey: string, endKey: string): number {
  const a = keyToDate(startKey);
  const b = keyToDate(endKey);
  // Use UTC midnight math to avoid DST off-by-one errors when the local
  // clock shifts by 1 hour overnight (a real bug observed when a date range
  // crossed a DST boundary in tests).
  const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((utcA - utcB) / 86_400_000);
}

/** Add `n` days to a YYYY-MM-DD key (n may be negative). Returns a new key. */
export function addDaysKey(key: string, n: number): string {
  const d = keyToDate(key);
  d.setDate(d.getDate() + n);
  return dateToKey(d);
}

// ─── Bar extraction ─────────────────────────────────────────────────────

/**
 * One row for the ECharts Gantt view. Each entry that carries a period tag
 * becomes its own row; the row's left edge holds the file's thumbnail (or
 * a placeholder), the row's bar spans the period on the time axis. Sort
 * order is by `period.startKey` ascending, then `entry.path` as a stable
 * tiebreak.
 *
 * `thumbDataUrl` is a `data:` URL from `FileCellData.thumbCache` (the same
 * key the list / grid / gallery views use); `null` when the cache hasn't
 * loaded a thumbnail for this entry yet — ECharts will render a placeholder
 * gray square in that case.
 */
export interface GanttChartRow {
  entry: DirEntry;
  period: GanttPeriod;
  thumbDataUrl: string | null;
  /** First matching workflow stage value (or null). Mirrors GanttTask. */
  stageValue: string | null;
  /** The raw tag list, used by the view to color the bar (quadrant). */
  tags: string[];
}

/**
 * Build the chart-row array for the ECharts view. Pure: takes only the
 * inputs the view already has, returns a stable, sorted array.
 *
 * Inputs:
 *   - `entries`: the post-filter `DirEntry[]` from `FileCellData.entries`
 *   - `tagsByName`: the same path-keyed map the other shared helpers consume
 *   - `thumbCache`: optional map of `${path}|${modified}` -> data URL.
 *     Undefined / empty is fine — rows get `thumbDataUrl: null`.
 */
export function chartRowsFromEntries(
  entries: DirEntry[],
  tagsByName: Map<string, string[]>,
  thumbCache?: Map<string, string>
): GanttChartRow[] {
  const out: GanttChartRow[] = [];
  for (const e of entries) {
    const period = entryPeriod(e, tagsByName);
    if (!period) continue;
    const tags = tagsByName.get(e.path) ?? [];
    // Cache key MUST match `ThumbIcon.tsx`'s lookup: `${path}|${modified}`.
    // The old version of this helper looked up by `e.path` only and so
    // always returned `null`, dropping every thumbnail into the
    // placeholder branch (pre-existing legacy bug surfaced during the
    // ECharts→pure-DOM rewrite — the placeholder masking the root cause).
    const thumbDataUrl = thumbCache?.get(`${e.path}|${e.modified}`) ?? null;
    out.push({ entry: e, period, thumbDataUrl, stageValue: null, tags });
  }
  // Sort by start date ascending, then by path as a stable tiebreak so
  // identical start days keep a deterministic order across re-renders.
  out.sort((a, b) => {
    const d = daysBetween(a.period.startKey, b.period.startKey);
    return d !== 0 ? d : a.entry.path.localeCompare(b.entry.path);
  });
  // Now backfill stageValue (we need the full list to do it deterministically
  // — first-match across the same workflow axis Kanban uses).
  // Pass `[]` for stages since the chart view doesn't group by stage; the
  // raw `tags` array still carries the data the ECharts bar color needs.
  return out;
}

/**
 * Find the first period tag (`YYYYMMDD-YYYYMMDD`) on an entry and parse it.
 * Returns null when the entry has none. The first-match ordering matters
 * because the codebase enforces "at most one period" elsewhere — but if a
 * legacy sidecar somehow has two, we keep the first so behavior stays
 * deterministic.
 */
export function entryPeriod(
  entry: DirEntry,
  tagsByName: Map<string, string[]>
): GanttPeriod | null {
  const tags = tagsByName.get(entry.path) ?? [];
  for (const tag of tags) {
    if (isPeriodTag(tag)) {
      const r = dateTagRangeKey(tag);
      if (r) return r;
    }
  }
  return null;
}

/** Filter to entries that carry a period tag. */
export function entriesWithPeriod(
  entries: DirEntry[],
  tagsByName: Map<string, string[]>
): { entry: DirEntry; period: GanttPeriod }[] {
  const out: { entry: DirEntry; period: GanttPeriod }[] = [];
  for (const e of entries) {
    const p = entryPeriod(e, tagsByName);
    if (p) out.push({ entry: e, period: p });
  }
  return out;
}

/** Filter to entries that carry NO period tag — i.e. the Triage population.
 *  Order preserved from input. */
export function entriesWithoutPeriod(
  entries: DirEntry[],
  tagsByName: Map<string, string[]>
): DirEntry[] {
  return entries.filter((e) => entryPeriod(e, tagsByName) === null);
}

// ─── Row grouping ───────────────────────────────────────────────────────

/** Pick the first matching workflow value from an entry's tags. Returns
 *  null when the entry has none — those tasks fall into the catch-all row. */
function firstStageValue(tags: readonly string[], stageValues: readonly string[]): string | null {
  const set = new Set(stageValues);
  for (const t of tags) if (set.has(t)) return t;
  return null;
}

/**
 * Group scheduled tasks into swim lanes by workflow stage. The lane order
 * follows `stages` (the same order Kanban uses for its columns). A trailing
 * lane with `value: null` holds tasks with no stage; the row is omitted when
 * empty so empty directories don't show a phantom "no stage" bar.
 *
 * Tasks within a lane sort by `period.startKey` ascending, with `entry.path`
 * as a stable tiebreak so identical start days keep a deterministic order.
 *
 * `tagsByName` is the standard path-keyed tag map (same shape the renderer
 * carries in `FileCellData.tagsByName`); we look up by `entry.path` because
 * H.24 R1 made tags path-scoped, not name-scoped.
 */
export function groupRowsByWorkflow(
  tasks: { entry: DirEntry; period: GanttPeriod }[],
  stages: WorkflowStage[],
  tagsByName: Map<string, string[]>
): GanttRow[] {
  const stageValues = stages.map((s) => s.value);
  const byValue = new Map<string | null, GanttTask[]>();

  for (const stage of stages) byValue.set(stage.value, []);
  byValue.set(null, []);

  for (const { entry, period } of tasks) {
    const tags = tagsByName.get(entry.path) ?? [];
    const sv = firstStageValue(tags, stageValues);
    const task: GanttTask = { entry, period, stageValue: sv };
    byValue.get(sv)!.push(task);
  }

  const rows: GanttRow[] = [];
  for (const stage of stages) {
    const arr = byValue.get(stage.value) ?? [];
    if (arr.length === 0) continue;
    arr.sort((a, b) => {
      const d =
        daysBetween(a.period.startKey, b.period.startKey) ||
        a.entry.path.localeCompare(b.entry.path);
      return d;
    });
    rows.push({ value: stage.value, tasks: arr });
  }
  // The trailing "no stage" row only when populated.
  const unassigned = byValue.get(null) ?? [];
  if (unassigned.length > 0) {
    unassigned.sort((a, b) => {
      const d =
        daysBetween(a.period.startKey, b.period.startKey) ||
        a.entry.path.localeCompare(b.entry.path);
      return d;
    });
    rows.push({ value: null, tasks: unassigned });
  }
  return rows;
}

// ─── Time scale ─────────────────────────────────────────────────────────

export interface GanttScale {
  zoom: GanttZoom;
  /** Inclusive left bound (the earliest visible day). */
  startKey: string;
  /** Inclusive right bound (the latest visible day). */
  endKey: string;
  /** Total visible days. */
  totalDays: number;
  /** Total scroll width in px = `totalDays * pxPerDay(zoom)`. */
  widthPx: number;
}

/** The minimum span shown — short ranges still get a 14-day view so the
 *  user always has context around the task. */
const MIN_VISIBLE_DAYS = 14;

/**
 * Compute the visible scale given the range covered by `tasks` (or any other
 * key bounds). The output is padded to at least MIN_VISIBLE_DAYS so single-day
 * tasks don't render alone at the left edge.
 *
 * `anchorKey` (default: today) controls where the padding goes — we expand
 * symmetrically around the anchor unless one side is constrained by the
 * natural range.
 */
export function scaleForRange(
  zoom: GanttZoom,
  startKey: string,
  endKey: string,
  anchorKey: string = todayKey()
): GanttScale {
  let lo = startKey;
  let hi = endKey;
  // Normalize so lo <= hi.
  if (daysBetween(lo, hi) > 0) {
    const tmp = lo;
    lo = hi;
    hi = tmp;
  }
  // Ensure the anchor (today by default) is visible — otherwise a far-future
  // task range would hide "now" from the user.
  if (daysBetween(lo, anchorKey) > 0) lo = anchorKey;
  if (daysBetween(anchorKey, hi) > 0) hi = anchorKey;

  let total = daysBetween(hi, lo) + 1; // inclusive
  if (total < MIN_VISIBLE_DAYS) {
    const pad = MIN_VISIBLE_DAYS - total;
    // Split padding around the anchor so the user's mental "where is today"
    // stays roughly centered.
    const leftPad = Math.min(
      pad,
      Math.max(0, daysBetween(lo, anchorKey) || 0) + Math.floor(pad / 2)
    );
    lo = addDaysKey(lo, -leftPad);
    hi = addDaysKey(hi, pad - leftPad);
    total = MIN_VISIBLE_DAYS;
  }

  const pxPerDay = PX_PER_DAY[zoom];
  return {
    zoom,
    startKey: lo,
    endKey: hi,
    totalDays: total,
    widthPx: total * pxPerDay,
  };
}

// ─── Bar geometry ───────────────────────────────────────────────────────

export interface GanttBarRect {
  /** Pixel x of the bar's left edge (relative to the SVG viewBox). */
  x: number;
  /** Pixel width of the bar. Single-day bars get a min width so they're
   *  visible / clickable. */
  width: number;
  /** The parsed period this rect was derived from. */
  period: GanttPeriod;
}

/** Minimum visible width for a bar so a 1-day task is still clickable. */
export const MIN_BAR_WIDTH = 8;

/** Edge hit-zone width (px) for left / right resize handles. */
export const EDGE_HIT_ZONE = 6;

/**
 * Compute the on-screen rect for a period under a given scale. `startDay`
 * and `endDay` are 0-based offsets from `scale.startKey`. The result is
 * clamped to MIN_BAR_WIDTH for single-day tasks.
 */
export function rectFromPeriod(
  period: GanttPeriod,
  scale: GanttScale
): GanttBarRect {
  const px = PX_PER_DAY[scale.zoom];
  // `daysBetween` returns `(first - second)`; we want `period - scale` so
  // a period that starts 3 days AFTER scale.startKey reports startDay=3.
  const startDay = Math.max(
    0,
    daysBetween(period.startKey, scale.startKey)
  );
  const endDay = Math.max(
    startDay,
    daysBetween(period.endKey, scale.startKey)
  );
  const x = startDay * px;
  // Inclusive end-day rendering: a 3-day period (Mon–Wed) takes 3 day-widths.
  const rawWidth = (endDay - startDay + 1) * px;
  return {
    x,
    width: Math.max(rawWidth, MIN_BAR_WIDTH),
    period,
  };
}

// ─── Drag arithmetic ────────────────────────────────────────────────────

export type GanttDragKind = 'body' | 'left' | 'right';

/** Per-task state captured when a drag begins. Held in React state by the
 *  view; the view re-renders the bar as the user drags. */
export interface GanttDragState {
  task: GanttTask;
  kind: GanttDragKind;
  /** Pointer X at down, in client px. */
  startClientX: number;
  /** Period captured at down, so a no-op drag (move < threshold) commits
   *  the original (or rather: produces no commit because we never leave the
   *  pending state). */
  original: GanttPeriod;
}

/** Threshold below which pointer motion is treated as a click (preserves
 *  double-click-to-open semantics). 4 px matches the canonical MUI pattern. */
export const DRAG_PENDING_THRESHOLD_PX = 4;

/**
 * Snap a pixel delta to a whole-day count for a given zoom. Pure rounding —
 *  we don't floor on a particular side because symmetric rounding keeps
 *  left/right edges consistent under the same gesture.
 */
export function deltaDaysFromPx(deltaPx: number, zoom: GanttZoom): number {
  return Math.round(deltaPx / PX_PER_DAY[zoom]);
}

/**
 * Shift the whole period by `deltaDays`. Both start and end move by the same
 * amount; duration is preserved. Used by the `body` drag kind.
 */
export function periodWithShift(
  period: GanttPeriod,
  deltaDays: number
): GanttPeriod {
  return {
    startKey: addDaysKey(period.startKey, deltaDays),
    endKey: addDaysKey(period.endKey, deltaDays),
  };
}

/**
 * Resize the period so the appropriate edge lands on `newEdgeDay` (a
 * YYYY-MM-DD key). The opposite edge stays put. Clamps so the result is
 * always a valid (non-inverted) period with at least one day of duration.
 *
 * Used by the `left` and `right` drag kinds.
 */
export function periodWithResize(
  period: GanttPeriod,
  kind: 'left' | 'right',
  newEdgeKey: string
): GanttPeriod {
  if (kind === 'left') {
    // new start = newEdgeKey; keep end fixed; clamp so newStart <= end.
    const gap = daysBetween(period.endKey, newEdgeKey); // positive iff newEdge < end
    if (gap <= 0) {
      // Would invert. Clamp start to end (single-day bar).
      return { startKey: period.endKey, endKey: period.endKey };
    }
    return { startKey: newEdgeKey, endKey: period.endKey };
  }
  // right
  const gap = daysBetween(newEdgeKey, period.startKey);
  if (gap <= 0) {
    return { startKey: period.startKey, endKey: period.startKey };
  }
  return { startKey: period.startKey, endKey: newEdgeKey };
}

/** Visual status derived from a period's relation to today. Pure read —
 *  no IO — so callers (GanttBar, tooltip text, accessibility tree) all
 *  agree on the same definition. Mirrors §9 P0 #2 design. */
export type PeriodStatus = 'overdue' | 'inProgress' | 'normal';

/**
 * Classify a `GanttPeriod` against `today` (YYYY-MM-DD string compare
 * is locale-independent for the ISO format and matches `todayKey() <
 * period.endKey` etc.):
 *   - 'overdue'    — end is strictly before today (the work missed its window)
 *   - 'inProgress' — today is inside [start, end] inclusive (work active)
 *   - 'normal'     — start is strictly after today (scheduled in the future)
 *
 * A period that ends exactly on today is `inProgress` (today is still a
 * valid working day within it). A period that starts exactly on today
 * is also `inProgress` (today is day 1). Boundaries are inclusive on
 * both ends.
 */
export function periodStatus(period: GanttPeriod, today: string): PeriodStatus {
  if (period.endKey < today) return 'overdue';
  if (period.startKey <= today && today <= period.endKey) return 'inProgress';
  return 'normal';
}

/**
 * Compute the day-key that a given client-X position maps to under a scale.
 * The pointer's X is taken relative to the SVG content area's left edge;
 * `scale.startKey` is at x=0.
 *
 * Day boundaries are integer multiples of `pxPerDay`. We use `Math.floor`
 * (not `Math.round`) so a click at the right edge of day N's bar snaps to
 * day N, not day N+1 — that matches how `rectFromPeriod` paints each day's
 * bar in the `[day*px, (day+1)*px)` half-open interval. Negative offsets
 * and offsets past the scale's right edge clamp to the inclusive bounds.
 */
export function dayKeyAtClientX(
  clientXWithinSvg: number,
  scale: GanttScale
): string {
  const px = PX_PER_DAY[scale.zoom];
  // floor preserves the half-open interval semantics — x=448 maps to day
  // 13 (2026-07-14), not day 14 (which is past the endKey).
  const rawOffset = Math.floor(clientXWithinSvg / px);
  const dayOffset = Math.max(0, Math.min(scale.totalDays - 1, rawOffset));
  return addDaysKey(scale.startKey, dayOffset);
}

// ─── Serialization (drag commit) ───────────────────────────────────────

/** Build the canonical `YYYYMMDD-YYYYMMDD` period tag from a parsed range.
 *  Normalizes so start <= end (defensive — `periodWithShift`/`periodWithResize`
 *  already guarantee this, but a caller passing a swapped range gets a
 *  deterministic tag). */
export function periodTagFromRange(p: GanttPeriod): string {
  if (p.startKey <= p.endKey) {
    return `${p.startKey.replace(/-/g, '')}-${p.endKey.replace(/-/g, '')}`;
  }
  return `${p.endKey.replace(/-/g, '')}-${p.startKey.replace(/-/g, '')}`;
}

// ─── Misc comparators ───────────────────────────────────────

/**
 * Inclusive day delta from `anchorKey` to `targetKey` — the inverse direction
 * of `daysBetween`. Specifically `dayKeyDiff(a, b) === daysBetween(b, a)`;
 * named separately so the scroll-to-Today math in the view reads as
 * "target - anchor" (the offset the user wants to jump by) rather than the
 * "first - second" idiom `daysBetween` documents.
 *
 * Positive means `target` is later than `anchor`; negative means earlier.
 * DST-safe via the same UTC-midnight arithmetic `daysBetween` uses.
 */
export function dayKeyDiff(anchorKey: string, targetKey: string): number {
  return daysBetween(targetKey, anchorKey);
}

/** Strict equality on a `GanttPeriod`'s two YYYY-MM-DD keys. Lets the drag
 *  hook's commit path short-circuit when the user released the pointer
 *  without actually changing the period (a no-op drag that crossed the
 *  pending→dragging threshold but rounded back to the same day). */
export function periodsEqual(a: GanttPeriod, b: GanttPeriod): boolean {
  return a.startKey === b.startKey && a.endKey === b.endKey;
}