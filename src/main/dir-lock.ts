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
 *
 * Bounded memory: each entry is dropped from `chains` once the *latest*
 * task for that key has settled — confirmed by comparing the stored tail to
 * `chains.get(key)` on the tail's own microtask. A still-pending successor
 * (e.g. a withLock call that chained onto us) keeps its own replacement
 * entry, so memory never grows past the number of keys that have *active*
 * in-flight work.
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
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  chains.set(key, tail);
  // Drop the entry once we know no successor replaced us. The check fires on
  // the tail's microtask — by then any immediately-chained withLock has
  // already installed its own entry into `chains`, so a stale delete would
  // break the chain. Comparing against `tail` lets us only delete when the
  // entry that's still there is *our* tail.
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}
