import type { ViewMode } from '../../shared/whale-meta';

/**
 * Configurable keyboard shortcuts for the file list (H.23 follow-up).
 *
 * The model is **key �?action**: a `Record<token, KeyAction>` map where the
 * key is a normalized `KeyboardEvent.key` token and the value is the action
 * that key performs. We picked key→action (not action→key) so that several
 * keys can map to the same action (e.g. both `Enter` and `ArrowRight` �? * `open`) and so there are never two actions fighting over one key.
 *
 * `FileList.handleKeyDown` resolves the incoming `KeyboardEvent` to an action
 * via `resolveAction(state.keybindings, e)` and dispatches it. The defaults
 * reflect the scheme requested for Whale:
 *   �?�?navigate, �?open, �?back (history), Tab cycle view,
 *   Enter open, Space toggle-select, Esc clear, F2 rename,
 *   Delete delete, Home/End jump.
 *
 * The bindings apply to the **list and grid** views (GalleryView etc. own
 * their own focused-container keydown and consume arrows themselves).
 */

/** Everything a bindable key can do. `'none'` disables the key. */
export type KeyAction =
  | 'navigateUp'
  | 'navigateDown'
  | 'open'
  | 'back'
  | 'switchView'
  | 'toggleSelect'
  | 'clearSelection'
  | 'rename'
  | 'delete'
  | 'jumpHome'
  | 'jumpEnd'
  | 'none';

/** A key the user can configure in Settings �?Keyboard. `token` is the
 *  normalized `KeyboardEvent.key` (see `normalizeKey`); `labelKey` is the
 *  i18n key for the key's display name. */
export interface MappableKey {
  token: string;
  labelKey: string;
}

/** The fixed set of keys exposed in the settings panel, in display order.
 *  Order mirrors how users read a keyboard legend: arrows first, then
 *  specials. To keep the panel bounded we don't offer arbitrary key-capture;
 *  users reassign a key's *action*, not which physical key participates. */
export const MAPPABLE_KEYS: readonly MappableKey[] = [
  { token: 'ArrowUp', labelKey: 'keyArrowUp' },
  { token: 'ArrowDown', labelKey: 'keyArrowDown' },
  { token: 'ArrowLeft', labelKey: 'keyArrowLeft' },
  { token: 'ArrowRight', labelKey: 'keyArrowRight' },
  { token: 'Tab', labelKey: 'keyTab' },
  { token: 'Enter', labelKey: 'keyEnter' },
  { token: 'Space', labelKey: 'keySpace' },
  { token: 'Escape', labelKey: 'keyEscape' },
  { token: 'Home', labelKey: 'keyHome' },
  { token: 'End', labelKey: 'keyEnd' },
  { token: 'F2', labelKey: 'keyF2' },
  { token: 'Delete', labelKey: 'keyDelete' },
];

/** The action menu offered for each key, in display order. */
export const KEYBOARD_ACTIONS: readonly { value: KeyAction; labelKey: string }[] = [
  { value: 'navigateUp', labelKey: 'actionNavigateUp' },
  { value: 'navigateDown', labelKey: 'actionNavigateDown' },
  { value: 'open', labelKey: 'actionOpen' },
  { value: 'back', labelKey: 'actionBack' },
  { value: 'switchView', labelKey: 'actionSwitchView' },
  { value: 'toggleSelect', labelKey: 'actionToggleSelect' },
  { value: 'clearSelection', labelKey: 'actionClearSelection' },
  { value: 'rename', labelKey: 'actionRename' },
  { value: 'delete', labelKey: 'actionDelete' },
  { value: 'jumpHome', labelKey: 'actionJumpHome' },
  { value: 'jumpEnd', labelKey: 'actionJumpEnd' },
  { value: 'none', labelKey: 'actionNone' },
];

/** Set of valid tokens, for the sanitize pass. */
const VALID_TOKENS: ReadonlySet<string> = new Set(
  MAPPABLE_KEYS.map((k) => k.token)
);
/** Set of valid actions, for the sanitize pass. */
const VALID_ACTIONS: ReadonlySet<KeyAction> = new Set(
  KEYBOARD_ACTIONS.map((a) => a.value)
);

/** Default key→action bindings. This is what a fresh install (and the
 *  "Reset to defaults" button) uses. */
export const DEFAULT_KEYBINDINGS: Record<string, KeyAction> = {
  ArrowUp: 'navigateUp',
  ArrowDown: 'navigateDown',
  ArrowLeft: 'back',
  ArrowRight: 'open',
  Tab: 'switchView',
  Enter: 'open',
  Space: 'toggleSelect',
  Escape: 'clearSelection',
  Home: 'jumpHome',
  End: 'jumpEnd',
  F2: 'rename',
  Delete: 'delete',
};

/**
 * The perspective cycle order for the "switch view" action. Matches the
 * header `ToggleButtonGroup` order so Tab cycling lands on the same sequence
 * the user sees in the toolbar. `'mindmap'` is the legacy alias rewritten to
 * `'knowledge-graph'` on read (`migrateViewMode`), so it's intentionally
 * absent here.
 *
 * H.29: `'kanban'` and `'matrix'` were removed from the cycle �?they now
 * live inside the `'task'` perspective as a Kanban / Matrix sub-switch.
 * Users reach them by Tab-cycling to `'task'` and then flipping the
 * in-view SegmentedButton. Net cycle length: 10 �?9.
 */
export const CYCLABLE_VIEWS: readonly ViewMode[] = [
  'list',
  'grid',
  'gallery',
  'task',
  'calendar',
  'folderviz',
  'mapique',
  'tagcloud',
  'knowledge-graph',
];

/** Next view in the cycle (wraps last �?first). Falls back to the first view
 *  if `current` somehow isn't in the cycle (defensive against legacy values). */
export function nextView(current: ViewMode): ViewMode {
  const idx = CYCLABLE_VIEWS.indexOf(current);
  if (idx < 0) return CYCLABLE_VIEWS[0];
  return CYCLABLE_VIEWS[(idx + 1) % CYCLABLE_VIEWS.length];
}

/**
 * Normalize a `KeyboardEvent` to the token used as a `keybindings` key.
 * Browsers historically report Space as `' '` (and very old ones as
 * `'Spacebar'`); we canonicalize to `'Space'` so the binding map and the UI
 * token (`MAPPABLE_KEYS`) agree. Everything else passes through as
 * `event.key` �?we deliberately do NOT incorporate modifier keys here, so
 * Shift+Arrow range-extend is handled inside the action handlers, not at the
 * binding-resolution layer.
 */
export function normalizeKey(e: { key: string }): string {
  if (e.key === ' ' || e.key === 'Spacebar') return 'Space';
  return e.key;
}

/**
 * Look up the action bound to a key event. Returns `null` for unmapped keys
 * (and for keys explicitly bound to `'none'`, since `sanitizeKeybindings`
 * strips those �?but we also treat a stored `'none'` defensively).
 */
export function resolveAction(
  bindings: Record<string, KeyAction>,
  e: { key: string }
): KeyAction | null {
  const action = bindings[normalizeKey(e)];
  if (!action || action === 'none') return null;
  return action;
}

/**
 * Coerce an arbitrary persisted value into a clean bindings map:
 *   - drop tokens not in `MAPPABLE_KEYS`,
 *   - drop unknown action values,
 *   - drop `'none'` entries (they're equivalent to absent).
 * Used by the settings reducer migration so a corrupt or hand-edited
 * persisted `keybindings` never crashes the app or blocks the real keys.
 */
export function sanitizeKeybindings(
  raw: unknown
): Record<string, KeyAction> {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_KEYBINDINGS };
  const out: Record<string, KeyAction> = {};
  for (const [token, action] of Object.entries(raw as Record<string, unknown>)) {
    if (!VALID_TOKENS.has(token)) continue;
    if (typeof action !== 'string') continue;
    if (!VALID_ACTIONS.has(action as KeyAction)) continue;
    if (action === 'none') continue;
    out[token] = action as KeyAction;
  }
  return out;
}
