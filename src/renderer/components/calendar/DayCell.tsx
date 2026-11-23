import { memo, useMemo, useState } from 'react';
import {
  Box,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Typography,
} from '@mui/material';
import CreateNewFolderIcon from '@mui/icons-material/CreateNewFolder';
import NoteAddIcon from '@mui/icons-material/NoteAdd';
import { useDrop } from 'react-dnd';
import { NativeTypes } from 'react-dnd-html5-backend';
import { DND_TYPE_FILE, type FileDragItem } from '-/services/dnd';
import type { DirEntry } from '../../../shared/ipc-types';
import {
  lookupEntry,
  setDateTagForDroppedEntries,
  type FileCellData,
} from '-/components/file-cell';
import { useIOActionsContext } from '-/hooks/IOActionsContextProvider';
import type { CalendarEntryContext } from '-/components/CalendarEntryMenu';
import { isToday } from '../../domain/calendar';
import { resolveSmartTag } from '../../../shared/smart-tags';
import { lunarDayLabel } from '../../domain/lunar';
import { CELL_MIN_HEIGHT } from './constants';
import { CalendarEntryItem } from './CalendarEntryItem';

export interface DayCellProps {
  day: { date: Date; inCurrentMonth: boolean; key: string };
  entries: DirEntry[];
  data: FileCellData;
  showEmptyHint: boolean;
  // Optional here because the month grid (GridView) can render without a
  // domain-menu host; entry cells then simply have no calendar menu.
  onOpenCalendarMenu?: (ctx: CalendarEntryContext) => void;
  entryTimeLabel?: (entry: DirEntry) => string | null;
  showLunar?: boolean;
}

// P2-6: memoized. A month grid renders up to 42 cells and the week timeline
// 168; the parent re-renders on every cursor/selection/thumbnail tick. With
// stable inputs (`day` from the `calendarDays` memo, `entries` from the bucket
// map — or the shared `EMPTY_ENTRIES`) an unchanged cell now skips entirely.
export const DayCell = memo(function DayCell({
  day,
  entries,
  data,
  showEmptyHint,
  onOpenCalendarMenu,
  entryTimeLabel,
  showLunar,
}: DayCellProps) {
  const { t, readOnly, onCreateTagged } = data;
  const { importExternalFiles } = useIOActionsContext();
  const today = isToday(day.date);
  const [dayCtx, setDayCtx] = useState<{ x: number; y: number } | null>(null);
  // P2-6: `resolveSmartTag` walks the period table and allocates its result;
  // the day (and its date) never changes for a mounted cell, so cache it.
  const autoTag = useMemo(
    () => resolveSmartTag('today', day.date) ?? day.key.replace(/-/g, ''),
    [day.date, day.key]
  );
  // P2-6: `lunarDayLabel` does lunar-calendar math; skip it unless shown.
  // (The label is pre-gated on the zh locale by the caller; an empty string —
  // no data / out of range — renders nothing.)
  const lunarLabel = useMemo(
    () => (showLunar ? lunarDayLabel(day.date) : ''),
    [showLunar, day.date]
  );

  // H.24 P1-5: drop target — dragging a file onto this day re-dates it
  // (overwrites its date tag with this day's smart tag). Reuses the
  // date-tag callback so the sidecar write + non-date-tag filtering is
  // shared with the domain menu's "Set as date". A multi-file drop goes
  // through the P1-2 batch callback (one `saveMany`); hosts that only expose
  // the legacy single-entry callback still get a per-entry fallback. No
  // confirm dialog — matches Kanban's direct-drop behavior, and it's
  // reversible (right-click → clear).
  //
  // Also accepts native OS files (NativeTypes.FILE): imports them into the
  // current directory and stamps THIS day's smart tag on the imported
  // paths. Without this, native drops on the day cell bubble up to
  // FileList's outer `nativeDropRef`, which loses the day context and
  // stamps a today-period tag (or nothing) instead of the user's chosen
  // day. Now the day cell owns the tag decision, mirroring the Kanban /
  // Matrix / Gantt fix in `importExternalFiles`.
  const [{ isOver, canDrop }, dropRef] = useDrop<
    FileDragItem | { files: File[] },
    unknown,
    { isOver: boolean; canDrop: boolean }
  >(
    () => ({
      accept: [DND_TYPE_FILE, NativeTypes.FILE],
      canDrop: () => !readOnly,
      drop: (item) => {
        if (!autoTag) return undefined;
        if ('files' in item) {
          // Native OS drop — import + stamp this day's tag.
          importExternalFiles(item.files, { tagToApply: autoTag }).catch(
            () => undefined
          );
          return undefined;
        }
        const targets: DirEntry[] = [];
        for (const p of item.paths) {
          // P2-8: O(1) through the host map (`lookupEntry`); the inline
          // `entries.find` fallback only runs for hosts without the map.
          const ent = lookupEntry(data, p);
          if (ent) targets.push(ent);
        }
        if (targets.length === 0) return undefined;
        // P1-2 (gui-audit 2026-11): one batch callback → one `saveMany`, not
        // N single-entry `save` calls. Falls back to the per-entry callback
        // for hosts that only provide the legacy single-entry API.
        setDateTagForDroppedEntries(data, targets, autoTag);
        return undefined;
      },
      collect: (monitor) => ({
        isOver: monitor.isOver(),
        canDrop: monitor.canDrop(),
      }),
    }),
    [readOnly, autoTag, data, importExternalFiles]
  );

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDayCtx({ x: e.clientX, y: e.clientY });
  };

  const handleCreate = (kind: 'folder' | 'file') => {
    setDayCtx(null);
    onCreateTagged?.(kind, autoTag);
  };

  // H.24 P0-4: left-clicking an empty part of the day cell creates a new file
  // pre-tagged with the day's date. We only trigger when the click lands on
  // the cell itself, not on an entry rendered inside (entries handle their own
  // click via CalendarEntryItem).
  const handleCellClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (readOnly) return;
    onCreateTagged?.('file', autoTag);
  };

  return (
    <Box
      ref={dropRef}
      onClick={handleCellClick}
      onContextMenu={handleContextMenu}
      role="gridcell"
      aria-label={t('calendarCellAria', {
        date: day.key,
        count: entries.length,
      })}
      sx={{
        minHeight: CELL_MIN_HEIGHT,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 1,
        border: isOver && canDrop ? 2 : 1,
        borderColor:
          isOver && canDrop
            ? 'success.main'
            : today
              ? 'primary.main'
              : 'divider',
        bgcolor: day.inCurrentMonth ? 'background.paper' : 'action.hover',
        opacity: day.inCurrentMonth ? 1 : 0.65,
        overflow: 'hidden',
        cursor: readOnly ? 'default' : 'pointer',
      }}
    >
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', p: 0.5, gap: 0.5, alignItems: 'center' }}>
        {lunarLabel ? (
          <Typography
            variant="caption"
            sx={{
              mr: 'auto',
              fontSize: '0.65rem',
              color: 'text.secondary',
              lineHeight: 1,
            }}
          >
            {lunarLabel}
          </Typography>
        ) : null}
        <Box
          sx={{
            width: 24,
            height: 24,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            ...(today && {
              bgcolor: 'primary.main',
              color: 'primary.contrastText',
            }),
          }}
        >
          <Typography variant="caption" sx={{ fontWeight: today ? 600 : 400 }}>
            {day.date.getDate()}
          </Typography>
        </Box>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 0.5, pb: 0.5 }}>
        {entries.length === 0 ? (
          showEmptyHint ? (
            <Typography
              variant="caption"
              color="text.disabled"
              sx={{ display: 'block', textAlign: 'center', mt: 1 }}
            >
              {t('noEntriesForDay')}
            </Typography>
          ) : null
        ) : (
          entries.map((entry) => (
            <CalendarEntryItem
              key={entry.path}
              entry={entry}
              data={data}
              onOpenCalendarMenu={onOpenCalendarMenu}
              entryTimeLabel={entryTimeLabel}
            />
          ))
        )}
      </Box>

      <Menu
        open={dayCtx !== null}
        onClose={() => setDayCtx(null)}
        anchorReference="anchorPosition"
        anchorPosition={
          dayCtx ? { top: dayCtx.y, left: dayCtx.x } : undefined
        }
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
});
