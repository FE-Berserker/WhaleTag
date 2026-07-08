/**
 * `GanttBar` — a single draggable period bar inside one row.
 *
 * Three hit-zones: a left-edge drag region, a body-drag region, and a
 * right-edge drag region. Each carries a `data-hitzone` attribute the
 * `useBarDrag` hook reads on `pointerdown` to decide which drag kind
 * ('left' / 'body' / 'right') to enter.
 *
 * Mounted by `GanttRow`. Position comes from the row's `left` / `width`
 * props (pre-computed via `rectFromPeriod`) so the timeline doesn't have
 * to re-derive bar geometry.
 *
 * During an in-flight drag, `previewStyle` overrides the bar's
 * `left` / `width` so the user sees the snap-to-day target. On commit
 * (or Escape) the hook returns `previewStyle: null` and the row's
 * settled geometry shows through.
 *
 * Step 3 (placeholder): the visual chrome is rendered now so the
 * timeline tests can assert positioning, but the `useBarDrag` wiring
 * is stubbed — it returns `{ dragProps: {}, isDragging: false,
 * previewStyle: null }` until Step 4 lands.
 */
import type { CSSProperties } from 'react';
import { Box, Tooltip } from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';

import {
  EDGE_HIT_ZONE,
  periodStatus,
  type GanttPeriod,
} from '../../../shared/gantt';

import { useBarDrag } from './useBarDrag';

interface GanttBarProps {
  entryPath: string;
  period: GanttPeriod;
  /** Pixel x of the bar's left edge, within the timeline's inner scroller. */
  left: number;
  /** Pixel width (>= MIN_BAR_WIDTH). */
  width: number;
  /** Vertical px within the row. */
  top: number;
  /** Bar fill — typically derived from the entry's tags (quadrant color). */
  color: string;
  /** Pixel-per-day at the current zoom — fed to the drag hook so the
   *  pointermove→days math stays right under the user's zoom choice. */
  pxPerDay: number;
  readOnly: boolean;
  /** Fires on pointerup that didn't move (pure click — see useBarDrag's
   *  pending→idle transition). The view wires this to its own click
   *  action; currently `openPeriodDialog(entry)` so the user can edit
   *  the period without going through the right-click menu. The
   *  PointerEvent is forwarded so the view can anchor any popup UI
   *  near the click point instead of relying on MUI's centered default. */
  onClick: (entryPath: string, e: React.PointerEvent) => void;
  /** Commit handler called with the resolved `GanttPeriod` on a real drag. */
  onCommit: (path: string, next: GanttPeriod) => void;
  /** Translate clientX → YYYY-MM-DD for edge resizes. */
  scaleStartKey: string;
  scaleTotalDays: number;
  /** P0 #2: today's date as YYYY-MM-DD. Used to classify the bar as
   *  overdue / in-progress / normal (overdue → red outline, in-progress
   *  → play-arrow badge on the left edge). Threaded from GanttTimeline
   *  (which already calls todayKey() for the today line) so we don't
   *  pay for a second Date.now() per render. */
  todayKey: string;
  /** i18next t — used for the in-progress / overdue tooltip text so
   *  the badges don't sit there silently. */
  t: (key: string, opts?: Record<string, unknown>) => string;
  /** P0 #4: when true, the bar renders a focus ring (a11y) and
   *  the timeline's keyboard handler will route arrow / Space / T
   *  keystrokes against it. The timeline owns the focus state. */
  focused?: boolean;
  /** P0 #4: tabIndex forwarding — the timeline sets `tabIndex={0}` on
   *  exactly one bar at a time (the focused one); non-focused bars
   *  are `tabIndex={-1}` so the user can't tab into them all. */
  tabIndex?: number;
  /** P0 #4: bubble focus changes (e.g. a programmatic focus) back to
   *  the timeline so the keyboard handler's `focusedPath` stays in
   *  sync. Click-driven focus is handled by onClick; this is the
   *  edge case where the bar itself receives focus from somewhere
   *  else (e.g. a screen reader's "next element" navigation). */
  onFocus?: (entryPath: string) => void;
}

export default function GanttBar({
  entryPath,
  period,
  left,
  width,
  top,
  color,
  pxPerDay,
  readOnly,
  onClick,
  onCommit,
  scaleStartKey,
  scaleTotalDays,
  todayKey: today,
  t,
  focused = false,
  tabIndex = -1,
  onFocus,
}: GanttBarProps) {
  const {
    onPointerDown: onBarPointerDown,
    onPointerUp: onBarPointerUp,
    isDragging,
    previewStyle,
  } = useBarDrag({
    entryPath,
    period,
    readOnly,
    pxPerDay,
    scaleStartKey,
    scaleTotalDays,
    onCommit,
    onClick,
  });

  // P0 #2: classify the bar against today. Pure read; the helper lives
  // in shared/gantt.ts so tests can pin the boundaries (overdue vs
  // in-progress at the inclusive boundaries, etc.) without standing up
  // a render tree. Recompute each render — period/todayKey change at
  // most once per "Today" click or per drag-commit.
  const status = periodStatus(period, today);

  const settledStyle: CSSProperties = {
    position: 'absolute',
    left,
    width,
    top,
    height: 28,
    borderRadius: 4,
    background: color,
    opacity: 0.85,
    cursor: readOnly ? 'default' : 'grab',
    userSelect: 'none',
    touchAction: 'none',
    boxSizing: 'border-box',
    // P0 #2: overdue bars get a red outline. `outline` (not `border`) so
    // it doesn't shift the bar's content box — `box-sizing: border-box`
    // means a border would steal 2px from `width` and the drag math
    // (which trusts `width` to be the bar's full visible extent) would
    // miscompute. `outline-offset: 1px` keeps the red off the bar's
    // rounded-corner interior.
    ...(status === 'overdue'
      ? { outline: '2px solid #ef4444', outlineOffset: 1 }
      : null),
    // P0 #4: focus ring — a thicker outline that wins over the overdue
    // one when both apply (focused + overdue). We use a high-contrast
    // brand-blue ring + 2px shadow for "see at a glance" — a11y
    // baseline requires the focused element to have a visible indicator,
    // and Chrome's default outline (1px dotted) doesn't read at 28px
    // bar height with our low-saturation backgrounds. `outline-offset: 2px`
    // so the ring sits clearly outside the bar's edge.
    ...(focused
      ? {
          outline: '2px solid #1976d2',
          outlineOffset: 2,
          boxShadow: '0 0 0 4px rgba(25, 118, 210, 0.25)',
        }
      : null),
  };

  const style: CSSProperties =
    isDragging && previewStyle ? { ...settledStyle, ...previewStyle } : settledStyle;

  // P0 #2: in-progress badge — a small play-arrow on the left edge,
  // green, ~14 px wide. Rendered as a child of the bar so the parent
  // `data-hitzone="body"` div still receives the drag (pointer-events
  // on the badge are blocked so clicks fall through to the bar's
  // onPointerDown handler). The icon is `aria-hidden` because the
  // meaning is conveyed by the tooltip text + the bar's red/green
  // visual coding (a11y: never rely on color alone — the icon AND the
  // outline together carry the semantic).
  //
  // Overdue tooltip: anchored to the WHOLE bar (not a child) so the
  // outline itself becomes the hover target. Wrapping the bar in a
  // Tooltip would shadow its onPointerDown/onPointerUp handlers —
  // instead we use a cloneElement-style pattern: the bar div is the
  // Tooltip's child when overdue, and the Tooltip just attaches
  // hover listeners (which don't intercept pointerdown on a child).
  const body = (
    <div
      data-testid={`gantt-bar-${entryPath}`}
      data-hitzone="body"
      data-entry-path={entryPath}
      data-status={status}
      data-focused={focused ? 'true' : undefined}
      tabIndex={tabIndex}
      onFocus={() => onFocus?.(entryPath)}
      style={style}
      onPointerDown={(e) => onBarPointerDown(e, 'body')}
      onPointerUp={(e) => onBarPointerUp(e, 'body')}
    >
      {/* Visual left-edge resize handle. Transparent — the hit-zone is
          purely the body div's data-hitzone attribute — but a thin line
          gives the user the cursor cue at higher EDGE_HIT_ZONE values. */}
      <div
        data-hitzone="left"
        aria-hidden
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: EDGE_HIT_ZONE,
          cursor: readOnly ? 'default' : 'ew-resize',
        }}
        onPointerDown={(e) => onBarPointerDown(e, 'left')}
        onPointerUp={(e) => onBarPointerUp(e, 'left')}
      />
      <div
        data-hitzone="right"
        aria-hidden
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          bottom: 0,
          width: EDGE_HIT_ZONE,
          cursor: readOnly ? 'default' : 'ew-resize',
        }}
        onPointerDown={(e) => onBarPointerDown(e, 'right')}
        onPointerUp={(e) => onBarPointerUp(e, 'right')}
      />
      {status === 'inProgress' ? (
        <Box
          data-testid={`gantt-in-progress-${entryPath}`}
          aria-hidden
          sx={{
            position: 'absolute',
            left: -14,
            top: '50%',
            transform: 'translateY(-50%)',
            width: 14,
            height: 14,
            borderRadius: '50%',
            bgcolor: '#22c55e',
            color: 'common.white',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
          }}
        >
          <PlayArrowIcon sx={{ fontSize: 12 }} />
        </Box>
      ) : null}
    </div>
  );

  if (status === 'inProgress') {
    return (
      <Tooltip title={t('ganttInProgress')} placement="top" arrow disableInteractive>
        {body}
      </Tooltip>
    );
  }
  if (status === 'overdue') {
    return (
      <Tooltip title={t('ganttOverdue')} placement="top" arrow disableInteractive>
        {body}
      </Tooltip>
    );
  }
  return body;
}
