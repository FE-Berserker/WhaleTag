import { useCallback, useMemo, useState } from 'react';
import { useDrop } from 'react-dnd';
import { NativeTypes } from 'react-dnd-html5-backend';
import {
  Box,
  Chip,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Typography,
} from '@mui/material';
import CreateNewFolderIcon from '@mui/icons-material/CreateNewFolder';
import NoteAddIcon from '@mui/icons-material/NoteAdd';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import Tooltip from '@mui/material/Tooltip';

import type { DirEntry } from '../../shared/ipc-types';
import type { WorkflowStage } from '../domain/workflow';
import { getTagColor } from '../domain/tag-colors';
import { QUADRANT_VALUES, quadrantFunctionalityOfTag, smartTagI18nKey } from '../../shared/smart-tags';
import { bucketEntries, UNTAGGED_COLUMN } from '../domain/kanban';
import { DND_TYPE_FILE, type FileDragItem } from '-/services/dnd';
import type { FileCellData } from '-/components/file-cell';
import EntryCard from '-/components/EntryCard';
import EntryCardStack from '-/components/EntryCardStack';
import { noTransitionMenuSlots } from './MenuNoTransition';
import MatrixEntryMenu from './MatrixEntryMenu';
import { useIOActionsContext } from '-/hooks/IOActionsContextProvider';

interface MatrixViewProps {
  /** The shared per-cell handler bag (same one list/grid/kanban use). */
  data: FileCellData;
  /**
   * Move `sources` into the quadrant for `targetValue` (null = the
   * untagged tray), with mutually-exclusive quadrant semantics. `values`
   * is the board axis (all four quadrant tokens).
   */
  onMoveToColumn: (
    sources: DirEntry[],
    targetValue: string | null,
    values: string[]
  ) => void;
  /** H.28 P0-1: workflow stages — exposed in the card right-click menu's
   *  "Move to stage" section. Same prop KanbanView takes; the matrix view
   *  itself doesn't show workflow columns but lets users edit the tag
   *  from the menu. */
  stages: WorkflowStage[];
}

/**
 * Priority matrix (Eisenhower) perspective: a fixed 2×2 grid of the four
 * quadrant tags (urgent×important), plus an "untagged" tray for files with
 * no quadrant yet. Dragging a card into a quadrant re-tags it (mutually
 * exclusive). Reuses the Kanban bucketing (`bucketEntries`) and the shared
 * `EntryCard`.
 *
 * H.28 P0-1: card right-click opens a domain-aware menu (MatrixEntryMenu)
 * with three sections — Move to stage / Set priority / Set period — plus
 * Clear priority / Clear period / inline Edit tags / Open / Delete / More
 * file actions. Mirrors KanbanEntryMenu so the two perspectives stay
 * behavior-parallel.
 */
export default function MatrixView({ data, onMoveToColumn, stages }: MatrixViewProps) {
  const { entries, tagsByName } = data;
  // Memoize: bucketEntries is O(N) over visible entries (one tagsByName.get
  // per file). Recomputing on every parent render — when only the data
  // ref changes (e.g. selection toggle, thumbCache update) — is wasted
  // work in directories with thousands of files.
  const buckets = useMemo(
    () => bucketEntries(entries, QUADRANT_VALUES, tagsByName),
    [entries, tagsByName]
  );
  const untagged = useMemo(
    () => buckets.get(UNTAGGED_COLUMN) ?? [],
    [buckets]
  );

  // H.28 P0-1: domain right-click menu state. The card click is wired via
  // `renderContextMenu` injected into EntryCard; MatrixEntryMenu owns its
  // own sub-menus (stage / priority / period dialog) internally.
  const [matrixMenu, setMatrixMenu] = useState<{
    x: number;
    y: number;
    entry: DirEntry;
  } | null>(null);

  // The right-clicked card + any selected siblings — every write action
  // (stage / priority / period / add-tag / remove-tag) operates on the
  // whole `sources` list, matching the kanban menu's behaviour.
  const menuSources = useMemo<DirEntry[]>(() => {
    if (!matrixMenu) return [];
    const selected = data.selectedPaths;
    if (selected && selected.has(matrixMenu.entry.path)) {
      return entries.filter((e) => selected.has(e.path));
    }
    return [matrixMenu.entry];
  }, [matrixMenu, entries, data.selectedPaths]);

  const menuCurrentTags = useMemo<string[]>(() => {
    if (!matrixMenu) return [];
    return tagsByName.get(matrixMenu.entry.path) ?? [];
  }, [matrixMenu, tagsByName]);

  const stageValues = useMemo(() => stages.map((s) => s.value), [stages]);

  // Stage / priority / period + tag handlers. `onMoveToStage` reuses
  // FileList's `handleMoveToColumn` with `stageValues` as the group axis;
  // FileList's `tagsAfterMove` keeps the workflow values mutually
  // exclusive.
  const onMoveToStage = useCallback(
    (sources: DirEntry[], target: string | null, groupTags: string[]) => {
      onMoveToColumn(sources, target, groupTags);
    },
    [onMoveToColumn]
  );

  const onMoreFileActions = useCallback(
    (entry: DirEntry, x: number, y: number) => {
      data.onMoreFileActions?.(entry, x, y);
    },
    [data.onMoreFileActions]
  );

  // P0-4 (perf audit): stable per-card menu opener, shared by Quadrant and
  // UntaggedTray. `setMatrixMenu` is a stable useState setter, so this never
  // re-creates — letting the children's own `renderContextMenu` callbacks
  // stay stable and the memo'd <EntryCard> bail out on unrelated re-renders.
  const openEntryMenu = useCallback(
    (entry: DirEntry, x: number, y: number) => {
      setMatrixMenu({ entry, x, y });
    },
    []
  );

  return (
    <Box
      sx={{
        height: '100%',
        width: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
        p: 1.5,
        overflow: 'hidden',
      }}
    >
      {/* The 2×2 quadrant grid (row-major: matches QUADRANT_VALUES order).
          minmax(0,1fr) (not 1fr = minmax(auto,1fr)) lets the tracks shrink below
          content so each quadrant stays viewport-bounded and scrolls internally
          instead of stretching the row. */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gridTemplateRows: 'repeat(2, minmax(0, 1fr))',
          gap: 1.5,
        }}
      >
        {QUADRANT_VALUES.map((value) => (
          <Quadrant
            key={value}
            value={value}
            entries={buckets.get(value) ?? []}
            data={data}
            onMoveToColumn={onMoveToColumn}
            // H.28 P0-1: card right-click → open MatrixEntryMenu. Reuse
            // the same `setMatrixMenu` setter as MatrixView's main
            // container; quadrant containers don't need their own menu.
            onOpenEntryMenu={openEntryMenu}
          />
        ))}
      </Box>

      {/* Untagged tray — triage files with no quadrant by dragging them up. */}
      {untagged.length > 0 ? (
        <UntaggedTray
          entries={untagged}
          data={data}
          onMoveToColumn={onMoveToColumn}
          onOpenEntryMenu={openEntryMenu}
        />
      ) : null}

      {/* H.28 P0-1: per-card domain menu (Move to stage / Set priority /
          Set period / Edit tags / Open / Delete / More file actions).
          Stages come from `props.stages`; the menu itself manages
          `currentStage` / `currentQuadrant` / `currentPeriod` from
          `tagsByName` so the selected checkmarks reflect reality. */}
      <MatrixEntryMenu
        ctx={matrixMenu}
        onClose={() => setMatrixMenu(null)}
        stageValues={stageValues}
        tagColors={data.tagColors}
        groups={data.groups}
        sources={menuSources}
        currentTags={menuCurrentTags}
        t={data.t}
        readOnly={data.readOnly}
        onMoveToStage={onMoveToStage}
        onMoveToPriority={onMoveToColumn}
        onAddTag={(entry, tag) => data.onAddTag?.(entry, tag)}
        onRemoveTag={(entry, tag) => data.onRemoveTag?.(entry, tag)}
        onSetEntryDateTag={(entry, tag) =>
          data.onSetEntryDateTag?.(entry, tag)
        }
        onRemoveEntryDateTag={(entry) =>
          data.onRemoveEntryDateTag?.(entry)
        }
        onOpen={(entry) => data.onOpen(entry)}
        onDelete={(entry) => data.onDelete(entry)}
        onMoreFileActions={onMoreFileActions}
      />
    </Box>
  );
}

interface QuadrantProps {
  value: string;
  entries: DirEntry[];
  data: FileCellData;
  onMoveToColumn: MatrixViewProps['onMoveToColumn'];
  /** H.28 P0-1: open the per-card domain menu at (x, y). */
  onOpenEntryMenu: (entry: DirEntry, x: number, y: number) => void;
}

function Quadrant({ value, entries, data, onMoveToColumn, onOpenEntryMenu }: QuadrantProps) {
  const { t, tagColors, groups, readOnly, onCreateTagged } = data;
  const { importExternalFiles } = useIOActionsContext();
  const [quadrantCtx, setQuadrantCtx] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setQuadrantCtx({ x: e.clientX, y: e.clientY });
  };

  const handleCreate = (kind: 'folder' | 'file') => {
    setQuadrantCtx(null);
    onCreateTagged?.(kind, value);
  };

  // P0-4 (perf audit): stable per-card right-click handler. Closes this
  // quadrant's header menu first (so the two never stack) then forwards to
  // the parent's stable `onOpenEntryMenu`. Both deps are stable, so this never
  // re-creates — keeping the memo'd <EntryCard> from busting on quadrant-local
  // state changes (menu open/close).
  const renderCardContextMenu = useCallback(
    (e: DirEntry, x: number, y: number) => {
      setQuadrantCtx(null);
      onOpenEntryMenu(e, x, y);
    },
    [onOpenEntryMenu]
  );

  // Quadrant accepts both internal cards (DND_TYPE_FILE) and native OS
  // files (NativeTypes.FILE). The native path imports the dropped files
  // AND stamps this quadrant's value as their tag — the quadrant owns
  // the tag decision instead of bubbling up to FileList's outer drop ref,
  // which used to stamp a today-period tag instead of the quadrant value.
  const [{ isOver, canDrop }, dropRef] = useDrop<
    FileDragItem | { files: File[] },
    unknown,
    { isOver: boolean; canDrop: boolean }
  >(
    () => ({
      accept: [DND_TYPE_FILE, NativeTypes.FILE],
      canDrop: () => !readOnly,
      drop: (item) => {
        if ('files' in item) {
          importExternalFiles(item.files, { tagToApply: value }).catch(
            () => undefined
          );
          return;
        }
        // H.25 P1-2 mirror: prefer the parent's O(1) `resolveEntry` over a
        // linear `entries.find` (O(M·N) when dragging M files in a large
        // folder). Fall back to the linear scan if a caller hasn't wired
        // the path-keyed lookup yet.
        const sources = item.paths
          .map(
            (p) =>
              data.resolveEntry?.(p) ??
              data.entries.find((e) => e.path === p)
          )
          .filter(Boolean) as DirEntry[];
        if (sources.length) onMoveToColumn(sources, value, QUADRANT_VALUES);
      },
      collect: (monitor) => ({
        isOver: monitor.isOver(),
        canDrop: monitor.canDrop(),
      }),
    }),
    [
      value,
      data.entries,
      data.resolveEntry,
      onMoveToColumn,
      readOnly,
      importExternalFiles,
    ]
  );

  const dropActive = isOver && canDrop;
  const color = getTagColor(value, tagColors, groups);
  // Prefer the localized quadrant label (e.g. "紧急&重要") over the raw
  // token ("urgent-important"). Falls back to the value when the function
  // isn't recognized — defensive in case a future custom quadrant slips
  // through QUADRANT_DEFS without a corresponding i18n key.
  const quadrantFn = quadrantFunctionalityOfTag(value);
  const label = quadrantFn ? t(smartTagI18nKey(quadrantFn)) : value;

  return (
    <Box
      ref={dropRef}
      data-testid={`matrix-quadrant-${value}`}
      onContextMenu={handleContextMenu}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        borderRadius: 1,
        bgcolor: dropActive ? 'action.hover' : 'action.selected',
        outline: dropActive ? 2 : 0,
        outlineColor: 'primary.main',
        outlineOffset: -2,
        // A subtle top accent in the quadrant's color.
        borderTop: 3,
        borderTopColor: color ?? 'text.disabled',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1, flexShrink: 0 }}>
        <Box
          sx={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            flexShrink: 0,
            bgcolor: color ?? 'text.disabled',
          }}
        />
        <Typography variant="subtitle2" noWrap sx={{ flex: 1, minWidth: 0 }}>
          {label}
        </Typography>
        <Chip label={entries.length} size="small" variant="outlined" />
      </Box>
      {/* Quadrant body: virtualized card stack (P0-4②). The quadrant Box above
          is the DnD drop target — it wraps this stack, so drops still land on
          the quadrant regardless of which cards are virtualized in/out. */}
      <Box sx={{ flex: 1, minHeight: 0, px: 1, pb: 1 }}>
        <EntryCardStack
          entries={entries}
          data={data}
          // H.28 P0-1: card right-click → open the per-card domain menu
          // (matrix scope). Closes the column header menu first so the
          // two menus never stack.
          renderContextMenu={renderCardContextMenu}
        />
      </Box>

      <Menu
        open={quadrantCtx !== null}
        onClose={() => setQuadrantCtx(null)}
        anchorReference="anchorPosition"
        anchorPosition={
          quadrantCtx
            ? { top: quadrantCtx.y, left: quadrantCtx.x }
            : undefined
        }
        slots={noTransitionMenuSlots}
        slotProps={{ transition: { timeout: 0 } }}
      >
        <MenuItem onClick={() => handleCreate('folder')} disabled={readOnly}>
          <ListItemIcon>
            <CreateNewFolderIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t('newFolder')}</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => handleCreate('file')} disabled={readOnly}>
          <ListItemIcon>
            <NoteAddIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t('newFile')}</ListItemText>
        </MenuItem>
      </Menu>
    </Box>
  );
}

function UntaggedTray({
  entries,
  data,
  onMoveToColumn,
  onOpenEntryMenu,
}: {
  entries: DirEntry[];
  data: FileCellData;
  onMoveToColumn: MatrixViewProps['onMoveToColumn'];
  /** H.28 P0-1: open the per-card domain menu at (x, y). */
  onOpenEntryMenu: (entry: DirEntry, x: number, y: number) => void;
}) {
  const { t, readOnly } = data;

  const [{ isOver, canDrop }, dropRef] = useDrop<
    FileDragItem,
    unknown,
    { isOver: boolean; canDrop: boolean }
  >(
    () => ({
      accept: DND_TYPE_FILE,
      canDrop: () => !readOnly,
      drop: (item) => {
        // H.25 P1-2 mirror: see Quadrant above — O(1) resolveEntry first.
        const sources = item.paths
          .map(
            (p) =>
              data.resolveEntry?.(p) ??
              data.entries.find((e) => e.path === p)
          )
          .filter(Boolean) as DirEntry[];
        if (sources.length) onMoveToColumn(sources, null, QUADRANT_VALUES);
      },
      collect: (monitor) => ({
        isOver: monitor.isOver(),
        canDrop: monitor.canDrop(),
      }),
    }),
    [data.entries, data.resolveEntry, onMoveToColumn, readOnly]
  );

  const dropActive = isOver && canDrop;

  return (
    <Box
      ref={dropRef}
      sx={{
        flexShrink: 0,
        maxHeight: 160,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 1,
        bgcolor: dropActive ? 'action.hover' : 'action.selected',
        outline: dropActive ? 2 : 0,
        outlineColor: 'primary.main',
        outlineOffset: -2,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 0.75, flexShrink: 0 }}>
        <Typography variant="subtitle2" noWrap sx={{ flex: 1, minWidth: 0 }}>
          {t('untagged')}
        </Typography>
        {/* Read-only locations can't move files into the tray either, but
            users have no way to tell — drop silently fails. The lock icon
            surfaces the constraint at a glance, matching the Quadrant's
            `disabled` menu items. */}
        {readOnly ? (
          <Tooltip title={t('readOnly')}>
            <LockOutlinedIcon
              fontSize="small"
              color="disabled"
              data-testid="matrix-untagged-readonly"
            />
          </Tooltip>
        ) : null}
        <Chip label={entries.length} size="small" variant="outlined" />
      </Box>
      {/* Horizontal tray of cards so it stays a thin strip. */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflowX: 'auto',
          overflowY: 'hidden',
          display: 'flex',
          gap: 1,
          px: 1,
          pb: 1,
          alignItems: 'flex-start',
        }}
      >
        {entries.map((entry) => (
          <Box key={entry.path} sx={{ width: 220, flexShrink: 0 }}>
            <EntryCard
              entry={entry}
              data={data}
              // H.28 P0-1: same domain menu injection as the quadrant
              // body — card right-click opens MatrixEntryMenu. `onOpenEntryMenu`
              // is already a stable useCallback from the parent (P0-4), so it
              // doubles as the card's renderContextMenu without a wrapper.
              renderContextMenu={onOpenEntryMenu}
            />
          </Box>
        ))}
      </Box>
    </Box>
  );
}