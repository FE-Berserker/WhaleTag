import type { TFunction } from 'i18next';

/** Human-readable file size (e.g. "1.5 MB"); empty string for 0/falsy. */
export function formatSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

/**
 * Locale date string for an ISO timestamp; empty string if missing/invalid.
 *
 * H.23 P2-3 — accepts an optional `mode` + `t` to render a human-friendly
 * "3 days ago" form. Two variants:
 *   - `'absolute'` (default) — `Intl.DateTimeFormat` short date.
 *   - `'relative'` — picks a bucket (just now / N min / N hr / N day) and
 *     delegates to the matching i18n key. Falls back to absolute for > 30
 *     days (the plan calls out "N 天前" for ~week-scale edits, not a
 *     year-scale history).
 *
 * `t` is required when `mode === 'relative'`; in `'absolute'` mode it is
 * unused (kept optional to keep the call site simple when the toggle is
 * off).
 */
export function formatDate(
  iso: string,
  opts?: { mode?: 'absolute' | 'relative'; t?: TFunction }
): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mode = opts?.mode ?? 'absolute';
  if (mode === 'absolute') {
    return d.toLocaleDateString();
  }
  // mode === 'relative'
  const t = opts?.t;
  if (!t) {
    // Without an i18n function we cannot render the relative form — fall
    // back to absolute rather than throw, so callers that forget the `t`
    // still get a sane (date-formatted) string.
    return d.toLocaleDateString();
  }
  const now = Date.now();
  const ms = now - d.getTime();
  if (ms < 60_000) return t('justNow');
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) {
    return t('nMinutesAgo', { count: minutes });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return t('nHoursAgo', { count: hours });
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return t('nDaysAgo', { count: days });
  }
  // > 30 days: still show absolute, the relative form's "31 天前" is
  // less useful than the actual date.
  return d.toLocaleDateString();
}

/** Truncate `s` to at most `max` characters, appending `…` when shortened.
 *  CJK characters count as 1 (good-enough heuristic; the goal is to avoid
 *  overflow in ECharts tile labels, not pixel-perfect width). */
export function truncate(s: string, max: number): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}
