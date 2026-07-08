import type { AnyAction } from 'redux';
import type { SearchQuery } from '-/services/search-filter';

/**
 * A named, persisted advanced-search query the user can re-run later. The query
 * is location-independent (it filters whatever index is loaded), so saved
 * searches apply across all locations.
 */
export interface SavedSearch {
  id: string;
  name: string;
  query: SearchQuery;
}

export interface SavedSearchesState {
  items: SavedSearch[];
}

const initialState: SavedSearchesState = { items: [] };

export const ADD_SAVED_SEARCH = 'savedsearches/ADD';
export const REMOVE_SAVED_SEARCH = 'savedsearches/REMOVE';

interface AddSavedSearchAction extends AnyAction {
  type: typeof ADD_SAVED_SEARCH;
  payload: SavedSearch;
}
interface RemoveSavedSearchAction extends AnyAction {
  type: typeof REMOVE_SAVED_SEARCH;
  payload: string; // id
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `ss_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function addSavedSearch(
  name: string,
  query: SearchQuery
): AddSavedSearchAction {
  return {
    type: ADD_SAVED_SEARCH,
    payload: { id: newId(), name: name.trim(), query },
  };
}
export function removeSavedSearch(id: string): RemoveSavedSearchAction {
  return { type: REMOVE_SAVED_SEARCH, payload: id };
}

export default function savedSearchesReducer(
  state = initialState,
  action: AddSavedSearchAction | RemoveSavedSearchAction | AnyAction
): SavedSearchesState {
  // Migrate persisted state from before this slice existed.
  const base: SavedSearchesState =
    state && Array.isArray(state.items) ? state : initialState;

  switch (action.type) {
    case ADD_SAVED_SEARCH:
      return {
        items: [...base.items, (action as AddSavedSearchAction).payload],
      };
    case REMOVE_SAVED_SEARCH: {
      const id = (action as RemoveSavedSearchAction).payload;
      return { items: base.items.filter((s) => s.id !== id) };
    }
    default:
      return base;
  }
}
