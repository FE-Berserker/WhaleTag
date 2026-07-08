/**
 * Redux-persist storage adapter backed by synchronous main-process file IO.
 *
 * Electron's localStorage is asynchronously flushed to disk by Chromium and
 * can lose data on process exit. This adapter routes every read/write through
 * `window.whale` synchronous IPC to the main process, which performs
 * synchronous file IO so the data is committed before the call returns.
 *
 * The methods still return Promises because redux-persist v5 calls `.catch()`
 * on the result; we resolve immediately after the synchronous IPC completes.
 *
 * Robustness (H.25 — settings reverting to defaults):
 *  - The getItem path is **defensive** about what the main process hands back.
 *    A non-null, non-undefined, non-string value (which would happen if
 *    `ipcRenderer.sendSync` ever lost its type contract) is treated as a
 *    read failure rather than fed into `JSON.parse` and corrupting the
 *    rehydrated state.
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
  getItem: (key: string): Promise<string | null> => {
    assertWhale();
    let value: unknown;
    try {
      value = window.whale.persistReadSync(key);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[persist-storage-adapter] read IPC failed for', key, e);
      return Promise.resolve(null);
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
            window.whale.persistWriteSync(key, legacy);
          } catch (e) {
            // eslint-disable-next-line no-console
            console.error(
              '[persist-storage-adapter] failed to write migrated blob for',
              key,
              e
            );
            return Promise.resolve(null);
          }
          return Promise.resolve(legacy);
        }
      }
      return Promise.resolve(null);
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
      return Promise.resolve(null);
    }
    return Promise.resolve(value);
  },
  setItem: (key: string, value: string): Promise<void> => {
    assertWhale();
    try {
      window.whale.persistWriteSync(key, value);
    } catch (e) {
      // Surface the failure: the previous file is still intact, but the
      // renderer's `setItem` Promise now rejects, so redux-persist logs
      // the error and the user sees it in DevTools rather than silently
      // losing changes on next launch.
      // eslint-disable-next-line no-console
      console.error('[persist-storage-adapter] write IPC failed for', key, e);
      return Promise.reject(e);
    }
    return Promise.resolve();
  },
  removeItem: (key: string): Promise<void> => {
    assertWhale();
    try {
      window.whale.persistDeleteSync(key);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[persist-storage-adapter] delete IPC failed for', key, e);
      return Promise.reject(e);
    }
    return Promise.resolve();
  },
};

export default mainProcessStorage;
