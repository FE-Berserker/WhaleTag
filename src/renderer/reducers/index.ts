import { combineReducers } from 'redux';
import locations, { LocationsState } from './locations';
import settings, { SettingsState } from './settings';
import taglibrary, { TagLibraryState } from './taglibrary';
import workflow, { WorkflowState } from './workflow';
import recent, { RecentState } from './recent';
import savedsearches, { SavedSearchesState } from './savedsearches';
import extensions, { ExtensionsState } from './extensions';
import ai, { AiState } from './ai';

/** Root state shape. Add new slices here as they are created. */
export interface RootState {
  locations: LocationsState;
  settings: SettingsState;
  taglibrary: TagLibraryState;
  workflow: WorkflowState;
  recent: RecentState;
  savedsearches: SavedSearchesState;
  extensions: ExtensionsState;
  ai: AiState;
}

const rootReducer = combineReducers<RootState>({
  locations,
  settings,
  taglibrary,
  workflow,
  recent,
  savedsearches,
  extensions,
  ai,
});

export default rootReducer;
