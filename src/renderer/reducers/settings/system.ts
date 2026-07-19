import type { AnyAction } from 'redux';
import {
  DEFAULT_KEYBINDINGS,
  sanitizeKeybindings,
  type KeyAction,
} from '../../domain/keybindings';
import { REMOVE_LOCATION, type RemoveLocationAction } from '-/reducers/locations';
import { REMOVE_STAGE } from '-/reducers/workflow';

/**
 * System domain of the settings slice: default location, auto-update,
 * keybindings, task reminder (+ the two cross-slice reactions:
 * REMOVE_LOCATION / REMOVE_STAGE). Split out of the old god-slice
 * `settings.ts` (docs/01 §12) — verbatim fields / actions / migrations /
 * reducer cases.
 */
export interface SystemFields {
  /**
   * Location to auto-open on startup. `null` = no default (restore whatever
   * was last active). Cleared automatically when the location is removed.
   */
  defaultLocationId: string | null;
  /**
   * Phase 6: when true, main process auto-checks GitHub Releases ~5s after
   * `whenReady` for a newer version and pushes `app:update-available` to the
   * renderer. The manual "Check for updates" button in Settings always works
   * regardless of this flag (the user can opt out of the *background* check
   * without losing the manual trigger). Default `true` — the standard
   * desktop-app experience.
   */
  autoUpdateCheck: boolean;
  /**
   * Customizable key→action bindings for the file list (Settings ▸ Keyboard).
   * Keys are normalized `KeyboardEvent.key` tokens (see `renderer/domain/keybindings`);
   * values are `KeyAction`. A missing key (or one sanitized away) means "no
   * action" — the browser default for that key is preserved, which is what
   * lets Tab fall back to focus traversal when the user sets it to 'none'.
   * Defaults live in `DEFAULT_KEYBINDINGS`; persisted values are sanitized on
   * load via `sanitizeKeybindings`.
   */
  keybindings: Record<string, KeyAction>;
  /**
   * Task reminder: on startup, check the monitored location for files tagged
   * with a pending workflow status (not-started / in-progress) and list them.
   * Off by default.
   */
  taskReminderEnabled: boolean;
  /** Location id whose pending tasks are checked on startup; null = none chosen. */
  taskReminderLocationId: string | null;
  /**
   * Workflow stage IDs that count as "pending" for the startup task reminder.
   * `null` means the user has not configured it yet and the defaults should be
   * derived from the current workflow stages. Empty array = explicitly none.
   */
  taskReminderStageIds: string[] | null;
}

export const systemInitial: SystemFields = {
  defaultLocationId: null,
  autoUpdateCheck: true,
  // Fresh copy so accidental mutation of initialState never bleeds into the
  // shared DEFAULT_KEYBINDINGS reference (the reducer always treats state as
  // immutable, but defense-in-depth is cheap here).
  keybindings: { ...DEFAULT_KEYBINDINGS },
  taskReminderEnabled: false,
  taskReminderLocationId: null,
  taskReminderStageIds: null,
};

// --- Action types ------------------------------------------------------------
export const SET_DEFAULT_LOCATION = 'settings/SET_DEFAULT_LOCATION';
export const SET_AUTO_UPDATE_CHECK = 'settings/SET_AUTO_UPDATE_CHECK';
export const SET_KEYBINDING = 'settings/SET_KEYBINDING';
export const RESET_KEYBINDINGS = 'settings/RESET_KEYBINDINGS';
export const SET_TASK_REMINDER_ENABLED = 'settings/SET_TASK_REMINDER_ENABLED';
export const SET_TASK_REMINDER_LOCATION_ID =
  'settings/SET_TASK_REMINDER_LOCATION_ID';
export const SET_TASK_REMINDER_STAGE_IDS =
  'settings/SET_TASK_REMINDER_STAGE_IDS';

export interface SetDefaultLocationAction extends AnyAction {
  type: typeof SET_DEFAULT_LOCATION;
  payload: string | null; // null = clear default
}
export interface SetAutoUpdateCheckAction extends AnyAction {
  type: typeof SET_AUTO_UPDATE_CHECK;
  /** `true` enables the 5s-delayed startup check; the manual button is always available. */
  payload: boolean;
}
export interface SetKeybindingAction extends AnyAction {
  type: typeof SET_KEYBINDING;
  /** `token` = normalized key (see `renderer/domain/keybindings`); `action === 'none'`
   *  removes the binding so the browser default for that key is restored
   *  (e.g. Tab → focus traversal). */
  payload: { token: string; action: KeyAction };
}
export interface ResetKeybindingsAction extends AnyAction {
  type: typeof RESET_KEYBINDINGS;
}
export interface SetTaskReminderEnabledAction extends AnyAction {
  type: typeof SET_TASK_REMINDER_ENABLED;
  payload: boolean;
}
export interface SetTaskReminderLocationIdAction extends AnyAction {
  type: typeof SET_TASK_REMINDER_LOCATION_ID;
  payload: string | null;
}
export interface SetTaskReminderStageIdsAction extends AnyAction {
  type: typeof SET_TASK_REMINDER_STAGE_IDS;
  payload: string[] | null;
}

// --- Action creators ---------------------------------------------------------
export function setDefaultLocation(
  id: string | null
): SetDefaultLocationAction {
  return { type: SET_DEFAULT_LOCATION, payload: id };
}

/** Phase 6: toggle the 5s-delayed startup GitHub Releases check. */
export function setAutoUpdateCheck(enabled: boolean): SetAutoUpdateCheckAction {
  return { type: SET_AUTO_UPDATE_CHECK, payload: enabled };
}

export function setKeybinding(
  token: string,
  action: KeyAction
): SetKeybindingAction {
  return { type: SET_KEYBINDING, payload: { token, action } };
}

export function resetKeybindings(): ResetKeybindingsAction {
  return { type: RESET_KEYBINDINGS };
}

export function setTaskReminderEnabled(
  enabled: boolean
): SetTaskReminderEnabledAction {
  return { type: SET_TASK_REMINDER_ENABLED, payload: enabled };
}

export function setTaskReminderLocationId(
  id: string | null
): SetTaskReminderLocationIdAction {
  return { type: SET_TASK_REMINDER_LOCATION_ID, payload: id };
}

export function setTaskReminderStageIds(
  ids: string[] | null
): SetTaskReminderStageIdsAction {
  return { type: SET_TASK_REMINDER_STAGE_IDS, payload: ids };
}

// --- Migration (redux-persist backfill) --------------------------------------
export function migrateSystem<T extends SystemFields>(base: T): T {
  let next = base;
  if (next.defaultLocationId === undefined)
    next = { ...next, defaultLocationId: null };
  // Keybindings: backfill defaults for pre-keybindings persisted state, and
  // sanitize otherwise (drop unknown tokens / actions and 'none' entries so a
  // corrupt or hand-edited store can't crash handleKeyDown or shadow a real
  // key). Defaults are spread so the reducer never shares mutable state with
  // the `DEFAULT_KEYBINDINGS` export.
  //
  // CRITICAL: only allocate a new `base` object when sanitization actually
  // drops or changes something. `sanitizeKeybindings` always returns a fresh
  // object (by design — it must not alias the input), so naively wrapping it
  // in `base = { ...base, keybindings: sanitized }` would make every persisted
  // settings look "modified" to redux-persist's `autoMergeLevel1`
  // reconciler. That reconciler skips rehydration whenever
  // `originalState[key] !== reducedState[key]`, so an identity-different
  // keybindings object would silently drop the entire rehydrated settings
  // slice (themeMode, language, viewDepth, etc. all revert to defaults on
  // every restart) — which is the original H.25 bug. Comparing against the
  // previous keybindings keeps rehydration alive while still cleaning up
  // hand-edited blobs that need it.
  if (next.keybindings === undefined) {
    next = { ...next, keybindings: { ...DEFAULT_KEYBINDINGS } };
  } else {
    const sanitized = sanitizeKeybindings(next.keybindings);
    const prev = next.keybindings;
    let bindingsChanged = Object.keys(sanitized).length !== Object.keys(prev).length;
    if (!bindingsChanged) {
      for (const token of Object.keys(sanitized)) {
        if (sanitized[token] !== prev[token]) {
          bindingsChanged = true;
          break;
        }
      }
    }
    if (bindingsChanged) {
      next = { ...next, keybindings: sanitized };
    }
  }
  if (next.taskReminderEnabled === undefined)
    next = { ...next, taskReminderEnabled: false };
  if (next.taskReminderLocationId === undefined)
    next = { ...next, taskReminderLocationId: null };
  if (next.taskReminderStageIds === undefined)
    next = { ...next, taskReminderStageIds: null };
  return next;
}

// --- Reducer (this domain's cases, incl. the cross-slice reactions) ----------
export function reduceSystem<T extends SystemFields>(
  state: T,
  action: AnyAction
): T {
  switch (action.type) {
    case SET_DEFAULT_LOCATION:
      return { ...state, defaultLocationId: action.payload };
    case SET_AUTO_UPDATE_CHECK:
      return { ...state, autoUpdateCheck: action.payload };
    case SET_KEYBINDING: {
      // Rename the payload's `action` field to avoid shadowing the reducer's
      // `action` param. Setting a key to 'none' removes it entirely so the
      // browser default (e.g. Tab focus traversal) is restored for that key.
      const { token, action: keyAction } = action.payload;
      const keybindings = { ...state.keybindings };
      if (keyAction === 'none') delete keybindings[token];
      else keybindings[token] = keyAction;
      return { ...state, keybindings };
    }
    case RESET_KEYBINDINGS:
      return { ...state, keybindings: { ...DEFAULT_KEYBINDINGS } };
    case SET_TASK_REMINDER_ENABLED:
      return { ...state, taskReminderEnabled: action.payload };
    case SET_TASK_REMINDER_LOCATION_ID:
      return { ...state, taskReminderLocationId: action.payload };
    case SET_TASK_REMINDER_STAGE_IDS:
      return { ...state, taskReminderStageIds: action.payload };
    case REMOVE_STAGE: {
      // A deleted workflow stage should no longer count as pending.
      const removedId = action.payload as string;
      const ids = state.taskReminderStageIds;
      if (!ids || !ids.includes(removedId)) return state;
      return {
        ...state,
        taskReminderStageIds: ids.filter((id) => id !== removedId),
      };
    }
    case REMOVE_LOCATION: {
      // Drop the default and the reminder target if the removed location was it.
      const removed = (action as RemoveLocationAction).payload;
      let next = state;
      if (next.defaultLocationId === removed)
        next = { ...next, defaultLocationId: null };
      if (next.taskReminderLocationId === removed)
        next = { ...next, taskReminderLocationId: null };
      return next;
    }
    default:
      return state;
  }
}
