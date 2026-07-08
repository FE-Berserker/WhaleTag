import { Box, Tooltip } from '@mui/material';
import DateRangeIcon from '@mui/icons-material/DateRange';
import { useDrag } from 'react-dnd';
import type { TFunction } from 'i18next';

import { DND_TYPE_TAG, type TagDragItem } from '-/services/dnd';
import { smartTagI18nKey, type SmartTagDef } from '../../shared/smart-tags';
import { PERIOD_COLOR } from '../../shared/tag-colors';

/**
 * Shared quick-tag chips used by the tag-library surfaces AND the file tray's
 * smart/rating/workflow/quadrant quick-add rows. Both are draggable (drag onto
 * a file applies the tag) AND clickable (optional `onClick` — the file tray
 * uses it to apply to the currently-selected file). Keeping a single component
 * for both entry points means visual + interaction parity between the
 * side-panel library and the file-properties tray.
 *
 * Two flavours mirror the underlying drag payload:
 *  - `SmartTagChip` — drags a `SmartTagDef` (functionality + title). Drop
 *    targets resolve the template (e.g. "today") to the dated concrete value
 *    (e.g. "today-20260627"). Used for SMART_TAGS / RATING_TAGS / QUADRANT_TAGS.
 *  - `StageChip` — drags a CONCRETE workflow-stage token. Stages are
 *    user-defined values like "not-started" that don't need resolution.
 */

const QUICK_CHIP_SX = {
  display: 'inline-flex',
  alignItems: 'center',
  border: 1,
  borderColor: 'divider',
  borderRadius: 5,
  px: 0.5,
  py: '1px',
  bgcolor: 'background.paper',
  cursor: 'grab',
  userSelect: 'none',
  fontSize: 11,
  lineHeight: 1.3,
  fontWeight: 500,
  whiteSpace: 'nowrap',
  // `color` is filled per-instance via the spread below; this is the
  // resting look (text in the theme's primary text color).
} as const;

/** A built-in smart tag (time / rating / quadrant). Drags the `def` payload;
 *  drop targets resolve the template to the concrete value at drop time. */
export function SmartTagChip({
  def,
  label,
  hint,
  color,
  onClick,
}: {
  def: SmartTagDef;
  label: string;
  /** Tooltip body. Omit to skip the wrapper. */
  hint?: string;
  /** Optional accent for the label (rating chips use gold, quadrants their
   *  per-state color, time tags leave it default). */
  color?: string;
  /** Optional click handler — fires on left click. Drag still works. */
  onClick?: () => void;
}) {
  const [{ isDragging }, dragRef] = useDrag<
    TagDragItem,
    unknown,
    { isDragging: boolean }
  >(
    () => ({
      type: DND_TYPE_TAG,
      item: { tag: def.title, functionality: def.functionality },
      collect: (monitor) => ({ isDragging: monitor.isDragging() }),
    }),
    [def]
  );
  const body = (
    <Box
      ref={dragRef}
      onClick={onClick}
      sx={{
        ...QUICK_CHIP_SX,
        color,
        opacity: isDragging ? 0.4 : 1,
        cursor: onClick ? 'pointer' : 'grab',
      }}
    >
      {label}
    </Box>
  );
  return hint ? <Tooltip title={hint}>{body}</Tooltip> : body;
}

/** A customizable workflow stage chip. Drags the concrete `value` token —
 *  no template resolution needed because stages are user-defined literals. */
export function StageChip({
  value,
  label,
  color,
  hint,
  onClick,
}: {
  value: string;
  label: string;
  color?: string;
  /** Tooltip body. Omit to skip the wrapper. */
  hint?: string;
  /** Optional click handler — fires on left click. Drag still works. */
  onClick?: () => void;
}) {
  const [{ isDragging }, dragRef] = useDrag<
    TagDragItem,
    unknown,
    { isDragging: boolean }
  >(
    () => ({
      type: DND_TYPE_TAG,
      item: { tag: value },
      collect: (monitor) => ({ isDragging: monitor.isDragging() }),
    }),
    [value]
  );
  const body = (
    <Box
      ref={dragRef}
      onClick={onClick}
      sx={{
        ...QUICK_CHIP_SX,
        color,
        opacity: isDragging ? 0.4 : 1,
        cursor: onClick ? 'pointer' : 'grab',
      }}
    >
      {label}
    </Box>
  );
  return hint ? <Tooltip title={hint}>{body}</Tooltip> : body;
}

/**
 * Period-tag quick-add chip. Drags the literal `tag: 'period:'` payload
 * (no `functionality` — period is an independent family, not a smart-tag
 * template). Drop targets detect this payload in
 * `Row.tsx#onDrop` (`if (item.tag === 'period:')`) and open
 * `PeriodTagDialog` to collect start/end dates before writing the
 * `YYYYMMDD-YYYYMMDD` token.
 *
 * Rendered with `DateRange` icon + `PERIOD_COLOR` accent (violet) to
 * match the `period:` fold chip in the tag library. Phase 5 / 2026-07-04.
 */
export function PeriodChip({
  label,
  hint,
  onClick,
}: {
  label: string;
  hint?: string;
  onClick?: () => void;
}) {
  const [{ isDragging }, dragRef] = useDrag<
    TagDragItem,
    unknown,
    { isDragging: boolean }
  >(
    () => ({
      type: DND_TYPE_TAG,
      // No `functionality` — period is a fold key, not a smart tag.
      item: { tag: 'period:' },
      collect: (monitor) => ({ isDragging: monitor.isDragging() }),
    }),
    []
  );
  const body = (
    <Box
      ref={dragRef}
      onClick={onClick}
      sx={{
        ...QUICK_CHIP_SX,
        color: PERIOD_COLOR,
        opacity: isDragging ? 0.4 : 1,
        cursor: onClick ? 'pointer' : 'grab',
        gap: 0.5,
        // Inline icon for the violet accent — color flows down via the
        // Box's `color` prop.
        '& .MuiSvgIcon-root': { fontSize: 14 },
      }}
    >
      <DateRangeIcon sx={{ fontSize: 14 }} />
      {label}
    </Box>
  );
  return hint ? <Tooltip title={hint}>{body}</Tooltip> : body;
}

/**
 * Tiny helper used by surfaces that render these chips: given a `t()` from
 * react-i18next, return the per-chip label honoring the smart-tag variant
 * (ratings show star glyphs; everything else is the localized title).
 */
export function quickChipLabel(
  def: SmartTagDef,
  t: TFunction,
  glyphFallback: string | null
): string {
  // Rating values are constant glyphs (★..★★★★★) — language-independent.
  // smartTagGlyph returns null for non-rating defs; fall through to the
  // localized title for time/quadrant defs.
  return glyphFallback ?? t(smartTagI18nKey(def.functionality));
}