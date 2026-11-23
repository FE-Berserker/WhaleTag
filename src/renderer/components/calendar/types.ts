import type { DirEntry } from '../../../shared/ipc-types';
import type { CalendarEntryContext } from '-/components/CalendarEntryMenu';
import type { FileCellData } from '-/components/file-cell';

/** The five calendar perspectives. */
export type CalendarViewMode = 'month' | 'week' | 'year' | 'agenda' | 'week-timeline';

/** H.24 P0-5: 'auto' prefers date tags, falls back to modified date. */
export type GroupingSource = 'modified' | 'dateTag' | 'auto';

/**
 * Props shared by the period sub-views (month / week / year / week-timeline).
 * Extracted verbatim from CalendarView.tsx during the P2 split (task-17).
 */
export interface SubViewProps {
  cursor: Date;
  weekStartsOn: 0 | 1;
  buckets: Map<string, DirEntry[]>;
  data: FileCellData;
  /** Required for month/week (renders DayCell); unused by year view. */
  onOpenCalendarMenu?: (ctx: CalendarEntryContext) => void;
  /** H.24 P1-6: per-entry HH:MM formatter; undefined in dateTag grouping. */
  entryTimeLabel?: (entry: DirEntry) => string | null;
  /** H.24 P2-6: render lunar day labels (already locale-gated by the caller). */
  showLunar?: boolean;
}
