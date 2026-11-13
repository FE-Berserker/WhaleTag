import { randomUUID } from 'crypto';

/**
 * Request/response correlation primitives shared by `index-worker-host.ts`
 * and `thumb-worker-host.ts` (Electron `utilityProcess` workers). Both hosts
 * spend ~30 lines each on the same
 * bookkeeping — a `pending: Map<reqId, Pending>` for in-flight requests,
 * `rejectAll()` on `'exit'` / `'error'` / shutdown kill, and a drop-on-
 * stale-reply idempotency check. Keeping the primitives here, stateless,
 * means each host file only carries its own transport-specific code (spawn,
 * send, message parsing) and lifecycle-specific quirks (cooldown FSM,
 * subscriber fan-out).
 */

/** A single in-flight request awaiting a worker reply. */
export interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  /**
   * Inactivity watchdog handle (absent when the caller asked for no
   * timeout). Always cleared when the request settles, so a late worker
   * reply can't reject a promise that already resolved.
   */
  timer?: ReturnType<typeof setTimeout>;
  /** Last time the worker showed a sign of life (any message). */
  lastActivity: number;
}

/** Options for {@link newRequest}. */
export interface NewRequestOptions {
  /**
   * Reject when the worker has been silent for this long. "Silent" is
   * measured against the last message of ANY kind (reply or pushed event):
   * a long `index:build` that keeps emitting progress never trips it, while
   * a wedged/never-answering worker does. `0`/omitted disables the timer.
   */
  timeoutMs?: number;
  /** Label used in the timeout error message, e.g. the op name. */
  label?: string;
}

/** `name` carried by the error {@link newRequest} rejects with on timeout. */
export const WORKER_TIMEOUT_ERROR = 'WorkerRequestTimeout';

/**
 * Arm (or re-arm) the inactivity watchdog for one pending request. When the
 * timer fires we compare against `lastActivity`: if the worker spoke since
 * the previous arm, we simply wait another window; otherwise the request is
 * dropped from the map and rejected, so a hung worker surfaces as an error
 * instead of a promise that never settles.
 */
function armInactivityTimer(
  pending: Map<string, Pending>,
  reqId: string,
  entry: Pending,
  timeoutMs: number,
  label: string
): void {
  entry.timer = setTimeout(() => {
    if (Date.now() - entry.lastActivity < timeoutMs) {
      armInactivityTimer(pending, reqId, entry, timeoutMs, label);
      return;
    }
    // Drop before rejecting: a reply that lands afterwards must not settle
    // an already-rejected promise (completeRequest returns false for it).
    pending.delete(reqId);
    const err = new Error(
      `${label} timed out after ${timeoutMs} ms of worker silence`
    );
    err.name = WORKER_TIMEOUT_ERROR;
    entry.reject(err);
  }, timeoutMs);
  // Don't keep the main process alive just for a watchdog.
  entry.timer.unref?.();
}

function clearTimer(p: Pending): void {
  if (p.timer) {
    clearTimeout(p.timer);
    p.timer = undefined;
  }
}

/**
 * Register a new in-flight request. Returns the `reqId` the caller must
 * attach to its outgoing message, plus the `promise` for the eventual
 * reply. The caller is responsible for calling `completeRequest()` /
 * `failRequest()` (driven by the worker's reply) or `rejectAllPending()`
 * (driven by the worker's death / shutdown kill).
 */
export function newRequest(
  pending: Map<string, Pending>,
  options: NewRequestOptions = {}
): { reqId: string; promise: Promise<unknown> } {
  const reqId = randomUUID();
  let resolve!: (v: unknown) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const entry: Pending = { resolve, reject, lastActivity: Date.now() };
  pending.set(reqId, entry);
  const timeoutMs = options.timeoutMs ?? 0;
  if (timeoutMs > 0) {
    armInactivityTimer(pending, reqId, entry, timeoutMs, options.label ?? 'worker request');
  }
  return { reqId, promise };
}

/**
 * Record that the worker produced a message (reply or pushed event) so the
 * inactivity watchdogs of every in-flight request see it as progress.
 */
export function markWorkerActivity(pending: Map<string, Pending>): void {
  const now = Date.now();
  for (const p of pending.values()) p.lastActivity = now;
}

/**
 * Resolve the in-flight request with `result` and drop the entry. Returns
 * `true` if the request was found (the worker reply matched an outstanding
 * request). Returns `false` if the request was already settled or never
 * existed — i.e. a late reply after a worker crash, which is normal
 * because the `'exit'` handler rejects every pending entry but the
 * worker may still flush an in-flight reply before the OS reaps it.
 */
export function completeRequest(
  pending: Map<string, Pending>,
  reqId: string,
  result: unknown
): boolean {
  const p = pending.get(reqId);
  if (!p) return false;
  pending.delete(reqId);
  clearTimer(p);
  p.resolve(result);
  return true;
}

/** Mirror of {@link completeRequest} for failures. */
export function failRequest(
  pending: Map<string, Pending>,
  reqId: string,
  err: Error
): boolean {
  const p = pending.get(reqId);
  if (!p) return false;
  pending.delete(reqId);
  clearTimer(p);
  p.reject(err);
  return true;
}

/**
 * Reject every in-flight request with `err` and clear the map. Called
 * from the `'exit'` / `'error'` handlers and from the shutdown `kill()`
 * path. Each individual rejection propagates to its caller's awaited
 * promise, surfacing the worker death as a thrown error at the IPC layer.
 */
export function rejectAllPending(
  pending: Map<string, Pending>,
  err: Error
): void {
  for (const p of pending.values()) {
    clearTimer(p);
    p.reject(err);
  }
  pending.clear();
}
