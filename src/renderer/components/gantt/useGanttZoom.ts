/**
 * `useGanttZoom` — owns the Gantt zoom level (Day/Week/Month) and its
 * localStorage persistence. Replaces the raw `useState` + `useEffect` +
 * `localStorage.getItem` triplet the original `GanttView.tsx` had.
 *
 * localStorage key: `whale-task-gantt-zoom` (kept for backward compatibility
 * with the previous ECharts-era layout — same key the test file reads).
 *
 * Stored shape:
 *   `{ "zoom": "day" }`
 *
 * Reads swallow quota / disabled-storage errors via `readPrefs` /
 * `writePrefs` (see `src/renderer/domain/perspective-prefs.ts`) — a failed save
 * never surfaces.
 *
 * Scale derivation (`startKey` / `endKey`) is handled by `scaleForRange`
 * in `renderer/domain/gantt.ts` and is composed by the timeline — keeping this
 * hook narrowly scoped to zoom + persistence makes it unit-testable and
 * lets the timeline dictate the padding/anchoring policy.
 */
import { useCallback, useEffect, useState } from 'react';

import { readPrefs, writePrefs } from '../../domain/perspective-prefs';
import type { GanttZoom } from '../../domain/gantt';

const PREFS_KEY = 'whale-task-gantt-zoom';

interface ZoomPrefs {
  zoom?: GanttZoom;
}

/** Defensive coerce — tampered / outdated localStorage entries must not
 *  crash the view. Mirrors `sanitizeSubView` in `TaskView.tsx`. */
function sanitizeZoom(value: unknown): GanttZoom | null {
  return value === 'day' || value === 'week' || value === 'month'
    ? value
    : null;
}

/**
 * @param initialZoom The default zoom if no persisted value (typically
 *                    `'day'`). The first paint uses this synchronously so
 *                    SSR / first render never flashes a wrong zoom.
 */
export function useGanttZoom(
  initialZoom: GanttZoom = 'day'
): [GanttZoom, (next: GanttZoom) => void] {
  const [zoom, setZoomState] = useState<GanttZoom>(() => {
    const prefs = readPrefs<ZoomPrefs>(PREFS_KEY);
    return sanitizeZoom(prefs?.zoom) ?? initialZoom;
  });

  // Belt-and-suspenders re-read on mount — protects against another tab or
  // another component writing the same key between the initial `useState`
  // read and the first paint. Cheap (one localStorage get) and only runs
  // once.
  useEffect(() => {
    const prefs = readPrefs<ZoomPrefs>(PREFS_KEY);
    const persisted = sanitizeZoom(prefs?.zoom);
    if (persisted && persisted !== zoom) {
      setZoomState(persisted);
    }
    // Intentional: run once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setZoom = useCallback((next: GanttZoom) => {
    setZoomState(next);
    writePrefs<ZoomPrefs>(PREFS_KEY, { zoom: next });
  }, []);

  return [zoom, setZoom];
}
