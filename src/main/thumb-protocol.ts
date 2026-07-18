/**
 * Type definitions for the thumbnail-render utilityProcess protocol. Pure
 * types — no runtime — shared between the parent (main process) and the
 * utility process child (`thumb-worker.ts`).
 *
 * Mirrors `index-protocol.ts` (docs/15 §P0-2), narrowed to a single
 * three-way op: the pure-JS CPU-heavy renders (pdf / ebook / font) that
 * used to run on the main event loop. See `docs/06-thumbnails.md` §8.
 */

/**
 * Every request op the worker handles. The string literal matches the log
 * tag so lines are grep-friendly and the host/worker share a single source
 * of truth.
 */
export type ThumbWorkerOp = 'thumb:pdf' | 'thumb:font' | 'thumb:ebook';

/**
 * Per-op argument shape. A discriminated union keyed by `op` — the host
 * uses this union to type-check `thumbRequest(op, arg)` calls.
 */
export type ThumbWorkerArg =
  | { op: 'thumb:pdf'; arg: { srcPath: string } }
  | { op: 'thumb:font'; arg: { srcPath: string } }
  | { op: 'thumb:ebook'; arg: { srcPath: string } };

/**
 * Per-op return type. Same discriminated-union shape as `ThumbWorkerArg`.
 * `buf` crosses the port via structured clone, which turns the worker's
 * Node `Buffer` into a plain `Uint8Array` on the host side — the host
 * rewraps it with `Buffer.from(...)` before handing it to callers.
 */
export type ThumbWorkerResult =
  | { op: 'thumb:pdf'; result: { buf: Uint8Array } }
  | { op: 'thumb:font'; result: { buf: Uint8Array } }
  | { op: 'thumb:ebook'; result: { buf: Uint8Array } };

/** A request envelope sent from host → worker. */
export interface ThumbWorkerRequest {
  reqId: string;
  op: ThumbWorkerOp;
  arg: unknown;
}

/** Successful response: worker → host. */
export interface ThumbWorkerOk {
  reqId: string;
  ok: true;
  result: unknown;
}

/**
 * Failed response: worker → host. `stack` is included only in dev to avoid
 * leaking build-machine absolute paths through IPC; production strips it.
 */
export interface ThumbWorkerErr {
  reqId: string;
  ok: false;
  error: {
    name: string;
    message: string;
    stack?: string;
  };
}

/** Server-pushed events (no reqId). Currently only `ready`. */
export type ThumbWorkerEvent = { kind: 'ready' };

/** Discriminated union of every message that flows on the worker port. */
export type ThumbWorkerMessage =
  | ThumbWorkerRequest
  | ThumbWorkerOk
  | ThumbWorkerErr
  | ThumbWorkerEvent;
