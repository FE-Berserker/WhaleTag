import { ipcApi } from './ipc-api';

/**
 * Tracks the most recent `setAllowedRoots` IPC so callers can await it before
 * issuing write-side IPCs (notably `index:build` / `tagLibrary:read`) that
 * consult `assertWithinAllowedRoot`.
 *
 * Why this exists: React fires child useEffects BEFORE their parents on the
 * first mount, so a child that wants to `buildLocationIndex(root)` at startup
 * will dispatch its IPC before Root's effect has called `setAllowedRoots`.
 * Main's `assertWithinAllowedRoot` is fail-closed — empty allowedRoots means
 * "Refused: no configured locations" — and TaskReminder's deps don't change
 * after the failed first attempt, so the IPC is never retried. Recording the
 * in-flight promise here lets the child `await` the registration that the
 * parent effect already kicked off, with no race and no extra round trip.
 */
let inFlight: Promise<void> | null = null;

/**
 * Register the configured location roots with the main process and remember
 * the promise. Drop-in replacement for the bare `ipcApi.setAllowedRoots` call
 * from `Root.tsx`.
 */
export function setAllowedRootsAndWait(roots: string[]): Promise<void> {
  inFlight = ipcApi.setAllowedRoots(roots);
  // Swallow unhandled rejection noise if a caller forgets to await — Root.tsx
  // intentionally fires-and-forgets the result. The Promise we hand back still
  // rejects, so any caller that DOES await it (e.g. TaskReminder) sees the
  // real failure.
  inFlight.catch(() => undefined);
  return inFlight;
}

/**
 * Resolve once the most recent `setAllowedRoots` call has completed. Returns
 * an already-resolved promise when no registration is in flight (i.e. nothing
 * has called `setAllowedRootsAndWait` yet — typically only on the very first
 * render before Root's effect runs; callers should guard accordingly).
 */
export function waitForAllowedRoots(): Promise<void> {
  return inFlight ?? Promise.resolve();
}