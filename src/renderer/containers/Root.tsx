import { useEffect, useMemo, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';

import MainLayout from '-/containers/MainLayout';
import TaskReminder from '-/components/TaskReminder';
import { CurrentLocationContextProvider } from '-/hooks/CurrentLocationContextProvider';
import { DirectoryContentContextProvider } from '-/hooks/DirectoryContentContextProvider';
import { DirectoryTreeRefreshContextProvider } from '-/hooks/DirectoryTreeRefreshContextProvider';
import { IOActionsContextProvider } from '-/hooks/IOActionsContextProvider';
import { LocationIndexContextProvider } from '-/hooks/LocationIndexContextProvider';
import { TagMetaContextProvider } from '-/hooks/TagMetaContextProvider';
import { LocationTagLibraryContextProvider } from '-/hooks/LocationTagLibraryContextProvider';
import { ExtensionContextProvider } from '-/hooks/ExtensionContextProvider';
import { BackgroundPlayerContextProvider } from '-/hooks/BackgroundPlayerContextProvider';
import { AiComponentProvider } from '-/hooks/useAiComponent';
import { setActiveLocation } from '-/reducers/locations';
import { createWhaleTheme } from '-/theme';
import { useResolvedTheme } from '-/theme/useResolvedThemeMode';
import { RootState } from '-/reducers';
import i18n from '-/i18n';
import { ipcApi } from '-/services/ipc-api';
import { setAllowedRootsAndWait } from '-/services/allowed-roots';

/**
 * Root container: top of the renderer tree (after the Redux/i18n/Persist
 * wrappers in index.tsx). Builds the MUI theme from the persisted
 * `settings.themeMode`, then composes the context provider stack + MainLayout.
 *
 * Nesting order matters: DirectoryContent reads from CurrentLocation;
 * IOActions reads from both; LocationIndex reads from CurrentLocation.
 */
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
    void setAllowedRootsAndWait(locationItems.map((l) => l.path));
  }, [locationItems]);

  // docs/04 §10: keep the dir-watcher's fulltext root set in sync so an
  // external change inside a fulltext root schedules an incremental rebuild.
  const fulltextPaths = useSelector(
    (s: RootState) => s.settings?.fulltextPaths ?? []
  );
  useEffect(() => {
    void ipcApi.syncFulltextPaths(fulltextPaths).catch(() => undefined);
  }, [fulltextPaths]);

  // Clean up stale extension revisions once on startup.
  useEffect(() => {
    if (locationItems.length === 0) return;
    void ipcApi.cleanupRevisions(30);
  }, []);

  // Pin the react-dnd HTML5 backend to a singleton via useMemo so React 18
  // StrictMode's dev-mode double-invoke doesn't try to register the same
  // backend twice (the symptom is "Cannot have two HTML5 backends at the
  // same time."). See https://github.com/react-dnd/react-dnd/issues/3623.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const DndAny: any = DndProvider;
  const dndBackend = useMemo(() => ({ backend: HTML5Backend }), []);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <DndAny {...dndBackend}>
        <AiComponentProvider>
        <CurrentLocationContextProvider>
          <DirectoryContentContextProvider>
            <DirectoryTreeRefreshContextProvider>
              <IOActionsContextProvider>
                <LocationIndexContextProvider>
                  <TagMetaContextProvider>
                    <LocationTagLibraryContextProvider>
                      <ExtensionContextProvider>
                        <BackgroundPlayerContextProvider>
                          <MainLayout />
                          <TaskReminder />
                        </BackgroundPlayerContextProvider>
                      </ExtensionContextProvider>
                    </LocationTagLibraryContextProvider>
                  </TagMetaContextProvider>
                </LocationIndexContextProvider>
              </IOActionsContextProvider>
            </DirectoryTreeRefreshContextProvider>
          </DirectoryContentContextProvider>
        </CurrentLocationContextProvider>
        </AiComponentProvider>
      </DndAny>
    </ThemeProvider>
  );
}
