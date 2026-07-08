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
import SettingsIcon from '@mui/icons-material/Settings';

import type { DirEntry } from '../../shared/ipc-types';
import type { WorkflowStage } from '../../shared/workflow';
import { getTagColor } from '../../shared/tag-colors';
import { bucketEntries, UNTAGGED_COLUMN } from '../../shared/kanban';
import { DND_TYPE_FILE, type FileDragItem } from '-/services/dnd';
import { tagDisplayLabel } from '-/services/tag-display';
import type { FileCellData } from '-/components/file-cell';
import EntryCard from '-/components/EntryCard';
import KanbanEntryMenu, {
  type KanbanEntryContext,
} from '-/components/KanbanEntryMenu';
import { NoTransition, NoBackdrop } from '-/components/MenuNoTransition';
import WorkflowManagerDialog from '-/components/WorkflowManagerDialog';
import { useIOActionsContext } from '-/hooks/IOActionsContextProvider';

const COLUMN_MIN_WIDTH = 240;

interface KanbanViewProps {
  /** The shared per-cell handler bag (same one list/grid use). */
  data: FileCellData;
  /** The customizable workflow stages — one column each, in order. */
  stages: WorkflowStage[];
  /**
   * Move `sources` into the column for `targetValue` (null = the untagged
   * column), applying mutually-exclusive workflow semantics. `stageValues` is
   * the full board axis (all stage tokens).
   */
  onMoveToColumn: (
    sources: DirEntry[],
    targetValue: string | null,
    stageValues: string[]
  ) => void;
}

/**
 * Kanban perspective: the customizable workflow stages become columns (plus a
 * trailing "untagged" column). Each file lands in the column of the first stage
 * value it carries; dragging a card to another column re-tags it (mutually
 * exclusive among the workflow values). See `src/shared/kanban.ts` for the pure
 * bucketing/move logic.
 *
 * H.25: card-level right-click uses `KanbanEntryMenu` (domain-aware: move
 * stage / set priority / set deadline / edit tags / open / delete / more
 * file actions). The column header right-click menu now also opens the
 * `WorkflowManagerDialog` for in-place stage management.
 */
export default function KanbanView({
  data,
  stages,
  onMoveToColumn,
}: KanbanViewProps) {
  const { entries, tagsByName, t } = data;

  if (stages.length === 0) {
    return (
      <Box
        sx={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          p: 4,
        }}
      >
        <Typography color="text.secondary" sx={{ textAlign: 'center' }}>
          {t('kanbanNoStages')}
        </Typography>
      </Box>
    );
  }

  const stageValues = stages.map((s) => s.value);
  const buckets = bucketEntries(entries, stageValues, tagsByName);
  // Column order: stage values (board order), then the untagged column.
  const columnKeys = [...stageValues, UNTAGGED_COLUMN];

  // H.25 P0-4: per-card domain menu state. `null` ⇒ closed; otherwise the
  // anchor coords + the right-clicked entry. The `sources` (multi-selection
  // awareness) is computed lazily in the menu's `handleMove` path, but the
  // entry itself is the one the user clicked.
  const [kanbanMenu, setKanbanMenu] = useState<KanbanEntryContext | null>(
    null
  );
  // H.25 P0-5: column-header "manage stages" entry opens this dialog. Only
  // the non-untagged columns have the menu; untagged is implicitly the
  // "no workflow group" set, so it doesn't need stage management.
  const [wfMgrOpen, setWfMgrOpen] = useState(false);

  // Derive the multi-selection aware sources for the menu. When the
  // right-clicked card is part of a multi-selection, every selected entry
  // moves together (same as dragging). Otherwise just the right-clicked one.
  const menuSources = useMemo<DirEntry[]>(() => {
    if (!kanbanMenu) return [];
    const selected = data.selectedPaths;
    if (selected && selected.has(kanbanMenu.entry.path)) {
      return entries.filter((e) => selected.has(e.path));
    }
    return [kanbanMenu.entry];
  }, [kanbanMenu, data.selectedPaths, entries]);

  const menuCurrentTags = useMemo<string[]>(() => {
    if (!kanbanMenu) return [];
    return tagsByName.get(kanbanMenu.entry.path) ?? [];
  }, [kanbanMenu, tagsByName]);

  // Handler stubs (readOnly + readOnly-aware) for the menu. `onMoveToColumn`
  // comes from FileList (handles mutually-exclusive workflow semantics);
  // `onAddTag` / `onRemoveTag` / `onSetEntryDateTag` / `onRemoveEntryDateTag`
  // are also from FileList. `onOpen` / `onDelete` are passed through; the
  // latter is no-op when readOnly. `onMoreFileActions` delegates to the
  // generic EntryContextMenu via FileList's `onContextEntry`.
  const onMoreFileActions = useCallback(
    (entry: DirEntry, x: number, y: number) => {
      data.onMoreFileActions?.(entry, x, y);
    },
    [data.onMoreFileActions]
  );

  return (
    <>
      <Box
        sx={{
          height: '100%',
          width: '100%',
          boxSizing: 'border-box',
          display: 'flex',
          gap: 1.5,
          overflowX: 'auto',
          overflowY: 'hidden',
          p: 1.5,
          alignItems: 'stretch',
        }}
      >
        {columnKeys.map((key) => (
          <KanbanColumn
            key={key}
            tag={key === UNTAGGED_COLUMN ? null : key}
            entries={buckets.get(key) ?? []}
            stageValues={stageValues}
            data={data}
            onMoveToColumn={onMoveToColumn}
            onOpenWorkflowManager={() => setWfMgrOpen(true)}
            onCloseEntryMenu={() => setKanbanMenu(null)}
            onOpenEntryMenu={(entry, x, y) =>
              setKanbanMenu({ entry, x, y })
            }
          />
        ))}
      </Box>

      {/* H.25 P0-4: card right-click → domain menu. The card click is wired
          via `renderContextMenu` injected into EntryCard. The menu handles
          its own sub-menus (stage / priority / deadline) internally. */}
      <KanbanEntryMenu
        ctx={kanbanMenu}
        onClose={() => setKanbanMenu(null)}
        stageValues={stageValues}
        tagColors={data.tagColors}
        groups={data.groups}
        sources={menuSources}
        currentTags={menuCurrentTags}
        t={t}
        readOnly={data.readOnly}
        onMoveToColumn={onMoveToColumn}
        onAddTag={(entry, tag) => data.onAddTag?.(entry, tag)}
        onRemoveTag={(entry, tag) => data.onRemoveTag?.(entry, tag)}
        onSetEntryDateTag={(entry, tag) => data.onSetEntryDateTag?.(entry, tag)}
        onRemoveEntryDateTag={(entry) => data.onRemoveEntryDateTag?.(entry)}
        onOpen={(entry) => data.onOpen(entry)}
        onDelete={(entry) => data.onDelete(entry)}
        onMoreFileActions={onMoreFileActions}
      />

      {/* H.25 P0-5: column header "manage stages" entry opens this dialog. */}
      <WorkflowManagerDialog
        open={wfMgrOpen}
        onClose={() => setWfMgrOpen(false)}
      />
    </>
  );
}

interface KanbanColumnProps {
  /** The column's stage value, or null for the untagged column. */
  tag: string | null;
  entries: DirEntry[];
  stageValues: string[];
  data: FileCellData;
  onMoveToColumn: KanbanViewProps['onMoveToColumn'];
  /** Open the workflow manager dialog (only invoked by non-untagged columns). */
  onOpenWorkflowManager: () => void;
  /**
   * Open the per-card domain menu (KanbanEntryMenu) anchored at (x, y).
   * The right-clicked card's entry is passed so the menu knows which file
   * to operate on (multi-selection awareness is computed in the parent
   * from `data.selectedPaths`).
   */
  onOpenEntryMenu: (entry: DirEntry, x: number, y: number) => void;
  /** Close the per-card domain menu so it doesn't overlap column menus. */
  onCloseEntryMenu: () => void;
}

function KanbanColumn({
  tag,
  entries,
  stageValues,
  data,
  onMoveToColumn,
  onOpenWorkflowManager,
  onOpenEntryMenu,
  onCloseEntryMenu,
}: KanbanColumnProps) {
  const { t, tagColors, groups, readOnly, onCreateTagged } = data;
  const { importExternalFiles } = useIOActionsContext();
  const [columnCtx, setColumnCtx] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // Dismiss any open per-card menu so the two context menus don't stack.
    onCloseEntryMenu();
    setColumnCtx({ x: e.clientX, y: e.clientY });
  };

  const handleCreate = (kind: 'folder' | 'file') => {
    setColumnCtx(null);
    if (tag !== null) onCreateTagged?.(kind, tag);
  };

  // H.25 P1-2: prefer the parent's `data.resolveEntry` (O(1) path → entry
  // lookup) over the previous `data.entries.find(e => e.path === p)` (O(N)
  // per drop. Fall back to the linear scan if a caller hasn't wired the
  // path-keyed lookup yet — keeps backward-compat with any custom test
  // harness that builds a minimal FileCellData.
  //
  // Native (OS file manager → whale) drops are also accepted here so the
  // column owns the tag decision. The previous architecture only accepted
  // internal items on the column; native files bubbled up to FileList's
  // outer `nativeDropRef`, which lost the column context and stamped every
  // imported file with a today-period tag instead of the column's workflow
  // stage. Now the column handles both: internal cards move into the
  // column, external files import + apply THIS column's tag.
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
          // Native OS file drop. `tag === null` means the "untagged"
          // column — drop there to import without stamping any workflow
          // stage (matches what the column visually represents).
          importExternalFiles(item.files, { tagToApply: tag }).catch(
            () => undefined
          );
          return;
        }
        const sources = item.paths
          .map(
            (p) =>
              data.resolveEntry?.(p) ?? data.entries.find((e) => e.path === p)
          )
          .filter(Boolean) as DirEntry[];
        if (sources.length) onMoveToColumn(sources, tag, stageValues);
      },
      collect: (monitor) => ({
        isOver: monitor.isOver(),
        canDrop: monitor.canDrop(),
      }),
    }),
    [
      tag,
      stageValues,
      data.entries,
      data.resolveEntry,
      onMoveToColumn,
      readOnly,
      importExternalFiles,
    ]
  );

  const dropActive = isOver && canDrop;
  const color = tag ? getTagColor(tag, tagColors, groups) : undefined;

  return (
    <Box
      ref={dropRef}
      onContextMenu={handleContextMenu}
      data-testid={tag === null ? 'kanban-column-untagged' : `kanban-column-${tag}`}
      sx={{
        flex: `1 1 ${COLUMN_MIN_WIDTH}px`,
        minWidth: COLUMN_MIN_WIDTH,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        borderRadius: 1,
        bgcolor: dropActive ? 'action.hover' : 'action.selected',
        outline: dropActive ? 2 : 0,
        outlineColor: 'primary.main',
        outlineOffset: -2,
      }}
    >
      {/* Column header: color dot + label + count */}
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 1,
          px: 1.5,
          py: 1,
          flexShrink: 0,
        }}
      >
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
          {tag ? tagDisplayLabel(tag, t) : t('untagged')}
        </Typography>
        <Chip label={entries.length} size="small" variant="outlined" />
      </Box>

      {/* Column body: scrollable card stack */}
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 1, pb: 1 }}>
        {entries.map((entry) => (
          <EntryCard
            key={entry.path}
            entry={entry}
            data={data}
            renderContextMenu={(e, x, y) => {
              // Close this column's own menu first so we never show both
              // the column menu and the per-card menu at the same time.
              setColumnCtx(null);
              onOpenEntryMenu(e, x, y);
            }}
          />
        ))}
      </Box>

      <Menu
        open={columnCtx !== null}
        onClose={() => setColumnCtx(null)}
        anchorReference="anchorPosition"
        anchorPosition={
          columnCtx
            ? { top: columnCtx.y, left: columnCtx.x }
            : undefined
        }
        slots={{ transition: NoTransition, backdrop: NoBackdrop }}
        slotProps={{ transition: { timeout: 0 } }}
      >
        <MenuItem
          onClick={() => handleCreate('folder')}
          disabled={readOnly}
          data-testid={tag === null ? 'kanban-column-new-folder' : `kanban-column-new-folder-${tag}`}
        >
          <ListItemIcon>
            <CreateNewFolderIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t('newFolder')}</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => handleCreate('file')}
          disabled={readOnly}
          data-testid={tag === null ? 'kanban-column-new-file' : `kanban-column-new-file-${tag}`}
        >
          <ListItemIcon>
            <NoteAddIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t('newFile')}</ListItemText>
        </MenuItem>
        {tag !== null && !readOnly ? (
          <MenuItem
            onClick={() => {
              setColumnCtx(null);
              onOpenWorkflowManager();
            }}
            data-testid={`kanban-column-manage-${tag}`}
          >
            <ListItemIcon>
              <SettingsIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('kanbanManageStages')}</ListItemText>
          </MenuItem>
        ) : null}
      </Menu>
    </Box>
  );
}
