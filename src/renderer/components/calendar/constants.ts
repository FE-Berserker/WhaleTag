import type { DirEntry } from '../../../shared/ipc-types';

/** Minimum height of a month-view day cell. */
export const CELL_MIN_HEIGHT = 96;
/** Thumbnail size inside a calendar entry row. */
export const ENTRY_THUMB = 24;

// P2-6: module-level identity. Both used to be allocated inside render:
// `hours` was a fresh 24-element array per TimelineView render, and every
// `?? []` fallback (one per day cell, 168 per week-timeline render) handed
// `<DayCell>` a brand-new array. That alone defeated its `memo`, because the
// prop compared unequal on every parent render.
export const EMPTY_ENTRIES: DirEntry[] = [];
export const HOURS: readonly number[] = Array.from({ length: 24 }, (_, h) => h);
