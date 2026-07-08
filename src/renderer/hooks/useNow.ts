import { useEffect, useState } from 'react';

/**
 * Returns a `Date` that refreshes periodically so the freshness checks in
 * `smartFunctionalityOfTag(tag, now)` / `tagDisplayLabel(tag, t, now)` see the
 * wall-clock crossing over minute / day / month / year boundaries.
 *
 * Granularity is one minute (default) — long enough to be cheap, short enough
 * that an open app sees the day roll over within 60 s of midnight. Tests that
 * need deterministic behavior should pass an explicit `now` argument to
 * `smartFunctionalityOfTag` / `tagDisplayLabel` instead of relying on this hook.
 *
 * Multiple subscribers in the same React tree share a single `setInterval`
 * only at the React rendering level — each component instance owns its own
 * timer. The interval is cleared on unmount.
 *
 * Usage:
 *   const now = useNow();
 *   <Chip label={tagDisplayLabel(tag, t, now)} />
 */
export function useNow(intervalMs: number = 60_000): Date {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    if (intervalMs <= 0) return;
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
