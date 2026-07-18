/**
 * Pure helpers for the Calendar perspective. React/Electron-free so the date
 * math and bucketing can be unit-tested in isolation (calendar.test.ts).
 *
 * The calendar works in the user's local timezone: file modified timestamps
 * (ISO-8601) are parsed and grouped by local year/month/day. This matches what
 * users see in their OS file manager.
 */

import type { DirEntry } from '../../shared/ipc-types';

export interface CalendarDay {
  /** Midnight-local Date for this grid cell. */
  date: Date;
  /** True when the cell belongs to the month being displayed (not padding). */
  inCurrentMonth: boolean;
  /** Stable local date key: YYYY-MM-DD. */
  key: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Returns a new Date set to 00:00:00 local time. */
export function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

/** Local YYYY-MM-DD for a Date. */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Add/subtract months (preserves local time-of-day). */
export function addMonths(d: Date, n: number): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
}

/** Add/subtract days (preserves local time-of-day). */
export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** Returns the first day of the week containing `date`. */
export function startOfWeek(date: Date, weekStartsOn: 0 | 1): Date {
  const day = date.getDay();
  const offset = (day - weekStartsOn + 7) % 7;
  return startOfDay(addDays(date, -offset));
}

/** Returns the 7 days of the week containing `date`. */
export function weekDays(date: Date, weekStartsOn: 0 | 1): CalendarDay[] {
  const first = startOfWeek(date, weekStartsOn);
  return Array.from({ length: 7 }, (_, i) => {
    const d = addDays(first, i);
    return { date: startOfDay(d), inCurrentMonth: true, key: ymd(d) };
  });
}

/** Returns midnight-local Dates for each month of `year` (Jan..Dec). */
export function yearMonths(year: number): Date[] {
  return Array.from({ length: 12 }, (_, i) => startOfDay(new Date(year, i, 1)));
}

/** True when two Dates are in the same local month. */
export function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

/** True when `date` is today in local time. */
export function isToday(date: Date): boolean {
  return ymd(date) === ymd(new Date());
}

/**
 * Detect whether the week starts on Sunday (0) or Monday (1) for `locale`.
 * Uses `Intl.Locale.getWeekInfo()` when available; otherwise falls back to
 * Monday for Chinese and Sunday for everything else (good enough for MVP).
 */
export function detectWeekStartsOn(locale: string): 0 | 1 {
  try {
    const loc = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
    };
    const info = loc.getWeekInfo?.();
    if (info) {
      // TC39 week info: 1=Monday ... 7=Sunday.
      // Treat Saturday/Sunday-start locales as Sunday-start; others as Monday-start.
      return info.firstDay >= 6 ? 0 : 1;
    }
  } catch {
    // Ignore unsupported locales.
  }
  return /^zh/i.test(locale) ? 1 : 0;
}

/**
 * Generate a month-view grid. Returns all days from the first displayed week
 * through the last displayed week, including padding days from the previous
 * and next months. The grid always contains complete weeks (multiples of 7).
 */
export function calendarDays(
  year: number,
  month: number,
  weekStartsOn: 0 | 1 = 0
): CalendarDay[] {
  const firstOfMonth = new Date(year, month, 1);
  const startDay = firstOfMonth.getDay(); // 0=Sunday
  const offset = (startDay - weekStartsOn + 7) % 7;

  const cursor = new Date(year, month, 1);
  cursor.setDate(cursor.getDate() - offset);

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const visibleCells = offset + daysInMonth;
  const rows = Math.ceil(visibleCells / 7);
  const count = rows * 7;

  const days: CalendarDay[] = [];
  for (let i = 0; i < count; i++) {
    const date = new Date(cursor);
    date.setDate(cursor.getDate() + i);
    days.push({
      date: startOfDay(date),
      inCurrentMonth: date.getMonth() === month,
      key: ymd(date),
    });
  }
  return days;
}

/**
 * Group `entries` by a date-key extractor. Entries whose extractor returns
 * `null` are omitted.
 */
export function bucketByDate(
  entries: DirEntry[],
  getDateKey: (entry: DirEntry) => string | null
): Map<string, DirEntry[]> {
  const buckets = new Map<string, DirEntry[]>();
  for (const entry of entries) {
    const key = getDateKey(entry);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(entry);
  }
  return buckets;
}

/** Default date extractor: uses `DirEntry.modified` converted to local date. */
export function modifiedDateKey(entry: DirEntry): string | null {
  const d = new Date(entry.modified);
  if (Number.isNaN(d.getTime())) return null;
  return ymd(d);
}

/** Number of days in a 1-based month. */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** Validates an 8-digit YYYYMMDD string and returns `YYYY-MM-DD`, or null. */
function parseYyyymmdd(value: string): string | null {
  if (!/^\d{8}$/.test(value)) return null;
  const year = parseInt(value.slice(0, 4), 10);
  const month = parseInt(value.slice(4, 6), 10);
  const day = parseInt(value.slice(6, 8), 10);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

/**
 * Extract a specific day key (`YYYY-MM-DD`) from a date-oriented tag.
 *
 * Supports:
 * - Whale smart tags: `today-YYYYMMDD`, `yesterday-YYYYMMDD`, `tomorrow-YYYYMMDD`,
 *   `now-YYYYMMDDTHHMM`
 * - TagSpaces-style bare day tags: `YYYYMMDD`
 * - Date-time tags: `YYYYMMDD~HHMM`, `YYYYMMDDTHHMM`
 * - Day-period start: `YYYYMMDD-YYYYMMDD`
 *
 * Month (`YYYYMM`) and year (`YYYY`) tags are intentionally ignored because they
 * do not map to a single calendar day.
 */
export function dateTagDayKey(tag: string): string | null {
  if (!tag) return null;

  // Whale smart tags that resolve to a specific day.
  const smart = /^(?:today|yesterday|tomorrow|now)-(\d{8})/.exec(tag);
  if (smart) return parseYyyymmdd(smart[1]);

  // Bare day tag, or period start, or date-time prefix.
  const bare = parseYyyymmdd(tag);
  if (bare) return bare;

  // Date-time tag: 20251223~1430 or 20251223T1430.
  const dateTime = /^(\d{8})[T~]/.exec(tag);
  if (dateTime) return parseYyyymmdd(dateTime[1]);

  // Period: 20251223-20251225 �?place on the start day.
  const period = /^(\d{8})-\d{8}$/.exec(tag);
  if (period) return parseYyyymmdd(period[1]);

  return null;
}

/**
 * True when `tag` is a date-oriented tag (smart / bare / dateTime / period).
 * Used to filter date tags out of an entry's tag list when rewriting them via
 * `setEntryDateTag` / `removeEntryDateTag` (H.24 P0-1).
 */
export function isDateTypedTag(tag: string): boolean {
  return dateTagDayKey(tag) !== null;
}

/**
 * True when `tag` is a period tag (`YYYYMMDD-YYYYMMDD`).
 *
 * Period tags are an independent exclusive family (see docs/03-tagging.md §5):
 * a file can hold at most one, and they are NOT part of the smart-date family
 * even though they share the `dateTagDayKey` parser for the start day.
 */
export function isPeriodTag(tag: string): boolean {
  return dateTagRangeKey(tag) !== null;
}

/**
 * Date extractor that uses the first date-specific tag on a file.
 * Falls back to `null` if the file carries no date tag, so the caller can
 * decide whether to hide it or fall back to modified date.
 */
export function dateTagDateKey(
  entry: DirEntry,
  tagsByName: Map<string, string[]>
): string | null {
  const tags = tagsByName.get(entry.path) ?? [];
  for (const tag of tags) {
    const key = dateTagDayKey(tag);
    if (key) return key;
  }
  return null;
}

/** A parsed `YYYYMMDD-YYYYMMDD` period tag, as inclusive local YYYY-MM-DD bounds. */
export interface DateTagRange {
  startKey: string;
  endKey: string;
}

/**
 * Parse a period date tag (`YYYYMMDD-YYYYMMDD`) into inclusive local day bounds,
 * or null if `tag` isn't a valid period. Only the bare period form is a range;
 * smart / day / datetime tags resolve to a single day (use {@link dateTagDayKey}).
 *
 * `start`/`end` are normalized so `start <= end` regardless of tag order.
 */
export function dateTagRangeKey(tag: string): DateTagRange | null {
  const m = /^(\d{8})-(\d{8})$/.exec(tag);
  if (!m) return null;
  const a = parseYyyymmdd(m[1]);
  const b = parseYyyymmdd(m[2]);
  if (!a || !b) return null;
  return a <= b ? { startKey: a, endKey: b } : { startKey: b, endKey: a };
}

/**
 * The period range of an entry's first `YYYYMMDD-YYYYMMDD` tag (or null if it
 * carries no period tag). Used by the month view to draw a multi-day bar; the
 * entry is STILL bucketed on its start day by {@link dateTagDateKey} (the bar
 * is an additional indicator, not a replacement for the day-cell entry).
 */
export function entryDateTagRange(
  entry: DirEntry,
  tagsByName: Map<string, string[]>
): DateTagRange | null {
  const tags = tagsByName.get(entry.path) ?? [];
  for (const tag of tags) {
    const r = dateTagRangeKey(tag);
    if (r) return r;
  }
  return null;
}

/** Combines date-tag extraction with a fallback to modified date. */
export function tagOrModifiedDateKey(
  entry: DirEntry,
  tagsByName: Map<string, string[]>
): string | null {
  return dateTagDateKey(entry, tagsByName) ?? modifiedDateKey(entry);
}

/** Relative time-window presets for the Calendar toolbar Range Filter. */
export type CalendarRange = 'today' | 'week' | 'month' | 'last30' | 'all';

/**
 * Inclusive `YYYY-MM-DD` bounds for a relative range around `today`, or null
 * for `'all'`. Bucket keys are `YYYY-MM-DD`, so callers can filter buckets by
 * plain string comparison �?this keeps the range filter independent of the
 * grouping source (modified / dateTag / auto all produce the same key shape).
 *
 * `today` is passed in (not read here) so the function stays pure and testable.
 */
export function rangeBounds(
  range: CalendarRange,
  today: Date,
  weekStartsOn: 0 | 1
): { min: string; max: string } | null {
  if (range === 'all') return null;
  const t0 = startOfDay(today);
  if (range === 'today') return { min: ymd(t0), max: ymd(t0) };
  if (range === 'week') {
    const s = startOfWeek(t0, weekStartsOn);
    return { min: ymd(s), max: ymd(addDays(s, 6)) };
  }
  if (range === 'month') {
    const first = new Date(t0.getFullYear(), t0.getMonth(), 1);
    const last = new Date(t0.getFullYear(), t0.getMonth() + 1, 0);
    return { min: ymd(first), max: ymd(last) };
  }
  // last30: today and the preceding 29 days.
  return { min: ymd(addDays(t0, -29)), max: ymd(t0) };
}

/** Localized "June 2026" / "2026�?�? label. */
export function formatMonthYear(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
  }).format(date);
}

/** Localized year label, e.g. "2026". */
export function formatYear(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { year: 'numeric' }).format(date);
}

/**
 * Localized week range label, e.g. "Jun 28 - Jul 4, 2026" or
 * "Dec 28, 2026 - Jan 3, 2027".
 */
export function formatWeekRange(
  start: Date,
  end: Date,
  locale: string
): string {
  const sameYear = start.getFullYear() === end.getFullYear();
  const sameMonth = sameYear && start.getMonth() === end.getMonth();
  const optsDay: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  const optsEnd: Intl.DateTimeFormatOptions = sameMonth
    ? { day: 'numeric' }
    : { month: 'short', day: 'numeric' };
  const startStr = new Intl.DateTimeFormat(locale, optsDay).format(start);
  const endStr = new Intl.DateTimeFormat(locale, optsEnd).format(end);
  const yearStr = new Intl.DateTimeFormat(locale, { year: 'numeric' }).format(
    end
  );
  return `${startStr} - ${endStr}, ${yearStr}`;
}

/** Localized short weekday labels starting with `weekStartsOn`. */
export function weekdayLabels(
  weekStartsOn: 0 | 1,
  locale: string
): string[] {
  const labels: string[] = [];
  // 2023-01-01 is a Sunday.
  const base = new Date(2023, 0, 1);
  for (let i = 0; i < 7; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + weekStartsOn + i);
    labels.push(
      new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(d)
    );
  }
  return labels;
}

/**
 * 53-week × 7-day grid for the year heatmap (GitHub-style). Returns exactly
 * 371 {@link CalendarDay}s starting from the first day of the week containing
 * Jan 1 of `year`. Days falling outside `year` carry `inCurrentMonth: false`
 * (the field is reused as "in the focused year" �?same shape, different
 * period). 53 weeks always covers a full year (a 52-week year + the partial
 * week at either end), matching GitHub's contribution graph.
 */
export function yearHeatmapGrid(
  year: number,
  weekStartsOn: 0 | 1
): CalendarDay[] {
  const jan1 = new Date(year, 0, 1);
  const start = startOfWeek(jan1, weekStartsOn);
  const days: CalendarDay[] = [];
  for (let i = 0; i < 53 * 7; i++) {
    const d = addDays(start, i);
    days.push({
      date: startOfDay(d),
      inCurrentMonth: d.getFullYear() === year,
      key: ymd(d),
    });
  }
  return days;
}

/**
 * Group entries by day-key AND hour-of-modified-time (0-23), for the week
 * timeline view. Each day maps to a 24-slot array (one bucket per hour; empty
 * hours are `[]`). Entries whose `getDateKey` returns null or whose `modified`
 * doesn't parse are omitted. The extractor is the caller's choice so this stays
 * grouping-source-agnostic (modified / auto).
 */
export function bucketByDateAndHour(
  entries: DirEntry[],
  getDateKey: (entry: DirEntry) => string | null
): Map<string, DirEntry[][]> {
  const m = new Map<string, DirEntry[][]>();
  for (const entry of entries) {
    const dayKey = getDateKey(entry);
    if (!dayKey) continue;
    const d = new Date(entry.modified);
    if (Number.isNaN(d.getTime())) continue;
    let hours = m.get(dayKey);
    if (!hours) {
      hours = Array.from({ length: 24 }, () => [] as DirEntry[]);
      m.set(dayKey, hours);
    }
    hours[d.getHours()].push(entry);
  }
  return m;
}

/** `sqrt`-compressed intensity (0..1) for a heatmap cell, given the cell count
 *  and the max count in the visible set. sqrt tames busy days so a single
 *  outlier doesn't wash out the rest. Returns 0 when maxCount is 0. */
export function heatIntensity(count: number, maxCount: number): number {
  if (count <= 0 || maxCount <= 0) return 0;
  return Math.min(1, Math.sqrt(count) / Math.sqrt(maxCount));
}
