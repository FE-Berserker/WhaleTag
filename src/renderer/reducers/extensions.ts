import type { AnyAction } from 'redux';
import type { ExtensionRegistry } from '../../shared/extension-types';

export interface EditState {
  dirty: boolean;
  saving: boolean;
}

export interface ExtensionsState {
  /** Built-in registry loaded from dist/extensions/registry.json. */
  registry: ExtensionRegistry | null;
  /** User override: file type (lowercase ext) -> extension id. */
  userDefaults: Record<string, string>;
  /** User override: extension id -> enabled. */
  enabledOverrides: Record<string, boolean>;
  /**
   * Transient edit state per TAB id (`makeTabId(filePath, extensionId)`), not
   * per file path: one file can be open in two extensions at once (text editor
   * + JSON viewer), and a file-path key made each tab clobber the other's
   * dirty/saving state — the second tab's `clearFileEditState` wiped the first
   * tab's "unsaved changes" flag, hiding a real pending edit.
   */
  editState: Record<string, EditState>;
}

const initialState: ExtensionsState = {
  registry: null,
  userDefaults: {},
  enabledOverrides: {},
  editState: {},
};

export const LOAD_EXTENSION_REGISTRY = 'extensions/LOAD_EXTENSION_REGISTRY';
export const SET_DEFAULT_EXTENSION = 'extensions/SET_DEFAULT_EXTENSION';
export const SET_EXTENSION_ENABLED = 'extensions/SET_EXTENSION_ENABLED';
export const SET_FILE_EDIT_STATE = 'extensions/SET_FILE_EDIT_STATE';
export const CLEAR_FILE_EDIT_STATE = 'extensions/CLEAR_FILE_EDIT_STATE';

export interface LoadExtensionRegistryAction extends AnyAction {
  type: typeof LOAD_EXTENSION_REGISTRY;
  payload: ExtensionRegistry | null;
}

export interface SetDefaultExtensionAction extends AnyAction {
  type: typeof SET_DEFAULT_EXTENSION;
  payload: { fileType: string; extensionId: string | null };
}

export interface SetExtensionEnabledAction extends AnyAction {
  type: typeof SET_EXTENSION_ENABLED;
  payload: { extensionId: string; enabled: boolean };
}

export interface SetFileEditStateAction extends AnyAction {
  type: typeof SET_FILE_EDIT_STATE;
  payload: { tabId: string; state: Partial<EditState> };
}

export interface ClearFileEditStateAction extends AnyAction {
  type: typeof CLEAR_FILE_EDIT_STATE;
  payload: { tabId: string };
}

export function loadExtensionRegistry(
  registry: ExtensionRegistry | null
): LoadExtensionRegistryAction {
  return { type: LOAD_EXTENSION_REGISTRY, payload: registry };
}

export function setDefaultExtension(
  fileType: string,
  extensionId: string | null
): SetDefaultExtensionAction {
  return {
    type: SET_DEFAULT_EXTENSION,
    payload: { fileType: fileType.toLowerCase(), extensionId },
  };
}

export function setExtensionEnabled(
  extensionId: string,
  enabled: boolean
): SetExtensionEnabledAction {
  return { type: SET_EXTENSION_ENABLED, payload: { extensionId, enabled } };
}

export function setFileEditState(
  tabId: string,
  state: Partial<EditState>
): SetFileEditStateAction {
  return { type: SET_FILE_EDIT_STATE, payload: { tabId, state } };
}

export function clearFileEditState(tabId: string): ClearFileEditStateAction {
  return { type: CLEAR_FILE_EDIT_STATE, payload: { tabId } };
}

export default function extensionsReducer(
  state = initialState,
  action:
    | LoadExtensionRegistryAction
    | SetDefaultExtensionAction
    | SetExtensionEnabledAction
    | SetFileEditStateAction
    | ClearFileEditStateAction
    | AnyAction
): ExtensionsState {
  switch (action.type) {
    case LOAD_EXTENSION_REGISTRY: {
      const payload = (action as LoadExtensionRegistryAction).payload;
      // Stale persisted state from previous sessions can reference extensions
      // that no longer exist (e.g. an extension removed by an app update).
      // Drop those entries on registry load so redux-persist rehydrates clean
      // state on the next write — no orphan keys lingering in localStorage.
      if (!payload) {
        return { ...state, registry: null };
      }
      const validIds = new Set(payload.extensions.map((e) => e.id));
      const cleanedUserDefaults: Record<string, string> = {};
      for (const [ft, id] of Object.entries(state.userDefaults)) {
        if (validIds.has(id)) cleanedUserDefaults[ft] = id;
      }
      const cleanedEnabledOverrides: Record<string, boolean> = {};
      for (const [id, enabled] of Object.entries(state.enabledOverrides)) {
        if (validIds.has(id)) cleanedEnabledOverrides[id] = enabled;
      }
      return {
        ...state,
        registry: payload,
        userDefaults: cleanedUserDefaults,
        enabledOverrides: cleanedEnabledOverrides,
      };
    }
    case SET_DEFAULT_EXTENSION: {
      const { fileType, extensionId } = (action as SetDefaultExtensionAction)
        .payload;
      const next = { ...state.userDefaults };
      if (extensionId) next[fileType] = extensionId;
      else delete next[fileType];
      return { ...state, userDefaults: next };
    }
    case SET_EXTENSION_ENABLED: {
      const { extensionId, enabled } = (action as SetExtensionEnabledAction)
        .payload;
      return {
        ...state,
        enabledOverrides: {
          ...state.enabledOverrides,
          [extensionId]: enabled,
        },
      };
    }
    case SET_FILE_EDIT_STATE: {
      const { tabId, state: patch } = (action as SetFileEditStateAction)
        .payload;
      // New tabs start stamped clean; an indexed read already has its own
      // dirty/saving flags. Spreading defaults before the prior entry keeps a
      // single specification per key (TS2783 under strict).
      const prior = state.editState[tabId] ?? {
        dirty: false,
        saving: false,
      };
      const nextEntry = { ...prior, ...patch };
      // Text editors post `dirty: true` on every document change, and the
      // persisted `extensions` slice is whitelisted: without this identity
      // short-circuit every keystroke produced a new root state, a full
      // serialization and an atomic disk write (throttled since 2026-11, but
      // still wasted work). Same values in → same state object out.
      if (
        state.editState[tabId] !== undefined &&
        prior.dirty === nextEntry.dirty &&
        prior.saving === nextEntry.saving
      ) {
        return state;
      }
      return {
        ...state,
        editState: {
          ...state.editState,
          [tabId]: nextEntry,
        },
      };
    }
    case CLEAR_FILE_EDIT_STATE: {
      const { tabId } = (action as ClearFileEditStateAction).payload;
      if (state.editState[tabId] === undefined) return state;
      const next = { ...state.editState };
      delete next[tabId];
      return { ...state, editState: next };
    }
    default:
      return state;
  }
}
