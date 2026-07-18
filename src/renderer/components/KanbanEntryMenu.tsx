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
import type { TagGroup } from '../domain/tag-library';
import {
  QUADRANT_COLORS,
  QUADRANT_VALUES,
  isQuadrantTag,
} from '../../shared/smart-tags';
import { isPeriodTag } from '../domain/calendar';
import { getTagColor } from '../domain/tag-colors';
import { tagDisplayLabel } from '-/services/tag-display';
import InlineTagInput from '-/components/InlineTagInput';
import { usePeriodTagDialog } from './PeriodTagDialog';
import {
  noTransitionMenuSlotProps,
  noTransitionMenuSlots,
} from './MenuNoTransition';

/** YYYY-MM-DD local date — same format `PeriodTagDialog` expects for its
 * `defaultStart` / `defaultEnd` props. Mirrors `todayIso()` in
 * PeriodTagDialog.tsx but exposed as a stable helper so the menu's
 * open-handler doesn't depend on the dialog's internal helpers. */
function todayIsoLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * H.25 P0-1: domain-aware right-click menu for Kanban entries. Mirrors the
 * `anchorReference="anchorPosition"` pattern of CalendarEntryMenu. The Menu
 * itself is always rendered and toggled via `open` (rather than unmounting
 * when closed) so MUI's Popover positioning state persists across open/close
 * cycles and avoids a flash or stuck-at-(0,0) anchor on re-open.
 * Sections (top→bottom):
 *   1. Move to stage — all workflow stages + "无阶段" (clear)
 *   2. Set priority — four quadrants + clear
 *   3. Set period — opens PeriodTagDialog (start + end) + Clear period
 *   ─── divider ───
 *   4. Edit tags — InlineTagInput for free-form tag add/remove
 *   ─── divider ───
 *   5. Open / Delete / More file actions
 *
 * The "Set period" entry used to be "Set deadline" with a today / tomorrow /
 * next-week submenu of smart-date tags. We switched to the period-tag
 * dialog (the same one a `period:` tag drop opens on EntryCard / Matrix /
 * Calendar) because the deadline smart-tags are single-day markers while
 * kanban planning often needs a date range; reusing the dialog keeps the
 * UX consistent with drag-and-drop.
 *
 * The "More file actions" entry delegates to `onMoreFileActions` (which
 * FileList wires to the generic EntryContextMenu) so the user can still
 * reach rename / move / copy / delete / reveal / etc. without losing the
 * kanban-specific context. The Kanban menu itself only carries `delete`
 * because every other write is already representable in the kanban section
 * (rename is a generic file op; move to another folder is a drop target,
 * not a context-menu thing).
 *
 * `onMoveToColumn` is invoked with the same `(sources, target, groupTags)`
 * shape used by the column drop handler, so dropping a card and choosing
 * "Move to stage → in-progress" go through the exact same IO path.
 */
export interface KanbanEntryContext {
  x: number;
  y: number;
  entry: DirEntry;
}

export interface KanbanEntryMenuProps {
  ctx: KanbanEntryContext | null;
  /** Close request from MUI (backdrop click / Escape / Tab away). */
  onClose: () => void;
  /** Customizable workflow stages — values become the "Move to stage" items. */
  stageValues: string[];
  /** Optional group definitions for getTagColor (workflow chips carry the
   * stage group color; falls back to settings.tagColors). */
  tagColors: Record<string, string>;
  groups: TagGroup[];
  /** Source files to move when "Move to stage" is clicked — when the
   * right-clicked card is part of a multi-selection, this includes every
   * selected entry (same as the drag-handle behavior). */
  sources: DirEntry[];
  /** Current tags of the right-clicked entry (used to derive the current
   * stage, quadrant, date-typed tag presence, and to seed InlineTagInput). */
  currentTags: string[];
  t: TFunction;
  readOnly: boolean;
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

/** Common menu props that all 3 Menus in this component share (main +
 *  Move-to-stage submenu + Set-priority submenu). NoTransition / NoBackdrop
 *  slots come from MenuNoTransition.tsx — see that file's header for the
 *  jsdom + (0,0) flash rationale. */
const menuSlotProps = noTransitionMenuSlotProps;
const menuSlots = noTransitionMenuSlots;

export default function KanbanEntryMenu({
  ctx,
  onClose,
  stageValues,
  tagColors,
  groups,
  sources,
  currentTags,
  t,
  readOnly,
  onMoveToColumn,
  onAddTag,
  onRemoveTag,
  onSetEntryDateTag,
  onRemoveEntryDateTag,
  onOpen,
  onDelete,
  onMoreFileActions,
}: KanbanEntryMenuProps) {
  // Per-submenu anchor state. Each section is implemented as a separate
  // <Menu anchorEl={...}> that opens on click (avoids the focus-trap
  // pitfalls of nested MUI submenus and keeps the test surface simple).
  const [stageAnchor, setStageAnchor] = useState<HTMLElement | null>(null);
  const [priorityAnchor, setPriorityAnchor] = useState<HTMLElement | null>(
    null
  );

  // "Set period" opens the shared `PeriodTagDialog` (same dialog the
  // `period:` drag-drop and Calendar entry menu both use). We close
  // ourselves first so the dialog stacks above the (now-dismissed)
  // menu without overlap; on confirm we route the resulting
  // `YYYYMMDD-YYYYMMDD` token through `onSetEntryDateTag` so the
  // existing "mutually-exclusive date-tag" rewrite in `useListCommands`
  // drops any prior period tag.
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

  // Safety net for the (0,0) anchor bug: the primary fix lives in
  // NoTransition above (it forwards `onEntering` so Popover can compute
  // its position from `anchorPosition` synchronously on enter). This
  // belt-and-suspenders call re-runs Popover's positioning once ctx
  // changes, in case the onEntering path ran before the content had
  // measurable dimensions (which would leave the menu at (0,0)).
  const menuRef = useRef<{ updatePosition: () => void } | null>(null);
  useLayoutEffect(() => {
    if (ctx && menuRef.current) {
      menuRef.current.updatePosition();
    }
  }, [ctx]);

  const { entry, x, y } = ctx ?? { entry: undefined as DirEntry | undefined, x: 0, y: 0 };
  const anchorPosition = useMemo(
    () => (ctx ? { top: y, left: x } : undefined),
    [ctx, x, y]
  );
  const currentQuadrant = currentTags.find(isQuadrantTag) ?? null;
  const currentStage =
    stageValues.find((sv) => currentTags.includes(sv)) ?? null;
  const currentPeriod = currentTags.find(isPeriodTag) ?? null;
  // Period tags are independent of smart-date tags (see `isPeriodTag` in
  // renderer/domain/calendar.ts). The "Clear period" entry below is gated on the
  // entry actually carrying a period — if there's none the button does
  // nothing useful.
  const hasPeriod = currentPeriod !== null;

  // When the menu is dismissed externally (backdrop click / Escape) the anchor
  // states must reset so the submenus don't linger if it re-opens elsewhere.
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
  // `onRemoveEntryDateTag` handle that the deadline submenu used —
  // period tags are an "all date-typed tags" family inside
  // `useListCommands`, so the existing remove path drops them.
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
              data-testid="kanban-open-stage"
              disabled={readOnly || sources.length === 0}
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
              data-testid="kanban-open-priority"
              disabled={readOnly}
              onClick={openPriority}
            >
              <ListItemIcon>
                <FlagIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('kanbanSetPriority')}</ListItemText>
              <ArrowRightIcon fontSize="small" sx={{ ml: 1, opacity: 0.6 }} />
            </MenuItem>

            {/* Section 3: Set period (opens PeriodTagDialog).
                "Clear period" lives right below for symmetry with the
                priority/stage sections that pair a setter with a clear
                entry; it stays disabled when there's no period tag to
                clear. */}
            <MenuItem
              data-testid="kanban-open-period"
              disabled={readOnly || sources.length === 0}
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
              data-testid="kanban-clear-period"
              disabled={readOnly || !hasPeriod}
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
              // Stop click propagation so the menu doesn't close when the user
              // is interacting with the InlineTagInput's text field.
              onClick={(e) => e.stopPropagation()}
              sx={{ px: 1.5, py: 1, minWidth: 280 }}
              data-testid="kanban-edit-tags"
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
                readOnly={readOnly}
              />
            </Box>

            <Divider />

            {/* Section 5: Open / Delete / More file actions */}
            <MenuItem
              data-testid="kanban-open"
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
              data-testid="kanban-delete"
              disabled={readOnly}
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
              data-testid="kanban-more"
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
            {/* Location-level shortcuts (set default / set reminder /
                toggle read-only) were removed here for the same reason as
                EntryContextMenu — they belong to the Sidebar's per-location
                context menu, not to the per-card entry menu. */}
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
              data-testid={`kanban-stage-${sv}`}
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
          data-testid="kanban-stage-none"
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
              data-testid={`kanban-priority-${q}`}
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
          data-testid="kanban-priority-clear"
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
