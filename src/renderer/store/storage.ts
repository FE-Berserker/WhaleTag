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
 *  - A read failure is **not** reported as `null`. `null` means the file is
 *    absent (first run); rejecting lets `configureStore` pause redux-persist
 *    before the defaults can be written over the real file.
 *  - The getItem path is **defensive** about what the main process hands back.
 *    A non-null, non-undefined, non-string value is treated as a read failure
 *    rather than fed into `JSON.parse` and corrupting the rehydrated state.
 *  - Failures are reported to the registered handler (one user-visible notice
 *    + pause on read failure) and logged, so nothing is silently swallowed.
 *  - The legacy localStorage migration is still here, but it now logs
 *    when it actually moves bytes (so a one-time migration is visible).
 */

import type { Storage } from 'redux-persist';

export type PersistFailureKind = 'read' | 'write' | 'delete';
export type PersistFailureHandler = (
  kind: PersistFailureKind,
  error: unknown
) => void;

let failureHandler: PersistFailureHandler | null = null;

/**
 * Register the store-level failure handler. Kept as a module setter instead of
 * an import from configureStore to avoid a cycle: redux-persist constructs the
 * storage adapter before the store/persistor exist.
 */
export function setPersistFailureHandler(
  handler: PersistFailureHandler | null
): void {
  failureHandler = handler;
}

function reportFailure(kind: PersistFailureKind, error: unknown): void {
  if (!failureHandler) return;
  try {
    failureHandler(kind, error);
  } catch (e) {
    // A throwing reporter must not turn a failed storage operation into an
    // unhandled rejection inside redux-persist's write chain.
    console.error('[persist-storage-adapter] failure handler threw', e);
  }
}

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
      console.error('[persist-storage-adapter] read IPC failed for', key, e);
      reportFailure('read', e);
      // Reject: returning null here makes redux-persist believe this is a
      // fresh install and immediately rewrite the defaults (data loss).
      throw e;
    }
    if (value === null || value === undefined) {
      // One-time migration from the old localStorage-backed storage. If the new
      // JSON file does not exist yet but localStorage still has the redux-
      // persist blob, copy it over so existing users do not lose settings.
      if (typeof localStorage !== 'undefined') {
        const legacy = localStorage.getItem(key);
        if (legacy !== null) {
          console.warn(
            '[persist-storage-adapter] migrating legacy localStorage blob for',
            key
          );
          try {
            await window.whale.persistWrite(key, legacy);
          } catch (e) {
            // The legacy blob is still the user's real state; use it for this
            // session even if the migration write failed (the next persist
            // write retries the same file). Never fall back to defaults here.
            console.error(
              '[persist-storage-adapter] failed to write migrated blob for',
              key,
              e
            );
            reportFailure('write', e);
          }
          return legacy;
        }
      }
      return null;
    }
    if (typeof value !== 'string') {
      const error = new Error(
        `persist read returned non-string for ${key} (type: ${typeof value})`
      );
      console.error('[persist-storage-adapter]', error.message, '— discarding');
      reportFailure('read', error);
      throw error;
    }
    return value;
  },
  setItem: async (key: string, value: string): Promise<void> => {
    assertWhale();
    try {
      await window.whale.persistWrite(key, value);
    } catch (e) {
      // Surface the failure: the previous file is still intact, but the
      // `setItem` Promise now rejects, so redux-persist logs the error and the
      // user gets a notice instead of losing changes silently.
      console.error('[persist-storage-adapter] write IPC failed for', key, e);
      reportFailure('write', e);
      throw e;
    }
  },
  removeItem: async (key: string): Promise<void> => {
    assertWhale();
    try {
      await window.whale.persistDelete(key);
    } catch (e) {
      console.error('[persist-storage-adapter] delete IPC failed for', key, e);
      reportFailure('delete', e);
      throw e;
    }
  },
};

export default mainProcessStorage;
