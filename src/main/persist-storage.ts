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
 *  - Writes are **atomic**: write to `<key>.json.tmp`, then `rename` over the
 *    final file. A crash mid-write leaves the previous file intact instead
 *    of a half-written blob that redux-persist's `JSON.parse` will reject on
 *    next launch (which is the exact failure mode that surfaced as
 *    "settings revert to defaults").
 *  - Errors are logged, not swallowed. The renderer-side adapter does the
 *    same, so a corrupt file surfaces in DevTools instead of silently
 *    downgrading the user to defaults.
 */

import { app } from 'electron';
import path from 'path';
import { promises as fsp } from 'fs';

let _persistDir: string | null = null;

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

function tmpPathForKey(key: string): string {
  return `${filePathForKey(key)}.tmp`;
}

export async function persistRead(key: string): Promise<string | null> {
  try {
    return await fsp.readFile(filePathForKey(key), 'utf8');
  } catch (e) {
    // A missing file is the normal first-run case, not an error.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[persist-storage] read failed for', key, e);
    }
    return null;
  }
}

export async function persistWrite(key: string, value: string): Promise<void> {
  const filePath = filePathForKey(key);
  const tmpPath = tmpPathForKey(key);
  try {
    await fsp.mkdir(persistDir(), { recursive: true });
    // Atomic write: write to .tmp, then rename over the final path. A crash
    // before the rename leaves the previous (intact) file in place.
    await fsp.writeFile(tmpPath, value, 'utf8');
    await fsp.rename(tmpPath, filePath);
  } catch (e) {
    console.error('[persist-storage] write failed for', key, e);
    // Best-effort cleanup of the leftover .tmp so it doesn't accumulate.
    try {
      await fsp.unlink(tmpPath);
    } catch {
      // ignore
    }
    // Re-throw so the renderer's adapter sees the failure and can surface it
    // (instead of silently keeping stale state on disk): the `setItem`
    // promise rejects, redux-persist logs the error, and the previous
    // on-disk file is still intact.
    throw e;
  }
}

export async function persistDelete(key: string): Promise<void> {
  try {
    await fsp.unlink(filePathForKey(key));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[persist-storage] delete failed for', key, e);
    }
  }
}
