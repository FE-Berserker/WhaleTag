import { randomUUID } from 'crypto';

/**
 * Request/response correlation primitives shared by `index-worker-host.ts`
 * (Electron `utilityProcess` worker) and `office-worker-host.ts` (external
 * python UNO bridge). Both packages spend ~30 lines each on the same
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
}

/**
 * Register a new in-flight request. Returns the `reqId` the caller must
 * attach to its outgoing message, plus the `promise` for the eventual
 * reply. The caller is responsible for calling `completeRequest()` /
 * `failRequest()` (driven by the worker's reply) or `rejectAllPending()`
 * (driven by the worker's death / shutdown kill).
 */
export function newRequest(
  pending: Map<string, Pending>
): { reqId: string; promise: Promise<unknown> } {
  const reqId = randomUUID();
  let resolve!: (v: unknown) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  pending.set(reqId, { resolve, reject });
  return { reqId, promise };
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
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}
