import os from 'os';
import path from 'path';
import { ipcMain } from 'electron';
import { acceptRootsFromRenderer } from '../known-roots';
import { setAllowedRoots, getAllowedRoots } from '../allowed-roots';
import { foldPath } from '../path-fold';
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
  // confine mutations to those roots (see assertWithinAllowedRoot). The push
  // is filtered through the main-process record of directories the user
  // actually picked (known-roots.ts) — otherwise a compromised renderer could
  // register `/` and defeat the whole boundary.
  ipcMain.handle('fs:setAllowedRoots', (_event, roots: string[]) => {
    const { accepted: next, refused } = acceptRootsFromRenderer(roots ?? []);
    for (const raw of refused) {
      console.warn(
        '[roots] ignoring a location that was never picked by the user:',
        raw
      );
    }
    // A root that disappeared = a removed location: close its index.db in
    // the worker so per-location handles don't leak for the rest of the
    // session (docs/04 §10). Fire-and-forget — a later query for a still-
    // registered root simply reopens its db lazily.
    //
    // Compare folded paths: the renderer can re-push the same location with a
    // different spelling (`C:\Foo` vs `c:\foo`, trailing separator). Exact
    // string comparison treated those as removals and closed a live db.
    const nextFolded = new Set(next.map((r) => foldPath(path.resolve(r))));
    for (const prev of lastSyncedRoots) {
      if (next.includes(prev)) continue;
      if (nextFolded.has(foldPath(path.resolve(prev)))) continue;
      void closeIndexDb(prev).catch(() => undefined);
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
