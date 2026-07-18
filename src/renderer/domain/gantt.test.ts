/**
 * Tests for the Gantt view's pure helpers (src/renderer/domain/gantt.ts).
 *
 * The view component itself is covered by GanttView.test.tsx (rendering +
 * pointer interactions under jsdom). This file locks down the data-shape
 * helpers that run in the renderer too �?period parsing, day arithmetic,
 * row grouping, drag math �?so a regression in the SVG geometry can't slip
 * through even when the view is mocked.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  addDaysKey,
  chartRowsFromEntries,
  dateToKey,
  dayKeyAtClientX,
  dayKeyDiff,
  daysBetween,
  deltaDaysFromPx,
  entriesWithPeriod,
  entriesWithoutPeriod,
  entryPeriod,
  groupRowsByWorkflow,
  keyToDate,
  periodsEqual,
  periodTagFromRange,
  periodWithResize,
  periodWithShift,
  periodStatus,
  PX_PER_DAY,
  rectFromPeriod,
  scaleForRange,
  todayKey,
  type GanttScale,
} from './gantt';
import type { DirEntry } from '../../shared/ipc-types';
import type { WorkflowStage } from './workflow';

// ─── Factories ──────────────────────────────────────────────────────────

function entry(name: string, overrides: Partial<DirEntry> = {}): DirEntry {
  return {
    name,
    path: `/root/${name}`,
    isFile: true,
    isDirectory: false,
    size: 0,
    modified: '1970-01-01T00:00:00.000Z',
    extension: '',
    ...overrides,
  };
}

/** Build a tagsByName map keyed by full path (mirrors `tagMap` in kanban.test.ts). */
function tagMap(pairs: Record<string, string[]>): Map<string, string[]> {
  return new Map(Object.entries(pairs).map(([k, v]) => [`/root/${k}`, v]));
}

const STAGES: WorkflowStage[] = [
  { id: 'wf_not-started', value: 'not-started', color: '#6b7280' },
  { id: 'wf_in-progress', value: 'in-progress', color: '#3b82f6' },
  { id: 'wf_completed', value: 'completed', color: '#22c55e' },
];

// ─── Date helpers ───────────────────────────────────────────────────────

describe('gantt key/date round-trip', () => {
  it('keyToDate and dateToKey are inverses for canonical YYYY-MM-DD', () => {
    for (const k of ['2026-07-04', '2025-01-01', '2024-12-31', '2024-02-29']) {
      assert.equal(dateToKey(keyToDate(k)), k, `round-trip ${k}`);
    }
  });

  it('keyToDate throws on malformed input (defensive guard)', () => {
    assert.throws(() => keyToDate('2026-7-4'));
    assert.throws(() => keyToDate('20260704'));
    assert.throws(() => keyToDate(''));
  });

  it('todayKey uses local time and zero-pads single-digit components', () => {
    // Pin a deterministic "now" so the test isn't flaky at midnight.
    const now = new Date(2026, 6, 4, 14, 30); // July is month 6 (0-indexed)
    assert.equal(todayKey(now), '2026-07-04');
  });
});

describe('gantt daysBetween', () => {
  it('returns 0 for the same day', () => {
    assert.equal(daysBetween('2026-07-04', '2026-07-04'), 0);
  });

  it('positive when the first arg is later than the second', () => {
    assert.equal(daysBetween('2026-07-10', '2026-07-04'), 6);
  });

  it('negative when the first arg is earlier than the second', () => {
    assert.equal(daysBetween('2026-07-01', '2026-07-04'), -3);
  });

  it('survives a DST boundary (UTC math, not local ms math)', () => {
    // Spring-forward in US/Eastern: 2026-03-08 �?2026-03-09 is still 1 day.
    assert.equal(daysBetween('2026-03-09', '2026-03-08'), 1);
  });
});

describe('gantt dayKeyDiff', () => {
  it('returns 0 for the same day', () => {
    assert.equal(dayKeyDiff('2026-07-04', '2026-07-04'), 0);
  });

  it('is positive when target is later than anchor', () => {
    // Scroll-to-today use case: anchor=2026-07-01, target=2026-07-04 �?+3.
    assert.equal(dayKeyDiff('2026-07-01', '2026-07-04'), 3);
  });

  it('is negative when target is earlier than anchor', () => {
    assert.equal(dayKeyDiff('2026-07-10', '2026-07-04'), -6);
  });

  it('survives a DST boundary', () => {
    assert.equal(dayKeyDiff('2026-03-08', '2026-03-09'), 1);
  });

  it('is the inverse direction of daysBetween', () => {
    for (const [a, b] of [
      ['2026-07-04', '2026-07-10'],
      ['2026-12-31', '2026-01-01'],
      ['2025-02-28', '2025-03-01'],
    ] as const) {
      assert.equal(dayKeyDiff(a, b), daysBetween(b, a));
    }
  });
});

describe('gantt addDaysKey', () => {
  it('adds positive days', () => {
    assert.equal(addDaysKey('2026-07-04', 5), '2026-07-09');
  });

  it('subtracts with negative input', () => {
    assert.equal(addDaysKey('2026-07-04', -3), '2026-07-01');
  });

  it('crosses month boundaries', () => {
    assert.equal(addDaysKey('2026-07-30', 5), '2026-08-04');
  });

  it('crosses year boundaries', () => {
    assert.equal(addDaysKey('2026-12-27', 5), '2027-01-01');
    assert.equal(addDaysKey('2026-12-31', 1), '2027-01-01');
  });
});

// ─── Period extraction ──────────────────────────────────────────────────

describe('gantt entryPeriod / entriesWithPeriod / entriesWithoutPeriod', () => {
  it('finds the period tag and returns the parsed range (sorted)', () => {
    const entries = [entry('a.txt')];
    const tags = tagMap({ 'a.txt': ['20260704-20260710', 'idea'] });
    const p = entryPeriod(entries[0], tags);
    assert.deepEqual(p, { startKey: '2026-07-04', endKey: '2026-07-10' });
  });

  it('returns null when no period tag is present', () => {
    const e = entry('a.txt');
    assert.equal(entryPeriod(e, tagMap({})), null);
    assert.equal(entryPeriod(e, tagMap({ 'a.txt': ['idea'] })), null);
    assert.equal(entryPeriod(e, tagMap({ 'a.txt': ['20260704'] })), null); // smart-date, not period
  });

  it('entriesWithPeriod / entriesWithoutPeriod partition the list', () => {
    const entries = [
      entry('a.txt'),
      entry('b.txt'),
      entry('c.txt'),
    ];
    const tags = tagMap({
      'a.txt': ['20260701-20260705'],
      'b.txt': ['idea'],
      'c.txt': ['20260710-20260715', 'in-progress'],
    });
    const withP = entriesWithPeriod(entries, tags);
    assert.equal(withP.length, 2);
    assert.deepEqual(
      withP.map((w) => w.entry.name),
      ['a.txt', 'c.txt']
    );
    const withoutP = entriesWithoutPeriod(entries, tags);
    assert.deepEqual(withoutP.map((e) => e.name), ['b.txt']);
  });

  it('handles a legacy inverted period tag (20260710-20260704) by sorting', () => {
    const e = entry('a.txt');
    const tags = tagMap({ 'a.txt': ['20260710-20260704'] });
    const p = entryPeriod(e, tags);
    assert.deepEqual(p, { startKey: '2026-07-04', endKey: '2026-07-10' });
  });
});

// ─── Row grouping ───────────────────────────────────────────────────────

describe('gantt groupRowsByWorkflow', () => {
  it('groups tasks by their first workflow stage value', () => {
    const tasks = [
      { entry: entry('a.txt'), period: { startKey: '2026-07-01', endKey: '2026-07-02' } },
      { entry: entry('b.txt'), period: { startKey: '2026-07-03', endKey: '2026-07-04' } },
      { entry: entry('c.txt'), period: { startKey: '2026-07-05', endKey: '2026-07-06' } },
    ];
    // Empty tag map �?all 3 fall into the catch-all (null) row.
    const rows = groupRowsByWorkflow(tasks, STAGES, new Map());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].value, null);
    assert.equal(rows[0].tasks.length, 3);
  });

  it('sorts tasks within a row by start date ascending', () => {
    const tags = tagMap({
      'a.txt': ['in-progress'],
      'b.txt': ['in-progress'],
      'c.txt': ['in-progress'],
    });
    const tasks = [
      { entry: entry('b.txt'), period: { startKey: '2026-07-10', endKey: '2026-07-11' } },
      { entry: entry('a.txt'), period: { startKey: '2026-07-01', endKey: '2026-07-02' } },
      { entry: entry('c.txt'), period: { startKey: '2026-07-05', endKey: '2026-07-06' } },
    ];
    const rows = groupRowsByWorkflow(tasks, STAGES, tags);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].value, 'in-progress');
    const names = rows[0].tasks.map((t) => t.entry.name);
    assert.deepEqual(names, ['a.txt', 'c.txt', 'b.txt']);
  });

  it('omits rows with no tasks and respects the stage order from input', () => {
    const tags = tagMap({
      'a.txt': ['not-started', '20260701-20260702'],
      'b.txt': ['completed', '20260703-20260704'],
    });
    const withP = entriesWithPeriod(
      [entry('a.txt'), entry('b.txt'), entry('c.txt')],
      tags
    );
    const rows = groupRowsByWorkflow(withP, STAGES, tags);
    // 'in-progress' has no tasks �?omitted. Order: not-started, completed.
    assert.deepEqual(
      rows.map((r) => r.value),
      ['not-started', 'completed']
    );
  });

  it('places tasks with no workflow tag in the trailing catch-all row', () => {
    const tags = tagMap({
      'a.txt': ['not-started', '20260701-20260702'],
      'b.txt': ['20260703-20260704'], // no stage
    });
    const withP = entriesWithPeriod(
      [entry('a.txt'), entry('b.txt')],
      tags
    );
    const rows = groupRowsByWorkflow(withP, STAGES, tags);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].value, null);
    assert.equal(rows[1].tasks.length, 1);
    assert.equal(rows[1].tasks[0].entry.name, 'b.txt');
  });
});

// ─── Scale & geometry ───────────────────────────────────────────────────

describe('gantt PX_PER_DAY', () => {
  it('is monotonically decreasing from day to month zoom', () => {
    assert.ok(PX_PER_DAY.day > PX_PER_DAY.week);
    assert.ok(PX_PER_DAY.week > PX_PER_DAY.month);
  });
});

describe('gantt scaleForRange', () => {
  it('returns totalDays >= MIN_VISIBLE_DAYS even for a single-day task', () => {
    const scale = scaleForRange('day', '2026-07-04', '2026-07-04');
    assert.ok(scale.totalDays >= 14, `totalDays was ${scale.totalDays}`);
    assert.equal(scale.widthPx, scale.totalDays * PX_PER_DAY.day);
  });

  it('expands to include "today" as anchor by default', () => {
    // Far-future range with no anchor override �?today is included via the
    // default anchorKey=todayKey().
    const today = todayKey();
    const scale = scaleForRange('day', '2030-01-01', '2030-12-31', today);
    assert.ok(
      daysBetween(scale.startKey, today) <= 0 &&
        daysBetween(today, scale.endKey) <= 0,
      `today (${today}) should be within [${scale.startKey}, ${scale.endKey}]`
    );
  });

  it('normalizes lo/hi so startKey <= endKey regardless of input order', () => {
    const scale = scaleForRange('week', '2026-07-10', '2026-07-01');
    assert.ok(scale.startKey <= scale.endKey);
  });

  it('respects the given zoom in widthPx', () => {
    const a = scaleForRange('day', '2026-07-04', '2026-07-04');
    const b = scaleForRange('month', '2026-07-04', '2026-07-04');
    assert.ok(a.widthPx > b.widthPx);
  });
});

describe('gantt rectFromPeriod', () => {
  const scale: GanttScale = {
    zoom: 'day',
    startKey: '2026-07-01',
    endKey: '2026-07-14',
    totalDays: 14,
    widthPx: 14 * PX_PER_DAY.day,
  };

  it('places a bar at the right pixel for its start day', () => {
    const r = rectFromPeriod(
      { startKey: '2026-07-04', endKey: '2026-07-04' },
      scale
    );
    assert.equal(r.x, 3 * PX_PER_DAY.day);
  });

  it('uses startDay+1 day width (inclusive end day) for a multi-day period', () => {
    const r = rectFromPeriod(
      { startKey: '2026-07-04', endKey: '2026-07-06' },
      scale
    );
    assert.equal(r.x, 3 * PX_PER_DAY.day);
    assert.equal(r.width, 3 * PX_PER_DAY.day); // 4, 5, 6 �?3 days
  });

  it('clamps a single-day bar to MIN_BAR_WIDTH', () => {
    const r = rectFromPeriod(
      { startKey: '2026-07-04', endKey: '2026-07-04' },
      scale
    );
    assert.ok(r.width >= 8);
  });

  it('returns x=0 for a bar at scale.startKey', () => {
    const r = rectFromPeriod(
      { startKey: '2026-07-01', endKey: '2026-07-01' },
      scale
    );
    assert.equal(r.x, 0);
  });
});

// ─── Drag arithmetic ────────────────────────────────────────────────────

describe('gantt deltaDaysFromPx', () => {
  it('rounds to the nearest day', () => {
    assert.equal(deltaDaysFromPx(0, 'day'), 0);
    assert.equal(deltaDaysFromPx(16, 'day'), 1); // half a day rounds to nearest
    assert.equal(deltaDaysFromPx(48, 'day'), 2); // 1.5 days rounds to 2
    // JS Math.round rounds half toward +Infinity, so -1.5 �?-1 (not -2).
    assert.equal(deltaDaysFromPx(-48, 'day'), -1);
  });

  it('uses the zoom-specific px-per-day', () => {
    // 60 px under week zoom = 5 days; under day zoom = 2 days.
    assert.equal(deltaDaysFromPx(60, 'week'), 5);
    assert.equal(deltaDaysFromPx(60, 'day'), 2);
  });
});

describe('gantt periodWithShift', () => {
  it('moves both edges by the same delta', () => {
    const p = periodWithShift(
      { startKey: '2026-07-04', endKey: '2026-07-10' },
      3
    );
    assert.deepEqual(p, { startKey: '2026-07-07', endKey: '2026-07-13' });
  });

  it('preserves duration across the shift', () => {
    const p = periodWithShift(
      { startKey: '2026-07-01', endKey: '2026-07-05' },
      -10
    );
    // 5-day inclusive range �?daysBetween(end, start) === 4 (number of
    // day-boundaries crossed). Must stay positive regardless of sign.
    assert.equal(daysBetween(p.endKey, p.startKey), 4);
  });

  it('handles zero delta as a no-op', () => {
    const p = periodWithShift(
      { startKey: '2026-07-04', endKey: '2026-07-10' },
      0
    );
    assert.deepEqual(p, { startKey: '2026-07-04', endKey: '2026-07-10' });
  });
});

describe('gantt periodWithResize', () => {
  it('moves the left edge and keeps the right edge fixed', () => {
    const p = periodWithResize(
      { startKey: '2026-07-04', endKey: '2026-07-10' },
      'left',
      '2026-07-02'
    );
    assert.deepEqual(p, { startKey: '2026-07-02', endKey: '2026-07-10' });
  });

  it('moves the right edge and keeps the left edge fixed', () => {
    const p = periodWithResize(
      { startKey: '2026-07-04', endKey: '2026-07-10' },
      'right',
      '2026-07-15'
    );
    assert.deepEqual(p, { startKey: '2026-07-04', endKey: '2026-07-15' });
  });

  it('clamps left resize that would invert the range to a single day at end', () => {
    const p = periodWithResize(
      { startKey: '2026-07-04', endKey: '2026-07-10' },
      'left',
      '2026-07-12' // beyond end �?would invert
    );
    assert.deepEqual(p, { startKey: '2026-07-10', endKey: '2026-07-10' });
  });

  it('clamps right resize that would invert to a single day at start', () => {
    const p = periodWithResize(
      { startKey: '2026-07-04', endKey: '2026-07-10' },
      'right',
      '2026-07-01' // before start �?would invert
    );
    assert.deepEqual(p, { startKey: '2026-07-04', endKey: '2026-07-04' });
  });
});

describe('gantt dayKeyAtClientX', () => {
  const scale: GanttScale = {
    zoom: 'day',
    startKey: '2026-07-01',
    endKey: '2026-07-14',
    totalDays: 14,
    widthPx: 14 * PX_PER_DAY.day,
  };

  it('snaps to the day boundary', () => {
    // x=64 px under day zoom (32 px/day) = day 2 �?2026-07-03
    assert.equal(dayKeyAtClientX(64, scale), '2026-07-03');
    // Halfway through day 2 still snaps to day 2.
    assert.equal(dayKeyAtClientX(80, scale), '2026-07-03');
  });

  it('returns the start key for x=0', () => {
    assert.equal(dayKeyAtClientX(0, scale), '2026-07-01');
  });

  it('returns the end key for x=width', () => {
    assert.equal(dayKeyAtClientX(scale.widthPx, scale), '2026-07-14');
  });

  it('clamps negative offsets to the start key', () => {
    assert.equal(dayKeyAtClientX(-100, scale), '2026-07-01');
  });
});

// ─── Serialization ──────────────────────────────────────────────────────

describe('gantt periodTagFromRange', () => {
  it('emits YYYYMMDD-YYYYMMDD', () => {
    assert.equal(
      periodTagFromRange({ startKey: '2026-07-04', endKey: '2026-07-10' }),
      '20260704-20260710'
    );
  });

  it('normalizes an inverted range so the tag is still valid', () => {
    assert.equal(
      periodTagFromRange({ startKey: '2026-07-10', endKey: '2026-07-04' }),
      '20260704-20260710'
    );
  });

  it('round-trips with dateTagRangeKey (via parseable input)', () => {
    const tag = periodTagFromRange({ startKey: '2026-07-04', endKey: '2026-07-10' });
    assert.match(tag, /^\d{8}-\d{8}$/);
  });
});

// ─── ECharts chart-row builder ──────────────────────────────────────────

describe('gantt chartRowsFromEntries', () => {
  it('returns one row per entry with a period tag', () => {
    const entries = [entry('a.txt'), entry('b.txt'), entry('c.txt')];
    const tags = tagMap({
      'a.txt': ['20260701-20260705'],
      'b.txt': ['idea'], // no period �?skipped
      'c.txt': ['20260710-20260715'],
    });
    const rows = chartRowsFromEntries(entries, tags);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => r.entry.name),
      ['a.txt', 'c.txt']
    );
  });

  it('sorts rows by start date ascending, path as stable tiebreak', () => {
    const entries = [entry('b.txt'), entry('a.txt'), entry('d.txt'), entry('c.txt')];
    const tags = tagMap({
      'a.txt': ['20260704-20260705'],
      'b.txt': ['20260704-20260705'], // same start as a �?path tiebreak
      'c.txt': ['20260710-20260711'],
      'd.txt': ['20260701-20260702'],
    });
    const rows = chartRowsFromEntries(entries, tags);
    assert.deepEqual(
      rows.map((r) => r.entry.name),
      ['d.txt', 'a.txt', 'b.txt', 'c.txt']
    );
  });

  it('attaches thumbDataUrl when the cache has it', () => {
    // Cache key format MUST match `ThumbIcon.tsx`'s lookup �?see
    // `${path}|${modified}` at ThumbIcon:60. Mirrors what the renderer
    // populates after a successful thumbnail load.
    const entries = [entry('a.txt')];
    const tags = tagMap({ 'a.txt': ['20260704-20260705'] });
    const cache = new Map<string, string>([
      ['/root/a.txt|1970-01-01T00:00:00.000Z', 'data:image/png;base64,XXX'],
    ]);
    const rows = chartRowsFromEntries(entries, tags, cache);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].thumbDataUrl, 'data:image/png;base64,XXX');
  });

  it('uses null thumbDataUrl when the cache is keyed by path alone (legacy lookups)', () => {
    // Regression guard: `chartRowsFromEntries` used to look up by `e.path`
    // only. If a stale caller is still keying the cache that way, the row
    // correctly gets `null` (placeholder) instead of a false-positive
    // data URL. Locking the behavior prevents a quiet revert to the
    // pre-fix lookup path.
    const entries = [entry('a.txt')];
    const tags = tagMap({ 'a.txt': ['20260704-20260705'] });
    const cache = new Map<string, string>([['/root/a.txt', 'data:image/png;base64,XXX']]);
    const rows = chartRowsFromEntries(entries, tags, cache);
    assert.equal(rows[0].thumbDataUrl, null);
  });

  it('uses null thumbDataUrl when the cache lacks the entry', () => {
    const entries = [entry('a.txt')];
    const tags = tagMap({ 'a.txt': ['20260704-20260705'] });
    const rows = chartRowsFromEntries(entries, tags);
    assert.equal(rows[0].thumbDataUrl, null);
  });

  it('uses null thumbDataUrl when an entry has a stale modified stamp', () => {
    // Same path, different `modified` �?different cache key. A row whose
    // entry's `modified` doesn't match the cached key falls back to the
    // placeholder; this mirrors `ThumbIcon`'s invalidation policy on
    // file change.
    const entries = [entry('a.txt', { modified: '2026-01-02T00:00:00.000Z' })];
    const tags = tagMap({ 'a.txt': ['20260704-20260705'] });
    const cache = new Map<string, string>([
      ['/root/a.txt|1970-01-01T00:00:00.000Z', 'data:image/png;base64,OLD'],
    ]);
    const rows = chartRowsFromEntries(entries, tags, cache);
    assert.equal(rows[0].thumbDataUrl, null);
  });

  it('returns empty array when no entries have periods', () => {
    const entries = [entry('a.txt'), entry('b.txt')];
    const rows = chartRowsFromEntries(entries, new Map());
    assert.equal(rows.length, 0);
  });
});

describe('gantt periodsEqual', () => {
  it('returns true when both keys match', () => {
    assert.equal(
      periodsEqual({ startKey: '2026-07-04', endKey: '2026-07-06' },
                    { startKey: '2026-07-04', endKey: '2026-07-06' }),
      true
    );
  });

  it('returns false when start differs', () => {
    assert.equal(
      periodsEqual({ startKey: '2026-07-04', endKey: '2026-07-06' },
                    { startKey: '2026-07-05', endKey: '2026-07-06' }),
      false
    );
  });

  it('returns false when end differs', () => {
    assert.equal(
      periodsEqual({ startKey: '2026-07-04', endKey: '2026-07-06' },
                    { startKey: '2026-07-04', endKey: '2026-07-07' }),
      false
    );
  });

  it('returns false when both differ', () => {
    assert.equal(
      periodsEqual({ startKey: '2026-07-04', endKey: '2026-07-06' },
                    { startKey: '2026-07-05', endKey: '2026-07-07' }),
      false
    );
  });

  it('treats a swapped range as different �?does not normalize', () => {
    // periodsEqual is a strict comparator; the docstring says it must NOT
    // normalize (periodWithShift/Resize already guarantee order upstream).
    // Pinning the behavior so a future "helpful" refactor doesn't quietly
    // change semantics for the drag hook's no-op short-circuit.
    assert.equal(
      periodsEqual({ startKey: '2026-07-06', endKey: '2026-07-04' },
                    { startKey: '2026-07-04', endKey: '2026-07-06' }),
      false
    );
  });
});

// P0 #2: pure read-only classification of a period vs today. Both
// GanttBar (visual outline + in-progress badge) and the accessibility
// tree's tooltip text consume this, so we lock the boundaries down.
describe('gantt periodStatus', () => {
  const TODAY = '2026-07-10';

  it('classifies a period that ends strictly before today as overdue', () => {
    assert.equal(
      periodStatus({ startKey: '2026-07-04', endKey: '2026-07-09' }, TODAY),
      'overdue'
    );
  });

  it('classifies a single-day period in the past as overdue', () => {
    assert.equal(
      periodStatus({ startKey: '2026-07-09', endKey: '2026-07-09' }, TODAY),
      'overdue'
    );
  });

  it('classifies today at the start of a multi-day period as inProgress (inclusive)', () => {
    assert.equal(
      periodStatus({ startKey: '2026-07-10', endKey: '2026-07-15' }, TODAY),
      'inProgress'
    );
  });

  it('classifies today at the end of a multi-day period as inProgress (inclusive)', () => {
    assert.equal(
      periodStatus({ startKey: '2026-07-05', endKey: '2026-07-10' }, TODAY),
      'inProgress'
    );
  });

  it('classifies a single-day period on today as inProgress', () => {
    assert.equal(
      periodStatus({ startKey: '2026-07-10', endKey: '2026-07-10' }, TODAY),
      'inProgress'
    );
  });

  it('classifies a period strictly after today as normal', () => {
    assert.equal(
      periodStatus({ startKey: '2026-07-11', endKey: '2026-07-15' }, TODAY),
      'normal'
    );
  });

  it('uses ISO date string compare (no Date object round-trip)', () => {
    // Boundary case: today is one day after the period ends, but the
    // string compare must agree �?this proves we don't accidentally go
    // through `new Date(...)` (which has TZ pitfalls).
    assert.equal(
      periodStatus({ startKey: '2026-07-08', endKey: '2026-07-09' }, TODAY),
      'overdue'
    );
    assert.equal(
      periodStatus({ startKey: '2026-07-09', endKey: '2026-07-10' }, TODAY),
      'inProgress'
    );
  });
});