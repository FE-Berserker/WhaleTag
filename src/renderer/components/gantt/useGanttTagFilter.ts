/**
 * `useGanttTagFilter` — multi-select filter hook for Gantt (P0 #5 + #6).
 *
 * Two filter dimensions live next to each other in the toolbar:
 *   - workflow stage (Kanban's column axis)
 *   - quadrant       (Matrix's quadrant axis)
 *
 * Each is independent — the row is "selected" iff BOTH its stage is in
 * the workflow selection AND its quadrant is in the quadrant selection.
 * When the user un-selects a value, rows carrying that value render at
 * `opacity: 0.3` and become non-interactive (the view gates drag +
 * context-menu writes on `isFilteredOut`).
 *
 * Defaults:
 *   - First paint: ALL currently-known values are selected (no filtering).
 *   - A value that didn't exist when the persisted prefs were written
 *     (e.g. a newly-added workflow stage) is auto-selected on first
 *     encounter — the user has to actively un-select it.
 *   - A value that WAS selected but has since been removed (e.g. user
 *     deleted a workflow stage) stays in the persisted Set; the view
 *     just doesn't render rows for non-existent stages, so it has no
 *     visible effect.
 *
 * Persistence:
 *   - localStorage key: `whale-task-gantt-filter`
 *   - shape: `{ workflow: string[]; quadrant: string[] }`
 *   - reads/writes go through the shared `readPrefs` / `writePrefs`
 *     helpers from [src/renderer/domain/perspective-prefs.ts](../renderer/domain/perspective-prefs.ts)
 *     so a tampered / quota-blocked storage can never crash the view
 *     (mirrors `useGanttZoom`'s pattern).
 *
 * Generic over `T extends string` so the two filter dimensions share one
 * implementation but type-check their values independently at the call
 * site (e.g. `useGanttTagFilter<WorkflowValue>('workflow', stageValues)`).
 *
 * Returns the live state plus a `toggle(value)` action. `toggle` is the
 * only mutation API; "select all" / "clear all" / "reset" are computed
 * from the current known-values list at the view layer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { readPrefs, writePrefs } from '../../domain/perspective-prefs';

/** Which filter dimension we're managing. */
export type GanttFilterKey = 'workflow' | 'quadrant';

/**
 * What the hook returns. Stable identity for the Set across renders when
 * contents don't change is NOT a goal — React reconciler only cares that
 * the consuming component re-renders on `selected` change (which it
 * always does, since we wrap the Set in a `useState`).
 */
export interface GanttTagFilter<T extends string> {
  /** Currently selected values (a value's row is filtered IN iff present). */
  selected: Set<T>;
  /** Toggle a single value in/out of the selection. */
  toggle: (value: T) => void;
  /** Replace the selection wholesale — used by "Reset" / "Clear all". */
  setAll: (values: Iterable<T>) => void;
  /** True iff the row carrying `values` (an entry's tag list) is
   *  filtered OUT by this hook. A row passes when ANY of its tag values
   *  is in `selected` (per-value OR semantics — e.g. a row with
   *  `urgent-important` passes when that quadrant is selected, even if
   *  it has no workflow tag and `workflow` selection is non-empty).
   *  This matches how a user thinks: "show me rows whose quadrant is
   *  one I've enabled"; rows with no relevant tag also pass (a
   *  tag-less row shouldn't disappear because the user toggled the
   *  filter).
   */
  passes: (entryTags: readonly string[]) => boolean;
}

const PREFS_KEY = 'whale-task-gantt-filter';

interface FilterPrefsShape {
  workflow?: unknown;
  quadrant?: unknown;
}

/** Coerce an unknown persisted value into a string array. Drops anything
 *  non-string; returns null if the result is empty (so callers can
 *  distinguish "stored nothing" from "stored []" — both are treated as
 *  "use defaults" by the hook). */
function sanitizeSelection(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((v): v is string => typeof v === 'string');
  return out.length > 0 ? out : null;
}

/** Read persisted selection for one key; null if missing or invalid. */
function readSelection(key: GanttFilterKey): Set<string> | null {
  const prefs = readPrefs<FilterPrefsShape>(PREFS_KEY);
  const sanitized = sanitizeSelection(prefs?.[key]);
  if (!sanitized) return null;
  return new Set(sanitized);
}

/** The hook.
 *
 * @param key        Which filter dimension ('workflow' or 'quadrant').
 * @param knownValues The values currently in the system (workflow stage
 *                    values from props, or the four fixed quadrants).
 *                    Used as the default selection on first paint / when
 *                    the persisted value is missing.
 */
export function useGanttTagFilter<T extends string>(
  key: GanttFilterKey,
  knownValues: readonly T[]
): GanttTagFilter<T> {
  // ─── State ───────────────────────────────────────────────────────
  // Initial selection: persisted (sanitized) if present, else ALL known
  // values (the "no filtering" default).
  const [selected, setSelected] = useState<Set<T>>(() => {
    const persisted = readSelection(key);
    if (persisted) return new Set(Array.from(persisted) as T[]);
    return new Set(knownValues);
  });

  // Track knownValues in a ref so the auto-include-new-values effect
  // can read the latest list without re-running on every parent render
  // (which would race the user's toggle clicks).
  const knownValuesRef = useRef(knownValues);
  knownValuesRef.current = knownValues;

  // Set of values the hook has EVER observed in `knownValues`. Used
  // by the auto-include effect to distinguish "new value the user
  // added to the system" (auto-include) from "user actively un-
  // selected this existing value" (leave alone).
  //
  // Without this distinction, the effect can't tell the difference
  // between the two cases — both look like "value not in selected" —
  // and would silently re-include user-unselected values whenever
  // the `knownValues` list grows for any reason (e.g. an unrelated
  // stage gets added).
  const seenValuesRef = useRef<Set<string>>(new Set(knownValues));

  // Auto-include values that didn't exist when the prefs were written.
  // E.g. user adds a new workflow stage → it shows up unfiltered by
  // default, even if the persisted selection was "all 3 originals".
  // Runs once per `knownValues` identity change.
  useEffect(() => {
    let didAdd = false;
    setSelected((prev) => {
      const next = new Set(prev);
      for (const v of knownValuesRef.current) {
        const isNew = !seenValuesRef.current.has(v);
        if (isNew && !next.has(v)) {
          next.add(v);
          didAdd = true;
        }
        seenValuesRef.current.add(v);
      }
      return didAdd ? next : prev;
    });
  }, [knownValues]);

  // Belt-and-suspenders re-read on mount — mirrors `useGanttZoom`'s
  // pattern. Protects against another tab / another component writing
  // the same key between the initial `useState` read and first paint.
  //
  // IMPORTANT: this REPLACES the selection wholesale (the "default to
  // all known values" only kicks in when nothing is persisted). The
  // auto-include effect above is what brings the selection back into
  // sync with the live `knownValues` list — so the persisted state
  // wins on mount, then any new known value gets union'd in.
  useEffect(() => {
    const persisted = readSelection(key);
    if (!persisted) return;
    setSelected(new Set(Array.from(persisted) as T[]));
    // Intentional: run once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Mutations ───────────────────────────────────────────────────
  const toggle = useCallback((value: T) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      // Persist AFTER deriving the next state — same pattern as
      // useGanttZoom.setZoom, so a quota error doesn't half-apply.
      writePrefs<FilterPrefsShape>(PREFS_KEY, {
        workflow: undefined,
        quadrant: undefined,
        [key]: Array.from(next),
      } as FilterPrefsShape);
      return next;
    });
  }, [key]);

  const setAll = useCallback((values: Iterable<T>) => {
    const next = new Set(values);
    setSelected(next);
    writePrefs<FilterPrefsShape>(PREFS_KEY, {
      workflow: undefined,
      quadrant: undefined,
      [key]: Array.from(next),
    } as FilterPrefsShape);
  }, [key]);

  // ─── Predicate ───────────────────────────────────────────────────
  // A row PASSES when:
  //   1. The row carries at least one KNOWN value (one that still
  //      exists in `knownValues`) AND at least one of those values is
  //      in the current `selected` set, OR
  //   2. The row carries NO known value AND the filter is in its
  //      "neutral" state (the user has not actively un-selected
  //      anything — `selected.size === knownValues.length`). In other
  //      words: tag-less rows are visible when the user hasn't done
  //      anything, but become hidden the moment the user narrows the
  //      filter. Without this rule, un-selecting every workflow stage
  //      would leave the chart showing only tag-less rows — the
  //      opposite of "show me only X" intuition.
  //
  // Legacy / removed values are ignored — a file carrying a since-
  // deleted stage tag shouldn't match against it.
  const passes = useCallback(
    (entryTags: readonly string[]): boolean => {
      const known = knownValuesRef.current;
      const knownSet = new Set(known);
      let hasKnownValue = false;
      let hasSelectedValue = false;
      for (const tag of entryTags) {
        if (!knownSet.has(tag as T)) continue;
        hasKnownValue = true;
        if (selected.has(tag as T)) {
          hasSelectedValue = true;
          break;
        }
      }
      if (hasKnownValue) return hasSelectedValue;
      // Tag-less row: pass only in the neutral state.
      return selected.size === known.length;
    },
    [selected]
  );

  return useMemo(
    () => ({ selected, toggle, setAll, passes }),
    [selected, toggle, setAll, passes]
  );
}
