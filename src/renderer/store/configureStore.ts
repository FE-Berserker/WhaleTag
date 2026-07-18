import { createStore } from 'redux';
import { persistReducer, persistStore, createTransform } from 'redux-persist';

import rootReducer, { RootState } from '-/reducers';
import { ExtensionsState } from '-/reducers/extensions';
import mainProcessStorage from './storage';

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
  // recent, savedsearches, extensions, ai). Add v2 here the next time the
  // schema moves and write a `migrate` that handles the upgrade.
  version: 1,
  storage: mainProcessStorage,
  whitelist: [
    'locations',
    'settings',
    'taglibrary',
    'workflow',
    'recent',
    'savedsearches',
    'extensions',
    'ai',
  ] as string[],
  transforms: [extensionsTransform],
  // Default no-op migrate — rehydrated state is taken as-is. The per-slice
  // reducers already migrate `=== undefined` fields on every action, so
  // adding new optional fields never requires a bump. Keep this here as the
  // explicit hook for future schema changes.
  migrate: (state: unknown, _version: number): Promise<unknown> =>
    Promise.resolve(state),
  // Verbose redux-persist logging in dev; off in production. The console
  // errors added in storage.ts and persist-storage.ts cover the production
  // case (a corrupt file surfaces in DevTools instead of silently
  // downgrading the user to defaults).
  debug: process.env.NODE_ENV === 'development',
};

const persistedReducer = persistReducer(persistConfig, rootReducer);

// No middleware: redux-thunk was registered for years but the codebase never
// had a single thunk action (async IPC lives in services / components), so
// the middleware was dead weight on every dispatch.
export const store = createStore(persistedReducer);
export const persistor = persistStore(store);

// Ensure pending redux-persist writes are flushed before the window unloads.
// The main process intercepts the close event and asks the renderer to flush.
// Load-bearing with the async (invoke) storage adapter: in-flight writes must
// be drained here before main destroys the window (3s closeFallback aside).
if (typeof window !== 'undefined' && window.whale?.onBeforeUnloadFlush) {
  window.whale.onBeforeUnloadFlush(async () => {
    await persistor.flush();
    window.whale.flushComplete();
  });
}

export type { RootState };
