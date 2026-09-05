import type { AnyAction } from 'redux';
import type { MapProvider } from './types';

/**
 * Integrations domain of the settings slice: Mapique tiles, user shell
 * commands. Split out of the old god-slice `settings.ts` (docs/01 §12) —
 * verbatim fields / actions / migrations / reducer cases.
 */
export interface IntegrationsFields {
  /**
   * Custom map tile URL for the Mapique perspective. Empty string uses the
   * default tiles for the selected {@link mapProvider}; a local/enterprise tile
   * server can be set here to override.
   */
  mapTileUrl: string;
  /**
   * Map source for the Mapique perspective. `gaode` (AutoNavi, reachable in
   * mainland China, GCJ-02 datum) or `osm` (OpenStreetMap via Leaflet, WGS-84
   * datum). Determines default tiles and whether GCJ-02 coordinate transform
   * is applied to WGS-84 coordinates.
   */
  mapProvider: MapProvider;
  /** User-configured shell commands (right-click → Commands). See `shared/shell-types`. */
  userCommands: import('../../../shared/shell-types').UserCommand[];
}

export const integrationsInitial: IntegrationsFields = {
  mapTileUrl: '',
  mapProvider: 'gaode',
  userCommands: [],
};

// --- Action types ------------------------------------------------------------
export const SET_MAP_TILE_URL = 'settings/SET_MAP_TILE_URL';
export const SET_MAP_PROVIDER = 'settings/SET_MAP_PROVIDER';
export const SET_USER_COMMANDS = 'settings/SET_USER_COMMANDS';

export interface SetMapTileUrlAction extends AnyAction {
  type: typeof SET_MAP_TILE_URL;
  payload: string;
}
export interface SetMapProviderAction extends AnyAction {
  type: typeof SET_MAP_PROVIDER;
  payload: MapProvider;
}
export interface SetUserCommandsAction extends AnyAction {
  type: typeof SET_USER_COMMANDS;
  payload: import('../../../shared/shell-types').UserCommand[];
}

// --- Action creators ---------------------------------------------------------
export function setMapTileUrl(url: string): SetMapTileUrlAction {
  return { type: SET_MAP_TILE_URL, payload: url.trim() };
}

export function setMapProvider(provider: MapProvider): SetMapProviderAction {
  return { type: SET_MAP_PROVIDER, payload: provider };
}

/**
 * Replace the whole user-commands list. The Settings UI mutates the array
 * (add/edit/remove/toggle) and dispatches the new array — mirroring how
 * `setAiSettings({ aiMcpServers })` works. Whole-array replace keeps the
 * action surface to one creator.
 */
export function setUserCommands(
  commands: import('../../../shared/shell-types').UserCommand[]
): SetUserCommandsAction {
  return { type: SET_USER_COMMANDS, payload: commands };
}

// --- Migration (redux-persist backfill) --------------------------------------
export function migrateIntegrations<T extends IntegrationsFields>(base: T): T {
  let next = base;
  if (next.mapTileUrl === undefined) next = { ...next, mapTileUrl: '' };
  if (next.mapProvider === undefined) next = { ...next, mapProvider: 'gaode' };
  if (next.userCommands === undefined) next = { ...next, userCommands: [] };
  return next;
}

// --- Reducer (this domain's cases only) --------------------------------------
export function reduceIntegrations<T extends IntegrationsFields>(
  state: T,
  action: AnyAction
): T {
  switch (action.type) {
    case SET_MAP_TILE_URL:
      return { ...state, mapTileUrl: action.payload };
    case SET_MAP_PROVIDER:
      return { ...state, mapProvider: action.payload };
    case SET_USER_COMMANDS:
      return { ...state, userCommands: action.payload };
    default:
      return state;
  }
}
