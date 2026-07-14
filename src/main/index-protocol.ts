/**
 * Type definitions for the index utilityProcess protocol. Pure types — no
 * runtime — shared between the parent (main process) and the utility
 * process child (`index-worker.ts`).
 *
 * See `docs/15-perf-audit.md` §P0-2 for the design rationale. The plan is
 * minimum viable: 11 ops, lazy spawn, no progress push (deferred).
 */

import type {
  IndexEntry,
  FulltextHit,
  ExifProcessedRecord,
} from '../shared/ipc-types';
import type { SearchQuery } from '../shared/search-query';

/**
 * Every request op the worker handles. The string literal matches the IPC
 * channel name so log lines are grep-friendly and the host/worker share a
 * single source of truth.
 */
export type IndexWorkerOp =
  // files index
  | 'index:build'
  | 'index:query'
  | 'index:advanced'
  | 'index:tags'
  | 'index:status'
  // fulltext
  | 'fulltext:build'
  | 'fulltext:search'
  | 'fulltext:has'
  // exif cache
  | 'exif:load-processed'
  | 'exif:mark-processed'
  | 'exif:mark-processed-many'
  | 'exif:clear-processed';

/**
 * Per-op argument shape. A discriminated union keyed by `op` — the host
 * uses this union to type-check `request<O>(op, arg)` calls.
 */
export type IndexWorkerArg =
  | { op: 'index:build'; arg: { rootPath: string } }
  | { op: 'index:query'; arg: { rootPath: string; q: string } }
  | { op: 'index:advanced'; arg: { rootPath: string; q: SearchQuery } }
  | { op: 'index:tags'; arg: { rootPath: string } }
  | { op: 'index:status'; arg: { rootPath: string } }
  | { op: 'fulltext:build'; arg: { rootPath: string } }
  | { op: 'fulltext:search'; arg: { rootPath: string; q: string } }
  | { op: 'fulltext:has'; arg: { rootPath: string } }
  | { op: 'exif:load-processed'; arg: { rootPath: string } }
  | {
      op: 'exif:mark-processed';
      arg: { rootPath: string; record: ExifProcessedRecord };
    }
  | {
      op: 'exif:mark-processed-many';
      arg: { rootPath: string; records: ExifProcessedRecord[] };
    }
  | { op: 'exif:clear-processed'; arg: { rootPath: string } };

/** Per-op return type. Same discriminated-union shape as `IndexWorkerArg`. */
export type IndexWorkerResult =
  | { op: 'index:build'; result: { count: number } }
  | { op: 'index:query'; result: IndexEntry[] }
  | { op: 'index:advanced'; result: IndexEntry[] }
  | { op: 'index:tags'; result: string[] }
  | { op: 'index:status'; result: { count: number; ready: boolean } }
  | { op: 'fulltext:build'; result: { count: number } }
  | { op: 'fulltext:search'; result: FulltextHit[] }
  | { op: 'fulltext:has'; result: boolean }
  | { op: 'exif:load-processed'; result: ExifProcessedRecord[] }
  | { op: 'exif:mark-processed'; result: void }
  | { op: 'exif:mark-processed-many'; result: void }
  | { op: 'exif:clear-processed'; result: void };

/** A request envelope sent from host → worker. */
export interface IndexWorkerRequest {
  reqId: string;
  op: IndexWorkerOp;
  arg: unknown;
}

/** Successful response: worker → host. */
export interface IndexWorkerOk {
  reqId: string;
  ok: true;
  result: unknown;
}

/**
 * Failed response: worker → host. `stack` is included only in dev to avoid
 * leaking build-machine absolute paths through IPC; production strips it.
 */
export interface IndexWorkerErr {
  reqId: string;
  ok: false;
  error: {
    name: string;
    message: string;
    stack?: string;
  };
}

/**
 * Server-pushed events (no reqId). Currently only `ready` — progress
 * events arrive in a follow-up PR (mirror the `ai:chunk` pattern at
 * `src/main/ai/ipc-ai-runtime.ts:57-63`).
 */
export type IndexWorkerEvent =
  | { kind: 'ready' }
  | {
      kind: 'progress';
      op: 'index:build' | 'fulltext:build';
      rootPath: string;
      phase: 'scan' | 'ingest' | 'extract' | 'delete';
      processed: number;
      total: number | null;
    };

/** Discriminated union of every message that flows on the worker port. */
export type IndexWorkerMessage =
  | IndexWorkerRequest
  | IndexWorkerOk
  | IndexWorkerErr
  | IndexWorkerEvent;