import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';

/**
 * Decouples the directory tree's local refresh from IOActions.
 *
 * DirectoryTree registers a callback that can reload a folder's children;
 * IOActionsContextProvider invokes it after creating/deleting folders so the
 * sidebar tree stays in sync with the file list.
 */
interface DirectoryTreeRefreshContextValue {
  registerRefreshTree: (cb: (path: string) => void) => void;
  unregisterRefreshTree: () => void;
  refreshTree: (path: string) => void;
}

const DirectoryTreeRefreshContext =
  createContext<DirectoryTreeRefreshContextValue | null>(null);

export function DirectoryTreeRefreshContextProvider({
  children,
}: {
  children: ReactNode;
}) {
  const callbackRef = useRef<((path: string) => void) | null>(null);

  const registerRefreshTree = useCallback(
    (cb: (path: string) => void) => {
      callbackRef.current = cb;
    },
    []
  );

  const unregisterRefreshTree = useCallback(() => {
    callbackRef.current = null;
  }, []);

  const refreshTree = useCallback((path: string) => {
    callbackRef.current?.(path);
  }, []);

  const value = useMemo(
    () => ({
      registerRefreshTree,
      unregisterRefreshTree,
      refreshTree,
    }),
    [registerRefreshTree, unregisterRefreshTree, refreshTree]
  );

  return (
    <DirectoryTreeRefreshContext.Provider value={value}>
      {children}
    </DirectoryTreeRefreshContext.Provider>
  );
}

export function useDirectoryTreeRefresh(): DirectoryTreeRefreshContextValue {
  const ctx = useContext(DirectoryTreeRefreshContext);
  if (!ctx) {
    throw new Error(
      'useDirectoryTreeRefresh must be used within DirectoryTreeRefreshContextProvider'
    );
  }
  return ctx;
}
