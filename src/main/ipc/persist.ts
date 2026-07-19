import { ipcMain } from 'electron';
import { persistRead, persistWrite, persistDelete } from '../persist-storage';

/**
 * redux-persist storage handlers backed by a main-process JSON file.
 * localStorage in Electron is asynchronously flushed by Chromium and can
 * lose data on process exit. The handlers commit the blob via async fs
 * (atomic tmp + rename) so state is on disk before the invoke resolves —
 * same durability as the removed sendSync + sync-fs variant, but without
 * blocking the renderer main thread or the main event loop (2026-07-18).
 *
 * Split out of the old god-registrar `ipc.ts` (docs/01 §12) — behavior is
 * verbatim.
 */

export function registerPersistHandlers(): void {
  ipcMain.handle('persist:read', (_event, key: string) => persistRead(key));
  ipcMain.handle('persist:write', (_event, key: string, value: string) =>
    persistWrite(key, value)
  );
  ipcMain.handle('persist:delete', (_event, key: string) =>
    persistDelete(key)
  );
}
