/**
 * Locale-independent date helpers shared by main, renderer and extensions.
 *
 * These are deliberately tiny and dependency-free: `pad2`/`addDays` used to be
 * duplicated in `shared/smart-tags.ts` and `renderer/domain/calendar.ts`, and
 * the two modules also both had a function named `ymd` — but with DIFFERENT
 * formats (`YYYYMMDD` for storage tokens vs `YYYY-MM-DD` for calendar keys).
 * Keeping both formatters here makes the distinction explicit and prevents a
 * future "dedupe" from silently changing a persisted tag format.
 */

/** Zero-pads a non-negative integer to two digits. */
export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Add/subtract days while preserving local time-of-day. */
export function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

/** Local `YYYY-MM-DD` — the calendar bucket / range key format. */
export function ymdLocal(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local `YYYYMMDD` — the compact smart-tag / period boundary format. */
export function ymdCompact(d: Date): string {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}
