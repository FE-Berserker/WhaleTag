import type { AnyAction } from 'redux';
import {
  DEFAULT_VIEW_DEPTH,
  MIN_VIEW_DEPTH,
  MAX_VIEW_DEPTH,
  clampViewDepth,
  normalizeFsPath,
  type ViewMode,
} from './types';

/**
 * File-browser behavior domain of the settings slice: default view, trash,
 * hidden files, lunar calendar, global view depth, full-text roots. Split
 * out of the old god-slice `settings.ts` (docs/01 §12) — verbatim fields /
 * actions / migrations / reducer cases.
 */
export interface BrowserFields {
  /**
   * Default file-area view for folders that don't override it in their
   * `.whale/wsm.json`. A folder's own perspective takes precedence.
   */
  defaultViewMode: ViewMode;
  /**
   * Send deletes through the system trash (recoverable) instead of permanent
   * removal. Default true — never destroy data unrecoverably without opt-in.
   */
  deleteToTrash: boolean;
  /**
   * Show files and folders whose names begin with a dot (e.g. `.whale`).
   * Hidden by default to keep the browser uncluttered.
   */
  showHiddenFiles: boolean;
  /**
   * Show Chinese-lunar day labels in the Calendar perspective (zh locale only).
   * Off by default — opt-in, since it's culturally specific and the labels add
   * density to day cells. See `renderer/domain/lunar.ts`.
   */
  showLunar: boolean;
  /**
   * Global recursion depth for entry collection. `1` = current directory only
   * (today's default, zero behavior change for existing users); `2-5` includes
   * subdirectories up to that many levels deep. Drives the unified slider in
   * `FileToolbar` and (after the H.24 data-layer work) is consumed by
   * `DirectoryContentContextProvider`. Per-folder overrides are not yet
   * supported — see plan §H.24 "已知取舍".
   */
  viewDepth: number;
  /**
   * Directories with full-text search enabled. Each is an independent index
   * root (may be a location root or any subdirectory). Stored verbatim;
   * compared/deduped via normalizeFsPath.
   */
  fulltextPaths: string[];
}

export const browserInitial: BrowserFields = {
  defaultViewMode: 'list',
  deleteToTrash: true,
  showHiddenFiles: false,
  showLunar: false,
  viewDepth: DEFAULT_VIEW_DEPTH,
  fulltextPaths: [],
};

// --- Action types ------------------------------------------------------------
export const SET_DEFAULT_VIEW_MODE = 'settings/SET_DEFAULT_VIEW_MODE';
export const SET_DELETE_TO_TRASH = 'settings/SET_DELETE_TO_TRASH';
export const SET_SHOW_HIDDEN_FILES = 'settings/SET_SHOW_HIDDEN_FILES';
export const SET_SHOW_LUNAR = 'settings/SET_SHOW_LUNAR';
export const SET_VIEW_DEPTH = 'settings/SET_VIEW_DEPTH';
export const ADD_FULLTEXT_PATH = 'settings/ADD_FULLTEXT_PATH';
export const REMOVE_FULLTEXT_PATH = 'settings/REMOVE_FULLTEXT_PATH';

export interface SetDefaultViewModeAction extends AnyAction {
  type: typeof SET_DEFAULT_VIEW_MODE;
  payload: ViewMode;
}
export interface SetDeleteToTrashAction extends AnyAction {
  type: typeof SET_DELETE_TO_TRASH;
  payload: boolean;
}
export interface SetShowHiddenFilesAction extends AnyAction {
  type: typeof SET_SHOW_HIDDEN_FILES;
  payload: boolean;
}
export interface SetShowLunarAction extends AnyAction {
  type: typeof SET_SHOW_LUNAR;
  payload: boolean;
}
export interface SetViewDepthAction extends AnyAction {
  type: typeof SET_VIEW_DEPTH;
  /** Clamped to [MIN_VIEW_DEPTH, MAX_VIEW_DEPTH] by `clampViewDepth` in the creator. */
  payload: number;
}
export interface AddFulltextPathAction extends AnyAction {
  type: typeof ADD_FULLTEXT_PATH;
  payload: string;
}
export interface RemoveFulltextPathAction extends AnyAction {
  type: typeof REMOVE_FULLTEXT_PATH;
  payload: string;
}

// --- Action creators ---------------------------------------------------------
export function setDefaultViewMode(mode: ViewMode): SetDefaultViewModeAction {
  return { type: SET_DEFAULT_VIEW_MODE, payload: mode };
}

export function setDeleteToTrash(enabled: boolean): SetDeleteToTrashAction {
  return { type: SET_DELETE_TO_TRASH, payload: enabled };
}

export function setShowHiddenFiles(enabled: boolean): SetShowHiddenFilesAction {
  return { type: SET_SHOW_HIDDEN_FILES, payload: enabled };
}

export function setShowLunar(enabled: boolean): SetShowLunarAction {
  return { type: SET_SHOW_LUNAR, payload: enabled };
}

export function setViewDepth(depth: number): SetViewDepthAction {
  return { type: SET_VIEW_DEPTH, payload: clampViewDepth(depth) };
}

export function addFulltextPath(p: string): AddFulltextPathAction {
  return { type: ADD_FULLTEXT_PATH, payload: p.trim() };
}

export function removeFulltextPath(p: string): RemoveFulltextPathAction {
  return { type: REMOVE_FULLTEXT_PATH, payload: p };
}

// --- Migration (redux-persist backfill) --------------------------------------
export function migrateBrowser<T extends BrowserFields>(base: T): T {
  let next = base;
  if (next.defaultViewMode === undefined)
    next = { ...next, defaultViewMode: 'list' };
  if (next.deleteToTrash === undefined) next = { ...next, deleteToTrash: true };
  if (next.showHiddenFiles === undefined)
    next = { ...next, showHiddenFiles: false };
  if (next.showLunar === undefined) next = { ...next, showLunar: false };
  if (next.fulltextPaths === undefined) next = { ...next, fulltextPaths: [] };
  // H.24: viewDepth lands in the same release as the data-layer change; the
  // default of 1 keeps existing users on the "current directory only" path so
  // the migration is invisible.
  if (next.viewDepth === undefined)
    next = { ...next, viewDepth: DEFAULT_VIEW_DEPTH };
  // Defensive: if a stale persisted value slipped out of bounds, normalize it
  // (e.g. NaN from a corrupt write, or a future schema that lowered MAX).
  if (
    !Number.isFinite(next.viewDepth) ||
    next.viewDepth < MIN_VIEW_DEPTH ||
    next.viewDepth > MAX_VIEW_DEPTH
  ) {
    next = { ...next, viewDepth: DEFAULT_VIEW_DEPTH };
  }
  return next;
}

// --- Reducer (this domain's cases only) --------------------------------------
export function reduceBrowser<T extends BrowserFields>(
  state: T,
  action: AnyAction
): T {
  switch (action.type) {
    case SET_DEFAULT_VIEW_MODE:
      return { ...state, defaultViewMode: action.payload };
    case SET_DELETE_TO_TRASH:
      return { ...state, deleteToTrash: action.payload };
    case SET_SHOW_HIDDEN_FILES:
      return { ...state, showHiddenFiles: action.payload };
    case SET_SHOW_LUNAR:
      return { ...state, showLunar: action.payload };
    case SET_VIEW_DEPTH:
      return { ...state, viewDepth: clampViewDepth(action.payload) };
    case ADD_FULLTEXT_PATH: {
      const p = action.payload as string;
      if (!p) return state;
      const norm = normalizeFsPath(p);
      if (state.fulltextPaths.some((x) => normalizeFsPath(x) === norm)) {
        return state; // already present
      }
      return { ...state, fulltextPaths: [...state.fulltextPaths, p] };
    }
    case REMOVE_FULLTEXT_PATH: {
      const norm = normalizeFsPath(action.payload as string);
      return {
        ...state,
        fulltextPaths: state.fulltextPaths.filter(
          (x) => normalizeFsPath(x) !== norm
        ),
      };
    }
    default:
      return state;
  }
}
