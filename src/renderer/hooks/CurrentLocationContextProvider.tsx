import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useDispatch, useSelector } from 'react-redux';

import type { WhaleLocation } from '../../shared/ipc-types';
import { RootState } from '-/reducers';
import { setActiveLocation } from '-/reducers/locations';
import { recordRecent } from '-/reducers/recent';
import { ipcApi } from '-/services/ipc-api';

/**
 * Owns the "where am I" state: the active location plus the current
 * sub-directory path inside it. Navigation (navigateTo / goUp) only changes
 * the in-memory path; switching locations resets to that location's root.
 *
 * Also maintains a navigation history within the current location for
 * back/forward.
 *
 * Must sit ABOVE DirectoryContentContextProvider (which reads
 * currentDirectoryPath) in the tree.
 */
interface CurrentLocationContextValue {
  currentLocation: WhaleLocation | null;
  currentDirectoryPath: string;
  openLocation: (location: WhaleLocation) => void;
  navigateTo: (dirPath: string) => void;
  /** Jump to a directory, switching the active location first if needed. */
  navigateToInLocation: (locationId: string, dirPath: string) => void;
  goUp: () => Promise<void>;
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
}

// Exported so component tests (e.g. CalendarView.test.tsx) can supply a stub
// value via `<CurrentLocationContext.Provider>` without standing up the real
// provider (which depends on Redux + ipcApi). Production code uses the hook.
export const CurrentLocationContext =
  createContext<CurrentLocationContextValue | null>(null);

export function useCurrentLocationContext(): CurrentLocationContextValue {
  const ctx = useContext(CurrentLocationContext);
  if (!ctx) {
    throw new Error(
      'useCurrentLocationContext must be used within CurrentLocationContextProvider'
    );
  }
  return ctx;
}

export function CurrentLocationContextProvider({
  children,
}: {
  children: ReactNode;
}) {
  const dispatch = useDispatch();
  const { items, activeId } = useSelector((s: RootState) => s.locations);

  const currentLocation = useMemo(
    () => items.find((l) => l.id === activeId) ?? null,
    [items, activeId]
  );

  const [currentDirectoryPath, setCurrentDirectoryPath] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  // Set just before switching location so the reset effect lands on this
  // sub-directory instead of the location root (used by navigateToInLocation).
  const pendingPathRef = useRef<string | null>(null);

  // When the active location changes, reset to its root (or a pending path)
  // and clear history.
  useEffect(() => {
    const pending = pendingPathRef.current;
    pendingPathRef.current = null;
    const root = currentLocation ? currentLocation.path : '';
    const target = pending && currentLocation ? pending : root;
    setCurrentDirectoryPath(target);
    setHistory(target ? [target] : []);
    setHistoryIndex(target ? 0 : -1);
    // We intentionally depend only on the location id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLocation?.id]);

  // Record every visited directory into the recent-directories LRU.
  useEffect(() => {
    if (!currentLocation || !currentDirectoryPath) return;
    dispatch(
      recordRecent({
        path: currentDirectoryPath,
        locationId: currentLocation.id,
      })
    );
  }, [currentDirectoryPath, currentLocation, dispatch]);

  const openLocation = useCallback(
    (location: WhaleLocation) => {
      dispatch(setActiveLocation(location.id));
      // The effect above will reset currentDirectoryPath + history.
    },
    [dispatch]
  );

  const navigateTo = useCallback(
    (dirPath: string) => {
      setCurrentDirectoryPath(dirPath);
      setHistory((prev) => [...prev.slice(0, historyIndex + 1), dirPath]
      );
      setHistoryIndex((prev) => prev + 1);
    },
    [historyIndex]
  );

  const navigateToInLocation = useCallback(
    (locationId: string, dirPath: string) => {
      if (currentLocation && locationId === currentLocation.id) {
        navigateTo(dirPath);
      } else {
        // Defer the target path; the location-reset effect will apply it.
        pendingPathRef.current = dirPath;
        dispatch(setActiveLocation(locationId));
      }
    },
    [currentLocation, navigateTo, dispatch]
  );

  const goUp = useCallback(async () => {
    if (!currentDirectoryPath) return;
    // Stop at the location root — don't browse above it.
    if (currentLocation && currentDirectoryPath === currentLocation.path) return;
    const parent = await ipcApi.parentDir(currentDirectoryPath);
    navigateTo(parent);
  }, [currentDirectoryPath, currentLocation, navigateTo]);

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < history.length - 1;

  const goBack = useCallback(() => {
    if (!canGoBack) return;
    const next = historyIndex - 1;
    setHistoryIndex(next);
    setCurrentDirectoryPath(history[next]);
  }, [canGoBack, history, historyIndex]);

  const goForward = useCallback(() => {
    if (!canGoForward) return;
    const next = historyIndex + 1;
    setHistoryIndex(next);
    setCurrentDirectoryPath(history[next]);
  }, [canGoForward, history, historyIndex]);

  const value = useMemo(
    () => ({
      currentLocation,
      currentDirectoryPath,
      openLocation,
      navigateTo,
      navigateToInLocation,
      goUp,
      canGoBack,
      canGoForward,
      goBack,
      goForward,
    }),
    [
      currentLocation,
      currentDirectoryPath,
      openLocation,
      navigateTo,
      navigateToInLocation,
      goUp,
      canGoBack,
      canGoForward,
      goBack,
      goForward,
    ]
  );

  return (
    <CurrentLocationContext.Provider value={value}>
      {children}
    </CurrentLocationContext.Provider>
  );
}
