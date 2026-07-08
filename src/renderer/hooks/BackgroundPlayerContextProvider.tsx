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
import type { DirEntry } from '../../shared/ipc-types';
import { isAudioFile } from '../../shared/whale-meta';

/**
 * Background-music dock state. Lives at the renderer root (sibling to
 * ExtensionContextProvider) so the dock's iframe keeps playing across
 * active-view changes — closing a fullscreen viewer or switching folders
 * does NOT clear the queue.
 *
 * Storage layout:
 *  - queue (paths only) / currentIndex / dismissed → localStorage (one JSON
 *    blob under `media-player-bg-state`). Survives restart. The full
 *    DirEntry isn't persisted — it's only needed for the maximize-to-viewer
 *    flow, and the dock re-derives a minimal entry on demand.
 *  - volume / muted / playbackRate → shared with media-player's fullscreen
 *    viewer via the same keys (`media-player-volume`, `media-player-muted`,
 *    `media-player-rate`) so the user's preference is consistent regardless
 *    of which surface they're touching.
 *
 * State invariant:
 *  - `currentIndex` always points at a valid queue entry, OR is `-1` when
 *    the queue is empty.
 *  - `playEntries` and `playEntry` reset `currentIndex` to 0 when they
 *    replace the queue. `enqueue` does NOT change `currentIndex`.
 */
interface BackgroundPlayerState {
  queue: string[];
  currentIndex: number;
  dismissed: boolean;
}

interface BackgroundPlayerContextValue extends BackgroundPlayerState {
  /** True when the dock should render (queue non-empty OR dismissed=false). */
  visible: boolean;
  /** Path of the currently-playing track, or `null` when queue is empty. */
  currentPath: string | null;
  /** Append entries to the queue without disturbing playback. */
  enqueue: (entries: DirEntry[]) => void;
  /** Replace the queue with `entries` and start at index 0. */
  playEntries: (entries: DirEntry[]) => void;
  /** Convenience: enqueue a single entry; if queue is empty, start it. */
  playEntry: (entry: DirEntry) => void;
  /** Skip to `index` in the queue. Out-of-range is clamped. */
  jumpTo: (index: number) => void;
  /** Resync the queue to reflect a folder change. Keeps the currently-playing
   *  track in the queue (with its index), prepends any pre-existing cross-
   *  folder tracks that aren't in the new folder, then appends the new
   *  folder's audio. No-op when there's no currently-playing track. */
  syncToDirectory: (folderAudioPaths: string[]) => void;
  /** Hide the dock until the next non-empty enqueue. */
  hide: () => void;
  /** Bring the dock back after a `hide` (e.g. via toast action). */
  restore: () => void;
}

const STORAGE_KEY = 'media-player-bg-state';
const MAX_QUEUE = 500;

const BackgroundPlayerContext = createContext<BackgroundPlayerContextValue | null>(
  null
);

/** Read state from localStorage with full validation — anything malformed
 *  collapses to an empty queue. */
function readPersistedState(): BackgroundPlayerState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { queue: [], currentIndex: -1, dismissed: false };
    const parsed = JSON.parse(raw) as Partial<BackgroundPlayerState>;
    if (!parsed || !Array.isArray(parsed.queue)) {
      return { queue: [], currentIndex: -1, dismissed: false };
    }
    const queue = parsed.queue.filter(
      (s): s is string => typeof s === 'string' && s.length > 0
    );
    // Drop entries past the cap (defensive — written before any cap bump).
    const trimmed = queue.slice(-MAX_QUEUE);
    const idx =
      typeof parsed.currentIndex === 'number' &&
      parsed.currentIndex >= 0 &&
      parsed.currentIndex < trimmed.length
        ? parsed.currentIndex
        : trimmed.length > 0
        ? 0
        : -1;
    return {
      queue: trimmed,
      currentIndex: idx,
      dismissed: !!parsed.dismissed,
    };
  } catch {
    return { queue: [], currentIndex: -1, dismissed: false };
  }
}

function writePersistedState(state: BackgroundPlayerState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota / disabled — best-effort persistence */
  }
}

function dedupeQueue(queue: string[], incoming: string[]): string[] {
  // Preserve order, drop duplicates of the head track so re-enqueuing it
  // doesn't queue two of the same song back-to-back.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...queue, ...incoming]) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export function BackgroundPlayerContextProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [state, setState] = useState<BackgroundPlayerState>(() =>
    readPersistedState()
  );
  // Avoid the initial write-back race: on the very first render the state
  // already matches what we read from storage, so skip the persistence pass.
  const hydratedRef = useRef(true);

  useEffect(() => {
    if (!hydratedRef.current) {
      writePersistedState(state);
    } else {
      hydratedRef.current = false;
    }
  }, [state]);

  const enqueue = useCallback((entries: DirEntry[]) => {
    const audioPaths = entries
      .filter((e) => !e.isDirectory && isAudioFile(e.name))
      .map((e) => e.path);
    if (audioPaths.length === 0) return;
    setState((prev) => {
      const queue = dedupeQueue(prev.queue, audioPaths);
      const idx = prev.currentIndex < 0 && queue.length > 0 ? 0 : prev.currentIndex;
      return {
        ...prev,
        queue,
        currentIndex: idx,
        // Adding a track to an empty dock un-collapses it.
        dismissed: prev.dismissed && prev.queue.length > 0 ? prev.dismissed : false,
      };
    });
  }, []);

  const playEntries = useCallback((entries: DirEntry[]) => {
    const audioPaths = entries
      .filter((e) => !e.isDirectory && isAudioFile(e.name))
      .map((e) => e.path);
    if (audioPaths.length === 0) return;
    setState({
      queue: audioPaths.slice(0, MAX_QUEUE),
      currentIndex: 0,
      dismissed: false,
    });
  }, []);

  const playEntry = useCallback((entry: DirEntry) => {
    playEntries([entry]);
  }, [playEntries]);

  const jumpTo = useCallback((index: number) => {
    setState((prev) => {
      if (prev.queue.length === 0) return prev;
      const clamped = Math.max(0, Math.min(prev.queue.length - 1, index));
      return { ...prev, currentIndex: clamped };
    });
  }, []);

  const syncToDirectory = useCallback((folderAudioPaths: string[]) => {
    setState((prev) => {
      // No active track → don't auto-adopt the folder (would force the user
      // into a song they didn't ask to play). Caller can still call
      // playEntries to opt in explicitly.
      if (!prev.queue[prev.currentIndex]) return prev;
      const currentTrack = prev.queue[prev.currentIndex];
      const folderSet = new Set(folderAudioPaths);
      // If the currently-playing track isn't in this folder, the dock has no
      // way to keep it on the dock queue once we replace — the bytes would
      // still play (host keeps currentPath stable until the user picks
      // something else), but prev/next would skip it. That's acceptable for
      // v1; users get the new folder's audio as their navigation source,
      // which matches "上一首/下一首自动检索对应文件夹下的音乐".
      if (!folderSet.has(currentTrack)) return prev;
      const idxInFolder = folderAudioPaths.indexOf(currentTrack);
      const queue = folderAudioPaths.slice(0, MAX_QUEUE);
      const idx = idxInFolder >= 0 ? idxInFolder : 0;
      return { ...prev, queue, currentIndex: idx };
    });
  }, []);

  const hide = useCallback(() => {
    setState((prev) => ({ ...prev, dismissed: true }));
  }, []);

  const restore = useCallback(() => {
    setState((prev) => ({ ...prev, dismissed: false }));
  }, []);

  const value = useMemo<BackgroundPlayerContextValue>(() => {
    const currentPath =
      state.currentIndex >= 0 && state.currentIndex < state.queue.length
        ? state.queue[state.currentIndex]
        : null;
    return {
      ...state,
      visible: state.queue.length > 0 && !state.dismissed,
      currentPath,
      enqueue,
      playEntries,
      playEntry,
      jumpTo,
      syncToDirectory,
      hide,
      restore,
    };
  }, [state, enqueue, playEntries, playEntry, jumpTo, syncToDirectory, hide, restore]);

  return (
    <BackgroundPlayerContext.Provider value={value}>
      {children}
    </BackgroundPlayerContext.Provider>
  );
}

export function useBackgroundPlayer(): BackgroundPlayerContextValue {
  const ctx = useContext(BackgroundPlayerContext);
  if (!ctx) {
    throw new Error(
      'useBackgroundPlayer must be used within BackgroundPlayerContextProvider'
    );
  }
  return ctx;
}