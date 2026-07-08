import type { AnyAction } from 'redux';
import { REMOVE_LOCATION, type RemoveLocationAction } from './locations';

/**
 * LRU of recently visited directories, most-recent first. Each entry remembers
 * which location it belongs to so we can switch location + path when the user
 * jumps back to it. Persisted so the list survives restarts.
 */
export interface RecentDir {
  path: string;
  locationId: string;
}

export interface RecentState {
  items: RecentDir[];
}

const MAX_RECENT = 15;

const initialState: RecentState = { items: [] };

export const RECORD_RECENT = 'recent/RECORD_RECENT';
export const CLEAR_RECENT = 'recent/CLEAR_RECENT';

interface RecordRecentAction extends AnyAction {
  type: typeof RECORD_RECENT;
  payload: RecentDir;
}
interface ClearRecentAction extends AnyAction {
  type: typeof CLEAR_RECENT;
}

export function recordRecent(entry: RecentDir): RecordRecentAction {
  return { type: RECORD_RECENT, payload: entry };
}
export function clearRecent(): ClearRecentAction {
  return { type: CLEAR_RECENT };
}

export default function recentReducer(
  state = initialState,
  action: RecordRecentAction | ClearRecentAction | AnyAction
): RecentState {
  // Migrate persisted state from before this slice existed.
  const base: RecentState =
    state && Array.isArray(state.items) ? state : initialState;

  switch (action.type) {
    case RECORD_RECENT: {
      const entry = (action as RecordRecentAction).payload;
      if (!entry.path || !entry.locationId) return base;
      // Move-to-front: drop any existing entry for the same path, then prepend.
      const rest = base.items.filter((it) => it.path !== entry.path);
      return { items: [entry, ...rest].slice(0, MAX_RECENT) };
    }
    case CLEAR_RECENT:
      return { items: [] };
    case REMOVE_LOCATION: {
      // Forget recents that belonged to the removed location.
      const id = (action as RemoveLocationAction).payload;
      const items = base.items.filter((it) => it.locationId !== id);
      return items.length === base.items.length ? base : { items };
    }
    default:
      return base;
  }
}
