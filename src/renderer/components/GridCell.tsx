import { useMemo, useRef } from 'react';
import {
  Box,
  Card,
  Checkbox,
  IconButton,
  Tooltip,
  Typography,
} from '@mui/material';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { useDrop, useDrag } from 'react-dnd';
import type { CellComponentProps } from 'react-window';

import { stripTagsFromName } from '-/services/tags';
import { formatSize, formatDate } from '-/services/format';
import {
  DND_TYPE_TAG,
  type TagDragItem,
  DND_TYPE_FILE,
  type FileDragItem,
} from '-/services/dnd';
import { usePeriodTagDialog } from './PeriodTagDialog';
import type { FileCellData } from './file-cell';
import ThumbIcon from './ThumbIcon';
import EntryTagChips from './EntryTagChips';
import { EMPTY_ARR } from '-/constants';

/** Local `YYYY-MM-DD` for "today" — used as the default for the period
 *  drop dialog. Duplicated from Row.tsx; small enough to inline at each
 *  drop site (a shared util can DRY this later if a 4th site appears). */
function todayIsoLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Max tag chips shown on a grid card before the `+N` overflow chip. */
const MAX_TAGS_PER_CELL = 3;

// P2-5 (perf audit): hoisted so the memo'd <EntryTagChips> gets a referentially
// stable `containerSx` prop instead of a fresh object every render.
const TAG_CHIPS_SX = {
  justifyContent: 'center',
  flexWrap: 'wrap',
  mt: 0.25,
} as const;
/** Vertical room below the thumbnail for name + tags + meta (px). */
export const GRID_CELL_FOOTER = 84;
/** Gap between cards (px); the card insets by half on each side. */
export const GRID_CELL_GAP = 8;

interface GridCellData extends FileCellData {
  /** Columns currently laid out (derived from container width / entrySize). */
  columnCount: number;
  /** Grid cell edge length (px) — drives the thumbnail size. */
  entrySize: number;
  /** Actual rendered cell width (px). Fills the viewport so there is no
   *  trailing blank strip; the thumbnail is capped to this width. */
  cellWidth: number;
}

/**
 * One file/folder card inside the virtualized grid. Maps its (rowIndex,
 * columnIndex) to a linear entry index; cells past the end render empty. All
 * gestures reuse the same handler bag as the list rows (`FileCellData`), so
 * selection / tagging / context-menu behavior is identical across views.
 */
export default function GridCell({
  rowIndex,
  columnIndex,
  style,
  entries,
  columnCount,
  entrySize,
  cellWidth,
  tagsByName,
  activeTag,
  tagColors,
  groups,
  t,
  thumbCache,
  isSelected,
  onSelectRow,
  onOpen,
  onClickTag,
  onTagContextMenu,
  onDropTag,
  onDropFiles,
  onContextEntry,
  readOnly,
  // H.23 P0-4 plumbing (mirrors Row's fields):
  selectedPaths,
  resolveEntry,
}: CellComponentProps<GridCellData>) {
  const index = rowIndex * columnCount + columnIndex;
  const entry = entries[index];

  // H.23 P0-5 (mirror of Row's fix): useDrop dep is a primitive
  // (`entry.path` if entry exists, otherwise empty). This keeps the dnd
  // subscription stable across parent rerenders that don't change which
  // entry lives at this slot. The `resolveEntry` swap replaces the
  // previous `entries.find(...)` walk inside the drop handler.
  const targetPath = entry?.path ?? '';
  // Period-tag drop: opened via context (Phase 5 / §8). Mirrors the same
  // pattern as Row.tsx — the dialog collects a start + end date, on confirm
  // we apply the resulting `YYYYMMDD-YYYYMMDD` token via the regular
  // `onDropTag` path. Without this branch, dropping `period:` would write
  // the literal string `'period:'` to sidecar (broken).
  const { openDialog: openPeriodDialog } = usePeriodTagDialog();
  const dropPeriodFor = useRef<Parameters<typeof onDropTag>[0] | null>(null);

  const [{ isOver, canDrop, isOverFile }, dropRef] = useDrop<
    TagDragItem | FileDragItem,
    unknown,
    { isOver: boolean; canDrop: boolean; isOverFile: boolean }
  >(
    () => ({
      accept: [DND_TYPE_TAG, DND_TYPE_FILE],
      drop: (item) => {
        if (!entry) return;
        if ('tag' in item) {
          if (item.tag === 'period:') {
            dropPeriodFor.current = entry;
            openPeriodDialog({
              defaultStart: todayIsoLocal(),
              defaultEnd: todayIsoLocal(),
              onConfirm: (period) => {
                const t = dropPeriodFor.current;
                dropPeriodFor.current = null;
                if (t) onDropTag(t, period, undefined);
              },
            });
            return;
          }
          onDropTag(entry, item.tag, item.functionality);
        } else if (entry.isDirectory) {
          const sources = item.paths
            .map((p) => resolveEntry?.(p))
            .filter(Boolean);
          // Drop source list comes from path → entry resolution (P0-4 plumbing).
          // Cast is safe because `resolveEntry` either returns the matching
          // `DirEntry` or `undefined`; we filter the latter before `onDropFiles`.
          onDropFiles(entry, sources as Parameters<typeof onDropFiles>[1]);
        }
      },
      canDrop: (item) => {
        if (!entry) return false;
        if ('tag' in item) return true;
        return entry.isDirectory && !item.paths.includes(entry.path);
      },
      collect: (monitor) => ({
        isOver: monitor.isOver(),
        canDrop: monitor.canDrop(),
        isOverFile:
          monitor.isOver() && (monitor.getItemType() as string) === DND_TYPE_FILE,
      }),
    }),
    // Narrow deps: targetPath is a primitive, resolveEntry is useCallback-stable,
    // handlers are useCallback-stable (P0-2 cellData). `entry.path` would also
    // work but `targetPath` keeps the array element out of the dep list.
    [targetPath, resolveEntry, onDropTag, onDropFiles]
  );

  // H.23 P0-4 + P0-5 (mirror of Row's dragItem useMemo): iterate the
  // parent-owned `selectedPaths` Set and resolve each path through
  // `resolveEntry` — O(k) where k = selection.size, instead of an O(n) walk
  // over every visible entry. Only visible selected entries resolve
  // (matches the prior scope: `entries` is `visible`). Memoized so identity
  // doesn't churn parent rerenders.
  const dragItem = useMemo<FileDragItem>(() => {
    if (!entry) {
      return { paths: [], names: [] };
    }
    if (selectedPaths && selectedPaths.has(entry.path)) {
      const paths: string[] = [];
      const names: string[] = [];
      selectedPaths.forEach((p) => {
        const e = resolveEntry?.(p);
        if (e) {
          paths.push(p);
          names.push(e.name);
        }
      });
      return { paths, names };
    }
    return { paths: [entry.path], names: [entry.name] };
  }, [selectedPaths, resolveEntry, entry?.path, entry?.name]);
  const [{ isDragging }, dragRef] = useDrag(
    () => ({
      type: DND_TYPE_FILE,
      item: dragItem,
      collect: (monitor) => ({ isDragging: monitor.isDragging() }),
      canDrag: () => !!entry && !readOnly,
    }),
    [dragItem, readOnly]
  );

  // Trailing cells in the last row have no entry — keep the grid shape intact.
  if (!entry) return <div style={style} />;

  const tags = tagsByName.get(entry.path) ?? EMPTY_ARR;
  const selected = isSelected(entry);
  const dropActive = (isOver && canDrop) || (isOverFile && entry.isDirectory);
  const thumbSize = Math.max(0, Math.min(entrySize, cellWidth) - 24);

  return (
    <div style={style}>
      <Card
        ref={(node) => {
          dragRef(node);
          dropRef(node);
        }}
        variant="outlined"
        tabIndex={-1}
        onClick={(e) => {
          // Match the list: modifier-click selects (range/toggle); plain click
          // selects for the properties tray. Double-click opens.
          onSelectRow(index, {
            shift: e.shiftKey,
            toggle: e.ctrlKey || e.metaKey,
          });
        }}
        onDoubleClick={() => onOpen(entry)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextEntry(entry, e.clientX, e.clientY);
        }}
        title={entry.name}
        sx={{
          position: 'absolute',
          inset: GRID_CELL_GAP / 2,
          display: 'flex',
          flexDirection: 'column',
          cursor: 'pointer',
          userSelect: 'none',
          p: 1,
          opacity: isDragging ? 0.4 : undefined,
          ...(selected && {
            borderColor: 'primary.main',
            bgcolor: 'action.selected',
          }),
          ...(dropActive && {
            outline: '2px solid',
            outlineColor: 'primary.main',
            outlineOffset: -2,
            bgcolor: 'action.hover',
          }),
          '&:hover .grid-cell-checkbox, &:hover .grid-cell-more': {
            opacity: 1,
          },
        }}
      >
        {/* Thumbnail + overlay controls */}
        <Box
          sx={{
            position: 'relative',
            height: thumbSize,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            mb: 0.5,
          }}
        >
          <ThumbIcon entry={entry} thumbCache={thumbCache} size={thumbSize} />
          <Checkbox
            className="grid-cell-checkbox"
            size="small"
            checked={selected}
            onClick={(e) => {
              e.stopPropagation();
              onSelectRow(index, {
                shift: e.shiftKey,
                toggle: e.ctrlKey || e.metaKey,
              });
            }}
            sx={{
              position: 'absolute',
              top: -6,
              left: -6,
              p: 0.25,
              bgcolor: 'background.paper',
              borderRadius: 1,
              opacity: selected ? 1 : 0, // reveal on hover (or when selected)
              transition: 'opacity 120ms',
            }}
          />
          <Tooltip title={t('more')}>
            <IconButton
              className="grid-cell-more"
              size="small"
              onClick={(e) => {
                e.stopPropagation();
                onContextEntry(entry, e.clientX, e.clientY);
              }}
              sx={{
                position: 'absolute',
                top: -6,
                right: -6,
                p: 0.25,
                bgcolor: 'background.paper',
                opacity: 0,
                transition: 'opacity 120ms',
              }}
            >
              <MoreVertIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>

        {/* Filename */}
        <Typography
          variant="body2"
          noWrap
          sx={{ width: '100%', textAlign: 'center' }}
        >
          {stripTagsFromName(entry.name)}
        </Typography>

        {/* Tags */}
        {tags.length > 0 ? (
          <EntryTagChips
            entry={entry}
            tags={tags}
            activeTag={activeTag}
            tagColors={tagColors}
            groups={groups}
            max={MAX_TAGS_PER_CELL}
            t={t}
            onClickTag={onClickTag}
            onTagContextMenu={onTagContextMenu}
            containerSx={TAG_CHIPS_SX}
          />
        ) : null}

        {/* Size / date footer */}
        <Typography
          variant="caption"
          color="text.secondary"
          noWrap
          sx={{ mt: 'auto', width: '100%', textAlign: 'center' }}
        >
          {[
            entry.isFile ? formatSize(entry.size) : '',
            formatDate(entry.modified),
          ]
            .filter(Boolean)
            .join(' · ')}
        </Typography>
      </Card>
    </div>
  );
}
