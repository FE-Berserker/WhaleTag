/**
 * Domain-aware right-click menu for Gantt (Tasks §3.3) entries. Mirrors
 * `KanbanEntryMenu` and `MatrixEntryMenu` so the three perspectives stay
 * behavior-parallel:
 *   1. Move to stage — all workflow stages + clear
 *   2. Set priority — four quadrants + clear
 *   3. Set period — opens PeriodTagDialog (start + end) + Clear period
 *   ─── divider ───
 *   4. Edit tags — InlineTagInput for free-form tag add/remove
 *   ─── divider ───
 *   5. Open / Delete / More file actions
 *
 * The three sections use the same per-submenu `anchorEl` pattern Kanban's
 * menu uses (separate `<Menu>` instances opened by `setXAnchor`), which
 * sidesteps MUI's nested-submenu focus-trap quirks and keeps the test
 * surface flat. NoTransition / NoBackdrop come from `MenuNoTransition.tsx`
 * (jsdom reflow avoidance — see that file's header).
 *
 * The "Set period" path opens the shared `PeriodTagDialog` (the same
 * dialog the `period:` drag-drop, Kanban, Matrix, and Calendar views use).
 * On confirm, the resulting `YYYYMMDD-YYYYMMDD` token flows through
 * `onSetEntryDateTag`, which already runs `withSinglePeriodTag` to drop any
 * prior period — Gantt never invents new metadata (see the invariants
 * header in `shared/gantt.ts`).
 *
 * `onMoreFileActions` delegates to the generic `EntryContextMenu` so the
 * user can reach rename / move / copy / reveal / etc. without losing the
 * Gantt-specific context (same pattern the Kanban menu uses).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Divider,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Typography,
} from '@mui/material';
import ArrowRightIcon from '@mui/icons-material/ArrowRight';
import CheckIcon from '@mui/icons-material/Check';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import DateRangeIcon from '@mui/icons-material/DateRange';
import FlagIcon from '@mui/icons-material/Flag';
import LaunchIcon from '@mui/icons-material/Launch';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import ViewColumnIcon from '@mui/icons-material/ViewColumn';

import type { TFunction } from 'i18next';
import type { DirEntry } from '../../shared/ipc-types';
import type { TagGroup } from '../../shared/tag-library';
import {
  QUADRANT_COLORS,
  QUADRANT_VALUES,
  isQuadrantTag,
} from '../../shared/smart-tags';
import { isPeriodTag } from '../../shared/calendar';
import { getTagColor } from '../../shared/tag-colors';
import { tagDisplayLabel } from '-/services/tag-display';
import InlineTagInput from '-/components/InlineTagInput';
import { usePeriodTagDialog } from './PeriodTagDialog';
import {
  noTransitionMenuSlotProps,
  noTransitionMenuSlots,
} from './MenuNoTransition';

/** YYYY-MM-DD local date — same format `PeriodTagDialog` expects for its
 *  `defaultStart` / `defaultEnd` props. Mirrors `todayIso()` in
 *  PeriodTagDialog.tsx but exposed as a stable helper so the menu's
 *  open-handler doesn't depend on the dialog's internal helpers. */
function todayIsoLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Cursor-anchored right-click menu state (entry + click position). */
export interface GanttEntryContext {
  x: number;
  y: number;
  entry: DirEntry;
}

export interface GanttEntryMenuProps {
  ctx: GanttEntryContext | null;
  /** Close request from MUI (backdrop click / Escape / Tab away). */
  onClose: () => void;
  /** Customizable workflow stages — values become the "Move to stage" items. */
  stageValues: string[];
  tagColors: Record<string, string>;
  groups: TagGroup[];
  /** Source files to act on — when the right-clicked card is part of a
   *  multi-selection, this includes every selected entry (matches Kanban /
   *  Matrix menu behavior). */
  sources: DirEntry[];
  /** Current tags of the right-clicked entry. Used to derive the current
   *  stage, quadrant, period presence, and to seed InlineTagInput. */
  currentTags: string[];
  t: TFunction;
  readOnly: boolean;
  /** P0 #5/#6: true when at least one of `sources` is filtered out by
   *  the workflow/quadrant filters in the view. Write actions are
   *  disabled in this case so the user doesn't silently act on a row
   *  they've just hidden. Computed by the view from the live filter
   *  state — the menu doesn't know about the filters themselves,
   *  just whether to gate writes. */
  hasFilteredSource?: boolean;
  onMoveToColumn: (
    sources: DirEntry[],
    targetValue: string | null,
    stageValues: string[]
  ) => void;
  onAddTag: (entry: DirEntry, tag: string) => void;
  onRemoveTag: (entry: DirEntry, tag: string) => void;
  onSetEntryDateTag: (entry: DirEntry, dateKey: string) => void;
  onRemoveEntryDateTag: (entry: DirEntry) => void;
  onOpen: (entry: DirEntry) => void;
  onDelete: (entry: DirEntry) => void;
  onMoreFileActions: (entry: DirEntry, x: number, y: number) => void;
}

const menuSlotProps = noTransitionMenuSlotProps;
const menuSlots = noTransitionMenuSlots;

export default function GanttEntryMenu({
  ctx,
  onClose,
  stageValues,
  tagColors,
  groups,
  sources,
  currentTags,
  t,
  readOnly,
  hasFilteredSource = false,
  onMoveToColumn,
  onAddTag,
  onRemoveTag,
  onSetEntryDateTag,
  onRemoveEntryDateTag,
  onOpen,
  onDelete,
  onMoreFileActions,
}: GanttEntryMenuProps) {
  const [stageAnchor, setStageAnchor] = useState<HTMLElement | null>(null);
  const [priorityAnchor, setPriorityAnchor] = useState<HTMLElement | null>(
    null
  );

  // "Set period" opens the shared `PeriodTagDialog` (same dialog the
  // `period:` drag-drop, Kanban, Matrix, and Calendar views use). We close
  // ourselves first so the dialog stacks above the (now-dismissed) menu
  // without overlap; on confirm we route the resulting `YYYYMMDD-YYYYMMDD`
  // token through `onSetEntryDateTag` so the existing "mutually-exclusive
  // date-tag" rewrite in `useListCommands` drops any prior period tag.
  const { openDialog: openPeriodDialog } = usePeriodTagDialog();
  const targetsForPeriodRef = useRef<DirEntry[] | null>(null);
  const openPeriod = () => {
    if (!ctx || sources.length === 0) return;
    targetsForPeriodRef.current = sources;
    onClose();
    openPeriodDialog({
      defaultStart: todayIsoLocal(),
      defaultEnd: todayIsoLocal(),
      onConfirm: (period) => {
        const targets = targetsForPeriodRef.current;
        targetsForPeriodRef.current = null;
        if (!targets) return;
        for (const target of targets) onSetEntryDateTag(target, period);
      },
    });
  };

  // Safety net for the (0,0) anchor bug (see KanbanEntryMenu.tsx comment
  // block for full rationale). Re-runs Popover's positioning once ctx
  // changes so the menu doesn't sit at the viewport origin on first open.
  const menuRef = useRef<{ updatePosition: () => void } | null>(null);
  useLayoutEffect(() => {
    if (ctx && menuRef.current) {
      menuRef.current.updatePosition();
    }
  }, [ctx]);

  const { entry, x, y } = ctx ?? {
    entry: undefined as DirEntry | undefined,
    x: 0,
    y: 0,
  };
  const anchorPosition = useMemo(
    () => (ctx ? { top: y, left: x } : undefined),
    [ctx, x, y]
  );
  const currentQuadrant = currentTags.find(isQuadrantTag) ?? null;
  const currentStage =
    stageValues.find((sv) => currentTags.includes(sv)) ?? null;
  const currentPeriod = currentTags.find(isPeriodTag) ?? null;
  // Period tags are independent of smart-date tags (see `isPeriodTag` in
  // shared/calendar.ts). The "Clear period" entry below is gated on the
  // entry actually carrying a period — if there's none the button does
  // nothing useful.
  const hasPeriod = currentPeriod !== null;

  // P0 #5/#6: writes are blocked when ANY source is filtered out. This
  // is OR'd into every existing `disabled={readOnly | …}` check below —
  // "Open" stays enabled (reading a hidden row is still allowed), and
  // "More actions" too (delegates to the generic file menu which has
  // its own gating).
  const writesDisabled = readOnly || hasFilteredSource;

  // When the menu is dismissed externally (backdrop click / Escape) the
  // anchor states must reset so the submenus don't linger if it re-opens
  // elsewhere.
  useEffect(() => {
    if (!ctx) {
      setStageAnchor(null);
      setPriorityAnchor(null);
    }
  }, [ctx]);

  // ── submenu openers ───────────────────────────────────────────────
  const openStage = (e: React.MouseEvent<HTMLLIElement>) => {
    e.stopPropagation();
    setStageAnchor(e.currentTarget);
  };
  const openPriority = (e: React.MouseEvent<HTMLLIElement>) => {
    e.stopPropagation();
    setPriorityAnchor(e.currentTarget);
  };

  // ── move to stage handler ────────────────────────────────────────
  const handleMove = (target: string | null) => {
    onMoveToColumn(sources, target, stageValues);
    closeAll();
  };

  // ── priority handlers ────────────────────────────────────────────
  const handleSetPriority = (q: string) => {
    // Strip any existing quadrant first (mutex is enforced inside handleAddTag
    // via normalize, but we make the intent explicit so the "Clear priority"
    // item is the only way to remove one).
    if (currentQuadrant && currentQuadrant !== q) {
      onRemoveTag(entry!, currentQuadrant);
    }
    onAddTag(entry!, q);
    closeAll();
  };
  const handleClearPriority = () => {
    if (currentQuadrant) onRemoveTag(entry!, currentQuadrant);
    closeAll();
  };

  // ── period handlers ─────────────────────────────────────────────
  // "Set period" opens the shared PeriodTagDialog (see `openPeriod`
  // above). "Clear period" routes through the same
  // `onRemoveEntryDateTag` handle that the Kanban menu uses —
  // `useListCommands` knows period tags as an "all date-typed tags" family
  // and the existing remove path drops them.
  const handleClearPeriod = () => {
    if (hasPeriod) onRemoveEntryDateTag(entry!);
    closeAll();
  };

  const closeAll = () => {
    setStageAnchor(null);
    setPriorityAnchor(null);
    onClose();
  };

  // Inline tag add/remove — the InlineTagInput's own onBlur commits the
  // current value, which is fine for our context.
  const handleAddInline = (tag: string) => {
    onAddTag(entry!, tag);
  };
  const handleRemoveInline = (tag: string) => {
    onRemoveTag(entry!, tag);
  };

  return (
    <>
      <Menu
        action={menuRef}
        open={ctx !== null}
        onClose={onClose}
        anchorReference="anchorPosition"
        anchorPosition={anchorPosition}
        slotProps={{
          paper: { onContextMenu: (e: React.MouseEvent) => e.preventDefault() },
          ...menuSlotProps,
        }}
        slots={menuSlots}
      >
        {ctx ? (
          <>
            {/* Section 1: Move to stage */}
            <MenuItem
              data-testid="gantt-open-stage"
              disabled={writesDisabled || sources.length === 0}
              onClick={openStage}
            >
              <ListItemIcon>
                <ViewColumnIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('kanbanMoveToStage')}</ListItemText>
              <ArrowRightIcon fontSize="small" sx={{ ml: 1, opacity: 0.6 }} />
            </MenuItem>

            {/* Section 2: Set priority */}
            <MenuItem
              data-testid="gantt-open-priority"
              disabled={writesDisabled}
              onClick={openPriority}
            >
              <ListItemIcon>
                <FlagIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('kanbanSetPriority')}</ListItemText>
              <ArrowRightIcon fontSize="small" sx={{ ml: 1, opacity: 0.6 }} />
            </MenuItem>

            {/* Section 3: Set period (opens PeriodTagDialog) + Clear period.
                "Clear period" stays disabled when there's no period tag to
                clear — same gating the Kanban menu applies. */}
            <MenuItem
              data-testid="gantt-open-period"
              disabled={writesDisabled || sources.length === 0}
              onClick={() => {
                openPeriod();
                closeAll();
              }}
            >
              <ListItemIcon>
                <DateRangeIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('kanbanSetPeriod')}</ListItemText>
            </MenuItem>
            <MenuItem
              data-testid="gantt-clear-period"
              disabled={writesDisabled || !hasPeriod}
              onClick={handleClearPeriod}
            >
              <ListItemIcon>
                <DeleteOutlineIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('kanbanClearPeriod')}</ListItemText>
            </MenuItem>

            <Divider />

            {/* Section 4: Edit tags (inline) */}
            <Box
              onClick={(e) => e.stopPropagation()}
              sx={{ px: 1.5, py: 1, minWidth: 280 }}
              data-testid="gantt-edit-tags"
            >
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ pl: 0.5, mb: 0.5, display: 'block' }}
              >
                {t('kanbanEditTags')}
              </Typography>
              <InlineTagInput
                tags={currentTags}
                tagColors={tagColors}
                groups={groups}
                t={t}
                onAdd={handleAddInline}
                onRemove={handleRemoveInline}
                readOnly={writesDisabled}
              />
            </Box>

            <Divider />

            {/* Section 5: Open / Delete / More file actions */}
            <MenuItem
              data-testid="gantt-open"
              onClick={() => {
                onOpen(entry!);
                closeAll();
              }}
            >
              <ListItemIcon>
                <LaunchIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('open')}</ListItemText>
            </MenuItem>
            <MenuItem
              data-testid="gantt-delete"
              disabled={writesDisabled}
              onClick={() => {
                onDelete(entry!);
                closeAll();
              }}
            >
              <ListItemIcon>
                <DeleteOutlineIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('delete')}</ListItemText>
            </MenuItem>
            <MenuItem
              data-testid="gantt-more"
              onClick={() => {
                // Defer to the parent so it can close this menu first, then
                // dispatch the generic file context menu. Pass the original
                // cursor position so the new menu anchors there.
                onMoreFileActions(entry!, x, y);
                closeAll();
              }}
            >
              <ListItemIcon>
                <MoreHorizIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('moreActions')}</ListItemText>
            </MenuItem>
          </>
        ) : null}
      </Menu>

      {/* Submenu: Move to stage */}
      <Menu
        open={stageAnchor !== null}
        onClose={() => setStageAnchor(null)}
        anchorEl={stageAnchor}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={menuSlotProps}
        slots={menuSlots}
      >
        {stageValues.map((sv) => {
          const selected = sv === currentStage;
          const color = getTagColor(sv, tagColors, groups);
          return (
            <MenuItem
              key={sv}
              data-testid={`gantt-stage-${sv}`}
              selected={selected}
              onClick={() => handleMove(sv)}
            >
              <ListItemIcon>
                {selected ? (
                  <CheckIcon fontSize="small" />
                ) : (
                  <Box
                    sx={{
                      width: 12,
                      height: 12,
                      borderRadius: '50%',
                      bgcolor: color ?? 'text.disabled',
                      ml: 0.5,
                      mr: 0.5,
                    }}
                  />
                )}
              </ListItemIcon>
              <ListItemText>{tagDisplayLabel(sv, t)}</ListItemText>
            </MenuItem>
          );
        })}
        <Divider />
        <MenuItem
          data-testid="gantt-stage-none"
          selected={currentStage === null}
          onClick={() => handleMove(null)}
        >
          <ListItemIcon>
            {currentStage === null ? (
              <CheckIcon fontSize="small" />
            ) : (
              <Box sx={{ width: 12, height: 12, ml: 0.5, mr: 0.5 }} />
            )}
          </ListItemIcon>
          <ListItemText>{t('kanbanNoStage')}</ListItemText>
        </MenuItem>
      </Menu>

      {/* Submenu: Set priority */}
      <Menu
        open={priorityAnchor !== null}
        onClose={() => setPriorityAnchor(null)}
        anchorEl={priorityAnchor}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={menuSlotProps}
        slots={menuSlots}
      >
        {QUADRANT_VALUES.map((q) => {
          const selected = q === currentQuadrant;
          return (
            <MenuItem
              key={q}
              data-testid={`gantt-priority-${q}`}
              selected={selected}
              onClick={() => handleSetPriority(q)}
            >
              <ListItemIcon>
                {selected ? (
                  <CheckIcon fontSize="small" />
                ) : (
                  <Box
                    sx={{
                      width: 12,
                      height: 12,
                      borderRadius: '50%',
                      bgcolor: QUADRANT_COLORS[q] ?? 'text.disabled',
                      ml: 0.5,
                      mr: 0.5,
                    }}
                  />
                )}
              </ListItemIcon>
              <ListItemText>{tagDisplayLabel(q, t)}</ListItemText>
            </MenuItem>
          );
        })}
        <Divider />
        <MenuItem
          data-testid="gantt-priority-clear"
          disabled={!currentQuadrant}
          onClick={handleClearPriority}
        >
          <ListItemIcon>
            <DeleteOutlineIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t('kanbanClearPriority')}</ListItemText>
        </MenuItem>
      </Menu>
    </>
  );
}