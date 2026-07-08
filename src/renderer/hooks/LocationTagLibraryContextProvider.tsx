import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { ipcApi } from '-/services/ipc-api';
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
interface LocationTagLibraryContextValue {
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
    ipcApi
      .readTagLibrary(locationRoot)
      .then((map) => {
        if (!cancelled) setDescriptions(map);
      })
      .catch(() => {
        if (!cancelled) setDescriptions({});
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
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
        try {
          const fresh = await ipcApi.readTagLibrary(locationRoot);
          setDescriptions(fresh);
        } catch {
          // Swallow the rollback failure — the original error is the meaningful one.
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
        // Restore the previous entry on failure.
        if (prev !== undefined) {
          setDescriptions((cur) => ({ ...cur, [tag]: prev }));
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