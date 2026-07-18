/**
 * Redux-persist storage adapter backed by main-process file IO (async IPC).
 *
 * Electron's localStorage is asynchronously flushed to disk by Chromium and
 * can lose data on process exit. This adapter routes every read/write through
 * `window.whale` async IPC (`invoke`) to the main process, which commits the
 * JSON file (atomic tmp + rename) before the invoke resolves — the durability
 * guarantee of the old `sendSync` adapter, but without blocking the renderer
 * main thread or the main-process event loop (2026-07-18 migration; the
 * `persist:*Sync` channels were removed).
 *
 * Rehydration is async: `PersistGate` (index.tsx) already gates first render
 * on it. Pending writes are drained on window close via `persistor.flush()`
 * in configureStore.ts — that handshake is load-bearing and must stay,
 * otherwise the last in-flight write could be lost when the window closes.
 *
 * Robustness (H.25 — settings reverting to defaults):
 *  - The getItem path is **defensive** about what the main process hands back.
 *    A non-null, non-undefined, non-string value is treated as a read failure
 *    rather than fed into `JSON.parse` and corrupting the rehydrated state.
 *  - Errors are logged so a corrupt/missing file surfaces in DevTools
 *    instead of silently downgrading the user to defaults.
 *  - The legacy localStorage migration is still here, but it now logs
 *    when it actually moves bytes (so a one-time migration is visible).
 */

import type { Storage } from 'redux-persist';

function assertWhale(): void {
  if (typeof window === 'undefined' || !window.whale) {
    throw new Error('Main-process storage requires window.whale');
  }
}

const mainProcessStorage: Storage = {
  getItem: async (key: string): Promise<string | null> => {
    assertWhale();
    let value: unknown;
    try {
      value = await window.whale.persistRead(key);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[persist-storage-adapter] read IPC failed for', key, e);
      return null;
    }
    if (value === null || value === undefined) {
      // One-time migration from the old localStorage-backed storage. If the new
      // JSON file does not exist yet but localStorage still has the redux-
      // persist blob, copy it over so existing users do not lose settings.
      if (typeof localStorage !== 'undefined') {
        const legacy = localStorage.getItem(key);
        if (legacy !== null) {
          // eslint-disable-next-line no-console
          console.warn(
            '[persist-storage-adapter] migrating legacy localStorage blob for',
            key
          );
          try {
            await window.whale.persistWrite(key, legacy);
          } catch (e) {
            // eslint-disable-next-line no-console
            console.error(
              '[persist-storage-adapter] failed to write migrated blob for',
              key,
              e
            );
            return null;
          }
          return legacy;
        }
      }
      return null;
    }
    if (typeof value !== 'string') {
      // eslint-disable-next-line no-console
      console.error(
        '[persist-storage-adapter] read returned non-string for',
        key,
        '(type:',
        typeof value,
        ') — discarding'
      );
      return null;
    }
    return value;
  },
  setItem: async (key: string, value: string): Promise<void> => {
    assertWhale();
    try {
      await window.whale.persistWrite(key, value);
    } catch (e) {
      // Surface the failure: the previous file is still intact, but the
      // renderer's `setItem` Promise now rejects, so redux-persist logs
      // the error and the user sees it in DevTools rather than silently
      // losing changes on next launch.
      // eslint-disable-next-line no-console
      console.error('[persist-storage-adapter] write IPC failed for', key, e);
      throw e;
    }
  },
  removeItem: async (key: string): Promise<void> => {
    assertWhale();
    try {
      await window.whale.persistDelete(key);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[persist-storage-adapter] delete IPC failed for', key, e);
      throw e;
    }
  },
};

export default mainProcessStorage;
