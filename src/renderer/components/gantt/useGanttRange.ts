/**
 * `useGanttRange` — P1 #8 quick-range presets (1w / 2w / 1m / 1q).
 *
 * Owns the optional range override for the Gantt timeline's visible
 * scale. When `range` is null, the timeline derives its scale from the
 * natural task range (existing behavior). When set, the timeline uses
 * `ganttRangeToBounds(range, anchorKey=today)` as the start/end and
 * `scaleForRange` for padding + width math.
 *
 * Why a SEPARATE hook from `useGanttZoom`: zoom controls px-per-day
 * (how big a day looks); range controls span (how many days are
 * visible). They're orthogonal — `range='1q' zoom='day'` shows a
 * quarter at 1-day granularity; `range='1q' zoom='week'` shows the
 * same quarter with week-sized columns. The toolbar ToggleButtonGroup
 * lets the user pick from a curated list of common combinations
 * without exposing the underlying two-axis model.
 *
 * localStorage key: `whale-task-gantt-range`. The `zoom` field is
 * unchanged (`whale-task-gantt-zoom`); this hook owns a separate
 * preference, persisted as `{ "range": "1m" } | {}`.
 */
import { useCallback, useEffect, useState } from 'react';

import { readPrefs, writePrefs } from '../../../shared/perspective-prefs';
import { todayKey } from '../../../shared/gantt';

/** Curated quick-range presets. Each maps to a fixed day-span centered
 *  on today; the toolbar renders one ToggleButton per entry. Add new
 *  entries here to expose them in the UI. */
export type GanttRangePreset = '1w' | '2w' | '1m' | '1q';

const RANGE_DAYS: Record<GanttRangePreset, number> = {
  '1w': 7,
  '2w': 14,
  '1m': 30,
  '1q': 90,
};

/** Localized button labels for the toolbar. The Toolbar reads this
 *  via the i18n key `ganttShortcut<Range>` (e.g. `ganttShortcut1w`).
 *  Kept here as a single source of truth so the toolbar doesn't have
 *  to remember the per-range key naming. */
export const RANGE_LABEL_KEYS: Record<GanttRangePreset, string> = {
  '1w': 'ganttShortcut1w',
  '2w': 'ganttShortcut2w',
  '1m': 'ganttShortcut1m',
  '1q': 'ganttShortcut1q',
};

/** Defensive coerce — tampered / outdated localStorage entries must
 *  not crash the view. */
function sanitizeRange(value: unknown): GanttRangePreset | null {
  return value === '1w' || value === '2w' || value === '1m' || value === '1q'
    ? value
    : null;
}

const PREFS_KEY = 'whale-task-gantt-range';

interface RangePrefs {
  range?: GanttRangePreset;
}

export interface UseGanttRangeResult {
  range: GanttRangePreset | null;
  setRange: (next: GanttRangePreset | null) => void;
}

/**
 * Persists the Gantt's quick-range override. Returns `range: null`
 * when no preset is selected (timeline falls back to the natural
 * task-range derivation). Re-reads on mount for cross-tab consistency
 * (cheap — one localStorage get on mount only).
 */
export function useGanttRange(): UseGanttRangeResult {
  const [range, setRangeState] = useState<GanttRangePreset | null>(() => {
    const prefs = readPrefs<RangePrefs>(PREFS_KEY);
    return sanitizeRange(prefs?.range) ?? null;
  });

  useEffect(() => {
    const prefs = readPrefs<RangePrefs>(PREFS_KEY);
    const persisted = sanitizeRange(prefs?.range) ?? null;
    if (persisted !== range) setRangeState(persisted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setRange = useCallback((next: GanttRangePreset | null) => {
    setRangeState(next);
    writePrefs<RangePrefs>(PREFS_KEY, next ? { range: next } : {});
  }, []);

  return { range, setRange };
}

/**
 * Pure helper: convert a range preset to (startKey, endKey) bounds,
 * centered on `anchorKey` (default: today). Used by the Gantt timeline
 * when a range override is active.
 *
 * `Math.floor(days / 2)` puts roughly half before, half after the
 * anchor. For odd day counts (e.g. 7) the "after" side gets the
 * extra day, which matches "next N days" intuition ("show me the
 * next week" → today + 7 days, not today - 3 to today + 4).
 */
export function ganttRangeToBounds(
  range: GanttRangePreset,
  anchorKey: string = todayKey()
): { startKey: string; endKey: string } {
  const days = RANGE_DAYS[range];
  const halfBefore = Math.floor(days / 2);
  const halfAfter = days - 1 - halfBefore;
  // Add days via local date math (no Date object round-trip — keeps
  // TZ-safe per the §9 Gantt ISO-string invariant).
  const anchorMs = new Date(`${anchorKey}T00:00:00Z`).getTime();
  const startMs = anchorMs - halfBefore * 86_400_000;
  const endMs = anchorMs + halfAfter * 86_400_000;
  return {
    startKey: msToIso(startMs),
    endKey: msToIso(endMs),
  };
}

function msToIso(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Exposed for unit tests + future hooks that want the day counts. */
export const GANTT_RANGE_DAYS = RANGE_DAYS;