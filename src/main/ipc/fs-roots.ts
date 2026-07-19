import os from 'os';
import path from 'path';
import { ipcMain } from 'electron';
import { setAllowedRoots, getAllowedRoots } from '../allowed-roots';
import { closeIndexDb } from '../index-worker-host';
import { syncWatchedRoots } from '../dir-watcher';
import { triggerStartupMigration } from '../migrate-date-tags';

/**
 * Location-root handlers: home/parent probes + the renderer's
 * `fs:setAllowedRoots` sync push. Split out of the old god-registrar `ipc.ts`
 * (docs/01 §12) — behavior is verbatim; only the module boundary is new.
 */

export function registerFsRootsHandlers(): void {
  ipcMain.handle('fs:homeDir', () => os.homedir());

  ipcMain.handle('fs:parentDir', (_event, dirPath: string) =>
    path.dirname(dirPath)
  );

  // Raw (un-folded) roots from the previous push. index-db keys its
  // connection cache by the exact renderer-pushed strings, so removed
  // locations must be diffed against these — `getAllowedRoots()` is
  // case-folded/normalized and its entries wouldn't match the db keys
  // (docs/04 §10).
  let lastSyncedRoots: string[] = [];

  // The renderer syncs its configured locations here so write handlers can
  // confine mutations to those roots (see assertWithinAllowedRoot).
  ipcMain.handle('fs:setAllowedRoots', (_event, roots: string[]) => {
    const next = roots ?? [];
    // A root that disappeared = a removed location: close its index.db in
    // the worker so per-location handles don't leak for the rest of the
    // session (docs/04 §10). Fire-and-forget — a later query for a still-
    // registered root simply reopens its db lazily.
    for (const prev of lastSyncedRoots) {
      if (!next.includes(prev)) {
        void closeIndexDb(prev).catch(() => undefined);
      }
    }
    lastSyncedRoots = [...next];
    setAllowedRoots(next);
    // docs/04 §10: reconcile fs.watch coverage with the same root set (added
    // locations get a watcher, removed ones are closed). Drives the
    // `fs:dirChanged` push + incremental index rebuilds on external change.
    syncWatchedRoots(next);
    // The startup date-tag migration must wait for this push: at bootstrap
    // the root set is always still empty (the renderer hasn't mounted yet),
    // so running it there silently did nothing (docs/09 §26). The trigger's
    // once-guard keeps later re-pushes (location add/remove) from re-running.
    void triggerStartupMigration(getAllowedRoots());
  });
}
