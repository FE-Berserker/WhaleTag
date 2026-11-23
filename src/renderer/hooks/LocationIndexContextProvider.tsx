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

import type { IndexEntry, IndexProgressEvent } from '../../shared/ipc-types';
import { ipcApi } from '-/services/ipc-api';
import { useCurrentLocationContext } from './CurrentLocationContextProvider';

export type IndexStatus = 'idle' | 'loading' | 'building' | 'ready' | 'error';

/** Live build progress for the active location (null when no build is
 *  flowing events — docs/04 §10). */
export type IndexProgress = Pick<
  IndexProgressEvent,
  'phase' | 'processed' | 'total'
>;

interface LocationIndexContextValue {
  status: IndexStatus;
  error: string | null;
  count: number;
  /** Scan/ingest progress of the running build, if any. */
  progress: IndexProgress | null;
  /** Builds (walks + ingests) the index for the current location. */
  build: () => Promise<void>;
  /** Filename/path/tags fuzzy search (FTS5) — async, runs in main. */
  search: (query: string) => Promise<IndexEntry[]>;
}

const LocationIndexContext = createContext<LocationIndexContextValue | null>(
  null
);

export function useLocationIndexContext(): LocationIndexContextValue {
  const ctx = useContext(LocationIndexContext);
  if (!ctx) {
    throw new Error(
      'useLocationIndexContext must be used within LocationIndexContextProvider'
    );
  }
  return ctx;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Owns the search-index STATUS for the active location. The index itself lives
 * in SQLite in the main process (`<root>/.whale/index.db`); the renderer only
 * triggers builds and issues searches over IPC — no full entry list is loaded
 * into memory and there's no Fuse instance (plan §6.6 P2).
 *
 * Must sit below CurrentLocationContextProvider in the tree.
 */
export function LocationIndexContextProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { currentLocation } = useCurrentLocationContext();
  const [status, setStatus] = useState<IndexStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [progress, setProgress] = useState<IndexProgress | null>(null);

  // P1-3 (gui-audit 2026-11): async-result ownership. The index IPC calls can
  // outlive the state they were started for — the user switches location (or
  // starts a second build) while `buildLocationIndex` is still awaiting, and
  // the old result used to be written onto the NEW location's status/count.
  //
  // `requestSeqRef` is a monotonic generation token: every new build claims a
  // token, and it is bumped again whenever the active location changes or the
  // provider unmounts. A continuation only writes state when its captured
  // token still matches (i.e. it still owns the current generation).
  // `mountedRef` additionally keeps unmount cleanup from touching state.
  const requestSeqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Invalidate any in-flight continuation so a late IPC reply can't
      // resolve into a dead component.
      requestSeqRef.current += 1;
    };
  }, []);

  // Any location change (including "no location") invalidates builds that were
  // started against the previous one. Declared in its own effect so it runs
  // for every id change without re-running the probe below.
  useEffect(() => {
    requestSeqRef.current += 1;
  }, [currentLocation?.id]);

  // docs/04 §10: live build progress for the active location. Events for
  // other roots (fulltext builds from Settings, another location's build)
  // are ignored; the terminal `done` event clears the indicator.
  useEffect(() => {
    const rootPath = currentLocation?.path;
    if (!rootPath) {
      setProgress(null);
      return undefined;
    }
    const off = ipcApi.onIndexProgress((ev) => {
      if (ev.rootPath !== rootPath) return;
      if (ev.done) {
        setProgress(null);
      } else {
        setProgress({ phase: ev.phase, processed: ev.processed, total: ev.total });
      }
    });
    return () => {
      off();
      setProgress(null);
    };
  }, [currentLocation?.path]);

  // Probe the index status when the active location changes.
  useEffect(() => {
    let cancelled = false;
    if (!currentLocation) {
      setStatus('idle');
      setError(null);
      setCount(0);
      return;
    }
    setStatus('loading');
    setError(null);
    ipcApi
      .indexStatus(currentLocation.path)
      .then((s) => {
        if (cancelled) return;
        setCount(s.count);
        setStatus(s.ready ? 'ready' : 'idle');
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(errMsg(e));
          setStatus('error');
        }
      });
    return () => {
      cancelled = true;
    };
    // Intentionally depend only on the location id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLocation?.id]);

  const build = useCallback(async () => {
    if (!currentLocation) return;
    // Claim the generation this build belongs to. Bumped by a location change,
    // a newer build, or unmount — after the await we only write state when
    // we still own it.
    requestSeqRef.current += 1;
    const requestSeq = requestSeqRef.current;
    setStatus('building');
    setError(null);
    try {
      const { count: c } = await ipcApi.buildLocationIndex(currentLocation.path);
      if (!mountedRef.current || requestSeqRef.current !== requestSeq) return;
      setCount(c);
      setStatus('ready');
    } catch (e) {
      if (!mountedRef.current || requestSeqRef.current !== requestSeq) return;
      setError(errMsg(e));
      setStatus('error');
    }
  }, [currentLocation]);

  const search = useCallback(
    async (query: string): Promise<IndexEntry[]> => {
      if (!currentLocation) return [];
      return ipcApi.queryIndex(currentLocation.path, query);
    },
    [currentLocation]
  );

  const value = useMemo(
    () => ({ status, error, count, progress, build, search }),
    [status, error, count, progress, build, search]
  );

  return (
    <LocationIndexContext.Provider value={value}>
      {children}
    </LocationIndexContext.Provider>
  );
}
