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
import { useTranslation } from 'react-i18next';

import type { WhaleLocation } from '../../shared/ipc-types';
import { RootState } from '-/reducers';
import { setActiveLocation } from '-/reducers/locations';
import { recordRecent } from '-/reducers/recent';
import { ipcApi } from '-/services/ipc-api';
import { notifyApp } from '-/services/app-notice';
import { errorMessage } from '-/services/errors';

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
export interface CurrentLocationContextValue {
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

/**
 * Path + back/forward history as ONE state value. Splitting `history` and
 * `historyIndex` across two `useState`s let a callback capture a stale index:
 * two navigations batched into the same render truncated the history to the
 * OLD index and pushed the wrong entry, so Back skipped a real directory.
 */
interface NavigationState {
  path: string;
  history: string[];
  index: number;
}

const EMPTY_NAVIGATION: NavigationState = { path: '', history: [], index: -1 };

export function CurrentLocationContextProvider({
  children,
}: {
  children: ReactNode;
}) {
  const dispatch = useDispatch();
  const { items, activeId } = useSelector((s: RootState) => s.locations);
  const { t } = useTranslation();
  // `t` feeds only failure notices; keep it in a ref so goUp's identity doesn't
  // churn (and don't put it in deps — i18n may return a fresh `t` each render).
  const translateRef = useRef(t);
  translateRef.current = t;

  const currentLocation = useMemo(
    () => items.find((l) => l.id === activeId) ?? null,
    [items, activeId]
  );

  const [nav, setNav] = useState<NavigationState>(EMPTY_NAVIGATION);
  const currentDirectoryPath = nav.path;
  // Latest path for async callbacks: a navigation that lands while `goUp`'s IPC
  // is in flight must win over the parent lookup started before it.
  const currentPathRef = useRef(currentDirectoryPath);
  currentPathRef.current = currentDirectoryPath;
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
    setNav(
      target
        ? { path: target, history: [target], index: 0 }
        : EMPTY_NAVIGATION
    );
    // We intentionally depend only on the location id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLocation?.id]);

  // Record every visited directory into the recent-directories LRU.
  useEffect(() => {
    if (!currentLocation || !currentDirectoryPath) return;
    // The reset effect above runs on a location change while
    // `currentDirectoryPath` still holds the PREVIOUS location's directory for
    // one render, so this effect used to persist "old directory + new
    // locationId". Clicking that recents entry then navigated a folder that
    // does not exist inside the new location (rejected as out of bounds) and
    // consumed one of the 15 slots. Only record paths that belong here.
    const root = currentLocation.path.replace(/[\\/]+$/, '');
    const inside =
      currentDirectoryPath === root ||
      currentDirectoryPath.startsWith(`${root}\\`) ||
      currentDirectoryPath.startsWith(`${root}/`);
    if (!inside) return;
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

  const navigateTo = useCallback((dirPath: string) => {
    // Functional update: use the index of the state being replaced, never a
    // value captured at render time (two same-tick navigations used to
    // truncate the forward history at the stale index).
    setNav((prev) => ({
      path: dirPath,
      history: [...prev.history.slice(0, prev.index + 1), dirPath],
      index: prev.index + 1,
    }));
  }, []);

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
    const from = currentDirectoryPath;
    try {
      const parent = await ipcApi.parentDir(from);
      // A navigation completed while the IPC was in flight: don't yank the user
      // back to a parent of the directory they already left.
      if (currentPathRef.current !== from) return;
      navigateTo(parent);
    } catch (error) {
      // Callers are plain `onClick={() => goUp()}` handlers (FileToolbar), so a
      // rethrow here would surface as an unhandled rejection. Report instead.
      console.error(
        '[CurrentLocation] failed to resolve the parent directory:',
        from,
        error
      );
      notifyApp(
        translateRef.current('operationFailed', {
          message: errorMessage(error),
        })
      );
    }
  }, [currentDirectoryPath, currentLocation, navigateTo]);

  const canGoBack = nav.index > 0;
  const canGoForward = nav.index < nav.history.length - 1;

  const goBack = useCallback(() => {
    setNav((prev) => {
      if (prev.index <= 0) return prev;
      const index = prev.index - 1;
      return { path: prev.history[index], history: prev.history, index };
    });
  }, []);

  const goForward = useCallback(() => {
    setNav((prev) => {
      if (prev.index >= prev.history.length - 1) return prev;
      const index = prev.index + 1;
      return { path: prev.history[index], history: prev.history, index };
    });
  }, []);

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
