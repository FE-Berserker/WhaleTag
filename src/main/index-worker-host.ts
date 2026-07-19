/**
 * Parent-side proxy for the index utilityProcess (`serviceName: 'whale-index'`).
 *
 * Responsibilities:
 *  - Lazily fork the child on first request (the spawn is memoised so
 *    concurrent first-callers share one fork).
 *  - Correlate requests ↔ responses via a `pending` map keyed by reqId.
 *  - Reject every pending request when the child exits or errors.
 *  - Re-spawn on next request after a crash (no auto-respawn loop —
 *    a hard crash gets one restart from the next user action).
 *  - `killIndexWorker()` for app-quit shutdown (best-effort kill without
 *    graceful flush; a graceful `shutdown` op + WAL checkpoint is a
 *    follow-up).
 *
 * The renderer-facing IPC layer (`src/main/ipc.ts`) calls `request()`
 * directly. `subscribe()` fans out worker events (`ready` + build
 * `progress`) — `main.ts` forwards progress to windows as `index:progress`
 * (docs/04 §10).
 */

import { utilityProcess, UtilityProcess } from 'electron';
import {
  newRequest,
  completeRequest,
  failRequest,
  rejectAllPending,
  type Pending,
} from './worker-protocol';
import { resolveIndexWorkerEntryPath } from './index-worker-spawn';
import type {
  IndexWorkerOp,
  IndexWorkerArg,
  IndexWorkerResult,
  IndexWorkerMessage,
  IndexWorkerEvent,
} from './index-protocol';

/** Window in which we wait for the worker's `ready` event after spawn. */
const READY_TIMEOUT_MS = 10_000;

const SERVICE_NAME = 'whale-index';
const STDERR_TAG = '[whale-index] ';

let child: UtilityProcess | null = null;
let spawnPromise: Promise<void> | null = null;
const pending = new Map<string, Pending>();
const subscribers = new Set<(ev: IndexWorkerEvent) => void>();

/**
 * Lazily spawn the child utilityProcess. Memoised: concurrent first-callers
 * share the same `spawnPromise` so we never fork twice for one boot.
 *
 * Resolves once the child has either emitted `{ kind: 'ready' }` (preferred)
 * or fired the `'spawn'` event (fallback). If neither fires within
 * `READY_TIMEOUT_MS`, we proceed optimistically — per-op errors will
 * surface via the request/response cycle.
 */
async function ensureSpawn(): Promise<void> {
  if (child) return;
  if (spawnPromise) return spawnPromise;

  spawnPromise = new Promise<void>((resolve) => {
    const entry = resolveIndexWorkerEntryPath();
    const c = utilityProcess.fork(entry, [], {
      serviceName: SERVICE_NAME,
      // 'pipe' lets us prefix worker stdout/stderr so log lines are
      // distinguishable from the main process in dev consoles.
      stdio: 'pipe',
    });
    child = c;

    c.stdout?.on('data', (b: Buffer) => {
      process.stdout.write(STDERR_TAG + b.toString());
    });
    c.stderr?.on('data', (b: Buffer) => {
      process.stderr.write(STDERR_TAG + b.toString());
    });

    let resolved = false;
    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      resolve();
    };

    c.on('message', (raw: unknown) => {
      const msg = raw as IndexWorkerMessage;
      // Server-pushed events (no reqId): fan out to subscribers, and use
      // `ready` as one valid signal that the child has booted.
      if ('kind' in msg) {
        for (const h of subscribers) {
          try {
            h(msg);
          } catch {
            // Don't let a subscriber crash the host.
          }
        }
        if (msg.kind === 'ready') finish();
        return;
      }
      // Response (has reqId): narrow to ok|err via the `'ok' in msg` check
      // — TypeScript can't infer the discrimination from a single boolean
      // alone on a 4-member union.
      if (!('ok' in msg)) return;
      if (msg.ok) {
        completeRequest(pending, msg.reqId, msg.result);
      } else {
        // Narrow `IndexWorkerOk | IndexWorkerErr` to `IndexWorkerErr` via
        // the literal type discriminator (`ok: true | false`). TS handles
        // this for the boolean check itself but loses precision when
        // accessing `.error` because the parent union is generic over
        // `msg`; the cast is the smallest precise fix.
        const errMsg = msg as Extract<IndexWorkerMessage, { ok: false }>;
        const err = new Error(errMsg.error.message);
        err.name = errMsg.error.name;
        if (errMsg.error.stack) err.stack = errMsg.error.stack;
        failRequest(pending, msg.reqId, err);
      }
    });

    c.on('exit', (code: number) => {
      const e = new Error(`index worker exited unexpectedly (code=${code})`);
      rejectAllPending(pending, e);
      child = null;
      spawnPromise = null;
      // Don't auto-respawn — next request() will lazy-spawn fresh.
    });

    // Electron's `UtilityProcess` type only re-exposes `on('spawn', …)`, so
    // we cast through `EventEmitter` to attach the `error` listener. The
    // `'exit'` event still fires for crashes; this just gives us an
    // earlier signal for spawn-time failures.
    (c as unknown as NodeJS.EventEmitter).on('error', (err: Error) => {
      // The 'exit' event usually follows; reject all pending either way
      // so the renderer surfaces the error promptly.
      rejectAllPending(pending, err);
    });

    // 'spawn' is a strong fallback — it fires once Node has started.
    c.once('spawn', () => finish());

    setTimeout(finish, READY_TIMEOUT_MS).unref?.();
  });

  try {
    await spawnPromise;
  } catch (e) {
    spawnPromise = null;
    throw e;
  }
}

/**
 * Send a request to the worker and await the correlated response.
 *
 * Lazy-spawns on first call. Throws on worker exit (the host rejects
 * every pending request when the child dies — see `'exit'` handler).
 *
 * The `op` literal types `arg` and `result` so call sites get full
 * type-checking: `request('index:query', { rootPath, q: 'foo' })` returns
 * `Promise<IndexEntry[]>`.
 */
// `ResultFor<O>` uses a distributive conditional (`O extends ... ?`)
// so TypeScript correctly narrows `IndexWorkerResult` to the single
// variant matching `O`. A plain `Extract<IndexWorkerResult, { op: O }>`
// over a generic `O` widens to the full union because of how
// `Extract` distributes; the conditional form is the only shape TS
// gets right.
type ResultFor<O extends IndexWorkerOp> = O extends IndexWorkerOp
  ? Extract<IndexWorkerResult, { op: O }>['result']
  : never;

export async function request<O extends IndexWorkerOp>(
  op: O,
  arg: Extract<IndexWorkerArg, { op: O }>['arg']
): Promise<ResultFor<O>> {
  await ensureSpawn();
  if (!child) throw new Error('index worker not running');
  const { reqId, promise } = newRequest(pending);
  child!.postMessage({ reqId, op, arg });
  // `promise` is typed as `Promise<unknown>` so the per-op generic on
  // `request<O>` can narrow the return type at the call site. The precise
  // shape is enforced by the signature above.
  return promise as Promise<ResultFor<O>>;
}

/**
 * Subscribe to server-pushed events (`ready` on boot; `progress` during
 * `index:build` / `fulltext:build`). Returns an unsubscribe function —
 * mirror the `onAiChunk` shape at `src/main/preload.ts:291-316`.
 */
export function subscribe(handler: (ev: IndexWorkerEvent) => void): () => void {
  subscribers.add(handler);
  return () => {
    subscribers.delete(handler);
  };
}

/**
 * Ask the worker to close the index.db connection for `rootPath` (docs/04
 * §10 — its location was removed from settings). No-op when the worker
 * isn't running: a never-spawned worker holds no handles, and respawning
 * just to close would be pure waste. Fire-and-forget at the call site.
 */
export async function closeIndexDb(rootPath: string): Promise<void> {
  if (!child) return;
  await request('index:close', { rootPath });
}

/**
 * Graceful shutdown for app quit (docs/04 §10): ask the worker to
 * `closeAllDbs()` so SQLite WAL checkpoints into the main db file (no `-wal`
 * residue), bounded by a timeout — quitting must never hang on a stuck
 * worker. No-op when the worker was never spawned. The caller is expected
 * to `killIndexWorker()` right after (the process is killed either way;
 * this only decides whether the WAL is flushed first).
 */
export async function shutdownIndexWorker(timeoutMs = 1000): Promise<void> {
  if (!child) return;
  try {
    await Promise.race([
      request('index:shutdown', {}),
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs).unref?.();
      }),
    ]);
  } catch {
    // Best effort — the kill that follows still ends the process.
  }
}

/**
 * Best-effort kill for app shutdown. Pending requests are rejected via the
 * `'exit'` handler (and cleared defensively here in case `kill()` is
 * synchronous on Windows). Pair with {@link shutdownIndexWorker} for a WAL
 * checkpoint before the kill.
 */
export function killIndexWorker(): void {
  if (pending.size > 0) {
    rejectAllPending(pending, new Error('index worker killed at app shutdown'));
  }
  if (!child) return;
  try {
    child.kill();
  } catch {
    // Already dead — ignore.
  }
  child = null;
  spawnPromise = null;
}