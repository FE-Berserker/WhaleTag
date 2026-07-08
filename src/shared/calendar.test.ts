import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DirEntry } from './ipc-types';
import {
  addDays,
  addMonths,
  bucketByDate,
  calendarDays,
  dateTagDateKey,
  dateTagDayKey,
  formatWeekRange,
  formatYear,
  isSameMonth,
  isToday,
  isDateTypedTag,
  modifiedDateKey,
  rangeBounds,
  dateTagRangeKey,
  entryDateTagRange,
  yearHeatmapGrid,
  bucketByDateAndHour,
  heatIntensity,
  startOfDay,
  startOfWeek,
  tagOrModifiedDateKey,
  weekDays,
  yearMonths,
  ymd,
} from './calendar';

/** Minimal DirEntry factory; `modified` is an ISO-8601 string. */
function entry(name: string, modified: string): DirEntry {
  const dot = name.lastIndexOf('.');
  return {
    name,
    path: `/root/${name}`,
    isFile: true,
    isDirectory: false,
    size: 0,
    modified,
    extension: dot >= 0 ? name.slice(dot + 1).toLowerCase() : '',
  };
}

describe('calendar date primitives', () => {
  it('startOfDay zeroes out time components', () => {
    const d = new Date(2026, 5, 28, 14, 35, 59, 999);
    const r = startOfDay(d);
    assert.equal(r.getHours(), 0);
    assert.equal(r.getMinutes(), 0);
    assert.equal(r.getSeconds(), 0);
    assert.equal(r.getMilliseconds(), 0);
    assert.equal(r.getDate(), 28);
  });

  it('ymd formats local date as YYYY-MM-DD', () => {
    assert.equal(ymd(new Date(2026, 0, 5)), '2026-01-05');
    assert.equal(ymd(new Date(2026, 11, 31)), '2026-12-31');
  });

  it('addMonths rolls across year boundaries', () => {
    const d = new Date(2026, 0, 15);
    assert.equal(addMonths(d, 2).getMonth(), 2);
    assert.equal(addMonths(d, -1).getMonth(), 11);
    assert.equal(addMonths(d, -1).getFullYear(), 2025);
  });

  it('addDays rolls across month boundaries', () => {
    const d = new Date(2026, 5, 28);
    assert.equal(addDays(d, 5).getMonth(), 6);
    assert.equal(addDays(d, 5).getDate(), 3);
  });

  it('isSameMonth respects year and month', () => {
    assert.ok(isSameMonth(new Date(2026, 5, 1), new Date(2026, 5, 30)));
    assert.ok(!isSameMonth(new Date(2026, 5, 1), new Date(2026, 6, 1)));
    assert.ok(!isSameMonth(new Date(2026, 5, 1), new Date(2025, 5, 1)));
  });

  it('isToday matches the current local date', () => {
    assert.ok(isToday(new Date()));
    assert.ok(!isToday(new Date(2020, 0, 1)));
  });
});

describe('week helpers', () => {
  it('startOfWeek returns Sunday when week starts on Sunday', () => {
    const d = new Date(2026, 5, 28); // Sunday
    const r = startOfWeek(d, 0);
    assert.equal(r.getDay(), 0);
    assert.equal(r.getDate(), 28);
  });

  it('startOfWeek returns previous Monday when week starts on Monday', () => {
    const d = new Date(2026, 5, 28); // Sunday
    const r = startOfWeek(d, 1);
    assert.equal(r.getDay(), 1);
    assert.equal(r.getDate(), 22);
  });

  it('weekDays returns 7 days starting from the configured week start', () => {
    const days = weekDays(new Date(2026, 5, 28), 0);
    assert.equal(days.length, 7);
    assert.equal(days[0].date.getDay(), 0);
    assert.equal(days[6].date.getDay(), 6);
    assert.equal(days[0].date.getDate(), 28);
    assert.equal(days[6].date.getDate(), 4);
  });

  it('formatWeekRange omits redundant month/year within the same month', () => {
    const s = formatWeekRange(new Date(2026, 5, 28), new Date(2026, 6, 4), 'en');
    assert.ok(s.includes('Jun'));
    assert.ok(s.includes('2026'));
  });

  it('formatYear returns a four-digit year', () => {
    assert.match(formatYear(new Date(2026, 5, 1), 'en'), /2026/);
  });
});

describe('year helpers', () => {
  it('yearMonths returns 12 month anchors', () => {
    const months = yearMonths(2026);
    assert.equal(months.length, 12);
    months.forEach((m, i) => {
      assert.equal(m.getFullYear(), 2026);
      assert.equal(m.getMonth(), i);
      assert.equal(m.getDate(), 1);
    });
  });
});

describe('calendarDays month grid', () => {
  it('generates complete weeks only', () => {
    const days = calendarDays(2026, 5, 0); // June 2026, Sunday start
    assert.equal(days.length % 7, 0);
  });

  it('includes the full month plus padding days', () => {
    // June 2026 starts on Monday; Sunday-start grid needs 1 leading padding day.
    const days = calendarDays(2026, 5, 0);
    const inMonth = days.filter((d) => d.inCurrentMonth);
    assert.equal(inMonth.length, 30);
    assert.ok(days.some((d) => !d.inCurrentMonth));
  });

  it('honors Monday as week start', () => {
    // June 2026 starts on Monday; Monday-start grid should have no leading padding.
    const days = calendarDays(2026, 5, 1);
    assert.ok(days[0].inCurrentMonth);
    assert.equal(days[0].date.getDay(), 1);
  });

  it('handles February in a leap year', () => {
    const days = calendarDays(2024, 1, 1); // Feb 2024, Monday start
    const inMonth = days.filter((d) => d.inCurrentMonth);
    assert.equal(inMonth.length, 29);
  });

  it('provides stable YYYY-MM-DD keys', () => {
    const days = calendarDays(2026, 5, 0);
    for (const day of days) {
      assert.match(day.key, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(day.key, ymd(day.date));
    }
  });
});

describe('bucketByDate grouping', () => {
  it('groups entries by the supplied extractor', () => {
    const entries = [
      entry('a.txt', '2026-06-27T10:00:00.000Z'),
      entry('b.txt', '2026-06-27T22:00:00.000Z'),
      entry('c.txt', '2026-06-28T08:00:00.000Z'),
    ];
    const buckets = bucketByDate(entries, modifiedDateKey);
    // Times are UTC; convert to local date keys for assertion.
    assert.equal(buckets.size, 2);
    const keys = [...buckets.keys()].sort();
    assert.deepEqual(keys, [modifiedDateKey(entries[0]), modifiedDateKey(entries[2])].sort());
  });

  it('omits entries with unparseable dates', () => {
    const entries = [
      entry('bad.txt', 'not-a-date'),
      entry('good.txt', '2026-06-27T10:00:00.000Z'),
    ];
    const buckets = bucketByDate(entries, modifiedDateKey);
    assert.equal(buckets.size, 1);
    assert.ok(!buckets.has('not-a-date'));
  });

  it('returns an empty map for empty input', () => {
    const buckets = bucketByDate([], modifiedDateKey);
    assert.equal(buckets.size, 0);
  });
});

describe('modifiedDateKey', () => {
  it('extracts local date from ISO modified timestamp', () => {
    // 2026-06-27T10:00:00Z is the same local day in most timezones.
    const e = entry('x.txt', '2026-06-27T10:00:00.000Z');
    const key = modifiedDateKey(e);
    assert.ok(key);
    assert.match(key, /^2026-06-/);
  });

  it('returns null for invalid strings', () => {
    assert.equal(modifiedDateKey(entry('x.txt', '')), null);
    assert.equal(modifiedDateKey(entry('x.txt', 'invalid')), null);
  });
});

describe('date tag extraction', () => {
  it('extracts day from Whale smart tags', () => {
    assert.equal(dateTagDayKey('today-20260628'), '2026-06-28');
    assert.equal(dateTagDayKey('yesterday-20260627'), '2026-06-27');
    assert.equal(dateTagDayKey('tomorrow-20260629'), '2026-06-29');
    assert.equal(dateTagDayKey('now-20260628T1430'), '2026-06-28');
  });

  it('extracts day from bare TagSpaces-style tags', () => {
    assert.equal(dateTagDayKey('20260628'), '2026-06-28');
    assert.equal(dateTagDayKey('20251231'), '2025-12-31');
  });

  it('extracts day from date-time tags', () => {
    assert.equal(dateTagDayKey('20260628~1430'), '2026-06-28');
    assert.equal(dateTagDayKey('20260628T1430'), '2026-06-28');
  });

  it('extracts start day from period tags', () => {
    assert.equal(dateTagDayKey('20260628-20260630'), '2026-06-28');
  });

  it('rejects invalid or non-day date tags', () => {
    assert.equal(dateTagDayKey('20260631'), null); // invalid day
    assert.equal(dateTagDayKey('20261301'), null); // invalid month
    assert.equal(dateTagDayKey('202606'), null);   // month only
    assert.equal(dateTagDayKey('2026'), null);     // year only
    assert.equal(dateTagDayKey('work'), null);
  });

  it('dateTagDateKey uses the first date tag on a file', () => {
    const e = entry('x.txt', '2026-06-01T10:00:00.000Z');
    // H.24 R1 / H.25 B7: path-keyed lookup. `entry()` sets `path = '/root/<name>'`.
    const tags = new Map([['/root/x.txt', ['work', 'today-20260628']]]);
    assert.equal(dateTagDateKey(e, tags), '2026-06-28');
  });

  it('tagOrModifiedDateKey prefers date tag then falls back to modified', () => {
    const e = entry('x.txt', '2026-06-01T10:00:00.000Z');
    const tags = new Map([['/root/x.txt', ['today-20260628']]]);
    assert.equal(tagOrModifiedDateKey(e, tags), '2026-06-28');

    const noTag = entry('y.txt', '2026-06-15T10:00:00.000Z');
    assert.equal(
      tagOrModifiedDateKey(noTag, new Map()),
      modifiedDateKey(noTag)
    );
  });

  it('bucketByDate can group by date tags', () => {
    const entries = [
      entry('a.txt', '2026-06-01T10:00:00.000Z'),
      entry('b.txt', '2026-06-01T10:00:00.000Z'),
    ];
    // H.24 R1 / H.25 B7: `dateTagDateKey` reads from the path-keyed map.
    // The `entry()` helper above sets `path = '/root/<name>'`.
    const tags = new Map([
      ['/root/a.txt', ['today-20260628']],
      ['/root/b.txt', ['work']],
    ]);
    const buckets = bucketByDate(entries, (e) => dateTagDateKey(e, tags));
    assert.deepEqual(buckets.get('2026-06-28')?.map((e) => e.name), ['a.txt']);
    assert.equal(buckets.get('2026-06-01')?.length, undefined);
  });
});

describe('isDateTypedTag (H.24 P0-1)', () => {
  it('returns true for Whale smart day tags', () => {
    assert.ok(isDateTypedTag('today-20260628'));
    assert.ok(isDateTypedTag('yesterday-20260627'));
    assert.ok(isDateTypedTag('tomorrow-20260629'));
    assert.ok(isDateTypedTag('now-20260628T1430'));
  });

  it('returns true for bare TagSpaces-style day tags', () => {
    assert.ok(isDateTypedTag('20260628'));
    assert.ok(isDateTypedTag('20251231'));
  });

  it('returns true for date-time and period tags', () => {
    assert.ok(isDateTypedTag('20260628~1430'));
    assert.ok(isDateTypedTag('20260628T1430'));
    assert.ok(isDateTypedTag('20260628-20260630'));
  });

  it('returns false for non-date tags', () => {
    assert.equal(isDateTypedTag('work'), false);
    assert.equal(isDateTypedTag('urgent'), false);
    assert.equal(isDateTypedTag('star3'), false);
    assert.equal(isDateTypedTag('2026'), false); // year only
    assert.equal(isDateTypedTag('202606'), false); // month only
  });

  it('returns false for invalid day strings', () => {
    assert.equal(isDateTypedTag('20260631'), false); // invalid day
    assert.equal(isDateTypedTag('20261301'), false); // invalid month
    assert.equal(isDateTypedTag(''), false);
  });
});

describe('rangeBounds', () => {
  // Anchor every test on a fixed "today" so bounds are deterministic regardless
  // of when the suite runs. 2026-07-15 is a Wednesday.
  const today = new Date(2026, 6, 15, 9, 30, 0);

  it('returns null for "all"', () => {
    assert.equal(rangeBounds('all', today, 0), null);
    assert.equal(rangeBounds('all', today, 1), null);
  });

  it('"today" spans a single day', () => {
    const b = rangeBounds('today', today, 0);
    assert.ok(b);
    assert.equal(b!.min, '2026-07-15');
    assert.equal(b!.max, '2026-07-15');
  });

  it('"week" spans 7 days starting on weekStartsOn', () => {
    // Wed 2026-07-15. Sunday-start week = 2026-07-12..07-18.
    const sun = rangeBounds('week', today, 0)!;
    assert.equal(sun.min, '2026-07-12');
    assert.equal(sun.max, '2026-07-18');
    // Monday-start week = 2026-07-13..07-19.
    const mon = rangeBounds('week', today, 1)!;
    assert.equal(mon.min, '2026-07-13');
    assert.equal(mon.max, '2026-07-19');
  });

  it('"month" spans the whole calendar month', () => {
    const b = rangeBounds('month', today, 0)!;
    assert.equal(b.min, '2026-07-01');
    assert.equal(b.max, '2026-07-31');
  });

  it('"last30" spans today and the preceding 29 days', () => {
    const b = rangeBounds('last30', today, 0)!;
    assert.equal(b.min, '2026-06-16');
    assert.equal(b.max, '2026-07-15');
  });

  it('bounds are inclusive YYYY-MM-DD strings that compare correctly', () => {
    // A bucket keyed on the first day of the month is inside "month".
    const b = rangeBounds('month', today, 0)!;
    assert.ok('2026-07-01' >= b.min && '2026-07-01' <= b.max);
    assert.ok('2026-06-30' < b.min); // outside (before)
    assert.ok('2026-08-01' > b.max); // outside (after)
  });
});

describe('dateTagRangeKey', () => {
  it('parses a YYYYMMDD-YYYYMMDD period into inclusive bounds', () => {
    assert.deepEqual(dateTagRangeKey('20260628-20260630'), {
      startKey: '2026-06-28',
      endKey: '2026-06-30',
    });
  });

  it('normalizes a reversed period so start <= end', () => {
    assert.deepEqual(dateTagRangeKey('20260630-20260628'), {
      startKey: '2026-06-28',
      endKey: '2026-06-30',
    });
  });

  it('accepts a single-day period (start === end)', () => {
    assert.deepEqual(dateTagRangeKey('20260628-20260628'), {
      startKey: '2026-06-28',
      endKey: '2026-06-28',
    });
  });

  it('returns null for non-period tags (smart / bare / datetime)', () => {
    assert.equal(dateTagRangeKey('today-20260628'), null);
    assert.equal(dateTagRangeKey('20260628'), null); // bare day, not a range
    assert.equal(dateTagRangeKey('20260628T1430'), null);
    assert.equal(dateTagRangeKey('work'), null);
    assert.equal(dateTagRangeKey(''), null);
  });

  it('returns null for a period with invalid day components', () => {
    assert.equal(dateTagRangeKey('20260631-20260700'), null); // 07-00 invalid
    assert.equal(dateTagRangeKey('20261301-20260630'), null); // month 13
  });
});

describe('entryDateTagRange', () => {
  const tagsByName = new Map<string, string[]>([
    ['/root/a.txt', ['work', '20260628-20260630']],
    ['/root/b.txt', ['today-20260628']], // single-day, not a range
    ['/root/c.txt', ['urgent']],
  ]);

  it('returns the first period range on an entry', () => {
    const r = entryDateTagRange(
      { name: 'a.txt', path: '/root/a.txt' } as DirEntry,
      tagsByName
    );
    assert.deepEqual(r, { startKey: '2026-06-28', endKey: '2026-06-30' });
  });

  it('returns null for an entry with only single-day tags', () => {
    const r = entryDateTagRange(
      { name: 'b.txt', path: '/root/b.txt' } as DirEntry,
      tagsByName
    );
    assert.equal(r, null);
  });

  it('returns null for an entry with no period tag', () => {
    const r = entryDateTagRange(
      { name: 'c.txt', path: '/root/c.txt' } as DirEntry,
      tagsByName
    );
    assert.equal(r, null);
  });
});

describe('yearHeatmapGrid', () => {
  it('returns exactly 53 * 7 = 371 days', () => {
    const grid = yearHeatmapGrid(2026, 0);
    assert.equal(grid.length, 371);
  });

  it('starts on the week-start day containing Jan 1 (Sunday-start)', () => {
    // 2026-01-01 is a Thursday. Sunday-start week containing it starts 2025-12-28.
    const grid = yearHeatmapGrid(2026, 0);
    assert.equal(grid[0].key, '2025-12-28');
  });

  it('starts on Monday for a Monday-start locale', () => {
    // Monday-start week containing 2026-01-01 (Thu) starts 2025-12-29 (Mon).
    const grid = yearHeatmapGrid(2026, 1);
    assert.equal(grid[0].key, '2025-12-29');
  });

  it('flags days outside the year as not in the period', () => {
    const grid = yearHeatmapGrid(2026, 0);
    // First day (2025-12-28) is in 2025 → inCurrentMonth false.
    assert.equal(grid[0].inCurrentMonth, false);
    // Jan 1 2026 is in period.
    const jan1 = grid.find((d) => d.key === '2026-01-01');
    assert.ok(jan1 && jan1.inCurrentMonth);
  });
});

describe('bucketByDateAndHour', () => {
  it('buckets entries by day and hour-of-modified', () => {
    const entries = [
      entry('a.txt', '2026-06-15T09:30:00.000Z'), // hour depends on TZ; just assert same-day grouping
      entry('b.txt', '2026-06-15T14:00:00.000Z'),
    ];
    const m = bucketByDateAndHour(entries, modifiedDateKey);
    // Both share a day key → one day entry with 24 hour-slots.
    assert.equal(m.size, 1, 'two same-day entries collapse to one day');
    const day = [...m.values()][0];
    assert.equal(day.length, 24, 'each day has 24 hour slots');
    const total = day.reduce((n, h) => n + h.length, 0);
    assert.equal(total, 2);
  });

  it('omits entries with no parseable modified time', () => {
    const bad = [{ ...entry('x.txt', '2026-06-15T10:00:00.000Z'), modified: 'not-a-date' }];
    const m = bucketByDateAndHour(bad as DirEntry[], modifiedDateKey);
    assert.equal(m.size, 0);
  });
});

describe('heatIntensity', () => {
  it('is 0 for zero count or zero max', () => {
    assert.equal(heatIntensity(0, 10), 0);
    assert.equal(heatIntensity(5, 0), 0);
  });

  it('is 1 at the max (sqrt-compressed so the max itself maps to 1)', () => {
    assert.equal(heatIntensity(10, 10), 1);
  });

  it('is sub-linear (4 on a max of 16 → 0.5, not 0.25)', () => {
    // sqrt(4)/sqrt(16) = 2/4 = 0.5 — sqrt tames outliers.
    assert.equal(heatIntensity(4, 16), 0.5);
  });

  it('clamps above 1', () => {
    assert.equal(heatIntensity(99, 4), 1);
  });
});
