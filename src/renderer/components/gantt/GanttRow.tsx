/**
 * `GanttRow` — one swim lane inside the Gantt timeline.
 *
 * Owns the row's vertical positioning, the thumbnail + filename + tag
 * chips column, and the colored bar (`<GanttBar>`). Per-row right-click is
 * delegated up to the view via the `onContextMenu` prop.
 *
 * Thumbnail rendering goes through `<ThumbIcon>` so the canonical cache
 * key (`${path}|${modified}`) and lazy-load behavior match the rest of
 * the app (list/grid/gallery/PropertiesTray). See the ThumbIcon header
 * for the IO + shared FIFO queue that keeps big directories responsive.
 *
 * Tag chips: stacked below the filename in the same 200-px column. Capped
 * at MAX_TAGS_PER_ROW with a `+N` overflow chip via `EntryTagChips` (the
 * same component list/grid/kanban/matrix/calendar/mapique use — so the
 * click-to-filter and right-click-to-remove semantics stay consistent
 * with the rest of the app, and the chip color fallback path matches
 * Whale's tag-library).
 *
 * Memoized on inputs that vary per entry. The component does NOT
 * re-render every pointermove during a drag — only its sibling bar
 * gets the `previewStyle` override.
 */
import { memo } from 'react';
import { Box, Tooltip, Typography } from '@mui/material';

import type { TFunction } from 'i18next';
import type { DirEntry } from '../../../shared/ipc-types';
import type { TagGroup } from '../../../shared/tag-library';
import type { GanttChartRow, GanttPeriod } from '../../../shared/gantt';
import { MIN_BAR_WIDTH } from '../../../shared/gantt';
import { tagDisplayLabel } from '-/services/tag-display';
import { isPeriodTag } from '../../../shared/calendar';

import ThumbIcon from '../ThumbIcon';
import EntryTagChips from '../EntryTagChips';
import GanttBar from './GanttBar';

interface GanttRowProps {
  row: GanttChartRow;
  /** Vertical px of this row within the inner scroller. */
  top: number;
  rowHeight: number;
  /** Pixel-per-day at the active zoom. Same value passed to the bar. */
  pxPerDay: number;
  /** Width reserved for the thumb + filename + tags column. */
  thumbColWidth: number;
  scaleStartKey: string;
  scaleTotalDays: number;
  readOnly: boolean;
  /** True iff the workflow/quadrant filter dims this row (P0 #5 + #6).
   *  Filtered rows render at opacity 0.3 and gate drag + right-click
   *  + double-click — they're context-only, not actionable. */
  filteredOut?: boolean;
  /** Swim-lane background tint (P0 #1). Low-opacity hex color from
   *  the row's workflow stage's tag color; `undefined` means no tint
   *  (the "no stage" lane, or stages=[], leaves the background
   *  untouched). The bar's own `colorFor` is independent of the lane
   *  tint per the §9.4 design decision. */
  laneTintColor?: string;
  /** Bar fill color. Drives the bar's `bgcolor`. The current
   *  implementation (post P1 #8 revert, 2026-07-06) returns a flat
   *  primary-ish blue for every bar; P1 #10 will swap this body for a
   *  per-entry `barColor` lookup from `.whale/wsd.json`. The signature
   *  is already on the future shape — `(entry) => string` — so this
   *  component won't need to change again. */
  colorFor: (entry: DirEntry) => string;
  /** Cache map for `<ThumbIcon>` (keyed `${path}|${modified}`). */
  thumbCache: Map<string, string>;
  /** Tag-library context — same as `FileCellData`. */
  tagColors: Record<string, string>;
  groups: TagGroup[];
  /** Currently active filter tag (for chip "is filtered" highlight). */
  activeTag: string | null;
  /** i18next t — passed straight into `EntryTagChips`. */
  t: TFunction;
  /** Click a chip — toggles tag as the active filter. */
  onClickTag: (tag: string) => void;
  /** Right-click a chip — opens the per-tag "remove from this entry" menu. */
  onTagContextMenu: (
    entry: DirEntry,
    tag: string,
    x: number,
    y: number
  ) => void;
  onOpen: (entry: DirEntry) => void;
  /** Fires when the user single-clicks the bar (no drag). Currently wired
   *  to open the shared PeriodTagDialog so the user can edit the entry's
   *  start/end dates without going through the right-click menu. The
   *  PointerEvent is forwarded so the view can position the popup near
   *  the click point instead of MUI's centered default. */
  onClick: (entry: DirEntry, e: React.PointerEvent) => void;
  /**
   * Drag-to-move / drag-to-resize commit. Entry-scoped (P1-5): GanttRow binds
   * its own `row.entry` when forwarding to <GanttBar>, so GanttTimeline can
   * pass a stable reference through instead of a per-row adapter (which would
   * bust GanttRow's memo every render). Mirrors the `onClick` binding below.
   */
  onCommit: (entry: DirEntry, next: GanttPeriod) => void;
  onContextMenu: (entry: DirEntry, clientX: number, clientY: number) => void;
  /** P0 #2: today's date as YYYY-MM-DD — drives overdue/in-progress
   *  visual coding on the bar. Threaded down from GanttTimeline. */
  todayKey: string;
  /** P0 #4: focus state for keyboard navigation. The timeline owns
   *  this and threads it to each row's bar; the focused bar renders
   *  the a11y ring. */
  focused?: boolean;
  /** P0 #4: tabIndex forwarding — only the focused bar accepts tab. */
  tabIndex?: number;
  /** P0 #4: bubble focus events up to the timeline so its state
   *  matches the DOM's focused element. */
  onBarFocus?: (entryPath: string) => void;
}

/** How many tag chips render inline before the `+N` overflow. Keeping the
 *  same number as Kanban's EntryCard behavior so a directory opened in
 *  Gantt looks similar to the same directory opened in Board. */
const MAX_TAGS_PER_ROW = 2;

function GanttRowImpl({
  row,
  top,
  rowHeight,
  pxPerDay,
  thumbColWidth,
  scaleStartKey,
  scaleTotalDays,
  readOnly,
  filteredOut = false,
  laneTintColor,
  colorFor,
  thumbCache,
  tagColors,
  groups,
  activeTag,
  t,
  onClickTag,
  onTagContextMenu,
  onOpen,
  onClick,
  onCommit,
  onContextMenu,
  todayKey,
  focused,
  tabIndex,
  onBarFocus,
}: GanttRowProps) {
  const { entry, period, tags } = row;

  // Bar geometry within the chart area (NOT including the thumb column).
  // The row's `display: flex` puts the thumb column at the left and the
  // chart area at flex:1; the bar's `left`/`width` are 0-based inside
  // that chart area.
  const startDays = daysSincePure(scaleStartKey, period.startKey);
  const endDays = daysSincePure(scaleStartKey, period.endKey);
  const barLeft = startDays * pxPerDay;
  const barWidth = Math.max((endDays - startDays + 1) * pxPerDay, MIN_BAR_WIDTH);

  return (
    <Box
      data-testid={`gantt-row-${entry.path}`}
      data-entry-path={entry.path}
      data-filtered-out={filteredOut ? 'true' : undefined}
      sx={{
        position: 'absolute',
        top,
        left: 0,
        right: 0,
        height: rowHeight,
        display: 'flex',
        alignItems: 'center',
        userSelect: 'none',
        // P0 #1: swim-lane background tint. Mixed at ~10% alpha so
        // the row stays readable but the user can SEE the lane
        // boundary at a glance. `undefined` (no stage / stages=[])
        // leaves the background transparent.
        bgcolor: laneTintColor
          ? `${laneTintColor}1A` // 0x1A = 26/255 ≈ 10% opacity
          : 'transparent',
        // P0 #5/#6: filtered-out rows stay in the layout (preserves
        // spatial context) but fade out and become non-interactive
        // via pointer-events:none below. The bar still renders its
        // color but can't be dragged or clicked.
        opacity: filteredOut ? 0.3 : 1,
        pointerEvents: filteredOut ? 'none' : 'auto',
        transition: 'opacity 120ms ease-out',
      }}
      // Double-click anywhere on the row opens the file. Mirrors the
      // Kanban EntryCard behavior (`onDoubleClick={() => onOpen(entry)}`
      // on the Card root) so the two task-management views stay
      // gesture-parallel. Single-click on the bar opens the period
      // dialog (new in H.17 P0-1); right-click opens GanttEntryMenu.
      // Chips are excluded so a dblclick on a tag chip doesn't toggle
      // the filter twice AND open the file — chips have their own
      // left-click semantic (tag filter toggle) that should win.
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('.MuiChip-root')) return;
        onOpen(entry);
      }}
      onContextMenu={(e) => {
        // Defensive: chips have their own per-tag remove menu via
        // EntryTagChips.onContextMenu (which calls e.stopPropagation()).
        // Normally the chip's stopPropagation prevents this row-level
        // handler from firing on a chip click, but the Tooltip wrapper
        // between the chip and the row can break React's stopPropagation
        // in some MUI/React event-delegation configurations — and when
        // that happens the user sees BOTH the per-tag menu AND this
        // row's GanttEntryMenu stacked at the cursor. Bail out early if
        // the right-click hit a chip so only the chip's own menu opens.
        // (Same anti-stacking idea as KanbanView's column handleContextMenu,
        // which dismisses its per-card menu via onCloseEntryMenu.)
        if ((e.target as HTMLElement).closest('.MuiChip-root')) return;
        e.preventDefault();
        // stopPropagation is REQUIRED here, not optional. Without it the
        // event bubbles up to FileList's outer container, which has its
        // own onContextMenu that opens a SECOND menu (the blank-area
        // EntryContextMenu via setCtxMenu) — the user sees two stacked
        // menus at the cursor: GanttEntryMenu + the FileList fallback.
        e.stopPropagation();
        onContextMenu(entry, e.clientX, e.clientY);
      }}
    >
      {/* Thumbnail + filename + tag chips column. */}
      <Box
        sx={{
          flexShrink: 0,
          width: thumbColWidth,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1,
          bgcolor: 'background.paper',
          height: '100%',
          borderRight: 1,
          borderColor: 'divider',
        }}
      >
        {/* Vertical stack: thumb (left column 48×48) and the
            filename+chips column to its right. */}
        <Box
          data-testid={`gantt-thumb-${entry.path}`}
          sx={{ flexShrink: 0, lineHeight: 0 }}
        >
          <ThumbIcon
            entry={entry}
            thumbCache={thumbCache}
            size={48}
            rounded={4}
          />
        </Box>
        {/* Right side of the column: filename on top, tag chips below
            (truncated + `+N`). Chips overflow horizontally inside this
            Stack if needed — the `noWrap` on the parent prevents the
            column from growing and pushing the bar off-screen. */}
        <Box
          sx={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 0.25,
            overflow: 'hidden',
          }}
        >
          <Typography
            variant="body2"
            noWrap
            sx={{
              color: readOnly ? 'text.disabled' : 'text.primary',
              lineHeight: 1.25,
            }}
          >
            {entry.name}
          </Typography>
          <Box sx={{ minWidth: 0, '& .MuiChip-root': { height: 18, fontSize: 11 } }}>
            {tags.length > 0 ? (
              // Hover the chip strip → full tag list, including any tags
              // hidden behind the `+N` chip. Disabled when there are no
              // tags (an empty tooltip arrow is just noise).
              // `disableInteractive` keeps the Tooltip from intercepting
              // pointer events — chip clicks + chip right-clicks (the
              // remove menu) still go through to EntryTagChips.
              <Tooltip
                placement="top"
                arrow
                enterDelay={300}
                leaveDelay={100}
                disableInteractive
                title={
                  <Box
                    sx={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 0.25,
                      maxWidth: 320,
                      py: 0.25,
                    }}
                  >
                    {tags.map((tag) => {
                      const isPeriod = isPeriodTag(tag);
                      return (
                        <Typography
                          key={tag}
                          variant="caption"
                          sx={{
                            fontSize: 12,
                            lineHeight: 1.4,
                            color: isPeriod
                              ? 'rgba(255, 255, 255, 0.75)'
                              : 'inherit',
                          }}
                        >
                          {tagDisplayLabel(tag, t)}
                          {isPeriod ? (
                            <Typography
                              component="span"
                              variant="caption"
                              sx={{
                                ml: 0.75,
                                fontSize: 10,
                                opacity: 0.7,
                              }}
                            >
                              (period)
                            </Typography>
                          ) : null}
                        </Typography>
                      );
                    })}
                  </Box>
                }
              >
                <Box sx={{ display: 'inline-block', maxWidth: '100%' }}>
                  <EntryTagChips
                    entry={entry}
                    tags={tags}
                    tagColors={tagColors}
                    groups={groups}
                    activeTag={activeTag}
                    max={MAX_TAGS_PER_ROW}
                    t={t}
                    onClickTag={onClickTag}
                    onTagContextMenu={onTagContextMenu}
                    containerSx={{ gap: 0.25 }}
                  />
                </Box>
              </Tooltip>
            ) : (
              <EntryTagChips
                entry={entry}
                tags={tags}
                tagColors={tagColors}
                groups={groups}
                activeTag={activeTag}
                max={MAX_TAGS_PER_ROW}
                t={t}
                onClickTag={onClickTag}
                onTagContextMenu={onTagContextMenu}
                containerSx={{ gap: 0.25 }}
              />
            )}
          </Box>
        </Box>
      </Box>

      {/* Chart area (where the bar lives). */}
      <Box
        sx={{
          position: 'relative',
          flex: 1,
          height: '100%',
        }}
      >
        <GanttBar
          entryPath={entry.path}
          period={period}
          left={barLeft}
          width={barWidth}
          top={(rowHeight - 28) / 2}
          color={colorFor(entry)}
          pxPerDay={pxPerDay}
          readOnly={readOnly}
          scaleStartKey={scaleStartKey}
          scaleTotalDays={scaleTotalDays}
          // Single-click on the bar pops the shared PeriodTagDialog
          // (currently used by right-click "Set period" too — same
          // UX surface). Drag (body shift / edge resize) commits via
          // onCommit unchanged. The PointerEvent is forwarded so the
          // view can anchor the dialog near the click point.
          // NB: GanttBar's onClick signature is (entryPath, e); we
          // declare both params so TypeScript contextually types `e`
          // as React.PointerEvent instead of as the first-param
          // `entryPath: string` (which it does for a 1-param arrow).
          onClick={(_path, e) => onClick(entry, e)}
          onCommit={(_path, next) => onCommit(entry, next)}
          todayKey={todayKey}
          t={t}
          focused={focused}
          tabIndex={tabIndex}
          onFocus={onBarFocus}
        />
      </Box>
    </Box>
  );
}

/** Whole-day offset helper, isolated to keep the row file pointer-free.
 *  Same UTC math as `daysSince` in `useBarDrag.ts`. */
function daysSincePure(anchor: string, target: string): number {
  const a = new Date(`${anchor}T00:00:00Z`).getTime();
  const t = new Date(`${target}T00:00:00Z`).getTime();
  return Math.round((t - a) / 86_400_000);
}

export default memo(GanttRowImpl);
