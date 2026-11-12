import fs, { promises as fsp } from 'fs';
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
 * Platform: `fs.watch {recursive: true}` works on Windows + macOS. Linux has
 * no recursive mode (`ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`), so `startWatch`
 * falls back to one watcher per directory: it walks the tree once, watches
 * every folder, and follows directories added/removed/renamed while running
 * (`attachDirTree` / `syncSubtree`). `.whale`, `node_modules` and `.git` are
 * never descended into (self-echo, and inotify's default ~8k watch budget),
 * and the total is capped by `MAX_DIR_WATCHERS`.
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
/** Directories the per-dir fallback never descends into: our own `.whale`
 *  (self-echo), and the two trees that make inotify's watch budget explode. */
const WATCH_SKIP_DIRS = new Set(['.whale', 'node_modules', '.git']);
/** Hard cap on per-dir watchers (inotify's default budget is ~8k per user). */
const MAX_DIR_WATCHERS = 4_096;
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
  /** `recursive`: one watcher keyed by the root. `per-dir`: one per folder. */
  mode: 'recursive' | 'per-dir';
  watchers: Map<string, fs.FSWatcher>;
  /** Warn once when the per-dir watcher cap is reached. */
  watcherLimitWarned: boolean;
  /** Coalesced changed paths (relative, forward-slash) awaiting flush. */
  pending: Set<string>;
  flushTimer: NodeJS.Timeout | null;
  /** True when a reindex for this root is in flight (skip re-trigger). */
  reindexing: boolean;
  /** A debounced rebuild fired while another rebuild was still running. */
  reindexDirty: boolean;
  reindexTimer: NodeJS.Timeout | null;
  /** Consecutive failed rebuilds — drives the retry backoff. */
  reindexFailures: number;
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

/** Debounce before a retry; doubles per consecutive failure, capped at 60 s. */
const MAX_RETRY_DELAY_MS = 60_000;

function retryDelay(failures: number): number {
  return Math.min(
    REINDEX_DEBOUNCE_MS * 2 ** Math.min(failures, 5),
    MAX_RETRY_DELAY_MS
  );
}

function scheduleReindex(
  rootPath: string,
  w: RootWatch,
  delayMs: number = REINDEX_DEBOUNCE_MS
): void {
  if (w.reindexTimer) clearTimeout(w.reindexTimer);
  w.reindexTimer = setTimeout(() => {
    w.reindexTimer = null;
    void reindexIfBuilt(rootPath, w);
  }, delayMs);
  w.reindexTimer.unref?.();
}

async function reindexIfBuilt(rootPath: string, w: RootWatch): Promise<void> {
  if (w.reindexing) {
    // The timer represented real changes. Remember them instead of dropping
    // the only rebuild that could incorporate those changes.
    w.reindexDirty = true;
    return;
  }
  w.reindexing = true;
  try {
    // Only roots with an EXISTING index get incremental rebuilds — never
    // create `.whale/index.db` for a root the user never indexed (this is
    // also what keeps read-only locations write-free).
    const status = await request('index:status', { rootPath });
    if (!status.ready) {
      w.reindexFailures = 0;
      return;
    }
    await request('index:build', { rootPath });
    w.reindexFailures = 0;
  } catch (error) {
    // A failed rebuild used to be dropped with "the next change retries" — but
    // nothing retries on a quiet root, leaving the index stale indefinitely.
    // Arm the dirty flag and back off (1.5 s doubling, capped at 60 s) so a
    // transient worker failure heals itself without hot-looping a dead one.
    w.reindexFailures += 1;
    w.reindexDirty = true;
    console.warn(
      `[dir-watcher] index rebuild failed for ${rootPath} (attempt ${w.reindexFailures}); retrying in ${retryDelay(w.reindexFailures)} ms`,
      error
    );
  } finally {
    w.reindexing = false;
    if (w.reindexDirty) {
      w.reindexDirty = false;
      scheduleReindex(rootPath, w, retryDelay(w.reindexFailures));
    }
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
const fulltextDirty = new Set<string>();
/** Consecutive failed full-text rebuilds per root (backoff + reset on success). */
const fulltextFailures = new Map<string, number>();

/** Sync the renderer's `settings.fulltextPaths` (pushed on change/startup). */
export function setFulltextRoots(paths: string[]): void {
  fulltextRoots.clear();
  for (const p of paths) fulltextRoots.add(p);
  // Drop pending timers and remembered rebuilds for roots removed mid-flight.
  for (const [fp, timer] of [...fulltextTimers.entries()]) {
    if (!fulltextRoots.has(fp)) {
      clearTimeout(timer);
      fulltextTimers.delete(fp);
    }
  }
  for (const fp of [...fulltextDirty]) {
    if (!fulltextRoots.has(fp)) fulltextDirty.delete(fp);
  }
}

function scheduleFulltextRootReindex(
  fp: string,
  delayMs: number = REINDEX_DEBOUNCE_MS
): void {
  const prev = fulltextTimers.get(fp);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    fulltextTimers.delete(fp);
    void reindexFulltextIfBuilt(fp);
  }, delayMs);
  timer.unref?.();
  fulltextTimers.set(fp, timer);
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
    scheduleFulltextRootReindex(fp);
  }
}

async function reindexFulltextIfBuilt(fp: string): Promise<void> {
  if (fulltextInflight.has(fp)) {
    fulltextDirty.add(fp);
    return;
  }
  fulltextInflight.add(fp);
  try {
    const has = await request('fulltext:has', { rootPath: fp });
    if (!has) {
      fulltextFailures.delete(fp);
      return;
    }
    await request('fulltext:build', { rootPath: fp });
    fulltextFailures.delete(fp);
  } catch (error) {
    // Same rule as the files index: a quiet root must still recover, so keep
    // the dirty flag armed and retry with backoff instead of waiting for an
    // unrelated filesystem event.
    const failures = (fulltextFailures.get(fp) ?? 0) + 1;
    fulltextFailures.set(fp, failures);
    fulltextDirty.add(fp);
    console.warn(
      `[dir-watcher] full-text rebuild failed for ${fp} (attempt ${failures}); retrying in ${retryDelay(failures)} ms`,
      error
    );
  } finally {
    fulltextInflight.delete(fp);
    if (fulltextDirty.delete(fp)) {
      scheduleFulltextRootReindex(fp, retryDelay(fulltextFailures.get(fp) ?? 0));
    }
  }
}

function queueChange(rootPath: string, w: RootWatch, rel: string): void {
  if (rel && isMetaPath(rel)) return; // our own `.whale/` churn — self-echo
  w.pending.add(rel);
  if (w.flushTimer) clearTimeout(w.flushTimer);
  w.flushTimer = setTimeout(() => flush(rootPath, w), DEBOUNCE_MS);
  w.flushTimer.unref?.();
}

function onWatchEvent(rootPath: string, w: RootWatch, filename: string | null): void {
  // fs.watch recursive reports paths relative to the watched root (or null on
  // buffer overflow — degrade to a blanket refresh marker).
  queueChange(rootPath, w, filename == null ? '' : filename.split(path.sep).join('/'));
}

function attachWatcher(
  rootPath: string,
  w: RootWatch,
  dir: string,
  watcher: fs.FSWatcher
): void {
  w.watchers.set(dir, watcher);
  watcher.on('error', () => {
    // Recursive mode: the single watcher died (root unmounted / renamed) —
    // drop the root; `syncWatchedRoots` re-creates it when the root is back.
    // Per-dir mode: drop only this folder; the parent's rename event
    // re-attaches it if the tree comes back.
    if (w.mode === 'recursive') stopWatch(rootPath);
    else detachWatcher(w, dir);
  });
}

function detachWatcher(w: RootWatch, dir: string): void {
  const watcher = w.watchers.get(dir);
  if (!watcher) return;
  w.watchers.delete(dir);
  try {
    watcher.close();
  } catch {
    // already closed
  }
}

function detachTree(w: RootWatch, dir: string): void {
  const prefix = dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
  for (const key of [...w.watchers.keys()]) {
    if (key === dir || key.startsWith(prefix)) detachWatcher(w, key);
  }
}

function attachDirWatcher(rootPath: string, w: RootWatch, dir: string): boolean {
  if (w.watchers.has(dir)) return true;
  if (w.watchers.size >= MAX_DIR_WATCHERS) {
    if (!w.watcherLimitWarned) {
      w.watcherLimitWarned = true;
      console.warn(
        `[dir-watcher] per-directory watch limit reached (${MAX_DIR_WATCHERS}) for ${rootPath}; deeper folders are no longer watched — use manual refresh or rebuild the index`
      );
    }
    return false;
  }
  try {
    const watcher = fs.watch(dir, (eventType, filename) =>
      onPerDirEvent(rootPath, w, dir, eventType, filename)
    );
    attachWatcher(rootPath, w, dir, watcher);
    return true;
  } catch {
    return false; // deleted between readdir and watch, or unreadable
  }
}

async function attachDirTree(rootPath: string, w: RootWatch, startDir: string): Promise<void> {
  const stack = [startDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    if (!attachDirWatcher(rootPath, w, dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // deleted while we walked it
    }
    for (const entry of entries) {
      // Symlinked folders are not followed: a link cycle would attach
      // watchers forever (and `MAX_DIR_WATCHERS` would stop at an arbitrary
      // point instead of at the real tree bound).
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (WATCH_SKIP_DIRS.has(entry.name)) continue;
      stack.push(path.join(dir, entry.name));
    }
  }
}

/** Follow a directory created / removed / renamed after the initial walk. */
async function syncSubtree(rootPath: string, w: RootWatch, target: string): Promise<void> {
  let info: fs.Stats;
  try {
    info = await fsp.stat(target);
  } catch {
    detachTree(w, target); // folder (or a parent of it) is gone
    return;
  }
  if (!info.isDirectory()) return;
  await attachDirTree(rootPath, w, target);
}

function onPerDirEvent(
  rootPath: string,
  w: RootWatch,
  dir: string,
  eventType: string,
  filename: string | null
): void {
  // One watcher per folder reports names relative to that folder; null means
  // the kernel dropped events — degrade to a blanket refresh marker.
  if (filename == null) {
    queueChange(rootPath, w, '');
    return;
  }
  // Windows reports the watched folder itself — sometimes via an extended
  // `\\?\C:\...` path — when that folder is deleted/renamed, so an "absolute
  // filename" must not be joined onto `dir` (that produced junk entries like
  // `a/b/?/C:/...`).
  let name = filename;
  if (name.startsWith('\\\\?\\')) name = name.slice(4);
  const full = path.isAbsolute(name) ? path.normalize(name) : path.join(dir, name);
  const rel = path.relative(rootPath, full).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
  queueChange(rootPath, w, rel);
  // Directories added/removed/renamed while running need watcher bookkeeping:
  // a new folder must get its own watcher, and a deleted one must release the
  // watchers beneath it (otherwise the map leaks on every delete).
  if (eventType === 'rename') {
    void syncSubtree(rootPath, w, full).catch((error) => {
      console.warn(`[dir-watcher] failed to follow ${full}:`, error);
    });
  }
}

function startWatch(rootPath: string, forcePerDir = false): RootWatch | null {
  const w: RootWatch = {
    mode: 'recursive',
    watchers: new Map(),
    watcherLimitWarned: false,
    pending: new Set(),
    flushTimer: null,
    reindexing: false,
    reindexDirty: false,
    reindexTimer: null,
    reindexFailures: 0,
  };
  if (!forcePerDir) {
    try {
      const watcher = fs.watch(rootPath, { recursive: true }, (_event, filename) =>
        onWatchEvent(rootPath, w, filename)
      );
      attachWatcher(rootPath, w, rootPath, watcher);
      return w;
    } catch {
      // Linux: `recursive: true` throws ERR_FEATURE_UNAVAILABLE_ON_PLATFORM.
      // Fall through to one watcher per directory.
    }
  }
  w.mode = 'per-dir';
  if (!attachDirWatcher(rootPath, w, rootPath)) return null; // root missing
  void attachDirTree(rootPath, w, rootPath).catch((error) => {
    console.warn(`[dir-watcher] failed to attach directory watchers for ${rootPath}:`, error);
  });
  return w;
}

function stopWatch(rootPath: string): void {
  const w = watches.get(rootPath);
  if (!w) return;
  if (w.flushTimer) clearTimeout(w.flushTimer);
  if (w.reindexTimer) clearTimeout(w.reindexTimer);
  w.reindexDirty = false;
  for (const watcher of w.watchers.values()) {
    try {
      watcher.close();
    } catch {
      // already closed
    }
  }
  w.watchers.clear();
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
  fulltextDirty.clear();
}

/** Test hooks: current watch count + whether a root is watched. */
export function _watchCountForTest(): number {
  return watches.size;
}
export function _pendingForTest(rootPath: string): string[] | null {
  const w = watches.get(rootPath);
  return w ? [...w.pending] : null;
}
export function _reindexDirtyForTest(rootPath: string): boolean | null {
  return watches.get(rootPath)?.reindexDirty ?? null;
}

/** Test seam: force the per-directory fallback (the Linux path) on any OS. */
export function _startWatchForcedPerDirForTest(rootPath: string): boolean {
  if (watches.has(rootPath)) stopWatch(rootPath);
  const w = startWatch(rootPath, true);
  if (!w) return false;
  watches.set(rootPath, w);
  return true;
}

export function _watchModeForTest(rootPath: string): 'recursive' | 'per-dir' | null {
  return watches.get(rootPath)?.mode ?? null;
}

export function _dirWatcherCountForTest(rootPath: string): number | null {
  return watches.get(rootPath)?.watchers.size ?? null;
}
