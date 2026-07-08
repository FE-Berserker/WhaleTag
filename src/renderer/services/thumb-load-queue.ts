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
let active = 0;

/**
 * Pull the next non-empty slot. Called after every state change (enqueue,
 * cancel, task completion) so the queue self-drains without a timer.
 */
function pump(): void {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const task = queue.shift() as Task;
    active += 1;
    // The `void` here means we don't await — the caller's `run` resolves on
    // its own and we re-pump from the finally block. Errors are swallowed
    // intentionally: a failed load (e.g. corrupt PDF) shouldn't stop the
    // queue; the ThumbIcon's own state setter marks `loaded=true` regardless.
    void task
      .run()
      .catch(() => undefined)
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

/**
 * Enqueue a thumbnail load. If a pending task for the same `key` is already
 * waiting, it's dropped first — the newer call wins, which keeps mount +
 * scroll-in interactions from queuing duplicates.
 */
export function enqueueThumbLoad(key: string, run: () => Promise<void>): void {
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (queue[i].key === key) queue.splice(i, 1);
  }
  queue.push({ key, run });
  pump();
}

/**
 * Drop any pending (not yet started) task for `key`. Already-running tasks
 * can't be aborted — IPC has no cancel — so the caller still guards its
 * state setters with a local `cancelled` flag and ignores late results.
 */
export function cancelThumbLoad(key: string): void {
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (queue[i].key === key) queue.splice(i, 1);
  }
}

/** Test-only escape hatch: read current queue depth and active count. */
export function _thumbQueueStats(): { pending: number; active: number } {
  return { pending: queue.length, active };
}