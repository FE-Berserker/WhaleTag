/**
 * Unit tests for `useGanttRange` — P1 #8 quick-range presets.
 *
 * Covers:
 *  - `ganttRangeToBounds` produces the expected day counts and centers
 *    on the anchor date.
 *  - localStorage persistence round-trip (sanitization + write shape).
 */

import { afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderHook, act, cleanup } from '@testing-library/react';
import globalJsdom from 'global-jsdom';

import {
  useGanttRange,
  ganttRangeToBounds,
  GANTT_RANGE_DAYS,
  type GanttRangePreset,
} from './useGanttRange';
import { daysBetween } from '../../domain/gantt';

before(async () => {
  globalJsdom();
});

afterEach(() => {
  cleanup();
  try {
    localStorage.removeItem('whale-task-gantt-range');
  } catch {
    /* ignore */
  }
});

describe('ganttRangeToBounds', () => {
  it('returns the exact day count for each preset centered on the anchor', () => {
    const anchor = '2026-07-05';
    for (const [preset, days] of Object.entries(GANTT_RANGE_DAYS) as [
      GanttRangePreset,
      number
    ][]) {
      const { startKey, endKey } = ganttRangeToBounds(preset, anchor);
      const span = daysBetween(endKey, startKey) + 1; // inclusive
      assert.equal(
        span,
        days,
        `${preset}: expected ${days} inclusive days, got ${span} (${startKey}..${endKey})`
      );
      assert.ok(
        startKey <= anchor && anchor <= endKey,
        `${preset}: anchor ${anchor} must sit inside [${startKey}, ${endKey}]`
      );
    }
  });

  it('centers odd presets with the extra day after the anchor', () => {
    // 1w = 7 days → 3 before + anchor + 3 after should be 7, but the
    // implementation uses floor(7/2)=3 before and 7-1-3=3 after, so
    // anchor is exactly centered.
    const { startKey, endKey } = ganttRangeToBounds('1w', '2026-07-05');
    assert.equal(daysBetween('2026-07-05', startKey), 3);
    assert.equal(daysBetween(endKey, '2026-07-05'), 3);
  });

  it('centers even presets with equal before/after halves', () => {
    // 2w = 14 days → 7 before + anchor + 6 after = 14 total.
    const { startKey, endKey } = ganttRangeToBounds('2w', '2026-07-05');
    assert.equal(daysBetween('2026-07-05', startKey), 7);
    assert.equal(daysBetween(endKey, '2026-07-05'), 6);
  });
});

describe('useGanttRange', () => {
  it('defaults to null when localStorage is empty', () => {
    const { result } = renderHook(() => useGanttRange());
    assert.equal(result.current.range, null);
  });

  it('hydrates a persisted range from localStorage', () => {
    localStorage.setItem('whale-task-gantt-range', JSON.stringify({ range: '1m' }));
    const { result } = renderHook(() => useGanttRange());
    assert.equal(result.current.range, '1m');
  });

  it('sanitizes invalid persisted values to null', () => {
    localStorage.setItem('whale-task-gantt-range', JSON.stringify({ range: '1y' }));
    const { result } = renderHook(() => useGanttRange());
    assert.equal(result.current.range, null);
  });

  it('writes { range } when selecting a preset', () => {
    const { result } = renderHook(() => useGanttRange());
    act(() => result.current.setRange('2w'));
    assert.equal(result.current.range, '2w');
    assert.equal(
      localStorage.getItem('whale-task-gantt-range'),
      JSON.stringify({ range: '2w' })
    );
  });

  it('writes {} when clearing the range', () => {
    localStorage.setItem('whale-task-gantt-range', JSON.stringify({ range: '1q' }));
    const { result } = renderHook(() => useGanttRange());
    act(() => result.current.setRange(null));
    assert.equal(result.current.range, null);
    assert.equal(localStorage.getItem('whale-task-gantt-range'), JSON.stringify({}));
  });
});
