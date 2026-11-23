import { createStore } from 'redux';
import { persistReducer, persistStore, createTransform } from 'redux-persist';

import i18n from '-/i18n';
import { notifyApp } from '-/services/app-notice';
import rootReducer, { RootState } from '-/reducers';
import { ExtensionsState } from '-/reducers/extensions';
import { flushExtensionEditors } from '-/services/extension-save-flush';
import mainProcessStorage, { setPersistFailureHandler } from './storage';
import { createPersistFailureReporter } from './persist-failure';

/**
 * redux-persist: survives app restarts by writing whitelisted slices to a
 * JSON file in the main process (via window.whale IPC). We do not use
 * localStorage because Chromium flushes it asynchronously and the last write
 * can be lost when the renderer process exits.
 */

// Only persist user preferences from the extensions slice; registry is loaded
// from disk at runtime and editState is transient.
const extensionsTransform = createTransform(
  (inboundState: ExtensionsState) => ({
    userDefaults: inboundState.userDefaults,
    enabledOverrides: inboundState.enabledOverrides,
  }),
  (outboundState: Partial<ExtensionsState>) => ({
    registry: null,
    userDefaults: outboundState.userDefaults ?? {},
    enabledOverrides: outboundState.enabledOverrides ?? {},
    editState: {},
  }),
  { whitelist: ['extensions'] }
);

const persistConfig = {
  key: 'whale-root',
  // Bump when the shape of any persisted slice changes in a way that the
  // per-slice `=== undefined` migrations in the reducers can't paper over.
  // v1 = initial 9-slice layout (locations, settings, taglibrary, workflow,
  // recent, savedsearches, extensions, ai). v2 = the `ai` conversation slice
  // was removed together with the built-in AI assistant (0.5.0) — the v2
  // migrate drops the stale persisted key so combineReducers never sees it.
  version: 2,
  storage: mainProcessStorage,
  whitelist: [
    'locations',
    'settings',
    'taglibrary',
    'workflow',
    'recent',
    'savedsearches',
    'extensions',
  ] as string[],
  transforms: [extensionsTransform],
  // Coalesce bursts (typing in the text editor dispatches edit-state updates
  // per keystroke). Without this every dispatch re-serialized the whole root
  // and rewrote the file; the transform already strips editState, but the
  // persistoid still wrote the identical bytes each time.
  throttle: 1000,
  // v2: drop the removed `ai` slice from any pre-0.5.0 persisted root. The
  // settings-level `ai*` fields are stripped separately by the settings
  // reducer (see stripRemovedAiFields in reducers/settings.ts) because
  // settings rehydrates per-key via autoMergeLevel1, not via this migrate.
  // redux-persist's PersistedState is a string-keyed bag; the cast keeps the
  // strict `unknown` signature while preserving the original pass-through.
  migrate: (state: unknown, version: number): Promise<Record<string, unknown>> => {
    if (version < 2 && state && typeof state === 'object') {
      const next = { ...(state as Record<string, unknown>) };
      delete next.ai;
      return Promise.resolve(next);
    }
    return Promise.resolve(state as Record<string, unknown>);
  },
  // Verbose redux-persist logging in dev; off in production. The explicit
  // failure reporter below is what surfaces errors to the user in production.
  debug: process.env.NODE_ENV === 'development',
};

const persistedReducer = persistReducer(persistConfig, rootReducer);

// No middleware: redux-thunk was registered for years but the codebase never
// had a single thunk action (async IPC lives in services / components), so
// the middleware was dead weight on every dispatch.
export const store = createStore(persistedReducer);
export const persistor = persistStore(store);

// A failed rehydrate read must never overwrite the existing blob with reducer
// defaults. Pausing the persistor here happens before redux-persist's REHYDRATE
// handler calls `conditionalUpdate`, so the default state stays in memory only.
const reportPersistFailure = createPersistFailureReporter({
  pause: () => persistor.pause(),
  notify: notifyApp,
  translate: (key) => String(i18n.t(key)),
  log: (message, error) => console.error(message, error),
});
setPersistFailureHandler(reportPersistFailure);

// Ensure pending redux-persist writes are flushed before the window unloads.
// The main process intercepts the close event and asks the renderer to flush.
// Load-bearing with the async (invoke) storage adapter: in-flight writes must
// be drained here before main destroys the window (3s closeFallback aside).
// Extension editors keep their buffers inside the iframe, so a dirty
// drawio/markdown/json tab needs its own flush — redux-persist never sees
// that content (editState is transient and the transform strips it).
if (typeof window !== 'undefined' && window.whale?.onBeforeUnloadFlush) {
  window.whale.onBeforeUnloadFlush(async () => {
    // `flushComplete` MUST run even when a flush rejects (disk full, EACCES,
    // a hung extension iframe): main blocks the close for 8 s waiting for this
    // ack, then force-kills the window. Without the `finally` a single storage
    // failure turned every close into an 8 s hang and dropped the error.
    try {
      await Promise.all([persistor.flush(), flushExtensionEditors()]);
    } catch (error) {
      console.error('[persist] before-unload flush failed:', error);
    } finally {
      window.whale.flushComplete();
    }
  });
}

export type { RootState };
