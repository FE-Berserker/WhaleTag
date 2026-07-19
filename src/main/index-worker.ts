/**
 * Index utilityProcess entry point. Spawned via `utilityProcess.fork()` from
 * `src/main/index-worker-host.ts`. All SQLite + FTS5 + pdfjs + EXIF work
 * runs here, off the Electron main event loop — see
 * `docs/15-perf-audit.md` §P0-2 for the design rationale.
 *
 * The worker re-exports `index-db.ts`, `fulltext.ts`, and `indexer.ts`
 * verbatim. `index-db.ts` owns the module-level `openDbs: Map<rootPath, DB>`
 * cache; that map is now scoped to this process, which is the whole point
 * of moving the DB off main. Batch boundaries (`INGEST_BATCH=1000`,
 * `setImmediate` yield, `mapWithConcurrency(8/16)`) are preserved by
 * the re-imported modules — this file only translates the wire protocol.
 */

import type { ExifProcessedRecord } from '../shared/ipc-types';
import type { SearchQuery } from '../shared/search-query';
import type {
  IndexWorkerMessage,
  IndexWorkerRequest,
  IndexWorkerEvent,
} from './index-protocol';
import * as db from './index-db';
import * as fulltext from './fulltext';
import * as indexer from './indexer';

// In a utilityProcess child the parent port lives on `process` —
// `require('electron').parentPort` is undefined at runtime in Electron 42
// (the type is declared on the electron module export, the value is not
// there), so importing it from 'electron' yields undefined and the guard
// below would always throw. `process.parentPort` is `null` in the main
// process, so this guard still catches accidental main-process use.
const parentPort = process.parentPort;
if (!parentPort) {
  // This file is meant to run inside a `utilityProcess.fork()` child. If
  // it's somehow required from the main process, fail loudly so a future
  // refactor that re-imports the index pipeline into main throws on
  // boot rather than silently freezing the UI again.
  throw new Error('index-worker.ts must run inside a utilityProcess child');
}

// Re-bind type aliases to satisfy the discriminated-union narrowing in
// `dispatch`. Both refer to the same type but live in different files;
// `advancedQuery`'s signature uses one, our protocol types use the other.

function post(message: unknown): void {
  parentPort!.postMessage(message);
}

/**
 * docs/04 §10: per-request progress poster, time-throttled so a 100k-file
 * build doesn't flood the worker port with one message per file. The final
 * state is implicit — the request's own response resolves the awaiter, and
 * `done: true` is emitted once at completion for passive observers.
 */
function makeProgressPoster(
  op: 'index:build' | 'fulltext:build',
  rootPath: string
): (phase: 'scan' | 'ingest' | 'extract' | 'delete', processed: number, total: number | null) => void {
  let lastAt = 0;
  return (phase, processed, total) => {
    const now = Date.now();
    if (now - lastAt < 100) return;
    lastAt = now;
    const ev: IndexWorkerEvent = {
      kind: 'progress',
      op,
      rootPath,
      phase,
      processed,
      total,
    };
    post(ev);
  };
}

function fail(reqId: string, err: unknown): void {
  const name = err instanceof Error ? err.name : 'Error';
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  post({
    reqId,
    ok: false,
    error: {
      name,
      message,
      // Strip stack in prod to avoid leaking build-machine paths through
      // IPC. The renderer can still surface name + message.
      ...(process.env.NODE_ENV !== 'production' && stack
        ? { stack }
        : {}),
    },
  });
}

/**
 * Dispatch a single request to the right handler. Wrapped in try/catch
 * via the caller so any throw becomes an `IndexWorkerErr` reply.
 */
async function dispatch(req: IndexWorkerRequest): Promise<void> {
  switch (req.op) {
    // -------- writes / builds --------
    case 'index:build': {
      const { rootPath } = req.arg as { rootPath: string };
      const progress = makeProgressPoster('index:build', rootPath);
      const entries = await indexer.buildIndex(rootPath, (n) =>
        progress('scan', n, null)
      );
      await db.ingestFiles(rootPath, entries, (d, t) =>
        progress('ingest', d, t)
      );
      db.removeLegacyWsi(rootPath);
      post({
        kind: 'progress',
        op: 'index:build',
        rootPath,
        phase: 'ingest',
        processed: entries.length,
        total: entries.length,
        done: true,
      });
      post({ reqId: req.reqId, ok: true, result: { count: entries.length } });
      return;
    }
    case 'fulltext:build': {
      const { rootPath } = req.arg as { rootPath: string };
      const progress = makeProgressPoster('fulltext:build', rootPath);
      const { count } = await fulltext.buildFulltextIndex(rootPath, (n) =>
        progress('extract', n, null)
      );
      post({
        kind: 'progress',
        op: 'fulltext:build',
        rootPath,
        phase: 'extract',
        processed: count,
        total: count,
        done: true,
      });
      post({ reqId: req.reqId, ok: true, result: { count } });
      return;
    }
    case 'exif:mark-processed': {
      const { rootPath, record } = req.arg as {
        rootPath: string;
        record: ExifProcessedRecord;
      };
      db.markExifProcessed(rootPath, record);
      post({ reqId: req.reqId, ok: true, result: undefined });
      return;
    }
    case 'exif:mark-processed-many': {
      const { rootPath, records } = req.arg as {
        rootPath: string;
        records: ExifProcessedRecord[];
      };
      // Single-transaction batch — one WAL fsync for the whole array,
      // not one per record. This is the perf-critical property that
      // `markExifProcessedMany` was written for; do NOT split it.
      db.markExifProcessedMany(rootPath, records);
      post({ reqId: req.reqId, ok: true, result: undefined });
      return;
    }
    case 'exif:clear-processed': {
      const { rootPath } = req.arg as { rootPath: string };
      db.clearExifProcessed(rootPath);
      post({ reqId: req.reqId, ok: true, result: undefined });
      return;
    }

    // -------- reads --------
    case 'index:query': {
      const { rootPath, q } = req.arg as { rootPath: string; q: string };
      post({
        reqId: req.reqId,
        ok: true,
        result: db.queryFiles(rootPath, q),
      });
      return;
    }
    case 'index:advanced': {
      const { rootPath, q } = req.arg as {
        rootPath: string;
        q: SearchQuery;
      };
      post({
        reqId: req.reqId,
        ok: true,
        result: db.advancedQuery(rootPath, q),
      });
      return;
    }
    case 'index:tags': {
      const { rootPath } = req.arg as { rootPath: string };
      post({
        reqId: req.reqId,
        ok: true,
        result: db.distinctTags(rootPath),
      });
      return;
    }
    case 'index:status': {
      const { rootPath } = req.arg as { rootPath: string };
      post({
        reqId: req.reqId,
        ok: true,
        result: db.indexStatus(rootPath),
      });
      return;
    }
    case 'index:close': {
      // Location removed from settings — drop its cached db handle so
      // per-location connections don't accumulate (docs/04 §10). No-op
      // when the db was never opened.
      const { rootPath } = req.arg as { rootPath: string };
      db.closeDb(rootPath);
      post({ reqId: req.reqId, ok: true, result: undefined });
      return;
    }
    case 'index:shutdown': {
      // App quitting: close every db so SQLite WAL checkpoints into the main
      // file on clean close (no `-wal` residue). The host kills the process
      // right after this reply — anything heavier belongs in the host.
      db.closeAllDbs();
      post({ reqId: req.reqId, ok: true, result: undefined });
      return;
    }
    case 'fulltext:search': {
      const { rootPath, q } = req.arg as { rootPath: string; q: string };
      const hits = await fulltext.searchFulltext(rootPath, q);
      post({ reqId: req.reqId, ok: true, result: hits });
      return;
    }
    case 'fulltext:has': {
      const { rootPath } = req.arg as { rootPath: string };
      const has = await fulltext.hasFulltextIndex(rootPath);
      post({ reqId: req.reqId, ok: true, result: has });
      return;
    }
    case 'exif:load-processed': {
      const { rootPath } = req.arg as { rootPath: string };
      post({
        reqId: req.reqId,
        ok: true,
        result: db.loadExifProcessed(rootPath),
      });
      return;
    }
    default: {
      fail(
        req.reqId,
        new Error(
          `unknown op: ${(req as { op?: string }).op ?? '<missing>'}`
        )
      );
      return;
    }
  }
}

/**
 * Message entry point. `MessagePortMain` emits `'message'` with an event
 * whose `.data` is the deserialized payload. Anything missing a `reqId`
 * or `op` is silently dropped (worker echoes, malformed input, etc.).
 */
parentPort.on('message', (event: { data: unknown } | unknown) => {
  const data =
    event && typeof event === 'object' && 'data' in event
      ? (event as { data: unknown }).data
      : event;
  const msg = data as IndexWorkerMessage;
  if (!msg || typeof msg !== 'object') return;
  if (!('reqId' in msg) || !('op' in msg)) return;

  dispatch(msg as IndexWorkerRequest).catch((err: unknown) =>
    fail(msg.reqId, err)
  );
});

// Tell the host we're ready to receive requests. The host uses this as
// one of two signals that boot completed (the other being the `'spawn'`
// event on the parent side).
post({ kind: 'ready' } satisfies IndexWorkerEvent);