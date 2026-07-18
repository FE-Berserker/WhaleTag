/**
 * Resolve the absolute path of the bundled `uno-worker.py` python script.
 *
 * UNLIKE `resolveIndexWorkerEntryPath()` (../index-worker-spawn.ts), the
 * python script is NOT a webpack asset — the main webpack config has no
 * loader for `.py` (only `.m?js` / `.tsx?` / image types; see
 * `.erb/configs/webpack.config.base.ts`), so it is never emitted into
 * `dist/` and never lands inside `app.asar`. Instead it ships via
 * electron-builder's `extraResources` (resources/builder.json), which copies
 * it to real-FS `process.resourcesPath/office-worker/uno-worker.py`.
 *
 * That matters because the host launches it with `child_process.spawn`,
 * which is NOT asar-aware (unlike `utilityProcess.fork`). A path inside
 * app.asar would ENOENT at runtime — and only in packaged builds, since dev
 * runs against the source tree.
 *
 *   - packaged:  process.resourcesPath/office-worker/uno-worker.py
 *   - dev:       <repo>/src/main/office-worker/uno-worker.py
 *                (__dirname is release/app/dist/main; four `..` reach the
 *                repo root because webpack sets `node.__dirname = false`.)
 */

import path from 'path';
import { app } from 'electron';

export function resolveOfficeWorkerScriptPath(): string {
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      'office-worker',
      'uno-worker.py'
    );
  }
  return path.join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'src',
    'main',
    'office-worker',
    'uno-worker.py'
  );
}
