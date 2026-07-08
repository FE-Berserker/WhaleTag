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

/** YYYY-MM-DD local date — mirrors `todayIsoLocal` in KanbanEntryMenu so
 *  the same shared `PeriodTagDialog` defaults work without modification. */
function todayIsoLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Cursor-anchored right-click menu state (entry + click position). */
export interface MatrixEntryContext {
  x: number;
  y: number;
  entry: DirEntry;
}

export interface MatrixEntryMenuProps {
  ctx: MatrixEntryContext | null;
  onClose: () => void;
  /** Workflow stage values (e.g. `["not-started","in-progress","completed"]`).
   *  Mirrors the kanban column axis. The menu's "Move to stage" section
   *  exposes one item per value plus a "(no stage)" clear entry. */
  stageValues: string[];
  tagColors: Record<string, string>;
  groups: TagGroup[];
  /** Right-clicked entry plus any selected siblings (multi-selection aware,
   *  same as Kanban's `sources` bag). All three write actions operate on
   *  every entry in this list. */
  sources: DirEntry[];
  /** Current tags of the right-clicked entry — used to derive the current
   *  stage, quadrant, and period presence. Seed for InlineTagInput. */
  currentTags: string[];
  t: TFunction;
  readOnly: boolean;
  /** Move `sources` into the kanban workflow column for `targetValue`
   *  (null = clear / untagged). Same handler shape Kanban's column drop
   *  uses — FileList's `handleMoveToColumn` runs `tagsAfterMove` so the
   *  workflow values stay mutually exclusive. */
  onMoveToStage: (
    sources: DirEntry[],
    targetValue: string | null,
    stageValues: string[]
  ) => void;
  /** Move `sources` into a quadrant (priority). `groupTags` is
   *  `QUADRANT_VALUES` — FileList's handler enforces mutual exclusion. */
  onMoveToPriority: (
    sources: DirEntry[],
    targetValue: string | null,
    quadrantValues: string[]
  ) => void;
  onAddTag: (entry: DirEntry, tag: string) => void;
  onRemoveTag: (entry: DirEntry, tag: string) => void;
  onSetEntryDateTag: (entry: DirEntry, dateKey: string) => void;
  onRemoveEntryDateTag: (entry: DirEntry) => void;
  onOpen: (entry: DirEntry) => void;
  onDelete: (entry: DirEntry) => void;
  /** Delegate to the generic EntryContextMenu (open / rename / move / copy /
   *  delete / reveal / …) at (x, y). Same pattern KanbanEntryMenu uses for
   *  its "More file actions" entry. */
  onMoreFileActions: (entry: DirEntry, x: number, y: number) => void;
}

/**
 * H.28 P0-1: domain-aware right-click menu for Matrix (priority) view
 * entries. Mirrors the structure of KanbanEntryMenu so the two perspectives
 * stay behavior-parallel:
 *   1. Move to stage — workflow column target (or "(no stage)" to clear)
 *   2. Set priority — quadrant target (or clear)
 *   3. Set period — opens PeriodTagDialog (start + end) + Clear period
 *   ─── divider ───
 *   4. Edit tags — InlineTagInput for free-form tag add/remove
 *   ─── divider ───
 *   5. Open / Delete / More file actions
 *
 * Differs from KanbanEntryMenu in two ways:
 *  - "Move to stage" uses `stageValues` from the workflow config
 *    (passed in by MatrixView), not derived from the column keys the view
 *    itself shows (the matrix view doesn't display workflow columns).
 *  - "Open" stays in the menu; the matrix view's quadrant drop zones are
 *    a separate drag surface and aren't part of this menu.
 *
 * The "More file actions" entry delegates to `onMoreFileActions` (which
 * MatrixView wires to the generic EntryContextMenu) so the user can still
 * reach rename / move / copy / delete / reveal / etc.
 */
export default function MatrixEntryMenu({
  ctx,
  onClose,
  stageValues,
  tagColors,
  groups,
  sources,
  currentTags,
  t,
  readOnly,
  onMoveToStage,
  onMoveToPriority,
  onAddTag,
  onRemoveTag,
  onSetEntryDateTag,
  onRemoveEntryDateTag,
  onOpen,
  onDelete,
  onMoreFileActions,
}: MatrixEntryMenuProps) {
  const [stageAnchor, setStageAnchor] = useState<HTMLElement | null>(null);
  const [priorityAnchor, setPriorityAnchor] = useState<HTMLElement | null>(
    null
  );

  // "Set period" opens the shared `PeriodTagDialog` (same dialog the
  // kanban entry menu + EntryCard `period:` drops use). Close ourselves
  // first so the dialog stacks above the (now-dismissed) menu without
  // overlap; on confirm we route the resulting `YYYYMMDD-YYYYMMDD` token
  // through `onSetEntryDateTag` so the existing "mutually-exclusive
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

  // Safety net for the (0,0) anchor bug: the primary fix lives in
  // MenuNoTransition.tsx (it forwards `onEntering` so Popover can compute
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
  // shared/calendar.ts). The "Clear period" entry below is gated on the
  // entry actually carrying a period — if there's none the button does
  // nothing useful.
  const hasPeriod = currentPeriod !== null;
  const hasStage = currentStage !== null;

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
  const handleMoveStage = (target: string | null) => {
    onMoveToStage(sources, target, stageValues);
    closeAll();
  };

  // ── priority handlers ────────────────────────────────────────────
  // Strip any existing quadrant first (mutex is enforced by FileList's
  // `tagsAfterMove`, but we make the intent explicit so the "Clear
  // priority" item is the only way to remove one).
  const handleSetPriority = (q: string) => {
    if (currentQuadrant && currentQuadrant !== q) {
      onRemoveTag(entry!, currentQuadrant);
    }
    onMoveToPriority(sources, q, QUADRANT_VALUES);
    closeAll();
  };
  const handleClearPriority = () => {
    if (currentQuadrant) onRemoveTag(entry!, currentQuadrant);
    closeAll();
  };

  // ── period handlers ─────────────────────────────────────────────
  // "Set period" opens the shared PeriodTagDialog. "Clear period" routes
  // through `onRemoveEntryDateTag` — period tags are an "all date-typed
  // tags" family inside `useListCommands`, so the existing remove path
  // drops them.
  const handleClearPeriod = () => {
    if (hasPeriod) onRemoveEntryDateTag(entry!);
    closeAll();
  };

  const closeAll = () => {
    setStageAnchor(null);
    setPriorityAnchor(null);
    onClose();
  };

  // Inline tag add/remove — InlineTagInput's own onBlur commits the
  // current value, which is fine here.
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
          ...noTransitionMenuSlotProps,
        }}
        slots={noTransitionMenuSlots}
      >
        {ctx ? (
          <>
            {/* Section 1: Move to stage (workflow) */}
            <MenuItem
              data-testid="matrix-open-stage"
              disabled={readOnly || sources.length === 0}
              onClick={openStage}
            >
              <ListItemIcon>
                <ViewColumnIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('kanbanMoveToStage')}</ListItemText>
              <ArrowRightIcon fontSize="small" sx={{ ml: 1, opacity: 0.6 }} />
            </MenuItem>

            {/* Section 2: Set priority (quadrant) */}
            <MenuItem
              data-testid="matrix-open-priority"
              disabled={readOnly}
              onClick={openPriority}
            >
              <ListItemIcon>
                <FlagIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('kanbanSetPriority')}</ListItemText>
              <ArrowRightIcon fontSize="small" sx={{ ml: 1, opacity: 0.6 }} />
            </MenuItem>

            {/* Section 3: Set period (PeriodTagDialog) + Clear period */}
            <MenuItem
              data-testid="matrix-open-period"
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
              data-testid="matrix-clear-period"
              disabled={readOnly || !hasPeriod}
              onClick={handleClearPeriod}
            >
              <ListItemIcon>
                <DeleteOutlineIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('kanbanClearPeriod')}</ListItemText>
            </MenuItem>

            <Divider />

            {/* Section 4: Edit tags (inline) — same InlineTagInput pattern
                as the Kanban menu (see KanbanEntryMenu.tsx §4) and the
                EntryContextMenu inline editor added in H.27. */}
            <Box
              onClick={(e) => e.stopPropagation()}
              sx={{ px: 1.5, py: 1, minWidth: 280 }}
              data-testid="matrix-edit-tags"
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
              data-testid="matrix-open"
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
              data-testid="matrix-delete"
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
              data-testid="matrix-more"
              onClick={() => {
                // Defer to the parent so it can close this menu first,
                // then dispatch the generic file context menu. Pass the
                // original cursor position so the new menu anchors there.
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
        slotProps={noTransitionMenuSlotProps}
        slots={noTransitionMenuSlots}
      >
        {stageValues.map((sv) => {
          const selected = sv === currentStage;
          const color = getTagColor(sv, tagColors, groups);
          return (
            <MenuItem
              key={sv}
              data-testid={`matrix-stage-${sv}`}
              selected={selected}
              onClick={() => handleMoveStage(sv)}
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
          data-testid="matrix-stage-none"
          selected={currentStage === null}
          onClick={() => handleMoveStage(null)}
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
        slotProps={noTransitionMenuSlotProps}
        slots={noTransitionMenuSlots}
      >
        {QUADRANT_VALUES.map((q) => {
          const selected = q === currentQuadrant;
          return (
            <MenuItem
              key={q}
              data-testid={`matrix-priority-${q}`}
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
          data-testid="matrix-priority-clear"
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