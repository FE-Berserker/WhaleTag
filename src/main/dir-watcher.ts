import fs from 'fs';
import path from 'path';
import { request } from './index-worker-host';

/**
 * External-change watcher for configured locations (docs/04 §10): one
 * recursive `fs.watch` per location root; events are filtered, coalesced and
 * debounced, then:
 *
 *  1. broadcast as `fs:dirChanged` to every window — the renderer refreshes
 *     the file area when the change touches the open directory (see
 *     `DirectoryContentContextProvider`);
 *  2. re-run the INCREMENTAL index build for that root — but only when its
 *     index already exists (a root whose index was never built stays on the
 *     manual build path; we never create `.whale/index.db` unprompted, which
 *     also keeps read-only locations write-free).
 *
 * Platform: `fs.watch {recursive: true}` works on Windows + macOS. On Linux
 * it throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` — the root is then marked
 * unsupported and behaves as before (manual refresh / rebuild).
 *
 * Self-echo: everything under a `.whale` path segment is dropped — our own
 * sidecar / index.db / thumbs / transcode writes would otherwise retrigger
 * ourselves on every tag save. Real Whale file operations (rename/move/copy)
 * still echo through the watcher, which is harmless: the refresh is
 * idempotent and the incremental rebuild is cheap.
 *
 * `filename: null` (fs.watch buffer overflow) degrades to "something under
 * the root changed" (`''`) — consumers treat that as a blanket refresh.
 */

/** Payload broadcast on `fs:dirChanged` (mirrored in shared/ipc-types.ts). */
export interface DirChangedEvent {
  rootPath: string;
  /** Changed paths relative to `rootPath` (forward slashes). Empty = the
   *  watcher's filename buffer overflowed; treat as "anything may have
   *  changed". */
  paths: string[];
}

const META_DIR = '.whale';
/** Trailing debounce per root: events keep arriving → flush waits. */
const DEBOUNCE_MS = 500;
/** Cap on reported paths per flush (the rest are dropped — refresh doesn't
 *  need the full list, and huge bursts (git checkout) would flood IPC). */
const MAX_PATHS_PER_FLUSH = 500;
/** Backoff before re-indexing a root after its last change flush. */
const REINDEX_DEBOUNCE_MS = 1500;

/** True when `rel` (relative, either slash style) touches `.whale`. */
export function isMetaPath(rel: string): boolean {
  const norm = rel.split(path.sep).join('/');
  return norm === META_DIR || norm.startsWith(`${META_DIR}/`) || norm.includes(`/${META_DIR}/`);
}

/** True when `candidate` equals `ancestor` or sits beneath it (either slash
 *  style, segment-boundary aware, case-insensitive like the rest of the app). */
export function isSameOrDescendantPath(ancestor: string, candidate: string): boolean {
  const a = ancestor.split(path.sep).join('/').replace(/\/+$/, '').toLowerCase();
  const c = candidate.split(path.sep).join('/').toLowerCase();
  return c === a || c.startsWith(`${a}/`);
}

interface RootWatch {
  watcher: fs.FSWatcher;
  /** Coalesced changed paths (relative, forward-slash) awaiting flush. */
  pending: Set<string>;
  flushTimer: NodeJS.Timeout | null;
  /** True when a reindex for this root is in flight (skip re-trigger). */
  reindexing: boolean;
  reindexTimer: NodeJS.Timeout | null;
}

const watches = new Map<string, RootWatch>();

/** Broadcast sink — main.ts wires this to `webContents.send`. */
let broadcast: ((ev: DirChangedEvent) => void) | null = null;

export function setDirChangedBroadcast(fn: ((ev: DirChangedEvent) => void) | null): void {
  broadcast = fn;
}

function flush(rootPath: string, w: RootWatch): void {
  w.flushTimer = null;
  if (w.pending.size === 0) return;
  const paths = [...w.pending].slice(0, MAX_PATHS_PER_FLUSH);
  w.pending.clear();
  broadcast?.({ rootPath, paths });
  scheduleReindex(rootPath, w);
  scheduleFulltextReindex(rootPath, paths);
}

function scheduleReindex(rootPath: string, w: RootWatch): void {
  if (w.reindexTimer) clearTimeout(w.reindexTimer);
  w.reindexTimer = setTimeout(() => {
    w.reindexTimer = null;
    void reindexIfBuilt(rootPath, w);
  }, REINDEX_DEBOUNCE_MS);
  w.reindexTimer.unref?.();
}

async function reindexIfBuilt(rootPath: string, w: RootWatch): Promise<void> {
  if (w.reindexing) return;
  w.reindexing = true;
  try {
    // Only roots with an EXISTING index get incremental rebuilds — never
    // create `.whale/index.db` for a root the user never indexed (this is
    // also what keeps read-only locations write-free).
    const status = await request('index:status', { rootPath });
    if (!status.ready) return;
    await request('index:build', { rootPath });
  } catch {
    // Best effort: worker down / root unreadable — the next change retries.
  } finally {
    w.reindexing = false;
  }
}

// ---------------------------------------------------------------------------
// Full-text index invalidation (docs/04 §10): a fulltext root always sits
// under a location root (the build handler asserts it), so the location
// watcher above already sees every relevant event — the flush only has to
// map "change under FP" → debounced incremental `fulltext:build`, guarded by
// `fulltext:has` so an index is never created unprompted (same rule as the
// files index; read-only fulltext roots stay write-free).
// ---------------------------------------------------------------------------

const fulltextRoots = new Set<string>();
const fulltextTimers = new Map<string, NodeJS.Timeout>();
const fulltextInflight = new Set<string>();

/** Sync the renderer's `settings.fulltextPaths` (pushed on change/startup). */
export function setFulltextRoots(paths: string[]): void {
  fulltextRoots.clear();
  for (const p of paths) fulltextRoots.add(p);
  // Drop pending timers for roots that were removed mid-debounce.
  for (const [fp, timer] of [...fulltextTimers.entries()]) {
    if (!fulltextRoots.has(fp)) {
      clearTimeout(timer);
      fulltextTimers.delete(fp);
    }
  }
}

function scheduleFulltextReindex(rootPath: string, flushPaths: string[]): void {
  for (const fp of fulltextRoots) {
    if (!isSameOrDescendantPath(rootPath, fp)) continue; // FP not under this location
    const touched =
      flushPaths.length === 0 || // watch buffer overflow — conservative match
      flushPaths.some((rel) =>
        isSameOrDescendantPath(fp, `${rootPath}/${rel}`)
      );
    if (!touched) continue;
    const prev = fulltextTimers.get(fp);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      fulltextTimers.delete(fp);
      void reindexFulltextIfBuilt(fp);
    }, REINDEX_DEBOUNCE_MS);
    timer.unref?.();
    fulltextTimers.set(fp, timer);
  }
}

async function reindexFulltextIfBuilt(fp: string): Promise<void> {
  if (fulltextInflight.has(fp)) return;
  fulltextInflight.add(fp);
  try {
    const has = await request('fulltext:has', { rootPath: fp });
    if (!has) return;
    await request('fulltext:build', { rootPath: fp });
  } catch {
    // Best effort — the next change retries.
  } finally {
    fulltextInflight.delete(fp);
  }
}

function onWatchEvent(rootPath: string, w: RootWatch, filename: string | null): void {
  // fs.watch recursive reports paths relative to the watched root (or null on
  // buffer overflow — degrade to a blanket refresh marker).
  const rel = filename == null ? '' : filename.split(path.sep).join('/');
  if (rel && isMetaPath(rel)) return; // our own `.whale/` churn — self-echo
  w.pending.add(rel);
  if (w.flushTimer) clearTimeout(w.flushTimer);
  w.flushTimer = setTimeout(() => flush(rootPath, w), DEBOUNCE_MS);
  w.flushTimer.unref?.();
}

function startWatch(rootPath: string): RootWatch | null {
  const w: RootWatch = {
    watcher: null as unknown as fs.FSWatcher,
    pending: new Set(),
    flushTimer: null,
    reindexing: false,
    reindexTimer: null,
  };
  try {
    w.watcher = fs.watch(rootPath, { recursive: true }, (_event, filename) =>
      onWatchEvent(rootPath, w, filename)
    );
  } catch {
    // Linux: recursive watch unsupported → root falls back to manual refresh.
    return null;
  }
  w.watcher.on('error', () => {
    // Watcher died (root unmounted / renamed) — drop it; the next
    // `syncWatchedRoots` re-creates it if the root is back.
    stopWatch(rootPath);
  });
  return w;
}

function stopWatch(rootPath: string): void {
  const w = watches.get(rootPath);
  if (!w) return;
  if (w.flushTimer) clearTimeout(w.flushTimer);
  if (w.reindexTimer) clearTimeout(w.reindexTimer);
  try {
    w.watcher.close();
  } catch {
    // already closed
  }
  watches.delete(rootPath);
}

/**
 * Reconcile watchers with the configured location roots (called from the
 * `fs:setAllowedRoots` IPC handler — same push that registers the roots).
 */
export function syncWatchedRoots(roots: string[]): void {
  const wanted = new Set(roots);
  for (const key of [...watches.keys()]) {
    if (!wanted.has(key)) stopWatch(key);
  }
  for (const root of wanted) {
    if (watches.has(root)) continue;
    const w = startWatch(root);
    if (w) watches.set(root, w);
  }
}

/** Close every watcher (app quit). */
export function closeAllWatchers(): void {
  for (const key of [...watches.keys()]) stopWatch(key);
  for (const timer of fulltextTimers.values()) clearTimeout(timer);
  fulltextTimers.clear();
}

/** Test hooks: current watch count + whether a root is watched. */
export function _watchCountForTest(): number {
  return watches.size;
}
export function _pendingForTest(rootPath: string): string[] | null {
  const w = watches.get(rootPath);
  return w ? [...w.pending] : null;
}
