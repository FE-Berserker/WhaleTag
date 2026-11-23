/**
 * Renderer-side concurrency limiter for thumbnail IPC.
 *
 * Why this exists: opening a folder with thousands of images / videos / PDFs
 * spawns one `<ThumbIcon>` per entry. The naive "load on mount" pattern (the
 * original P0-6 issue) hits the main process with hundreds of concurrent
 * `thumbnail:load` / `thumbnail:generate` IPCs simultaneously, saturating the
 * renderer-main pipe and competing for the same sharp / ffmpeg pools in main.
 * Visual symptoms: the window freezes for several seconds on first paint,
 * and on a 4K monitor with a wide tray open the per-frame render budget is
 * blown out by IPC replies.
 *
 * P0-1 fix: cap concurrent thumbnail loads at `MAX_CONCURRENT = 4` (matches
 * the sharp worker pool size we use elsewhere). New requests wait in a FIFO
 * queue; tasks for the same `key` are de-duped so re-mounting / scrolling
 * back and forth doesn't re-trigger the same load. Cancelled (out-of-view)
 * keys are dropped from the queue so a fast scroll never kicks off stale
 * work.
 *
 * Re-mounting a thumb whose load is ALREADY in flight schedules one follow-up
 * (latest wins) instead of dropping the request: the cache write happens in
 * the task itself, so silently discarding it would leave a re-mounted
 * `ThumbIcon` permanently blank. The follow-up runs after the in-flight task
 * settles, never concurrently with it.
 *
 * Scope: this queue is intentionally renderer-side. It's the only place that
 * knows when the user has scrolled a thumb out of view, so global IPC
 * back-pressure belongs here, not in the main process.
 */

const MAX_CONCURRENT = 4;

interface Task {
  /** Cache key — usually `${entry.path}|${entry.modified}`. */
  key: string;
  /** The actual load work; must be idempotent and self-cancel via the caller's flag. */
  run: () => Promise<void>;
}

const queue: Task[] = [];
/** Keys whose task is currently running (IPC has no cancel — it must settle). */
const runningKeys = new Set<string>();
/** Latest re-enqueue for a key that is already running; promoted on settle. */
const followUps = new Map<string, Task>();
/** Keys already warned about in the current queue cycle (bounded log spam). */
const warnedKeys = new Set<string>();
let active = 0;

function reportTaskFailure(key: string, error: unknown): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn('[thumb-load-queue] thumbnail load failed:', key, error);
}

/**
 * Pull the next non-empty slot. Called after every state change (enqueue,
 * cancel, task completion) so the queue self-drains without a timer.
 */
function pump(): void {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const task = queue.shift() as Task;
    active += 1;
    runningKeys.add(task.key);
    // The `void` here means we don't await — the caller's `run` resolves on
    // its own and we re-pump from the finally block. A failed load (e.g.
    // corrupt PDF) must not stop the queue, but it is logged instead of
    // vanishing: silent failures made "thumbnail never appears" unexplainable.
    void task
      .run()
      .catch((error: unknown) => {
        reportTaskFailure(task.key, error);
      })
      .finally(() => {
        active -= 1;
        runningKeys.delete(task.key);
        const followUp = followUps.get(task.key);
        if (followUp) {
          followUps.delete(task.key);
          queue.push(followUp);
        }
        if (active === 0 && queue.length === 0) warnedKeys.clear();
        pump();
      });
  }
}

/**
 * Enqueue a thumbnail load. If a pending task for the same `key` is already
 * waiting, it's dropped first — the newer call wins, which keeps mount +
 * scroll-in interactions from queuing duplicates. If the key is currently
 * running, keep its latest re-request as a follow-up instead of dropping it.
 */
export function enqueueThumbLoad(key: string, run: () => Promise<void>): void {
  if (runningKeys.has(key)) {
    followUps.set(key, { key, run });
    return;
  }
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (queue[i].key === key) queue.splice(i, 1);
  }
  queue.push({ key, run });
  pump();
}

/**
 * Drop any pending (not yet started) task for `key`, plus a follow-up queued
 * while it was running. Already-running tasks can't be aborted — IPC has no
 * cancel — so the caller still guards its state setters with a local
 * `cancelled` flag and ignores late results.
 */
export function cancelThumbLoad(key: string): void {
  followUps.delete(key);
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (queue[i].key === key) queue.splice(i, 1);
  }
}
