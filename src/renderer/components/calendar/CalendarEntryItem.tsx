import { useMemo } from 'react';
import { Box, Typography } from '@mui/material';
import { useDrag } from 'react-dnd';
import { DND_TYPE_FILE, type FileDragItem } from '-/services/dnd';
import type { DirEntry } from '../../../shared/ipc-types';
import { lookupEntryIndex, type FileCellData } from '-/components/file-cell';
import ThumbIcon from '-/components/ThumbIcon';
import type { CalendarEntryContext } from '-/components/CalendarEntryMenu';
import { ENTRY_THUMB } from './constants';

export function CalendarEntryItem({
  entry,
  data,
  onOpenCalendarMenu,
  entryTimeLabel,
}: {
  entry: DirEntry;
  data: FileCellData;
  // Optional alongside DayCellProps: the month grid may host no domain menu.
  onOpenCalendarMenu?: (ctx: CalendarEntryContext) => void;
  entryTimeLabel?: (entry: DirEntry) => string | null;
}) {
  const { entries, onOpen, onSelectRow, isSelected, thumbCache, t, selectedPaths, readOnly } =
    data;
  const selected = isSelected(entry);
  // H.24 P1-6: HH:MM only renders in modified grouping (undefined otherwise).
  const timeLabel = entryTimeLabel?.(entry) ?? null;

  // H.24 P1-5: drag source — drag this entry (or, if it's selected, the whole
  // selection) onto another day cell to re-date it. Mirrors Row.tsx's item shape
  // so the DayCell drop target (and FileList folder-drop) accept it identically.
  const dragItem = useMemo<FileDragItem>(() => {
    if (selectedPaths?.has(entry.path)) {
      const paths: string[] = [];
      const names: string[] = [];
      for (const e of entries) {
        if (selectedPaths.has(e.path)) {
          paths.push(e.path);
          names.push(e.name);
        }
      }
      return { paths, names };
    }
    return { paths: [entry.path], names: [entry.name] };
  }, [selectedPaths, entries, entry.path, entry.name]);

  const [{ isDragging }, dragRef] = useDrag(
    () => ({
      type: DND_TYPE_FILE,
      item: dragItem,
      collect: (monitor) => ({ isDragging: monitor.isDragging() }),
      canDrag: () => !readOnly,
    }),
    [dragItem, readOnly]
  );

  // Single-click selects (consistent with list/grid/gallery); double-click
  // opens. Click-to-open made it impossible to select or start a drag
  // without the file popping open.
  const handleClick = () => {
    // P2-8: O(1) through the host's path→index map (was a scan per click).
    const index = lookupEntryIndex(data, entry.path);
    if (index >= 0) {
      onSelectRow(index, { shift: false, toggle: false });
    }
  };
  const handleDoubleClick = () => {
    onOpen(entry);
  };

  // H.24 P0-1: the entry's right-click opens the calendar domain menu (not the
  // generic EntryContextMenu). The generic file menu is still reachable via the
  // domain menu's "more" item, which the parent wires to `data.onContextEntry`.
  const handleContext = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onOpenCalendarMenu?.({ x: e.clientX, y: e.clientY, entry });
  };

  return (
    <Box
      ref={dragRef}
      aria-label={t('calendarEntryAria', { name: entry.name })}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContext}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        px: 0.5,
        py: 0.25,
        borderRadius: 0.5,
        cursor: readOnly ? 'default' : 'grab',
        userSelect: 'none',
        opacity: isDragging ? 0.4 : 1,
        '&:hover': { bgcolor: 'action.hover' },
        // A month cell keeps its own scroll box and can hold hundreds of
        // entries. `content-visibility: auto` lets Chromium skip layout/paint
        // for rows scrolled out of view; the intrinsic size keeps the
        // scrollbar from jumping. (Agenda rows are already windowed — this
        // covers only the day-cell list, with no visible change.)
        contentVisibility: 'auto',
        // Row height = ENTRY_THUMB (24) + py 0.25 on both sides (4). The old
        // 40px guess made content-visibility reserve too much space, so the
        // month scroll position jumped when rows entered the viewport.
        containIntrinsicSize: '0 28px',
        ...(selected && {
          bgcolor: 'action.selected',
          outline: 1,
          outlineColor: 'primary.main',
        }),
      }}
    >
      <ThumbIcon entry={entry} thumbCache={thumbCache} size={ENTRY_THUMB} />
      <Typography
        variant="caption"
        noWrap
        sx={{ flex: 1, minWidth: 0 }}
        title={entry.name}
      >
        {entry.name}
      </Typography>
      {timeLabel ? (
        <Typography
          variant="caption"
          sx={{ flexShrink: 0, color: 'text.secondary', fontSize: '0.7rem' }}
        >
          {timeLabel}
        </Typography>
      ) : null}
    </Box>
  );
}
