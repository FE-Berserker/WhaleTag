import type { AnyAction } from 'redux';
import type {
  ExtensionRegistry,
  ExtensionManifest,
} from '../../shared/extension-types';

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
  /** Transient edit state per file path. Not persisted. */
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
  payload: { filePath: string; state: Partial<EditState> };
}

export interface ClearFileEditStateAction extends AnyAction {
  type: typeof CLEAR_FILE_EDIT_STATE;
  payload: { filePath: string };
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
  filePath: string,
  state: Partial<EditState>
): SetFileEditStateAction {
  return { type: SET_FILE_EDIT_STATE, payload: { filePath, state } };
}

export function clearFileEditState(
  filePath: string
): ClearFileEditStateAction {
  return { type: CLEAR_FILE_EDIT_STATE, payload: { filePath } };
}

export function getExtensionById(
  state: ExtensionsState,
  id: string
): ExtensionManifest | undefined {
  return state.registry?.extensions.find((e) => e.id === id);
}

export function isExtensionEnabled(
  state: ExtensionsState,
  id: string
): boolean {
  const manifest = getExtensionById(state, id);
  if (!manifest) return false;
  const override = state.enabledOverrides[id];
  return override !== undefined ? override : manifest.enabled;
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
      // that no longer exist (e.g. md-viewer after deletion). Drop those
      // entries on registry load so redux-persist rehydrates clean state on
      // the next write — no orphan keys lingering in localStorage.
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
      const { filePath, state: patch } = (action as SetFileEditStateAction)
        .payload;
      return {
        ...state,
        editState: {
          ...state.editState,
          [filePath]: { dirty: false, saving: false, ...state.editState[filePath], ...patch },
        },
      };
    }
    case CLEAR_FILE_EDIT_STATE: {
      const { filePath } = (action as ClearFileEditStateAction).payload;
      const next = { ...state.editState };
      delete next[filePath];
      return { ...state, editState: next };
    }
    default:
      return state;
  }
}
