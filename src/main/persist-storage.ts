/**
 * Main-process backed persistence for redux-persist.
 *
 * `localStorage` in Electron is backed by Chromium's LevelDB and its writes are
 * flushed asynchronously. On process exit the last few milliseconds of state
 * can be lost, which is why settings appeared to disappear after restart.
 *
 * This module keeps the redux-persist blob in a plain JSON file inside
 * `app.getPath('userData')` and uses async file IO with an atomic tmp+rename
 * commit, so the bytes are on disk before the IPC invoke resolves — the same
 * durability guarantee as the old `sendSync` + `writeFileSync` version, but
 * without blocking the renderer main thread or the main-process event loop
 * (2026-07-18 migration). The path is scoped under `persist/` so it can
 * coexist with other user-data files.
 *
 * Robustness (H.25 — settings reverting to defaults):
 *  - `persistDir()` is **lazy** — resolved on first call, not at import time.
 *    `app.getPath('userData')` works at import time today, but a future
 *    Electron change or a test that requires the module before
 *    `app.whenReady()` would otherwise write to the wrong place (and produce
 *    a file the running app never reads back). Lazy resolution makes the
 *    path depend on the app's actual runtime state, not on when Node
 *    evaluated the import.
 *  - Writes are **atomic + durable**: delegated to the shared
 *    `atomicWriteText` helper (the same one used by sidecar / index /
 *    thumbnail), which writes a pid+counter-unique temp, `datasync`s the
 *    bytes to stable storage, and only then `rename`s over the final file.
 *    The `datasync` before rename is what prevents a post-rename crash from
 *    exposing a partially-flushed temp as the target — the exact failure
 *    mode that surfaced as "settings revert to defaults".
 *  - Read errors are **propagated**, not collapsed into `null`. `null` means
 *    "the file does not exist" (first run) and nothing else: redux-persist
 *    treats it as an empty store and rewrites the defaults. The renderer
 *    pauses persistence when the read rejects, so a transient I/O error can
 *    no longer replace the user's settings/tag library with defaults.
 *  - A one-time `.bak` copy of the pre-session blob is kept next to the real
 *    file. It is best effort (a failed backup never blocks the write) and is
 *    meant for manual recovery when the primary file is later damaged.
 */

import { app } from 'electron';
import path from 'path';
import { promises as fsp } from 'fs';
import { atomicWriteText } from './atomic-write';

let _persistDir: string | null = null;

/** Paths whose pre-session backup has already been taken in this process. */
const backedUpPaths = new Set<string>();

/** Resolve the persist directory lazily. Safe to call before `app.whenReady()`
 *  in current Electron, but we still defer to the first call so any future
 *  Electron release that requires a ready app won't break the path. */
function persistDir(): string {
  if (_persistDir === null) {
    _persistDir = path.join(app.getPath('userData'), 'persist');
  }
  return _persistDir;
}

function filePathForKey(key: string): string {
  // Sanitize the key so it is safe as a filename. redux-persist keys are
  // simple strings like 'whale-root'; this guard is defense-in-depth.
  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(persistDir(), `${safeKey}.json`);
}

/**
 * Copy the current blob to `<key>.json.bak` once per process. Taking the copy
 * before the first write of a session preserves the state the app *read*, so
 * a bad later write can be diagnosed/recovered. Missing file (first run) is
 * not an error; any other failure is logged and the real write proceeds.
 */
async function backupOnce(filePath: string): Promise<void> {
  if (backedUpPaths.has(filePath)) return;
  try {
    await fsp.access(filePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    console.warn('[persist-storage] backup access failed for', filePath, e);
    return;
  }
  try {
    await fsp.copyFile(filePath, `${filePath}.bak`);
    backedUpPaths.add(filePath);
  } catch (e) {
    console.warn('[persist-storage] backup failed for', filePath, e);
  }
}

export async function persistRead(key: string): Promise<string | null> {
  try {
    return await fsp.readFile(filePathForKey(key), 'utf8');
  } catch (e) {
    // Only a missing file is the first-run case. Anything else (EACCES,
    // EIO, EISDIR, a disconnected drive) must reject: the renderer pauses
    // redux-persist on a read failure, whereas returning null here would let
    // the defaults be written over the user's real data.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    console.error('[persist-storage] read failed for', key, e);
    throw e;
  }
}

export async function persistWrite(key: string, value: string): Promise<void> {
  const filePath = filePathForKey(key);
  try {
    await fsp.mkdir(persistDir(), { recursive: true });
    // Keep the state the app started this session with, once. The copy runs
    // before the first write only, so a long session does not pay for it on
    // every keystroke flush.
    await backupOnce(filePath);
    // Atomic + durable write via the shared helper (same one used by sidecar
    // / index / thumbnail): write a pid+counter-unique temp, `datasync` the
    // bytes to stable storage, then rename over the final file. The
    // `datasync` before rename is what prevents a post-rename crash from
    // exposing a partially-flushed temp as the target — the exact failure
    // mode that surfaces as "settings revert to defaults". The unique temp
    // name also means concurrent `setItem` calls on the same key can't
    // collide on `<key>.json.tmp`.
    await atomicWriteText(filePath, value);
  } catch (e) {
    console.error('[persist-storage] write failed for', key, e);
    // Re-throw so the renderer's adapter sees the failure and can surface it
    // (instead of silently keeping stale state on disk): the `setItem`
    // promise rejects, redux-persist logs the error, and the previous
    // on-disk file is still intact (atomic-write cleans up its own temp on
    // failure and leaves the prior target untouched).
    throw e;
  }
}

export async function persistDelete(key: string): Promise<void> {
  try {
    await fsp.unlink(filePathForKey(key));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    console.error('[persist-storage] delete failed for', key, e);
    // Re-throw: a purge that leaves the blob on disk "succeeds" in the renderer
    // but the old state resurrects on the next launch. The caller (redux-persist
    // adapter) must see the failure instead.
    throw e;
  }
}
