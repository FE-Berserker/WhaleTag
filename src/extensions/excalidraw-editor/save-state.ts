export interface ExcalidrawPendingSave {
  json: string;
  revision: number;
}

export interface ExcalidrawSaveState {
  revision: number;
  observedJson: string;
  pendingSave: ExcalidrawPendingSave | null;
}

export function createExcalidrawSaveState(): ExcalidrawSaveState {
  return { revision: 0, observedJson: '', pendingSave: null };
}

/** Establish the freshly loaded scene without treating it as an edit. */
export function resetObservedJson(
  state: ExcalidrawSaveState,
  json: string
): ExcalidrawSaveState {
  return { ...state, observedJson: json };
}

/** Revision follows serialized content, not selection-only onChange callbacks. */
export function observeExcalidrawJson(
  state: ExcalidrawSaveState,
  json: string
): ExcalidrawSaveState {
  if (json === state.observedJson) return state;
  return { ...state, observedJson: json, revision: state.revision + 1 };
}

export function beginExcalidrawSave(
  state: ExcalidrawSaveState,
  json: string
): { state: ExcalidrawSaveState; snapshot: ExcalidrawPendingSave } {
  const observed = observeExcalidrawJson(state, json);
  const snapshot = { json, revision: observed.revision };
  return { state: { ...observed, pendingSave: snapshot }, snapshot };
}

/**
 * Every completed write advances the baseline to the snapshot actually written.
 * Dirty is then derived from the current scene, so a stale ack preserves newer
 * edits while an edit-then-undo back to that snapshot still becomes clean.
 */
export function resolveExcalidrawSaveAck(
  pendingSave: ExcalidrawPendingSave,
  currentJson: string
): { baselineJson: string; dirty: boolean } {
  return {
    baselineJson: pendingSave.json,
    dirty: currentJson !== pendingSave.json,
  };
}
