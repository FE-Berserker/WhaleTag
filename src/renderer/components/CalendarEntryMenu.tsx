import { Menu, MenuItem, ListItemIcon, ListItemText } from '@mui/material';
import EventAvailableIcon from '@mui/icons-material/EventAvailable';
import EventBusyIcon from '@mui/icons-material/EventBusy';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import type { DirEntry } from '../../shared/ipc-types';
import type { TFunction } from 'i18next';

export interface CalendarEntryContext {
  x: number;
  y: number;
  entry: DirEntry;
}

/**
 * H.24 P0-1: domain-aware right-click menu for Calendar entries. Mirrors the
 * pattern of MapiqueView's inline `<Menu>` (no EntryContextMenu coupling —
 * calendar semantics are about dates, not files). Core actions:
 *
 * 1. Set as today — overwrite the entry's date tag with today's `dateKey`.
 * 2. Clear date tag — strip every date-typed tag from the entry.
 * 3. Copy path — clipboard.
 * 4. More file actions — delegates to `EntryContextMenu` for the generic
 *    open / rename / move / delete / copy operations.
 *
 * Location-level shortcuts (set default / set reminder / toggle read-only)
 * were removed (P?): they belong to the Sidebar's per-location context menu,
 * not to per-entry right-click menus.
 */
export interface CalendarEntryMenuProps {
  ctx: CalendarEntryContext | null;
  /**
   * Close request from MUI (backdrop click / Escape / Tab away). The parent
   * owns `ctx` and must null it here — MUI's Menu is uncontrolled-by-prop, so
   * without this the menu can never be dismissed except by picking an item.
   */
  onClose: () => void;
  /** Day key to write when "Set as date" is clicked (e.g. `today-20260628`). */
  dateKey: string;
  /** Whether the entry already carries a date tag (drives "Clear date" enabled state). */
  hasDateTag: boolean;
  onSetDate: (entry: DirEntry, dateKey: string) => void;
  onRemoveDate: (entry: DirEntry) => void;
  onCopy: (entry: DirEntry) => void;
  onMoreFileActions: (entry: DirEntry, x: number, y: number) => void;
  readOnly: boolean;
  t: TFunction;
}

export default function CalendarEntryMenu({
  ctx,
  onClose,
  dateKey,
  hasDateTag,
  onSetDate,
  onRemoveDate,
  onCopy,
  onMoreFileActions,
  readOnly,
  t,
}: CalendarEntryMenuProps) {
  return (
    <Menu
      open={ctx !== null}
      onClose={onClose}
      anchorReference="anchorPosition"
      anchorPosition={ctx ? { top: ctx.y, left: ctx.x } : undefined}
      slotProps={{
        paper: { onContextMenu: (e: React.MouseEvent) => e.preventDefault() },
      }}
    >
      <MenuItem
        onClick={() => ctx && onSetDate(ctx.entry, dateKey)}
        disabled={readOnly || !dateKey}
        data-testid="calendar-entry-set-date"
      >
        <ListItemIcon>
          <EventAvailableIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>{t('calendarSetDate')}</ListItemText>
      </MenuItem>
      <MenuItem
        onClick={() => ctx && onRemoveDate(ctx.entry)}
        disabled={readOnly || !hasDateTag}
        data-testid="calendar-entry-clear-date"
      >
        <ListItemIcon>
          <EventBusyIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>{t('calendarClearDate')}</ListItemText>
      </MenuItem>
      <MenuItem
        onClick={() => ctx && onCopy(ctx.entry)}
        data-testid="calendar-entry-copy"
      >
        <ListItemIcon>
          <ContentCopyIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>{t('copy')}</ListItemText>
      </MenuItem>
      <MenuItem
        onClick={() => ctx && onMoreFileActions(ctx.entry, ctx.x, ctx.y)}
        data-testid="calendar-entry-more"
      >
        <ListItemIcon>
          <MoreHorizIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>{t('moreActions')}</ListItemText>
      </MenuItem>
      {/* Location-level shortcuts (set default / set reminder / toggle
          read-only) were removed here for the same reason as
          EntryContextMenu — they belong to the Sidebar's per-location
          context menu, not to the per-date entry menu. */}
    </Menu>
  );
}