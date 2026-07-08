/**
 * Per-key async mutex. Used by the aggregated sidecar store (`sidecar.ts`) to
 * serialize read-modify-write on a single directory's `wsd.json`: concurrent
 * writes to the SAME directory (e.g. batch-tagging many files at once) are
 * queued, while writes to DIFFERENT directories run in parallel.
 *
 * Electron main is a single process, so an in-memory map is sufficient — no
 * filesystem-level locking is needed.
 */

const chains = new Map<string, Promise<void>>();

/**
 * Runs `task` once every previously queued task for `key` has settled.
 *
 * The chain itself never rejects: a failing task surfaces its error to that
 * task's own caller (via the returned promise) but does NOT poison the queue
 * for tasks queued after it. Without this, one rejected write would leave all
 * later writes pending forever.
 */
export function withLock<T>(
  key: string,
  task: () => Promise<T>
): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  // Chain off a never-rejecting view of `prev`. `run` carries `task`'s own
  // outcome (handed back to the caller); the swallowed version is what we store
  // so the next task always starts from a settled, fulfilled predecessor.
  const run = prev.then(task);
  chains.set(
    key,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}
