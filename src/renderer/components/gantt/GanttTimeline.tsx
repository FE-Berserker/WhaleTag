/**
 * `GanttTimeline` — the horizontally-scrolling chart surface.
 *
 * Owns:
 *   - The outer scroll container (`data-testid="gantt-scroll"`).
 *   - The day/week/month tick grid behind the bars.
 *   - The today vertical marker.
 *   - The single IntersectionObserver that lazy-loads row thumbnails
 *     (rootMargin `200px 0px` — preloads two viewports ahead).
 *
 * Pure layout. All business logic (zoom, scale derivation, drag commit)
 * lives elsewhere; this component only renders geometry. The Pan is
 * DOM-owned (`scrollLeft` on the scroller element) — never put it in
 * React state, that would re-mount the inner content every wheel tick.
 *
 * The scroller ref is forwarded (passed in from the parent) so the
 * parent can drive a scroll-to-Today from the toolbar button.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';
import type { RefObject } from 'react';
import type { TFunction } from 'i18next';
import { useDrop } from 'react-dnd';
import { NativeTypes } from 'react-dnd-html5-backend';
import { Box, Typography } from '@mui/material';

import type { WorkflowStage } from '../../../shared/workflow';
import { getTagColor } from '../../../shared/tag-colors';
import { tagDisplayLabel } from '-/services/tag-display';
import {
  PX_PER_DAY,
  dayKeyDiff,
  groupRowsByWorkflow,
  periodTagFromRange,
  todayKey,
  type GanttChartRow,
  type GanttPeriod,
  type GanttScale,
  type GanttZoom,
} from '../../../shared/gantt';
import type { DirEntry } from '../../../shared/ipc-types';
import type { TagGroup } from '../../../shared/tag-library';
import { DND_TYPE_FILE, type FileDragItem } from '-/services/dnd';
import { useIOActionsContext } from '-/hooks/IOActionsContextProvider';

import GanttRow from './GanttRow';
import { useGanttKeyboardNavigation } from './useGanttKeyboardNavigation';

interface GanttTimelineProps {
  /** Forwarded scroller DOM ref so the parent view can drive the
   *  scroll-to-Today jump from its toolbar button. Typed as a mutable
   *  ref so we can write into it from a combined callback ref (we
   *  share the scroller's DOM node with react-dnd's drop target — see
   *  `setScrollerNode`). `useRef<HTMLDivElement | null>(null)` on the
   *  parent side is `MutableRefObject` and matches. */
  scrollerRef: { current: HTMLDivElement | null };
  scheduled: GanttChartRow[];
  scale: GanttScale;
  pxPerDay: number;
  readOnly: boolean;
  t: TFunction;
  /** Fired on double-click anywhere on the bar — opens the file. Single-
   *  click no longer routes through here; it goes through `onClick` so
   *  the view can pop the PeriodTagDialog instead. */
  onOpen: (entry: DirEntry) => void;
  /** Fired on a pure single-click (no drag) of the bar — the view wires
   *  this to open the PeriodTagDialog so the user can edit start/end.
   *  The PointerEvent is forwarded so the view can position the dialog
   *  near the click point instead of MUI's centered default. */
  onClick: (entry: DirEntry, e: React.PointerEvent) => void;
  /** Commits a new period for the given entry — bubbles to
   *  `data.onSetEntryDateTag` at the view level. */
  onCommit: (entry: DirEntry, next: GanttPeriod) => void;
  onContextMenu: (entry: DirEntry, clientX: number, clientY: number) => void;
  /** Bar fill color. Drives each row's `GanttBar.color` via
   *  `colorFor(row.entry)`. Post P1 #8 revert (2026-07-06) this returns
   *  a flat primary-ish blue; P1 #10 will replace the body with a
   *  per-entry `barColor` lookup from `.whale/wsd.json`. The signature
   *  is already on the future shape `(entry) => string` so this file
   *  won't need to change again. */
  colorFor: (entry: DirEntry) => string;
  /** `${path}|${modified}` -> data URL cache. Threaded through to the
   *  row's `<ThumbIcon>` — ThumbIcon owns the canonical cache-write
   *  semantics (cached hit / lazy load / type-glyph fallback). */
  thumbCache: Map<string, string>;
  /** Tag-library context for `<EntryTagChips>`. */
  tagColors: Record<string, string>;
  /** Path-keyed map of tags per entry. Used by swim-lane grouping
   *  (P0 #1) — `groupRowsByWorkflow` reads it to bucket each row
   *  into its workflow stage. Also passed to `GanttRow` indirectly
   *  via the existing tag-library context. */
  tagsByName: Map<string, string[]>;
  groups: TagGroup[];
  /** Active filter tag (drives chip "is filtered" highlight). */
  activeTag: string | null;
  /** Workflow stages used to group scheduled rows into swim lanes
   *  (P0 #1). Each stage becomes one lane (in `stages` order); rows
   *  with no workflow tag fall into a trailing "no stage" lane. The
   *  group's color (or built-in workflow color) tints each row's
   *  background. Pass `[]` to disable swim-lanes (everything falls
   *  into the single "no stage" lane — behaves as before this
   *  feature landed). */
  stages: WorkflowStage[];
  /** True iff the row's tags fail either the workflow or quadrant
   *  filter (P0 #5 + #6). Filtered rows render at opacity 0.3 and
   *  become non-interactive — drag/commit + onClick are blocked at
   *  the row + bar layer. Pure function from the view, kept here so
   *  the timeline can pass it through without recomputing. */
  isRowFilteredOut?: (tags: readonly string[]) => boolean;
  /** Click a tag chip — toggle it as the active filter. */
  onClickTag: (tag: string) => void;
  /** Right-click a chip — open the per-tag menu (remove). */
  onTagContextMenu: (
    entry: DirEntry,
    tag: string,
    x: number,
    y: number
  ) => void;
  /** Called once per dropped entry with the day-key (YYYY-MM-DD) under
   *  the drop point. The view wires this to `data.onSetEntryDateTag`
   *  with a 1-day period (startKey=endKey=dayKey). The drop is a no-op
   *  when the cursor is over the thumb column or past the scale's
   *  right edge — `dayKey` is null in that case and the view bails. */
  onDropEntry: (entry: DirEntry, dayKey: string | null) => void;
  /** P0 #4: keyboard 'T' shortcut scrolls the today line into view.
   *  The view already owns the toolbar Today button — we re-use the
   *  same handler so keyboard and click produce identical behavior. */
  onJumpToToday: () => void;
  /** Resolves a path back to its full entry — mirrors
   *  `FileCellData.resolveEntry`. Used by the drop handler to turn the
   *  dragged source paths into `DirEntry[]`. */
  resolveEntry?: (path: string) => DirEntry | undefined;
  /**
   * Fallback entry list for the drop handler: when `resolveEntry` fails
   * (e.g. the dropped file is in the directory but not in the visible
   * slice), fall back to a linear scan of all entries. Mirrors the same
   * two-tier pattern KanbanColumn's drop uses. */
  entries: DirEntry[];
  /** P0 #3: when the timeline is empty but Triage still has cards,
   *  the empty-state hint tells the user to drag a Triage card onto
   *  the chart (rather than the bare "no tasks" message). Plumbed
   *  from GanttView because Triage lives there, not in the timeline. */
  hasTriageHint?: boolean;
  /** P1 #9: ref to the inner chart-content Box for PNG export. The
   *  scroller itself has scrollbars; exporting the inner content gives
   *  the full timeline without chrome. */
  exportRef?: React.RefObject<HTMLDivElement | null>;
}

// 72 px fits two text lines in the thumb column: top line is the entry
// name, bottom line is one row of tag chips (max=2 + `+N`). Math:
// 16 px top padding + 18 px name + 4 px gap + 18 px chip row + 16 px bottom
// padding = 72 px.
const ROW_HEIGHT = 72;
const THUMB_COL_WIDTH = 200; // thumb (48) + 16 gap + filename column
const TICK_HEIGHT = 24;
const TODAY_LINE_COLOR = 'rgba(239, 68, 68, 0.7)'; // matches barFillColor('urgent-important')

export default function GanttTimeline({
  scrollerRef,
  scheduled,
  scale,
  pxPerDay,
  readOnly,
  t,
  onOpen,
  onClick,
  onCommit,
  onContextMenu,
  colorFor,
  thumbCache,
  tagColors,
  tagsByName,
  groups,
  activeTag,
  stages,
  isRowFilteredOut,
  onClickTag,
  onTagContextMenu,
  onDropEntry,
  resolveEntry,
  entries: allEntries,
  hasTriageHint,
  onJumpToToday,
  exportRef,
}: GanttTimelineProps) {
  // ResizeObserver: re-measure on each scroller resize so the
  // scroll-to-Today math (which subtracts clientWidth/2 from the target
  // offset) stays centered. The width is a ref-backed value to avoid
  // re-renders on every resize tick.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return undefined;
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      // No state update needed; scrollToToday reads `clientWidth` lazily
      // from the live element each time it's called. We only attach the
      // observer so the parent can be sure the DOM has measured at least
      // once before mounting its toolbar button.
      void el.clientWidth;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollerRef]);

  // (No IntersectionObserver here — row thumbnails use native
  // `<img loading="lazy">` and let the browser handle deferred decode.
  // See `GanttRow.tsx` header for the IO-vs-native decision.)

  // Wheel handler: ctrl/⌘+wheel suppresses browser pinch-zoom on macOS
  // but doesn't switch the Gantt zoom (Day/Week/Month switch happens via
  // the toolbar <Select>). Plain wheel that's purely vertical gets
  // translated to horizontal scroll for users on non-trackpad mice.
  useEffect(() => {
    const sc = scrollerRef.current;
    if (!sc) return undefined;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        return;
      }
      if (e.deltaX === 0 && e.deltaY !== 0) {
        // Translate vertical wheel to horizontal scroll. Trackpads emit
        // deltaX so they're unaffected.
        sc.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    };
    sc.addEventListener('wheel', onWheel, { passive: false });
    return () => sc.removeEventListener('wheel', onWheel);
  }, [scrollerRef]);

  // Tick grid for day/week/month. Guard: a 30-year view would render
  // ~11k ticks; fall back to month markers so the DOM stays bounded.
  const ticks = useMemo(() => buildTicks(scale, scale.zoom), [scale]);

  // Today marker — pixel position relative to the chart's inner
  // scroller origin. Combined with THUMB_COL_WIDTH on render so the
  // line is offset past the sticky thumb column.
  const todayX = useMemo(() => {
    const offsetDays = dayKeyDiff(scale.startKey, todayKey());
    return offsetDays * pxPerDay;
  }, [scale.startKey, pxPerDay]);

  // Inner content width: `totalDays * pxPerDay + thumb column` so the
  // scroll container has its long axis. The thumb column is rendered
  // sticky inside each row, so the bar geometry starts at 0 in chart
  // coordinates and the column overlays the leftmost 200 px.
  const innerWidth = scale.totalDays * pxPerDay;

  // ── Vertical windowing ────────────────────────────────────────────
  // Only the rows currently in view (plus a small overscan) get
  // mounted. Without this, a directory with thousands of scheduled
  // entries would render thousands of <ThumbIcon> IO subscriptions,
  // <EntryTagChips> trees, and <GanttBar> handlers on first paint —
  // a real "1000+ files" directory would jank during scroll and
  // hitch initial mount. The inner content's `minHeight` still
  // reflects the full row count so the scroller's vertical scroll
  // bar is accurate; only the rendered subset is sliced.
  //
  // We coalesce setState to "only re-render when a new row enters or
  // leaves the viewport" so high-frequency scroll events don't
  // thrash React. `computeRenderRange` is exported so unit tests can
  // verify the math directly without standing up the full DOM +
  // jsdom + react-dnd pipeline.
  const [scrollTop, setScrollTop] = useState(0);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return undefined;
    const onScroll = () => {
      const next = el.scrollTop;
      setScrollTop((prev) => {
        const prevRow = Math.floor(prev / ROW_HEIGHT);
        const nextRow = Math.floor(next / ROW_HEIGHT);
        // Same first-visible row → no re-render needed. Different row
        // boundary → re-render so the visible slice updates.
        return prevRow === nextRow ? prev : next;
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollerRef]);

  // ── Swim-lane grouping (P0 #1) ───────────────────────────────────
  // Each lane = one workflow stage (in `stages` order); trailing
  // "no stage" lane catches rows without a workflow tag. Within a
  // lane rows are sorted by `period.startKey` ascending (per
  // `groupRowsByWorkflow`'s stable sort). Rows failing the filter
  // are dropped from each lane's display; lanes that become empty
  // after filtering get ONE collapsed placeholder row so the user
  // knows the lane exists (and can reset the filter to bring rows
  // back).
  //
  // We flatten to a single ordered `displayRows` array (with each row
  // annotated by its `laneIndex`) so the existing vertical windowing
  // math keeps working unchanged — the lane structure is rendered
  // via absolutely-positioned dividers at the lane boundaries, NOT
  // by inserting divider rows into the slice.
  const swimLanes = useMemo(() => {
    const tasks = scheduled.map((r) => ({
      entry: r.entry,
      period: r.period,
    }));
    return groupRowsByWorkflow(tasks, stages, tagsByName);
  }, [scheduled, stages, tagsByName]);

  /** Per-stage color (the same color Kanban columns use). Computed
   *  once per render via the shared `getTagColor` helper so per-tag
   *  overrides + group colors all flow through the existing tag-color
   *  precedence rules. `null` = the "no stage" lane (untinted). */
  const stageColors = useMemo(() => {
    const out = new Map<string | null, string | undefined>();
    for (const stage of stages) {
      out.set(stage.value, getTagColor(stage.value, tagColors, groups));
    }
    out.set(null, undefined);
    return out;
  }, [stages, tagColors, groups]);

  /** Flatten lanes into a single ordered list of `{ chartRow, laneIndex }`
   *  for the windowing slice. Lanes whose `visibleCount === 0` are
   *  skipped here — they get a single placeholder row appended below. */
  interface DisplayRow {
    chartRow: GanttChartRow;
    laneIndex: number;
  }
  const displayRows = useMemo<DisplayRow[]>(() => {
    const out: DisplayRow[] = [];
    swimLanes.forEach((lane, idx) => {
      // Re-derive the original chartRow for each task (we threw away
      // `tags` / `thumbDataUrl` when calling `groupRowsByWorkflow`).
      const tasksWithRow: DisplayRow[] = [];
      for (const t of lane.tasks) {
        const cr = scheduled.find((r) => r.entry.path === t.entry.path);
        if (!cr) continue;
        if (isRowFilteredOut && isRowFilteredOut(cr.tags)) continue;
        tasksWithRow.push({ chartRow: cr, laneIndex: idx });
      }
      if (tasksWithRow.length === 0) return; // skip empty lanes here
      out.push(...tasksWithRow);
    });
    return out;
    // Re-derive when scheduled / lanes / filter change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swimLanes, scheduled, isRowFilteredOut]);

  /** Indices in `displayRows` where a new lane begins (i.e. a divider
   *  should be drawn immediately above that row). Excludes index 0. */
  const laneBoundaryIndices = useMemo(() => {
    const set = new Set<number>();
    let prevLane = -1;
    displayRows.forEach((r, i) => {
      if (r.laneIndex !== prevLane && prevLane !== -1) set.add(i);
      prevLane = r.laneIndex;
    });
    return set;
  }, [displayRows]);

  /** Number of lanes that have rows but ALL of those rows are filtered
   *  out. Used to render the "N stages hidden" collapsed placeholder.
   *  Only counted when the user has actually narrowed a filter — in
   *  the neutral state an empty lane is just an empty lane (no rows
   *  were ever scheduled into it), which doesn't need a placeholder. */
  const hiddenLaneCount = useMemo(() => {
    if (!isRowFilteredOut) return 0;
    let n = 0;
    for (const lane of swimLanes) {
      if (lane.tasks.length === 0) continue; // truly empty (no rows ever)
      const allHidden = lane.tasks.every((t) => {
        const cr = scheduled.find((r) => r.entry.path === t.entry.path);
        return cr ? isRowFilteredOut(cr.tags) : false;
      });
      if (allHidden) n++;
    }
    return n;
  }, [swimLanes, scheduled, isRowFilteredOut]);

  // Slice of `displayRows` that's actually rendered (the windowing
  // math uses `displayRows.length` instead of `scheduled.length`).
  const renderRangeV2 = useMemo(() => {
    const viewportHeight =
      scrollerRef.current?.clientHeight ?? DEFAULT_VIEWPORT_HEIGHT;
    // +1 for the optional hidden-lane placeholder row (added below
    // the last data row when any lanes are filtered out).
    const totalRows = displayRows.length + (hiddenLaneCount > 0 ? 1 : 0);
    return computeRenderRange(
      scrollTop,
      viewportHeight,
      totalRows,
      ROW_HEIGHT,
      ROW_OVERSCAN
    );
  }, [scrollTop, displayRows.length, hiddenLaneCount, scrollerRef]);
  const visibleScheduled = useMemo(
    () =>
      displayRows.slice(
        renderRangeV2.firstRow,
        Math.max(renderRangeV2.firstRow + 1, renderRangeV2.lastRow)
      ),
    [displayRows, renderRangeV2]
  );

  // P0 #4: keyboard navigation. The hook owns the focused-bar state +
  // the keydown handler; we just thread it down to each bar and attach
  // the handler to the scroller. `displayRows` is the source of truth
  // for traversal order — it already includes the lane grouping from
  // P0 #1, so ↑↓ crosses lanes in the same order the user sees them.
  const entryPaths = useMemo(
    () => displayRows.map((r) => r.chartRow.entry.path),
    [displayRows]
  );
  const getPeriod = useCallback(
    (entryPath: string): GanttPeriod | undefined => {
      const row = scheduled.find((r) => r.entry.path === entryPath);
      return row?.period;
    },
    [scheduled]
  );
  // Space → open the period dialog via the same path as a bar single-
  // click. The hook doesn't know how to build a synthetic PointerEvent
  // for the dialog anchor, so the timeline resolves the path → entry
  // here and forwards to the existing click handler.
  const activateBar = useCallback(
    (entryPath: string) => {
      const row = scheduled.find((r) => r.entry.path === entryPath);
      if (!row) return;
      const fakeEvent = {
        clientX: 0,
        clientY: 0,
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
      } as unknown as React.PointerEvent;
      onClick(row.entry, fakeEvent);
    },
    [scheduled, onClick]
  );
  // ← → shifts commit through the same `onCommit` path as a drag —
  // resolve entryPath → entry so the view's `onSetEntryDateTag` sees
  // a real DirEntry.
  const commitForPath = useCallback(
    (entryPath: string, next: GanttPeriod) => {
      const row = scheduled.find((r) => r.entry.path === entryPath);
      if (row) onCommit(row.entry, next);
    },
    [scheduled, onCommit]
  );
  const { focusedPath, setFocusedPath, tabIndexFor, onKeyDown: onKeyDownScroller } =
    useGanttKeyboardNavigation({
      paths: entryPaths,
      getPeriod,
      onCommit: commitForPath,
      onActivate: activateBar,
      onJumpToToday,
      readOnly,
    });

  // ── Drop target for unscheduled files (DND_TYPE_FILE) ─────────────
  // react-dnd's useDrop wires its own DOM listeners on the ref'd node
  // and captures pointer events from the drag — it doesn't interfere
  // with the bar's pointerdown drag handler or the row's right-click
  // menu. The drop callback resolves the entry paths from the drag
  // item and bubbles each (entry, dayKey) up to the view, which
  // does the actual `onSetEntryDateTag` write — keeping this hook
  // file free of FileCellData plumbing.
  //
  // Default start date = today. We deliberately ignore the cursor X
  // here because the dominant UX intent for dragging out of Triage
  // is "I want to schedule this unscheduled file NOW, not on a
  // specific past/future date" — picking the day under the cursor
  // would force the user to aim precisely, which adds friction to
  // the common case. Cursor position is still the drop-target
  // identity (useDrop fires only when the cursor is over the
  // scroller — thumb column or beyond), it just doesn't determine
  // the day. `dayKeyFromClientX` below is kept exported as a pure
  // helper for future use (e.g., drag-to-reschedule an existing bar)
  // but isn't consulted on this path.
  // GanttTimeline scroller also accepts native OS files: import them into
  // the current directory and stamp today's period tag, matching the
  // internal-card behavior (`dayKey = todayKey()`). Without this, native
  // drops on the timeline bubble up to FileList's outer `nativeDropRef`
  // which falls back to a today-period tag too — same outcome, but the
  // timeline visually claims the drop and we keep the column-context
  // architecture consistent across Kanban / Matrix / Gantt.
  const { importExternalFiles } = useIOActionsContext();
  const [, dropRef] = useDrop<
    FileDragItem | { files: File[] },
    unknown,
    { isOver: boolean; canDrop: boolean }
  >(() => ({
    accept: [DND_TYPE_FILE, NativeTypes.FILE],
    canDrop: () => !readOnly,
    drop: (item) => {
      if ('files' in item) {
        const today = todayKey();
        const todayTag = periodTagFromRange({
          startKey: today,
          endKey: today,
        });
        importExternalFiles(item.files, { tagToApply: todayTag }).catch(
          () => undefined
        );
        return;
      }
      const dayKey = todayKey();
      // Resolve each dragged path to an entry. When `resolveEntry` (O(1)
      // visibleByPath) fails, fall back to a linear scan of the full
      // entries list — mirrors KanbanColumn's two-tier drop pattern.
      const entries = item.paths
        .map(
          (p) =>
            (resolveEntry ? resolveEntry(p) : undefined) ??
            allEntries.find((e) => e.path === p)
        )
        .filter((e): e is DirEntry => Boolean(e));
      for (const e of entries) onDropEntry(e, dayKey);
    },
    collect: (monitor) => ({
      isOver: monitor.isOver(),
      canDrop: monitor.canDrop(),
    }),
  }));
  // Combine the forwarded scroller ref with the drop target ref via
  // a stable callback so both consumers see the same DOM node.
  //
  // react-dnd v16's `dropRef` is a CONNECT FUNCTION — `dropTarget(node)`
  // from `TargetConnector` — that accepts a DOM node (or ref) and
  // registers it with the dnd backend. It's a regular callback, not
  // a ref object, so we just call it directly.
  const setScrollerNode = useCallback(
    (node: HTMLDivElement | null) => {
      scrollerRef.current = node;
      dropRef(node);
    },
    [scrollerRef, dropRef]
  );

  if (scheduled.length === 0) {
    return (
      <Box
        data-testid="gantt-scroll"
        ref={(node: HTMLDivElement | null) => { dropRef(node); }}
        sx={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          bgcolor: 'background.default',
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* P0 #3: empty-state with vs without Triage. The "with Triage"
            branch tells the user the next concrete action — drag a card
            onto the timeline — which is far more useful than the bare
            "no tasks" message. */}
        <Typography
          variant="body2"
          color="text.secondary"
          data-testid={
            hasTriageHint ? 'gantt-empty-with-triage' : 'gantt-empty-no-triage'
          }
        >
          {hasTriageHint ? t('ganttNoTasksHint') : t('ganttNoTasks')}
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      ref={setScrollerNode}
      data-testid="gantt-scroll"
      tabIndex={-1}
      onKeyDown={onKeyDownScroller}
      sx={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        bgcolor: 'background.default',
        position: 'relative',
        overflowX: 'auto',
        overflowY: 'auto',
        outline: 'none', // suppress the scroller's own focus outline;
                         // the focused bar carries the ring instead
      }}
    >
      <Box
        ref={exportRef}
        data-testid="gantt-chart-content"
        sx={{
          position: 'relative',
          width: innerWidth + THUMB_COL_WIDTH,
          // Min height: each rendered row + optional hidden-lane
          // placeholder at the bottom. Windowing keeps the live DOM
          // bounded; this just gives the scroller an accurate scrollbar.
          minHeight:
            TICK_HEIGHT +
            (displayRows.length + (hiddenLaneCount > 0 ? 1 : 0)) * ROW_HEIGHT,
        }}
      >
        {/* Tick row — day/week/month labels. Absolute inside the chart
            so it scrolls horizontally with the bars. */}
        <Box
          data-testid="gantt-ticks"
          sx={{
            position: 'sticky',
            top: 0,
            left: 0,
            zIndex: 3,
            height: TICK_HEIGHT,
            bgcolor: 'background.paper',
            borderBottom: 1,
            borderColor: 'divider',
            ml: `${THUMB_COL_WIDTH}px`,
          }}
        >
          {ticks.map((tick, i) => (
            <Box
              key={`${tick.key}-${i}`}
              data-testid={`gantt-tick-${tick.key}`}
              sx={{
                position: 'absolute',
                left: tick.offsetPx,
                top: 0,
                height: '100%',
                px: 0.5,
                borderLeft: 1,
                borderColor: 'divider',
                fontSize: 11,
                color: 'text.secondary',
                whiteSpace: 'nowrap',
                userSelect: 'none',
              }}
            >
              {tick.label}
            </Box>
          ))}
        </Box>

        {/* Today marker — sits between the ticks row and the rows so it
            visually crosses the row backgrounds. zIndex 2 — above rows
            so it's visible while bar colors don't fight it. */}
        <Box
          data-testid="gantt-today-line"
          aria-hidden
          sx={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: THUMB_COL_WIDTH + todayX,
            width: 2,
            bgcolor: TODAY_LINE_COLOR,
            pointerEvents: 'none',
            zIndex: 3,
          }}
        />

        {/* Task rows — windowed. Only rows whose index is in
            [renderRange.firstRow, renderRange.lastRow) are mounted.
            The `top` uses the actual index so the row sits at the
            correct absolute position even though only a slice is
            rendered — the inner content's minHeight keeps the
            scrollbar accurate. */}
        {/* Swim-lane headers (P0 #1): a thin label strip rendered at
            the TOP of EVERY lane (including the first — without that
            fix the user only saw headers for lanes 2+, not lane 0).
            Occupies the 18 px between the previous lane's last row
            (or the tick row, for the first lane) and this lane's
            first row — no overlap with row content. The 1px top
            border doubles as the lane separator. Layout:
              top    = TICK_HEIGHT + i*ROW_HEIGHT - 18
              height = 18
              so the bottom edge sits exactly at the row's top edge.
            Pl = THUMB_COL_WIDTH + 8 so the chip + label start past
            the sticky thumb column. */}
        {visibleScheduled.map((displayRow, sliceIdx) => {
          const i = renderRangeV2.firstRow + sliceIdx;
          // Mark the FIRST visible row as a lane start too — without
          // this the first lane never gets a header (since the
          // boundary set only records "index where laneIndex
          // CHANGES", which can't fire at index 0).
          const prevVisibleIdx = i - 1;
          const isLaneStart =
            prevVisibleIdx < 0 ||
            displayRows[prevVisibleIdx]?.laneIndex !== displayRow.laneIndex;
          if (!isLaneStart) return null;
          const laneValue = swimLanes[displayRow.laneIndex]?.value ?? null;
          const laneColor = stageColors.get(laneValue);
          const laneLabel = laneValue
            ? tagDisplayLabel(laneValue, t)
            : t('ganttNoStageLane');
          return (
            <Box
              key={`lane-divider-${i}`}
              data-testid={`gantt-lane-divider-${displayRow.laneIndex}`}
              sx={{
                position: 'absolute',
                top: TICK_HEIGHT + i * ROW_HEIGHT - 18,
                left: 0,
                right: 0,
                height: 18,
                bgcolor: 'background.paper',
                borderTop: 1,
                borderColor: 'divider',
                zIndex: 2,
                pointerEvents: 'none',
                display: 'flex',
                alignItems: 'center',
                pl: `${THUMB_COL_WIDTH + 8}px`,
                pr: 1,
                gap: 1,
              }}
            >
              {/* Stage color chip — same color the rows are tinted
                  with, so the user can map "lane name → row color"
                  at a glance. */}
              <Box
                data-testid={`gantt-lane-chip-${displayRow.laneIndex}`}
                sx={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  bgcolor: laneColor ?? 'text.disabled',
                  flexShrink: 0,
                }}
              />
              <Typography
                variant="caption"
                sx={{
                  color: 'text.secondary',
                  fontWeight: 600,
                  fontSize: 11,
                  lineHeight: 1,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {laneLabel}
              </Typography>
            </Box>
          );
        })}

        {/* Task rows — windowed. Each visible row is annotated with
            its lane + the lane's color so the row can tint its own
            background without re-deriving the stage color. */}
        {visibleScheduled.map((displayRow, sliceIdx) => {
          const i = renderRangeV2.firstRow + sliceIdx;
          const row = displayRow.chartRow;
          const filtered = isRowFilteredOut?.(row.tags) ?? false;
          const stageValue = swimLanes[displayRow.laneIndex]?.value ?? null;
          const stageColor = stageColors.get(stageValue);
          return (
            <GanttRow
              key={row.entry.path}
              row={row}
              top={TICK_HEIGHT + i * ROW_HEIGHT}
              rowHeight={ROW_HEIGHT}
              pxPerDay={pxPerDay}
              thumbColWidth={THUMB_COL_WIDTH}
              scaleStartKey={scale.startKey}
              scaleTotalDays={scale.totalDays}
              readOnly={readOnly}
              filteredOut={filtered}
              // Swim-lane visual: low-opacity tint of the stage color
              // as the row's background. `undefined` (= "no stage"
              // lane, or stages=[]) leaves the background untouched.
              // The bar's `colorFor` (quadrant-derived) stays
              // independent per the §9.4 design decision.
              laneTintColor={stageColor}
              colorFor={colorFor}
              thumbCache={thumbCache}
              tagColors={tagColors}
              groups={groups}
              activeTag={activeTag}
              t={t}
              onClickTag={onClickTag}
              onTagContextMenu={onTagContextMenu}
              onOpen={onOpen}
              onClick={onClick}
              onCommit={(_path, next) => onCommit(row.entry, next)}
              onContextMenu={onContextMenu}
              // P0 #2: reuse the todayKey computed for the today line so
              // the bar's overdue/in-progress classification is in sync
              // with the line itself.
              todayKey={todayKey()}
              // P0 #4: keyboard navigation — the timeline owns the
              // focused state and threads it to each bar.
              focused={focusedPath === row.entry.path}
              tabIndex={tabIndexFor(row.entry.path)}
              onBarFocus={setFocusedPath}
            />
          );
        })}

        {/* Hidden-lane placeholder (P0 #1 + P0 #5/#6): when at least
            one lane's rows are all filtered out, render a single
            collapsed row below the chart saying "<N> stages hidden".
            Keeps the user oriented ("those lanes still exist, just
            narrowed"). Only shown when the user has actively narrowed
            — see `hiddenLaneCount`'s guard above. */}
        {hiddenLaneCount > 0
          ? (() => {
              const placeholderIdx = displayRows.length;
              // Only render when the placeholder is within the
              // windowed slice (cheap optimization for big dirs).
              if (
                placeholderIdx < renderRangeV2.firstRow ||
                placeholderIdx >= renderRangeV2.lastRow
              ) {
                return null;
              }
              const top = TICK_HEIGHT + placeholderIdx * ROW_HEIGHT;
              return (
                <Box
                  data-testid="gantt-hidden-lane-placeholder"
                  sx={{
                    position: 'absolute',
                    top,
                    left: 0,
                    right: 0,
                    height: ROW_HEIGHT,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    bgcolor: 'action.hover',
                    color: 'text.secondary',
                    borderTop: 1,
                    borderColor: 'divider',
                    borderBottom: 1,
                    pointerEvents: 'none',
                  }}
                >
                  <Typography variant="caption">
                    {t('ganttLaneHidden', { count: hiddenLaneCount })}
                  </Typography>
                </Box>
              );
            })()
          : null}
      </Box>
    </Box>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────

interface Tick {
  key: string;
  offsetPx: number;
  label: string;
}

/**
 * Build the tick-marker array for a given scale + zoom. Day-ticks for
 * `day` zoom (every day) and `week` zoom (every 7th day). For
 * `month` zoom — or whenever the range exceeds ~2 years — collapse to
 * month markers so the tick row stays readable.
 */
function buildTicks(scale: GanttScale, zoom: GanttZoom): Tick[] {
  const px = PX_PER_DAY[zoom];
  const out: Tick[] = [];
  if (scale.totalDays > 730 || zoom === 'month') {
    // Monthly ticks.
    const [yStr, mStr] = scale.startKey.split('-');
    let y = Number(yStr);
    let m = Number(mStr);
    // `while (true) { … if (…) break; }` — the loop is naturally bounded
    // by the scale end; a `for` would need a synthesized `endYear` /
    // `endMonth` here, which is more brittle. eslint-disable-next-line is
    // the cleanest way to keep this idiomatic.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const key = `${y}-${String(m).padStart(2, '0')}-01`;
      const offsetDays = daysSincePure(scale.startKey, key);
      if (offsetDays >= scale.totalDays) break;
      const monthLabel = `${y}-${String(m).padStart(2, '0')}`;
      out.push({
        key,
        offsetPx: offsetDays * px,
        label: monthLabel,
      });
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return out;
  }
  // Day ticks (week zoom: every 7th, day zoom: every day).
  const step = zoom === 'week' ? 7 : 1;
  for (let i = 0; i < scale.totalDays; i += step) {
    const key = addDaysKeyPure(scale.startKey, i);
    out.push({ key, offsetPx: i * px, label: formatTickLabel(key, zoom) });
  }
  return out;
}

function formatTickLabel(key: string, zoom: GanttZoom): string {
  if (zoom === 'week') return key.slice(5); // MM-DD
  return key.slice(8); // DD
}

function daysSincePure(anchor: string, target: string): number {
  const a = new Date(`${anchor}T00:00:00Z`).getTime();
  const t = new Date(`${target}T00:00:00Z`).getTime();
  return Math.round((t - a) / 86_400_000);
}

function addDaysKeyPure(key: string, n: number): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Convert a viewport-relative pointer X into a YYYY-MM-DD key under the
 * current scale, for use by the drop handler. Returns `null` when the
 * cursor is over the thumb column or past the scale's right edge —
 * callers should treat null as "no valid drop day" and bail.
 *
 * The math:
 *   - `clientX - rect.left` → cursor X within the scroller viewport
 *   - `+ scroller.scrollLeft` → cursor X within the scroller's inner
 *     content (the chart's day-0 anchor sits at THUMB_COL_WIDTH here)
 *   - `- THUMB_COL_WIDTH` → cursor X relative to chart's day 0
 *   - `/ pxPerDay` and `floor` → half-open day index (matches the
 *     same `Math.floor` / `[0, totalDays)` clamp
 *     `dayKeyAtClientX` uses in shared/gantt.ts)
 *   - clamped to `[0, scale.totalDays - 1]`
 *
 * Exported so unit tests can verify the math without standing up the
 * full DOM + react-dnd HTML5Backend pipeline.
 */
export function dayKeyFromClientX(
  clientX: number,
  scrollerEl: HTMLElement,
  scale: GanttScale,
  pxPerDay: number
): string | null {
  const rect = scrollerEl.getBoundingClientRect();
  const cursorWithinScroller = clientX - rect.left + scrollerEl.scrollLeft;
  const cursorWithinChart = cursorWithinScroller - THUMB_COL_WIDTH;
  if (cursorWithinChart < 0) return null; // over thumb column or before day 0
  const rawDay = Math.floor(cursorWithinChart / pxPerDay);
  if (rawDay < 0 || rawDay >= scale.totalDays) return null; // past right edge
  return addDaysKeyPure(scale.startKey, rawDay);
}

// ─── Vertical windowing ─────────────────────────────────────────────────

/** Fallback viewport height when the scroller hasn't been laid out
 *  yet (e.g., during the very first render before ResizeObserver
 *  fires). 600 px is a reasonable middle-of-the-road default — most
 *  Gantt usage shows 8-10 rows at 72 px each. */
const DEFAULT_VIEWPORT_HEIGHT = 600;

/** Extra rows to mount above and below the visible viewport. Trades
 *  a bit of extra DOM (at most 2 × ROW_OVERSCAN rows) for
 *  scroll-smoothness — without overscan, scrolling fast would briefly
 *  expose a row "popping in" at the viewport edge. 3 rows on each
 *  side ≈ 216 px ≈ 1 viewport of slack at typical sizes. */
export const ROW_OVERSCAN = 3;

/**
 * Compute the inclusive-exclusive row range to render for a given
 * vertical scroll state. Pure function — exposed for unit tests so
 * the math can be verified without standing up jsdom + react-dnd.
 *
 * Coordinate system: row i sits at `top = TICK_HEIGHT + i * ROW_HEIGHT`
 * within the scroller's inner content. So the scroller's `scrollTop`
 * 0 corresponds to row 0 just below the tick row.
 *
 * @param scrollTop      current scroller.scrollTop
 * @param viewportHeight current scroller.clientHeight
 * @param totalRows      total scheduled rows (so the result never
 *                       exceeds the data)
 * @param rowHeight      constant height of each row in px
 * @param overscan       extra rows above + below the viewport (≥ 0)
 * @returns              `{ firstRow, lastRow }` — lastRow is
 *                       exclusive (use as `slice(firstRow, lastRow)`)
 */
export function computeRenderRange(
  scrollTop: number,
  viewportHeight: number,
  totalRows: number,
  rowHeight: number,
  overscan: number
): { firstRow: number; lastRow: number } {
  if (totalRows <= 0) {
    return { firstRow: 0, lastRow: 0 };
  }
  // First visible row = the first row whose bottom edge is at or below
  // the viewport's top edge. Subtract TICK_HEIGHT because row 0 sits at
  // top=TICK_HEIGHT. Floor + overscan → render slightly above so
  // fast upward scrolls don't flash an empty gap.
  const firstVisible = Math.max(
    0,
    Math.floor((scrollTop - TICK_HEIGHT) / rowHeight) - overscan
  );
  // Last visible row = first row whose top edge is below the viewport's
  // bottom edge. ceil + overscan → render slightly below so fast
  // downward scrolls don't flash an empty gap.
  const lastVisibleExclusive = Math.min(
    totalRows,
    Math.ceil((scrollTop + viewportHeight - TICK_HEIGHT) / rowHeight) +
      overscan +
      1
  );
  // Always render at least one row when totalRows > 0 (defensive —
  // a viewport of 0 height would otherwise produce an empty slice
  // which makes the chart look broken).
  const lastRow = Math.max(firstVisible + 1, lastVisibleExclusive);
  return { firstRow: firstVisible, lastRow };
}
