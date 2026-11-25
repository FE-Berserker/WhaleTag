import { useEffect, useMemo, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';

import MainLayout from '-/containers/MainLayout';
import AppNoticeHost from '-/components/AppNoticeHost';
import { ConfirmDialogProvider } from '-/components/ConfirmDialogProvider';
import TaskReminder from '-/components/TaskReminder';
import { CurrentLocationContextProvider } from '-/hooks/CurrentLocationContextProvider';
import { DirectoryContentContextProvider } from '-/hooks/DirectoryContentContextProvider';
import { DirectoryTreeRefreshContextProvider } from '-/hooks/DirectoryTreeRefreshContextProvider';
import { IOActionsContextProvider } from '-/hooks/IOActionsContextProvider';
import { LocationIndexContextProvider } from '-/hooks/LocationIndexContextProvider';
import { TagMetaContextProvider } from '-/hooks/TagMetaContextProvider';
import { LocationTagLibraryContextProvider } from '-/hooks/LocationTagLibraryContextProvider';
import { ExtensionContextProvider } from '-/hooks/ExtensionContextProvider';
import { addLocation, removeLocation, setActiveLocation } from '-/reducers/locations';
import { createWhaleTheme } from '-/theme';
import { useResolvedTheme } from '-/theme/useResolvedThemeMode';
import { RootState } from '-/reducers';
import i18n from '-/i18n';
import { ipcApi } from '-/services/ipc-api';
import { setAllowedRootsAndWait } from '-/services/allowed-roots';
import { errorMessage } from '-/services/errors';
import { persistor, store } from '-/store/configureStore';

/**
 * Root container: top of the renderer tree (after the Redux/i18n/Persist
 * wrappers in index.tsx). Builds the MUI theme from the persisted
 * `settings.themeMode`, then composes the context provider stack + MainLayout.
 *
 * Nesting order matters: DirectoryContent reads from CurrentLocation;
 * IOActions reads from both; LocationIndex reads from CurrentLocation.
 */
const EMPTY_FULLTEXT_PATHS: string[] = [];

async function pushLocationRoots(
  items: RootState['locations']['items']
): Promise<void> {
  await setAllowedRootsAndWait(
    items.map((item) => item.path),
    items.filter((item) => item.isReadOnly).map((item) => item.path)
  );
}

export default function Root() {
  const dispatch = useDispatch();
  const themeMode = useSelector((s: RootState) => s.settings.themeMode);
  const language = useSelector((s: RootState) => s.settings?.language ?? 'en');
  const fontSize = useSelector((s: RootState) => s.settings?.fontSize ?? 13);
  const defaultLocationId = useSelector(
    (s: RootState) => s.settings?.defaultLocationId ?? null
  );
  const locationItems = useSelector((s: RootState) => s.locations.items);
  // Resolve the persisted ThemeMode into the concrete MUI mode and the color
  // preset. For classic modes this is the default 'whale' preset; for curated
  // full-theme modes it is the matching preset. This is the only place 'system'
  // and the new theme modes are converted; downstream palette.mode is always a
  // real MUI-acceptable value.
  const { mode: resolvedMode, presetId } = useResolvedTheme(themeMode);
  const theme = useMemo(
    () => createWhaleTheme(resolvedMode, presetId, fontSize),
    [resolvedMode, presetId, fontSize]
  );

  useEffect(() => {
    document.title = 'WhaleTag';
  }, []);

  // Prevent the browser/Electron default for file drops anywhere outside our
  // drop targets (which would otherwise navigate the window to the file://).
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  // Open the configured default location once on startup (if it still exists).
  // A ref guards against re-running when state hydrates / locations change.
  const appliedDefaultRef = useRef(false);
  useEffect(() => {
    if (appliedDefaultRef.current) return;
    if (!defaultLocationId) return;
    if (!locationItems.some((l) => l.id === defaultLocationId)) return;
    appliedDefaultRef.current = true;
    dispatch(setActiveLocation(defaultLocationId));
  }, [defaultLocationId, locationItems, dispatch]);

  useEffect(() => {
    document.documentElement.lang = language;
    if (i18n.language !== language) {
      void i18n.changeLanguage(language);
    }
  }, [language]);

  // Sync configured location roots to the main process so write handlers can
  // confine mutations to those paths (defense-in-depth — see assertWithinAllowedRoot).
  // Use the `…AndWait` helper so child effects that fire before this one can
  // `await waitForAllowedRoots()` before issuing write IPCs — otherwise React's
  // bottom-up effect order races main's fail-closed empty-roots check
  // (notably `index:build` in TaskReminder).
  useEffect(() => {
    void setAllowedRootsAndWait(
      locationItems.map((l) => l.path),
      // Read-only locations travel with the root push: main refuses writes
      // inside them (assertWritable), so the guard no longer lives only in
      // the renderer's own command handlers.
      locationItems.filter((l) => l.isReadOnly).map((l) => l.path)
    );
  }, [locationItems]);

  // MCP location additions still go through the same Redux action as the
  // native folder picker. Read the store AFTER dispatch, not a render-time
  // snapshot: a concurrent UI add/remove must never be omitted or resurrected
  // by this targeted root push. Ack only after roots and persistence settle.
  useEffect(() => {
    return ipcApi.onMcpAddLocationRequest((req) => {
      void (async () => {
        let failure: string | undefined;
        let addedId: string | undefined;
        try {
          const action = addLocation(req.name, req.path, req.readOnly);
          addedId = action.payload.id;
          dispatch(action);
          await pushLocationRoots(store.getState().locations.items);
          await persistor.flush();
        } catch (error) {
          failure = errorMessage(error) || 'location addition failed';
          console.error('[root] MCP location addition failed', error);
          if (addedId) {
            // A failed request must not leave a persisted duplicate that a
            // retry cannot see in main's allowed-root list. Roll back through
            // Redux, then re-sync and flush the removal before acknowledging.
            try {
              dispatch(removeLocation(addedId));
              await pushLocationRoots(store.getState().locations.items);
              await persistor.flush();
            } catch (rollbackError) {
              failure += `; rollback failed: ${errorMessage(rollbackError) || 'unknown error'}`;
              console.error('[root] MCP location rollback failed', rollbackError);
            }
          }
        }
        try {
          await ipcApi.mcpCompleteAddLocation(req.reqId, failure);
        } catch (error) {
          console.error('[root] MCP location acknowledgement failed', error);
        }
      })();
    });
  }, [dispatch]);

  // docs/04 §10: keep the dir-watcher's fulltext root set in sync so an
  // external change inside a fulltext root schedules an incremental rebuild.
  const fulltextPaths = useSelector(
    (s: RootState) => s.settings?.fulltextPaths ?? EMPTY_FULLTEXT_PATHS
  );
  useEffect(() => {
    void ipcApi.syncFulltextPaths(fulltextPaths).catch((e) => {
      // Watcher-sync failure is background; a tagged log is the honest level
      // (nobody clicked anything, and a toast per settings change would spam).
      console.warn('[root] fulltext path sync failed', e);
    });
  }, [fulltextPaths]);

  // Clean up stale extension revisions. Runs again whenever the number of
  // locations changes: the first render may precede the persisted location
  // list (empty → the early return below), so this cannot be a mount-only
  // effect.
  useEffect(() => {
    if (locationItems.length === 0) return;
    void ipcApi.cleanupRevisions(30).catch((e) => {
      console.warn('[root] revision cleanup failed', e);
    });
  }, [locationItems.length]);

  // Pin the react-dnd HTML5 backend to a stable props object via useMemo so
  // React 18 StrictMode's dev-mode double-invoke doesn't try to register the
  // same backend twice (the symptom is "Cannot have two HTML5 backends at the
  // same time."). See https://github.com/react-dnd/react-dnd/issues/3623.
  const dndProps = useMemo(() => ({ backend: HTML5Backend }), []);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <DndProvider {...dndProps}>
        <CurrentLocationContextProvider>
          <DirectoryContentContextProvider>
            <DirectoryTreeRefreshContextProvider>
              {/* App-wide MUI confirm — mounted above IOActionsContextProvider
                  so its trash-failure fallback can use it too. */}
              <ConfirmDialogProvider>
              <IOActionsContextProvider>
                <LocationIndexContextProvider>
                  <TagMetaContextProvider>
                    <LocationTagLibraryContextProvider>
                      <ExtensionContextProvider>
                        <MainLayout />
                        <TaskReminder />
                        <AppNoticeHost />
                      </ExtensionContextProvider>
                    </LocationTagLibraryContextProvider>
                  </TagMetaContextProvider>
                </LocationIndexContextProvider>
              </IOActionsContextProvider>
              </ConfirmDialogProvider>
            </DirectoryTreeRefreshContextProvider>
          </DirectoryContentContextProvider>
        </CurrentLocationContextProvider>
      </DndProvider>
    </ThemeProvider>
  );
}
