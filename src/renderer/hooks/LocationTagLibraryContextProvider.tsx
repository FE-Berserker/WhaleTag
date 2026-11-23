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
import { useTranslation } from 'react-i18next';

import { ipcApi } from '-/services/ipc-api';
import { notifyApp } from '-/services/app-notice';
import { waitForAllowedRoots } from '-/services/allowed-roots';
import { useCurrentLocationContext } from './CurrentLocationContextProvider';

/**
 * Per-location tag library: free-form descriptions keyed by tag, scoped to
 * ONE location root. The intent is "the location defines what its tags
 * MEAN": two locations can give the same tag string very different semantics
 * (e.g. `urgent` means "ship today" in one project and "needs review" in
 * another) without colliding.
 *
 * Storage lives at `<locationRoot>/.whale/wtaglib.json` (see
 * `src/main/tag-library.ts`). The context loads it on location change and
 * exposes optimistic local updates — callers can `setDescription` /
 * `clearDescription` and the next read reflects the change immediately
 * while the IPC write is in flight. Failures bubble out via rejection so
 * the caller can show a toast.
 *
 * Sits BELOW CurrentLocationContextProvider (reads currentLocation.path).
 */
export interface LocationTagLibraryContextValue {
  /** Tag → description map for the current location. Empty when no library. */
  descriptions: Record<string, string>;
  /** True while the initial IPC load for the current location is in flight. */
  loading: boolean;
  /** Set / replace a tag's description (empty string clears it). */
  setDescription: (tag: string, description: string) => Promise<void>;
  /** Remove a tag's description. Idempotent. */
  clearDescription: (tag: string) => Promise<void>;
}

const LocationTagLibraryContext =
  createContext<LocationTagLibraryContextValue | null>(null);

export function useLocationTagLibrary(): LocationTagLibraryContextValue {
  const ctx = useContext(LocationTagLibraryContext);
  if (!ctx) {
    throw new Error(
      'useLocationTagLibrary must be used within LocationTagLibraryContextProvider'
    );
  }
  return ctx;
}

export function LocationTagLibraryContextProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { currentLocation } = useCurrentLocationContext();
  const locationRoot = currentLocation?.path ?? null;
  const { t } = useTranslation();
  // `t` feeds only failure notices; a ref keeps it out of the effect/callback
  // dependency lists (i18n may return a fresh `t` identity on every render).
  const translateRef = useRef(t);
  translateRef.current = t;
  // Latest location for async callbacks. A write/rollback that resolves after
  // the user switched locations must not leak one location's library into the
  // other's context.
  const locationRootRef = useRef<string | null>(locationRoot);
  locationRootRef.current = locationRoot;

  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  // Load (or clear) when the active location changes. Empty location → empty
  // library; cancellation flag protects against late resolves after a swap.
  useEffect(() => {
    if (!locationRoot) {
      setDescriptions({});
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        // Child effects run before Root's, so on the first mount this IPC can
        // beat `fs:setAllowedRoots`; main is fail-closed and would reject with
        // "no configured locations". Await the registration the parent effect
        // already started — same guard as DirectoryTree / TaskReminder.
        await waitForAllowedRoots();
        if (cancelled) return;
        const map = await ipcApi.readTagLibrary(locationRoot);
        if (!cancelled) setDescriptions(map);
      } catch (error) {
        if (cancelled) return;
        // The main process only reads a MISSING wtaglib.json as `{}`; an
        // unreadable/corrupt file now rejects with the path. This catch
        // therefore means the library on disk is broken, not empty. Clearing
        // the map silently made every description look deleted — say so
        // instead.
        console.warn(
          '[LocationTagLibrary] failed to read the tag library:',
          locationRoot,
          error
        );
        setDescriptions({});
        notifyApp(translateRef.current('tagLibraryLoadFailed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [locationRoot]);

  const setDescription = useCallback(
    async (tag: string, description: string) => {
      if (!locationRoot) return;
      const trimmed = description.trim();
      // Optimistic local update so the UI reflects the change immediately.
      setDescriptions((prev) => {
        const next = { ...prev };
        if (trimmed) next[tag] = trimmed;
        else delete next[tag];
        return next;
      });
      try {
        await ipcApi.setTagLibraryDescription(locationRoot, tag, description);
      } catch (e) {
        // Roll back to the previous state so the UI matches disk on retry.
        // Only while the view still shows the location this write targeted:
        // re-reading the old root into the new location's context would show
        // one location's descriptions in another.
        if (locationRootRef.current === locationRoot) {
          try {
            const fresh = await ipcApi.readTagLibrary(locationRoot);
            if (locationRootRef.current === locationRoot) setDescriptions(fresh);
          } catch (rollbackError) {
            console.warn(
              '[LocationTagLibrary] rollback read failed; keeping the optimistic state:',
              locationRoot,
              rollbackError
            );
          }
        } else {
          console.warn(
            '[LocationTagLibrary] discarded a cross-location rollback for:',
            locationRoot
          );
        }
        throw e;
      }
    },
    [locationRoot]
  );

  const clearDescription = useCallback(
    async (tag: string) => {
      if (!locationRoot) return;
      const prev = descriptions[tag];
      setDescriptions((cur) => {
        if (!(tag in cur)) return cur;
        const next = { ...cur };
        delete next[tag];
        return next;
      });
      try {
        await ipcApi.clearTagLibraryDescription(locationRoot, tag);
      } catch (e) {
        // Restore the previous entry on failure — but only into the location
        // the entry came from (a stale restore would plant a foreign tag in
        // the newly selected location's library view).
        if (prev !== undefined && locationRootRef.current === locationRoot) {
          setDescriptions((cur) => ({ ...cur, [tag]: prev }));
        } else if (prev !== undefined) {
          console.warn(
            '[LocationTagLibrary] discarded a cross-location restore for:',
            locationRoot
          );
        }
        throw e;
      }
    },
    [locationRoot, descriptions]
  );

  const value = useMemo(
    () => ({
      descriptions,
      loading,
      setDescription,
      clearDescription,
    }),
    [descriptions, loading, setDescription, clearDescription]
  );

  return (
    <LocationTagLibraryContext.Provider value={value}>
      {children}
    </LocationTagLibraryContext.Provider>
  );
}