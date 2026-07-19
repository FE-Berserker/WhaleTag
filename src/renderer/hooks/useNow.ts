import { useSyncExternalStore } from 'react';

/**
 * Returns a `Date` that refreshes once a minute so freshness checks
 * (`smartFunctionalityOfTag(tag, now)` / `tagDisplayLabel(tag, t, now)`) see
 * the wall-clock cross over minute / day / month / year boundaries.
 *
 * ALL consumers share ONE module-level `setInterval` (started when the first
 * consumer mounts, cleared when the last unmounts) via a tiny external store
 * + `useSyncExternalStore`. Previously each consumer owned its own timer, so
 * the minute tick fired N times and re-rendered the tag library / file list /
 * properties tray N separate times each minute. Now it's one tick → one batch
 * re-render of every consumer, and they share the same `Date` snapshot in
 * between (the snapshot is cached and only swapped on each tick —
 * `useSyncExternalStore` requires `getSnapshot` to return a stable reference
 * between notifications).
 *
 * Tests that need deterministic behavior should pass an explicit `now`
 * argument to `smartFunctionalityOfTag` / `tagDisplayLabel` instead of this
 * hook.
 *
 * Usage:
 *   const now = useNow();
 *   <Chip label={tagDisplayLabel(tag, t, now)} />
 */

const INTERVAL_MS = 60_000;

// Module-level shared store.
let snapshot: Date = new Date();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  snapshot = new Date();
  for (const l of listeners) l();
}

function startTimer(): void {
  if (timer !== null) return;
  // Refresh immediately on (re)start so a consumer that mounts after the timer
  // was idle doesn't read a stale snapshot from the last active period.
  snapshot = new Date();
  timer = setInterval(tick, INTERVAL_MS);
}

function stopTimer(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (listeners.size === 1) startTimer();
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) stopTimer();
  };
}

function getSnapshot(): Date {
  return snapshot;
}

export function useNow(): Date {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Raw store access for ADVANCED consumers that gate the subscription behind a
 * condition (e.g. `useTagDisplayLabels` only subscribes when a shown tag is
 * date-shaped — most components then pay zero per-minute re-renders).
 * `useNow()` itself always subscribes; these let callers opt in dynamically.
 */
export const subscribeNow = subscribe;
export const getNowSnapshot = getSnapshot;
