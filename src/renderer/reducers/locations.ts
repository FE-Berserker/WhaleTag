import type { AnyAction } from 'redux';
import { WhaleLocation } from '../../shared/ipc-types';
import { basename } from '../services/path-util';

/**
 * Persisted location bookkeeping. The active location + its list survive app
 * restarts (see configureStore whitelist). Transient navigation state (the
 * current sub-directory) lives in CurrentLocationContext, not here.
 */
export interface LocationsState {
  items: WhaleLocation[];
  activeId: string | null;
}

const initialState: LocationsState = { items: [], activeId: null };

export const ADD_LOCATION = 'locations/ADD_LOCATION';
export const REMOVE_LOCATION = 'locations/REMOVE_LOCATION';
export const SET_ACTIVE_LOCATION = 'locations/SET_ACTIVE_LOCATION';
export const MOVE_LOCATION = 'locations/MOVE_LOCATION';
export const UPDATE_LOCATION = 'locations/UPDATE_LOCATION';

export interface AddLocationAction extends AnyAction {
  type: typeof ADD_LOCATION;
  payload: WhaleLocation;
}
export interface RemoveLocationAction extends AnyAction {
  type: typeof REMOVE_LOCATION;
  payload: string;
}
export interface SetActiveLocationAction extends AnyAction {
  type: typeof SET_ACTIVE_LOCATION;
  payload: string;
}
export interface MoveLocationAction extends AnyAction {
  type: typeof MOVE_LOCATION;
  payload: { from: number; to: number };
}
export interface UpdateLocationAction extends AnyAction {
  type: typeof UPDATE_LOCATION;
  payload: { id: string; patch: Partial<WhaleLocation> };
}
export type LocationsAction =
  | AddLocationAction
  | RemoveLocationAction
  | SetActiveLocationAction
  | MoveLocationAction
  | UpdateLocationAction;

/** Builds a WhaleLocation with a fresh id + timestamp. */
export function createLocation(
  name: string,
  dirPath: string,
  isReadOnly = false
): WhaleLocation {
  return {
    id:
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `loc_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    name: name.trim() || basename(dirPath),
    path: dirPath,
    type: 'local',
    isReadOnly,
    createdAt: new Date().toISOString(),
  };
}

/** Action creator: add a location (auto activates it if it's the first). */
export function addLocation(
  name: string,
  dirPath: string,
  isReadOnly = false
): AddLocationAction {
  return {
    type: ADD_LOCATION,
    payload: createLocation(name, dirPath, isReadOnly),
  };
}

export function removeLocation(id: string): RemoveLocationAction {
  return { type: REMOVE_LOCATION, payload: id };
}

export function setActiveLocation(id: string): SetActiveLocationAction {
  return { type: SET_ACTIVE_LOCATION, payload: id };
}

/** Reorder the location list: move the item at `from` to index `to`. */
export function moveLocation(from: number, to: number): MoveLocationAction {
  return { type: MOVE_LOCATION, payload: { from, to } };
}

/**
 * Patch an existing location in place. Fields not in `patch` are preserved.
 * Intended for cheap updates that already-known reducers don't cover — most
 * notably `isReadOnly`, which used to require removing the location and
 * re-adding it via the AddLocationDialog. Persists via redux-persist's
 * `locations` whitelist (see configureStore.ts).
 */
export function updateLocation(
  id: string,
  patch: Partial<WhaleLocation>
): UpdateLocationAction {
  return { type: UPDATE_LOCATION, payload: { id, patch } };
}

/** Convenience: flip / set just the readOnly flag on a location. */
export function setLocationReadOnly(
  id: string,
  isReadOnly: boolean
): UpdateLocationAction {
  return updateLocation(id, { isReadOnly });
}

export default function locationsReducer(
  state = initialState,
  action: LocationsAction | AnyAction
): LocationsState {
  switch (action.type) {
    case ADD_LOCATION: {
      const payload = (action as AddLocationAction).payload;
      const items = [...state.items, payload];
      return { items, activeId: state.activeId ?? payload.id };
    }
    case REMOVE_LOCATION: {
      const id = (action as RemoveLocationAction).payload;
      const items = state.items.filter((l) => l.id !== id);
      const activeId =
        state.activeId === id ? items[0]?.id ?? null : state.activeId;
      return { items, activeId };
    }
    case SET_ACTIVE_LOCATION:
      return {
        ...state,
        activeId: (action as SetActiveLocationAction).payload,
      };
    case MOVE_LOCATION: {
      const { from, to } = (action as MoveLocationAction).payload;
      const n = state.items.length;
      if (
        from === to ||
        from < 0 ||
        to < 0 ||
        from >= n ||
        to >= n
      ) {
        return state;
      }
      const items = [...state.items];
      const [moved] = items.splice(from, 1);
      items.splice(to, 0, moved);
      return { ...state, items };
    }
    case UPDATE_LOCATION: {
      const { id, patch } = (action as UpdateLocationAction).payload;
      let touched = false;
      const items = state.items.map((l) => {
        if (l.id !== id) return l;
        touched = true;
        return { ...l, ...patch };
      });
      // No-op when the location doesn't exist — preserves the previous
      // array reference (important: useSelector comparisons short-circuit
      // when state.items is unchanged, even if every selector returns a
      // fresh stable wrapper).
      if (!touched) return state;
      return { ...state, items };
    }
    default:
      return state;
  }
}
