import { memo, useMemo, useRef } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import { Box, Card, Typography } from '@mui/material';

import type { DirEntry } from '../../shared/ipc-types';
import {
  DND_TYPE_FILE,
  type FileDragItem,
  DND_TYPE_TAG,
  type TagDragItem,
} from '-/services/dnd';
import { stripTagsFromName } from '-/services/tags';
import type { FileCellData } from '-/components/file-cell';
import ThumbIcon from '-/components/ThumbIcon';
import EntryTagChips from '-/components/EntryTagChips';
import { usePeriodTagDialog } from './PeriodTagDialog';

const CARD_THUMB = 40;
const MAX_TAGS_PER_CARD = 4;
// Fixed card height so Kanban/Matrix rows stay visually aligned whether the
// entry carries tags or not: padding (16) + thumb row (40) + gap (4) + one tag
// row (24) = 84px. Cards with more tags still grow naturally.
const CARD_MIN_HEIGHT = 84;

/** Local `YYYY-MM-DD` for "today" — used as the default for the period
 *  drop dialog. See Row.tsx / GridCell.tsx for the same helper; small
 *  enough to inline. */
function todayIsoLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * A draggable file card — thumbnail + name + tag chips — shared by the Kanban
 * and Matrix board views. Drags as a FileDragItem (the whole selection if the
 * card is selected, else just itself); click/right-click reuse the FileCellData
 * handler bag so behavior matches the list/grid.
 *
 * H.25 P0-2: an optional `renderContextMenu` prop lets a parent (KanbanView)
 * inject a domain-aware right-click menu. When provided, the right-click goes
 * to that instead of the generic `data.onContextEntry` (which is what
 * list/grid/Matrix continue to use). FileList doesn't pass this prop, so the
 * fallback path is the existing FileList behavior.
 */
function EntryCardBase({
  entry,
  data,
  renderContextMenu,
}: {
  entry: DirEntry;
  data: FileCellData;
  /**
   * Optional domain-aware right-click override. When set, takes precedence
   * over `data.onContextEntry` so the Kanban view can show its task menu
   * instead of the generic file operations. List/grid callers omit this.
   */
  renderContextMenu?: (entry: DirEntry, x: number, y: number) => void;
}) {
  const {
    entries,
    tagsByName,
    activeTag,
    tagColors,
    groups,
    t,
    thumbCache,
    readOnly,
    isSelected,
    onSelectRow,
    onOpen,
    onDelete,
    onClickTag,
    onTagContextMenu,
    onContextEntry,
    onDropTag,
  } = data;

  // H.25 P1-1: prefer the parent's `selectedPaths` Set (O(1) lookup, stable
  // identity across renders) over recomputing `entries.filter(isSelected)`
  // per card every render — that was the O(N²) hot spot on large boards
  // (every visible card walks the whole entry list). The Set is the same one
  // Row uses for its dragItem memo; both views now share one source of truth.
  const selected = data.selectedPaths?.has(entry.path) ?? isSelected(entry);
  const dragItem = useMemo<FileDragItem>(() => {
    if (!selected) return { paths: [entry.path], names: [entry.name] };
    if (data.selectedPaths) {
      // O(visible) walk, but the Set membership check itself is O(1); the
      // pre-P0 filter+map allocated two arrays per card every render.
      const paths: string[] = [];
      const names: string[] = [];
      for (const e of data.entries) {
        if (data.selectedPaths.has(e.path)) {
          paths.push(e.path);
          names.push(e.name);
        }
      }
      return { paths, names };
    }
    // Fallback (pre-P0-4): no `selectedPaths` was wired — keep the old
    // behavior so callers that omit it don't regress.
    const sel = data.entries.filter(isSelected);
    return {
      paths: sel.map((e) => e.path),
      names: sel.map((e) => e.name),
    };
  }, [
    data.selectedPaths,
    data.entries,
    entry.path,
    entry.name,
    selected,
    isSelected,
  ]);

  const [{ isDragging }, dragRef] = useDrag(
    () => ({
      type: DND_TYPE_FILE,
      item: dragItem,
      canDrag: () => !readOnly,
      collect: (monitor) => ({ isDragging: monitor.isDragging() }),
    }),
    [dragItem, readOnly]
  );

  // Tag-drop target on the card itself. Mirrors the list/grid row pattern
  // in Row.tsx + the multi-select batch rule from GalleryCell.tsx so dragging
  // a tag chip from the Tag Library onto a Kanban/Matrix card applies the
  // tag (or to every selected entry if the card is part of a multi-selection).
  //
  // Period branch: dropping the `period:` fold chip opens the date dialog
  // and writes the resolved `YYYYMMDD-YYYYMMDD` token via the same
  // `onDropTag` path. Without this branch, dropping `period:` would write
  // the literal string and break the date-tag filter.
  const { openDialog: openPeriodDialog } = usePeriodTagDialog();
  const dropPeriodFor = useRef<DirEntry[] | null>(null);

  const [{ isOver, canDrop }, dropRef] = useDrop<
    TagDragItem,
    unknown,
    { isOver: boolean; canDrop: boolean }
  >(
    () => ({
      accept: [DND_TYPE_TAG],
      canDrop: () => !readOnly,
      drop: (item) => {
        if (!onDropTag) return;
        if (item.tag === 'period:') {
          const targets =
            selected &&
            data.selectedPaths &&
            data.selectedPaths.size > 1
              ? entries.filter((e) => data.selectedPaths!.has(e.path))
              : [entry];
          dropPeriodFor.current = targets;
          openPeriodDialog({
            defaultStart: todayIsoLocal(),
            defaultEnd: todayIsoLocal(),
            onConfirm: (period) => {
              const t = dropPeriodFor.current;
              dropPeriodFor.current = null;
              if (t) for (const target of t) onDropTag(target, period, undefined);
            },
          });
          return;
        }
        // Batch rule — same as GalleryCell: a drop on a selected card with
        // more than one selected entry tags every selected entry, not just
        // the drop target.
        if (
          selected &&
          data.selectedPaths &&
          data.selectedPaths.size > 1
        ) {
          const targets = entries.filter((e) =>
            data.selectedPaths!.has(e.path)
          );
          for (const target of targets) {
            onDropTag(target, item.tag, item.functionality);
          }
        } else {
          onDropTag(entry, item.tag, item.functionality);
        }
      },
      collect: (monitor) => ({
        isOver: monitor.isOver(),
        canDrop: monitor.canDrop(),
      }),
    }),
    [entry, entries, selected, data.selectedPaths, readOnly, onDropTag]
  );

  const dropActive = isOver && canDrop;

  const tags = tagsByName.get(entry.path) ?? [];

  // H.25 P2-1: keyboard reachability. Finder / Explorer convention:
  //   Enter — open the file
  //   Space — toggle selection (keep focus on this card)
  //   Delete — remove (readOnly aware)
  // We use `tabIndex={0}` so the card is part of the tab order (the previous
  // `-1` meant it was only reachable via mouse / drag), and stop space from
  // scrolling the page inside the column.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onOpen(entry);
    } else if (e.key === ' ') {
      e.preventDefault();
      const index = entries.findIndex((x) => x.path === entry.path);
      if (index >= 0) {
        onSelectRow(index, { shift: false, toggle: true });
      }
    } else if (e.key === 'Delete') {
      if (readOnly || !onDelete) return;
      e.preventDefault();
      onDelete(entry);
    }
  };

  return (
    <Card
      ref={(node: HTMLDivElement | null) => {
        // Combine drag-source ref + tag-drop ref on the same Card. Same
        // pattern as GalleryCell.tsx — both `useDrag` and `useDrop` need
        // to attach to the underlying DOM node.
        dragRef(node);
        dropRef(node);
      }}
      variant="outlined"
      tabIndex={0}
      role="button"
      aria-label={entry.name}
      title={entry.name}
      data-entry-path={entry.path}
      onClick={(e) => {
        const index = entries.findIndex((x) => x.path === entry.path);
        if (index >= 0) {
          onSelectRow(index, {
            shift: e.shiftKey,
            toggle: e.ctrlKey || e.metaKey,
          });
        }
      }}
      onDoubleClick={() => onOpen(entry)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        (renderContextMenu ?? onContextEntry)(entry, e.clientX, e.clientY);
      }}
      onKeyDown={handleKeyDown}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        p: 1,
        mb: 1,
        minHeight: `${CARD_MIN_HEIGHT}px`,
        cursor: 'pointer',
        userSelect: 'none',
        opacity: isDragging ? 0.4 : undefined,
        ...(selected && {
          borderColor: 'primary.main',
          bgcolor: 'action.selected',
        }),
        // Tag-drop-active outline: dashed inset border distinguishes a
        // drag-over from the solid selected border. Matches the column
        // drop indicator in KanbanView / MatrixView so the gesture looks
        // identical at both the card and column levels. A 1px size shift
        // (border thickening from 1px → 2px) is visually negligible in a
        // 84px-tall card; we don't compensate with `margin/padding` so the
        // theme spacing units stay simple.
        ...(dropActive && {
          borderStyle: 'dashed',
          borderWidth: 2,
          borderColor: 'primary.main',
        }),
      }}
    >
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 1,
          minWidth: 0,
        }}
      >
        <Box sx={{ flexShrink: 0, display: 'flex' }}>
          <ThumbIcon entry={entry} thumbCache={thumbCache} size={CARD_THUMB} />
        </Box>
        <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
          {stripTagsFromName(entry.name)}
        </Typography>
      </Box>
      {tags.length > 0 ? (
        <EntryTagChips
          entry={entry}
          tags={tags}
          activeTag={activeTag}
          tagColors={tagColors}
          groups={groups}
          max={MAX_TAGS_PER_CARD}
          t={t}
          onClickTag={onClickTag}
          onTagContextMenu={onTagContextMenu}
          containerSx={{ flexWrap: 'wrap' }}
        />
      ) : null}
    </Card>
  );
}

/**
 * P0-4 (perf audit): memo'd so the Kanban / Matrix / Gantt card stacks don't
 * re-run `useDrag` + `useDrop` (+ the nested `ThumbIcon` IntersectionObserver
 * / redux subscription and `EntryTagChips`) on every unrelated parent
 * re-render. Props are all reference-stable from the call sites:
 *   - `entry`    — a DirEntry ref reused from `data.entries` (per-card stable)
 *   - `data`     — FileList's `cellData` useMemo (re-binds only when a real
 *                  input changes; selection flips `isSelected`'s identity,
 *                  which IS a cellData dep, so a selection change still
 *                  re-renders every card with the fresh `selectedPaths`)
 *   - `renderContextMenu` — a `useCallback` in each view (see P0-4 notes)
 * So the shallow compare bails out unless one genuinely changes. `ThumbIcon`
 * keeps updating on its own when a thumbnail loads (its own useState), so
 * memoizing the card does not freeze thumbnail display — same model as the
 * react-window-memoized list `Row`.
 */
export default memo(EntryCardBase);
