import type { AnyAction } from 'redux';
import type {
  MapProvider,
  MdRenderThemePref,
  MdImageSaveMode,
  CustomCallout,
} from './types';
import {
  DEFAULT_MD_KEYBINDINGS,
  migrateMdKeybindings,
  type MdKeyAction,
} from '../../domain/md-keybindings';

/**
 * Integrations domain of the settings slice: external converters (LibreOffice
 * / dwg2dxf / ODA / Calibre), Mapique tiles, md-editor render preferences,
 * user shell commands. Split out of the old god-slice `settings.ts`
 * (docs/01 §12) — verbatim fields / actions / migrations / reducer cases.
 */
export interface IntegrationsFields {
  /**
   * Generate thumbnails for Office documents (doc/xls/ppt/...) by converting
   * them with LibreOffice. Disabled by default because it requires an external
   * binary; when disabled (or LibreOffice is missing) Office files show a
   * type icon instead.
   */
  officeThumbnailEnabled: boolean;
  /**
   * Optional explicit path to the LibreOffice `soffice` binary. `null` means
   * "auto-detect" (PATH + common install locations).
   */
  sofficePath: string | null;
  /**
   * Optional explicit path to the LibreDWG `dwg2dxf` binary used to preview
   * `.dwg` files. `null` means "auto-detect" on PATH.
   */
  dwg2dxfPath: string | null;
  /**
   * Optional explicit path to the ODA File Converter executable used to preview
   * `.dwg` files when LibreDWG is not available. `null` means auto-detect in
   * standard install locations.
   */
  odaPath: string | null;
  /**
   * Optional explicit path to Calibre's `ebook-convert` binary, used to convert
   * MOBI/AZW/AZW3 (and any other Calibre-supported input format registered
   * with the ebook viewer) into EPUB before rendering. `null` means
   * auto-detect on PATH and the standard install locations.
   */
  calibrePath: string | null;
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
  /** md-editor render-theme preset ('auto' = follow host light/dark).
   *  Pushed to the md-editor iframe via setMdRenderTheme; mirrored back from
   *  the editor's toolbar <select> via mdRenderThemeChanged. */
  mdEditorRenderTheme: MdRenderThemePref;
  /** User-defined callout types for md-editor's `> [!TYPE]` syntax (extend
   *  the 15 built-ins). Pushed to the iframe via setCustomCallouts. */
  customCallouts: CustomCallout[];
  /** User-configured shell commands (right-click → Commands). See `shared/shell-types`. */
  userCommands: import('../../../shared/shell-types').UserCommand[];
  /** md-editor keymap overrides (action → CodeMirror combo, e.g. 'Mod-s').
   *  Pushed to the iframe via setKeybindings; the editor reconfigures its
   *  keymapCompartment so changes apply live. '' = no binding for that action. */
  mdKeybindings: Record<MdKeyAction, string>;
  /** md-editor pasted-image save mode: 'current' (alongside the .md) or
   *  'subfolder' (a per-md subfolder). Pushed to the iframe via
   *  setImageSaveConfig. */
  mdImageSaveMode: MdImageSaveMode;
  /** Subfolder name for 'subfolder' mode; may contain `${filename}` (= the
   *  .md basename without extension). Sanitized against path traversal. */
  mdImageSubfolder: string;
}

/** Default subfolder name for md-editor's 'subfolder' image-save mode.
 *  `${filename}` expands to the .md basename without extension. */
export const DEFAULT_MD_IMAGE_SUBFOLDER = '${filename}.assets';

export const integrationsInitial: IntegrationsFields = {
  officeThumbnailEnabled: false,
  sofficePath: null,
  dwg2dxfPath: null,
  odaPath: null,
  calibrePath: null,
  mapTileUrl: '',
  mapProvider: 'gaode',
  mdEditorRenderTheme: 'auto',
  customCallouts: [],
  userCommands: [],
  mdKeybindings: { ...DEFAULT_MD_KEYBINDINGS },
  mdImageSaveMode: 'subfolder',
  mdImageSubfolder: DEFAULT_MD_IMAGE_SUBFOLDER,
};

// --- Action types ------------------------------------------------------------
export const SET_OFFICE_THUMBNAIL_ENABLED =
  'settings/SET_OFFICE_THUMBNAIL_ENABLED';
export const SET_SOFFICE_PATH = 'settings/SET_SOFFICE_PATH';
export const SET_DWG_2DXF_PATH = 'settings/SET_DWG_2DXF_PATH';
export const SET_ODA_PATH = 'settings/SET_ODA_PATH';
export const SET_CALIBRE_PATH = 'settings/SET_CALIBRE_PATH';
export const SET_MAP_TILE_URL = 'settings/SET_MAP_TILE_URL';
export const SET_MAP_PROVIDER = 'settings/SET_MAP_PROVIDER';
export const SET_MD_RENDER_THEME = 'settings/SET_MD_RENDER_THEME';
export const SET_CUSTOM_CALLOUTS = 'settings/SET_CUSTOM_CALLOUTS';
export const SET_USER_COMMANDS = 'settings/SET_USER_COMMANDS';
export const SET_MD_KEYBINDING = 'settings/SET_MD_KEYBINDING';
export const RESET_MD_KEYBINDINGS = 'settings/RESET_MD_KEYBINDINGS';
export const SET_MD_IMAGE_SAVE_MODE = 'settings/SET_MD_IMAGE_SAVE_MODE';
export const SET_MD_IMAGE_SUBFOLDER = 'settings/SET_MD_IMAGE_SUBFOLDER';

export interface SetOfficeThumbnailEnabledAction extends AnyAction {
  type: typeof SET_OFFICE_THUMBNAIL_ENABLED;
  payload: boolean;
}
export interface SetSofficePathAction extends AnyAction {
  type: typeof SET_SOFFICE_PATH;
  payload: string | null;
}
export interface SetDwg2dxfPathAction extends AnyAction {
  type: typeof SET_DWG_2DXF_PATH;
  payload: string | null;
}
export interface SetOdaPathAction extends AnyAction {
  type: typeof SET_ODA_PATH;
  payload: string | null;
}
export interface SetCalibrePathAction extends AnyAction {
  type: typeof SET_CALIBRE_PATH;
  payload: string | null;
}
export interface SetMapTileUrlAction extends AnyAction {
  type: typeof SET_MAP_TILE_URL;
  payload: string;
}
export interface SetMapProviderAction extends AnyAction {
  type: typeof SET_MAP_PROVIDER;
  payload: MapProvider;
}
export interface SetMdRenderThemeAction extends AnyAction {
  type: typeof SET_MD_RENDER_THEME;
  payload: MdRenderThemePref;
}
export interface SetCustomCalloutsAction extends AnyAction {
  type: typeof SET_CUSTOM_CALLOUTS;
  payload: CustomCallout[];
}
export interface SetUserCommandsAction extends AnyAction {
  type: typeof SET_USER_COMMANDS;
  payload: import('../../../shared/shell-types').UserCommand[];
}
export interface SetMdKeybindingAction extends AnyAction {
  type: typeof SET_MD_KEYBINDING;
  payload: { action: MdKeyAction; combo: string };
}
export interface ResetMdKeybindingsAction extends AnyAction {
  type: typeof RESET_MD_KEYBINDINGS;
}
export interface SetMdImageSaveModeAction extends AnyAction {
  type: typeof SET_MD_IMAGE_SAVE_MODE;
  payload: MdImageSaveMode;
}
export interface SetMdImageSubfolderAction extends AnyAction {
  type: typeof SET_MD_IMAGE_SUBFOLDER;
  payload: string;
}

// --- Action creators ---------------------------------------------------------
export function setOfficeThumbnailEnabled(
  enabled: boolean
): SetOfficeThumbnailEnabledAction {
  return { type: SET_OFFICE_THUMBNAIL_ENABLED, payload: enabled };
}

export function setSofficePath(path: string | null): SetSofficePathAction {
  return { type: SET_SOFFICE_PATH, payload: path };
}

export function setDwg2dxfPath(path: string | null): SetDwg2dxfPathAction {
  return { type: SET_DWG_2DXF_PATH, payload: path };
}

export function setOdaPath(path: string | null): SetOdaPathAction {
  return { type: SET_ODA_PATH, payload: path };
}

export function setCalibrePath(path: string | null): SetCalibrePathAction {
  return { type: SET_CALIBRE_PATH, payload: path };
}

export function setMapTileUrl(url: string): SetMapTileUrlAction {
  return { type: SET_MAP_TILE_URL, payload: url.trim() };
}

export function setMapProvider(provider: MapProvider): SetMapProviderAction {
  return { type: SET_MAP_PROVIDER, payload: provider };
}

/** Set the md-editor render-theme preset (Settings ▸ General + toolbar sync). */
export function setMdRenderTheme(
  theme: MdRenderThemePref
): SetMdRenderThemeAction {
  return { type: SET_MD_RENDER_THEME, payload: theme };
}

/** Replace the whole custom-callout list (Settings ▸ Callouts). Same
 *  whole-array-replace pattern as `setUserCommands`. */
export function setCustomCallouts(
  callouts: CustomCallout[]
): SetCustomCalloutsAction {
  return { type: SET_CUSTOM_CALLOUTS, payload: callouts };
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

/** Set one md-editor action's combo ('' clears it / unbinds the action). */
export function setMdKeybinding(
  action: MdKeyAction,
  combo: string
): SetMdKeybindingAction {
  return { type: SET_MD_KEYBINDING, payload: { action, combo } };
}

/** Restore all md-editor keybindings to defaults. */
export function resetMdKeybindings(): ResetMdKeybindingsAction {
  return { type: RESET_MD_KEYBINDINGS };
}

/** Set md-editor pasted-image save mode ('current' dir vs 'subfolder'). */
export function setMdImageSaveMode(
  mode: MdImageSaveMode
): SetMdImageSaveModeAction {
  return { type: SET_MD_IMAGE_SAVE_MODE, payload: mode };
}

/** Set the subfolder name for md-editor's 'subfolder' image-save mode. */
export function setMdImageSubfolder(
  subfolder: string
): SetMdImageSubfolderAction {
  return { type: SET_MD_IMAGE_SUBFOLDER, payload: subfolder };
}

/** Coerce a persisted mdImageSaveMode into a valid literal (default 'subfolder'). */
function sanitizeMdImageSaveMode(raw: unknown): MdImageSaveMode {
  return raw === 'current' || raw === 'subfolder' ? raw : 'subfolder';
}

/** Sanitize a persisted subfolder name: reject empty, path traversal (`..`),
 *  absolute paths, and Windows drive letters — fall back to the default so a
 *  corrupt/hand-edited value can never write outside the .md's directory. */
function sanitizeMdImageSubfolder(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_MD_IMAGE_SUBFOLDER;
  const s = raw.trim();
  if (s.length === 0) return DEFAULT_MD_IMAGE_SUBFOLDER;
  if (/^[\\/]/.test(s) || /^[a-zA-Z]:[\\/]/.test(s)) return DEFAULT_MD_IMAGE_SUBFOLDER;
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(s)) return DEFAULT_MD_IMAGE_SUBFOLDER;
  return s;
}

// --- Migration (redux-persist backfill) --------------------------------------
export function migrateIntegrations<T extends IntegrationsFields>(base: T): T {
  let next = base;
  if (next.officeThumbnailEnabled === undefined)
    next = { ...next, officeThumbnailEnabled: false };
  if (next.sofficePath === undefined) next = { ...next, sofficePath: null };
  if (next.dwg2dxfPath === undefined) next = { ...next, dwg2dxfPath: null };
  if (next.odaPath === undefined) next = { ...next, odaPath: null };
  if (next.calibrePath === undefined) next = { ...next, calibrePath: null };
  if (next.mapTileUrl === undefined) next = { ...next, mapTileUrl: '' };
  if (next.mapProvider === undefined) next = { ...next, mapProvider: 'gaode' };
  if (next.userCommands === undefined) next = { ...next, userCommands: [] };
  if (next.mdEditorRenderTheme === undefined)
    next = { ...next, mdEditorRenderTheme: 'auto' };
  if (next.customCallouts === undefined) next = { ...next, customCallouts: [] };
  if (next.mdKeybindings === undefined) {
    next = { ...next, mdKeybindings: { ...DEFAULT_MD_KEYBINDINGS } };
  } else {
    // §autoMergeLevel1 — only allocate a new mdKeybindings object when sanitize
    // actually changed something; otherwise the reconciler deems the whole
    // settings slice dirty and drops rehydrated themeMode / language / … on
    // the next persist write (the H.25 trap, see system.ts L164-194).
    const migrated = migrateMdKeybindings(next.mdKeybindings);
    const cur = next.mdKeybindings;
    const changed = (Object.keys(migrated) as MdKeyAction[]).some(
      (k) => cur[k] !== migrated[k]
    );
    if (changed) next = { ...next, mdKeybindings: migrated };
  }
  // md-editor image-save config — backfill + sanitize (path-traversal guard).
  if (next.mdImageSaveMode === undefined) {
    next = { ...next, mdImageSaveMode: 'subfolder' };
  } else {
    const m = sanitizeMdImageSaveMode(next.mdImageSaveMode);
    if (m !== next.mdImageSaveMode) next = { ...next, mdImageSaveMode: m };
  }
  if (next.mdImageSubfolder === undefined) {
    next = { ...next, mdImageSubfolder: DEFAULT_MD_IMAGE_SUBFOLDER };
  } else {
    const s = sanitizeMdImageSubfolder(next.mdImageSubfolder);
    if (s !== next.mdImageSubfolder) next = { ...next, mdImageSubfolder: s };
  }
  return next;
}

// --- Reducer (this domain's cases only) --------------------------------------
export function reduceIntegrations<T extends IntegrationsFields>(
  state: T,
  action: AnyAction
): T {
  switch (action.type) {
    case SET_OFFICE_THUMBNAIL_ENABLED:
      return { ...state, officeThumbnailEnabled: action.payload };
    case SET_SOFFICE_PATH:
      return { ...state, sofficePath: action.payload };
    case SET_DWG_2DXF_PATH:
      return { ...state, dwg2dxfPath: action.payload || null };
    case SET_ODA_PATH:
      return { ...state, odaPath: action.payload || null };
    case SET_CALIBRE_PATH:
      return { ...state, calibrePath: action.payload || null };
    case SET_MAP_TILE_URL:
      return { ...state, mapTileUrl: action.payload };
    case SET_MAP_PROVIDER:
      return { ...state, mapProvider: action.payload };
    case SET_MD_RENDER_THEME:
      return { ...state, mdEditorRenderTheme: action.payload };
    case SET_CUSTOM_CALLOUTS:
      return { ...state, customCallouts: action.payload };
    case SET_USER_COMMANDS:
      return { ...state, userCommands: action.payload };
    case SET_MD_KEYBINDING: {
      const { action: keyAction, combo } = (action as SetMdKeybindingAction)
        .payload;
      return {
        ...state,
        mdKeybindings: { ...state.mdKeybindings, [keyAction]: combo },
      };
    }
    case RESET_MD_KEYBINDINGS:
      return { ...state, mdKeybindings: { ...DEFAULT_MD_KEYBINDINGS } };
    case SET_MD_IMAGE_SAVE_MODE:
      return { ...state, mdImageSaveMode: action.payload };
    case SET_MD_IMAGE_SUBFOLDER:
      return { ...state, mdImageSubfolder: sanitizeMdImageSubfolder(action.payload) };
    default:
      return state;
  }
}
