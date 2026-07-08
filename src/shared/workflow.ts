/**
 * Customizable workflow stages — the user-editable successor to the hardcoded
 * `WORKFLOW_DEFS` in smart-tags.ts. Each stage is a tag value (the token stored
 * on a file), a display order (array position), and a color. Stages drive the
 * Kanban board columns and the workflow chips in the tag library/editor.
 *
 * `value` IS the stored token and the visible label (single whitespace-free
 * token, e.g. `in-progress`). The default set seeds a fresh install; the live
 * list lives in the persisted `workflow` redux slice and is fully editable.
 */

import { DEFAULT_WORKFLOW_DEFS, WORKFLOW_COLORS, WORKFLOW_COLOR } from './smart-tags';

export interface WorkflowStage {
  /** Stable id (does not change on rename). */
  id: string;
  /** The tag token stored on files; also the column title / chip label. */
  value: string;
  /** Chip / column accent color (hex). */
  color: string;
}

/** The built-in starter stages, derived from the legacy workflow defaults. */
export const DEFAULT_WORKFLOW_STAGES: WorkflowStage[] = DEFAULT_WORKFLOW_DEFS.map(
  (d) => ({
    id: `wf_${d.value}`,
    value: d.value,
    color: WORKFLOW_COLORS[d.value] ?? WORKFLOW_COLOR,
  })
);
