/**
 * Barrel export for the Gantt timeline sub-view.
 *
 * Internal callers (e.g. `useBarDrag`'s tests) import from the deeper
 * module paths. External callers (e.g. `TaskView.tsx`'s
 * `import GanttView from '-/components/GanttView'`) are unchanged: the
 * legacy `GanttView.tsx` re-exports the default-shipping component so
 * the public path stays stable.
 */
export { default as GanttBar } from './GanttBar';
export { default as GanttRow } from './GanttRow';
export { default as GanttTimeline } from './GanttTimeline';
export { useBarDrag } from './useBarDrag';
export { useGanttZoom } from './useGanttZoom';
export { useGanttRange, ganttRangeToBounds } from './useGanttRange';
