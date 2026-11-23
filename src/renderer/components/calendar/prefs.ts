import { readPrefs } from '../../domain/perspective-prefs';
import type { CalendarViewMode, GroupingSource } from './types';

// H.24 PA-3: per-location persisted view state. Keyed `whale.calendar.<locationId>`
// to match `whale.folderViz.*` / `whale.tagCloud.*`. `cursor` is deliberately NOT
// persisted — re-entering a location should land on today, not on whatever day
// was focused last time (avoids "where did the calendar go?" confusion).
export const PREFS_KEY_PREFIX = 'whale.calendar.';
export interface CalendarPrefs {
  viewMode: CalendarViewMode;
  grouping: GroupingSource;
}

/** Load + validate persisted prefs. Returns null on miss / parse error / bad values. */
export function loadCalendarPrefs(locationId: string): CalendarPrefs | null {
  const p = readPrefs<CalendarPrefs>(PREFS_KEY_PREFIX + locationId);
  if (!p) return null;
  const vm = p.viewMode;
  const gr = p.grouping;
  const okVm =
    vm === 'month' ||
    vm === 'week' ||
    vm === 'year' ||
    vm === 'agenda' ||
    vm === 'week-timeline';
  const okGr = gr === 'modified' || gr === 'dateTag' || gr === 'auto';
  return okVm && okGr ? { viewMode: vm, grouping: gr } : null;
}
