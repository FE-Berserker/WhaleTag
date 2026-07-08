/**
 * Pure helpers for the startup Task Reminder: which workflow tags count as
 * "pending", the search query that finds them, and grouping results by stage.
 * React/Electron-free so the query/grouping logic can be unit-tested.
 */

import type { IndexEntry } from './ipc-types';
import { type SearchQuery, emptyQuery } from './search-query';
import type { WorkflowStage } from './workflow';

/**
 * The built-in workflow tokens that were historically treated as pending.
 * Used to seed a sensible default when the user has not yet chosen which
 * stages should trigger reminders.
 */
const DEFAULT_PENDING_VALUES = ['not-started', 'in-progress'];

/**
 * Returns a sensible default list of stage IDs to treat as "pending" when the
 * user has not explicitly configured the reminder.
 *
 * 1. Prefer stages whose current value matches the historical defaults
 *    (`not-started` / `in-progress`) so existing users see no behavior change.
 * 2. If none match, fall back to the first two stages (typical Kanban early
 *    columns are "to do" and "doing").
 * 3. If there are fewer than two stages, use whatever exists.
 * 4. Empty workflow → empty selection.
 */
export function getDefaultPendingStageIds(stages: WorkflowStage[]): string[] {
  const matched = stages
    .filter((s) => DEFAULT_PENDING_VALUES.includes(s.value))
    .map((s) => s.id);
  if (matched.length > 0) return matched;
  if (stages.length >= 2) return stages.slice(0, 2).map((s) => s.id);
  if (stages.length > 0) return stages.map((s) => s.id);
  return [];
}

/** Advanced-search query matching files carrying ANY of the pending tags. */
export function buildPendingQuery(tags: string[]): SearchQuery {
  return {
    ...emptyQuery(),
    tags,
    tagMatch: 'any',
    type: 'files',
  };
}

/** One column of the reminder dialog: a pending tag and its matching entries. */
export interface PendingGroup {
  tag: string;
  entries: IndexEntry[];
}

/**
 * Groups `entries` by the first pending tag (in `tags` order) each one carries.
 * Entries with none of the pending tags are dropped. Groups follow `tags` order;
 * empty groups are omitted so the dialog only shows stages that have work.
 */
export function groupPending(entries: IndexEntry[], tags: string[]): PendingGroup[] {
  const byTag = new Map<string, IndexEntry[]>();
  for (const tag of tags) byTag.set(tag, []);
  for (const entry of entries) {
    const hit = tags.find((tg) => entry.tags.includes(tg));
    if (hit) byTag.get(hit)!.push(entry);
  }
  return tags
    .map((tag) => ({ tag, entries: byTag.get(tag)! }))
    .filter((g) => g.entries.length > 0);
}
