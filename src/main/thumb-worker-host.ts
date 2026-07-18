/**
 * Parent-side proxy for the thumbnail-render utilityProcess
 * (`serviceName: 'whale-thumb'`).
 *
 * Responsibilities (mirrors `index-worker-host.ts`):
 *  - Lazily fork the child on first request (the spawn is memoised so
 *    concurrent first-callers share one fork).
 *  - Correlate requests ↔ responses via a `pending` map keyed by reqId.
 *  - Reject every pending request when the child exits or errors.
 *  - Re-spawn on next request after a crash (no auto-respawn loop —
 *    a hard crash gets one restart from the next user action).
 *  - `killThumbWorker()` for app-quit shutdown (best-effort kill; pending
 *    requests are rejected via the `'exit'` handler).
 *  - In-process fallback under ELECTRON_RUN_AS_NODE (see `thumbRequest`).
 *
 * `thumbnail.ts` calls `thumbRequest()` directly from
 * `doGenerateThumbnail` / `encodeOfficeThumb`.
 */

import { utilityProcess, UtilityProcess } from 'electron';
import {
  newRequest,
  completeRequest,
  failRequest,
  rejectAllPending,
  type Pending,
} from './worker-protocol';
import { resolveThumbWorkerEntryPath } from './thumb-worker-spawn';
import {
  renderPdfThumb,
  renderFontThumb,
  renderEbookThumb,
} from './thumb-render';
import type {
  ThumbWorkerOp,
  ThumbWorkerMessage,
} from './thumb-protocol';

/** Window in which we wait for the worker's `ready` event after spawn. */
const READY_TIMEOUT_MS = 10_000;

const SERVICE_NAME = 'whale-thumb';
const STDERR_TAG = '[whale-thumb] ';

let child: UtilityProcess | null = null;
let spawnPromise: Promise<void> | null = null;
const pending = new Map<string, Pending>();

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
    const entry = resolveThumbWorkerEntryPath();
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
      const msg = raw as ThumbWorkerMessage;
      // Server-pushed events (no reqId): currently only `ready`, used as
      // one valid signal that the child has booted.
      if ('kind' in msg) {
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
        // Narrow `ThumbWorkerOk | ThumbWorkerErr` to `ThumbWorkerErr` via
        // the literal type discriminator (`ok: true | false`). TS handles
        // this for the boolean check itself but loses precision when
        // accessing `.error` because the parent union is generic over
        // `msg`; the cast is the smallest precise fix.
        const errMsg = msg as Extract<ThumbWorkerMessage, { ok: false }>;
        const err = new Error(errMsg.error.message);
        err.name = errMsg.error.name;
        if (errMsg.error.stack) err.stack = errMsg.error.stack;
        failRequest(pending, msg.reqId, err);
      }
    });

    c.on('exit', (code: number) => {
      const e = new Error(`thumb worker exited unexpectedly (code=${code})`);
      rejectAllPending(pending, e);
      child = null;
      spawnPromise = null;
      // Don't auto-respawn — next thumbRequest() will lazy-spawn fresh.
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
 * Send a render request to the worker and await the final JPEG buffer.
 *
 * Lazy-spawns on first call. Throws on worker exit (the host rejects
 * every pending request when the child dies — see `'exit'` handler).
 *
 * Under `ELECTRON_RUN_AS_NODE` the request is served IN-PROCESS instead:
 * the test runner (`scripts/run-tests.cjs` → `electron --test`) sets that
 * env var, and in plain-Node mode `utilityProcess.fork` does not exist.
 * `thumbnail.test.ts` / `ebook-cover.test.ts` call `generateThumbnail`
 * directly, so without this fallback they would crash on the fork. The
 * fallback runs the very same `thumb-render.ts` functions the worker
 * would, keeping the tests' coverage meaningful.
 */
export async function thumbRequest(
  op: ThumbWorkerOp,
  arg: { srcPath: string }
): Promise<Buffer> {
  if (process.env.ELECTRON_RUN_AS_NODE) {
    switch (op) {
      case 'thumb:pdf':
        return renderPdfThumb(arg.srcPath);
      case 'thumb:font':
        return renderFontThumb(arg.srcPath);
      case 'thumb:ebook':
        return renderEbookThumb(arg.srcPath);
      default:
        throw new Error(`unknown op: ${op as string}`);
    }
  }
  await ensureSpawn();
  if (!child) throw new Error('thumb worker not running');
  const { reqId, promise } = newRequest(pending);
  child.postMessage({ reqId, op, arg });
  // Structured clone turns the worker's Buffer into a plain Uint8Array on
  // this side; rewrap it so callers always get a real Buffer.
  const result = (await promise) as { buf: Uint8Array };
  return Buffer.from(result.buf);
}

/**
 * Best-effort kill for app shutdown. Pending requests are rejected via the
 * `'exit'` handler (and cleared defensively here in case `kill()` is
 * synchronous on Windows).
 */
export function killThumbWorker(): void {
  if (pending.size > 0) {
    rejectAllPending(pending, new Error('thumb worker killed at app shutdown'));
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
