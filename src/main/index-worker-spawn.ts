/**
 * Resolve the absolute path of the compiled `index-worker.js`.
 *
 * The worker is emitted next to `main.js` by the same webpack main config
 * (same output dir, MAIN_DIST), so we anchor on `__dirname` — the real
 * directory of `main.js` at runtime. Webpack sets `node.__dirname = false` in
 * BOTH the dev and prod main configs (so it is NOT polyfilled), which makes
 * this correct in both modes:
 *   - dev:       __dirname = release/app/dist/main
 *   - packaged:  __dirname = <resources>/app.asar/dist/main
 *
 * Do NOT use `app.getAppPath()`: in dev that returns the project root
 * (c:\WhaleTag), NOT release/app/, so `path.join(app.getAppPath(), 'dist',
 * 'main', ...)` points at a path that does not exist (c:\WhaleTag\dist\main\…)
 * and the fork fails with ERR_MODULE_NOT_FOUND. In packaged mode getAppPath()
 * is `app.asar`, which is why this bug only surfaced in dev.
 *
 * `utilityProcess.fork()` is Electron-native and asar-aware (unlike
 * `child_process.fork` — see electron/electron#2708), so it loads the worker
 * directly from inside app.asar without an `asarUnpack` rewrite.
 */

import path from 'path';

export function resolveIndexWorkerEntryPath(): string {
  return path.join(__dirname, 'index-worker.js');
}
