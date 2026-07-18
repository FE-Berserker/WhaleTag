import type { AnyAction } from 'redux';
import type { WorkflowStage } from '../domain/workflow';
import { DEFAULT_WORKFLOW_STAGES } from '../domain/workflow';

export type { WorkflowStage };

/**
 * The user-customizable workflow stages (persisted). Each stage's `value` is the
 * token stored on files; the array order is the Kanban column order. Stage
 * colors are mirrored into settings.tagColors so getTagColor resolves them
 * everywhere — this slice owns identity + order, settings owns the color.
 */
export interface WorkflowState {
  stages: WorkflowStage[];
  /** Migration version; bumped to re-seed the canonical default order once. */
  version?: number;
}

/** Current slice version. Bump + handle in the reducer to migrate persisted state. */
const WORKFLOW_VERSION = 2;

const initialState: WorkflowState = {
  stages: DEFAULT_WORKFLOW_STAGES,
  version: WORKFLOW_VERSION,
};

export const ADD_STAGE = 'workflow/ADD_STAGE';
export const REMOVE_STAGE = 'workflow/REMOVE_STAGE';
export const RENAME_STAGE = 'workflow/RENAME_STAGE';
export const SET_STAGE_COLOR = 'workflow/SET_STAGE_COLOR';
export const MOVE_STAGE = 'workflow/MOVE_STAGE';

interface AddStageAction extends AnyAction {
  type: typeof ADD_STAGE;
  payload: WorkflowStage;
}
interface RemoveStageAction extends AnyAction {
  type: typeof REMOVE_STAGE;
  payload: string; // stage id
}
interface RenameStageAction extends AnyAction {
  type: typeof RENAME_STAGE;
  payload: { id: string; value: string };
}
interface SetStageColorAction extends AnyAction {
  type: typeof SET_STAGE_COLOR;
  payload: { id: string; color: string };
}
interface MoveStageAction extends AnyAction {
  type: typeof MOVE_STAGE;
  payload: { id: string; dir: -1 | 1 };
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `wf_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/** Collapse a label into a single whitespace-free token usable as a tag. */
export function toStageToken(value: string): string {
  return value.trim().replace(/\s+/g, '-');
}

export function addStage(value: string, color: string): AddStageAction {
  return {
    type: ADD_STAGE,
    payload: { id: newId(), value: toStageToken(value), color },
  };
}
export function removeStage(id: string): RemoveStageAction {
  return { type: REMOVE_STAGE, payload: id };
}
export function renameStage(id: string, value: string): RenameStageAction {
  return { type: RENAME_STAGE, payload: { id, value: toStageToken(value) } };
}
export function setStageColor(id: string, color: string): SetStageColorAction {
  return { type: SET_STAGE_COLOR, payload: { id, color } };
}
export function moveStage(id: string, dir: -1 | 1): MoveStageAction {
  return { type: MOVE_STAGE, payload: { id, dir } };
}

type WorkflowAction =
  | AddStageAction
  | RemoveStageAction
  | RenameStageAction
  | SetStageColorAction
  | MoveStageAction;

export default function workflowReducer(
  state = initialState,
  action: WorkflowAction | AnyAction
): WorkflowState {
  // Migrate persisted state from before this slice existed.
  let base: WorkflowState =
    state && Array.isArray(state.stages) ? state : initialState;

  // v2 one-time migration: if the stages are still the pristine default set
  // (no add/remove/rename), adopt the new canonical column order — preserving
  // each stage's color and id. Customized boards are left untouched. Stamped so
  // it runs once and never overrides a user's later manual reordering.
  if (base.version !== WORKFLOW_VERSION) {
    const order = DEFAULT_WORKFLOW_STAGES.map((s) => s.value);
    const sameSet =
      base.stages.length === order.length &&
      base.stages.every((s) => order.includes(s.value));
    if (sameSet) {
      const byValue = new Map(base.stages.map((s) => [s.value, s]));
      base = {
        stages: order.map((v) => byValue.get(v)!),
        version: WORKFLOW_VERSION,
      };
    } else {
      base = { ...base, version: WORKFLOW_VERSION };
    }
  }

  switch (action.type) {
    case ADD_STAGE: {
      const stage = (action as AddStageAction).payload;
      if (!stage.value || base.stages.some((s) => s.value === stage.value)) {
        return base; // skip empty/duplicate tokens
      }
      return { ...base, stages: [...base.stages, stage] };
    }
    case REMOVE_STAGE: {
      const id = (action as RemoveStageAction).payload;
      return { ...base, stages: base.stages.filter((s) => s.id !== id) };
    }
    case RENAME_STAGE: {
      const { id, value } = (action as RenameStageAction).payload;
      if (!value || base.stages.some((s) => s.value === value && s.id !== id)) {
        return base; // reject empty / collision with another stage
      }
      return {
        ...base,
        stages: base.stages.map((s) => (s.id === id ? { ...s, value } : s)),
      };
    }
    case SET_STAGE_COLOR: {
      const { id, color } = (action as SetStageColorAction).payload;
      return {
        ...base,
        stages: base.stages.map((s) => (s.id === id ? { ...s, color } : s)),
      };
    }
    case MOVE_STAGE: {
      const { id, dir } = (action as MoveStageAction).payload;
      const i = base.stages.findIndex((s) => s.id === id);
      const j = i + dir;
      if (i === -1 || j < 0 || j >= base.stages.length) return base;
      const stages = [...base.stages];
      [stages[i], stages[j]] = [stages[j], stages[i]];
      return { ...base, stages };
    }
    default:
      return base;
  }
}
