import { useMemo } from 'react';
import { Box, Typography } from '@mui/material';
import { List as VirtualList, type RowComponentProps } from 'react-window';
import type { DirEntry } from '../../../shared/ipc-types';
import type { FileCellData } from '-/components/file-cell';
import type { CalendarEntryContext } from '-/components/CalendarEntryMenu';
import { CalendarEntryItem } from './CalendarEntryItem';

/** Flattened agenda row: a day header or an entry (drives virtualization). */
type AgendaRow =
  | { kind: 'header'; key: string; label: string }
  | { kind: 'entry'; key: string; entry: DirEntry };

interface AgendaRowData {
  rows: AgendaRow[];
  data: FileCellData;
  onOpenCalendarMenu: (ctx: CalendarEntryContext) => void;
  entryTimeLabel?: (entry: DirEntry) => string | null;
}

const AGENDA_HEADER_H = 34;
const AGENDA_ENTRY_H = 32;

/** One virtualized agenda row — a day header (overline) or a CalendarEntryItem. */
function AgendaRow({
  index,
  style,
  rows,
  data,
  onOpenCalendarMenu,
  entryTimeLabel,
}: RowComponentProps<AgendaRowData>) {
  const row = rows[index];
  if (!row) return <div style={style} />;
  if (row.kind === 'header') {
    return (
      <div style={{ ...style, display: 'flex', alignItems: 'center' }}>
        <Typography variant="overline" color="text.secondary">
          {row.label}
        </Typography>
      </div>
    );
  }
  return (
    <div style={style}>
      <CalendarEntryItem
        entry={row.entry}
        data={data}
        onOpenCalendarMenu={onOpenCalendarMenu}
        entryTimeLabel={entryTimeLabel}
      />
    </div>
  );
}

interface AgendaViewProps {
  buckets: Map<string, DirEntry[]>;
  locale: string;
  data: FileCellData;
  entryTimeLabel?: (entry: DirEntry) => string | null;
  onOpenCalendarMenu: (ctx: CalendarEntryContext) => void;
}

/**
 * H.24 P1-1: list-style "agenda" view — every dated entry (post range-filter)
 * grouped under its day, most-recent day first. Cursor/period navigation is
 * irrelevant here (the toolbar hides it in agenda mode). Virtualized
 * (react-window v2, variable row heights: day header vs entry) so a folder with
 * 1000+ files scrolls smoothly instead of rendering every row up front.
 */
export function AgendaView({
  buckets,
  locale,
  data,
  entryTimeLabel,
  onOpenCalendarMenu,
}: AgendaViewProps) {
  const { t } = data;
  // Flatten day-buckets into a single row list (header + entries), newest day
  // first. Virtualization needs a flat array; the header rows preserve grouping.
  const rows = useMemo<AgendaRow[]>(() => {
    const dateFmt = new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    const out: AgendaRow[] = [];
    for (const key of [...buckets.keys()].sort().reverse()) {
      const list = buckets.get(key) ?? [];
      if (list.length === 0) continue;
      // Bucket keys are local YYYY-MM-DD; rebuild a local Date (NOT new
      // Date(key), which would parse as UTC midnight and shift the day).
      const [y, m, d] = key.split('-').map(Number);
      out.push({ kind: 'header', key, label: dateFmt.format(new Date(y, m - 1, d)) });
      for (const entry of list) {
        out.push({ kind: 'entry', key: entry.path, entry });
      }
    }
    return out;
  }, [buckets, locale]);

  if (rows.length === 0) {
    return (
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Typography variant="body2" color="text.secondary">
          {t('calendarAgendaEmpty')}
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ flex: 1, minHeight: 0 }}>
      <VirtualList
        rowCount={rows.length}
        rowHeight={(i, p) =>
          p.rows[i]?.kind === 'header' ? AGENDA_HEADER_H : AGENDA_ENTRY_H
        }
        rowComponent={AgendaRow}
        rowProps={{ rows, data, onOpenCalendarMenu, entryTimeLabel }}
        style={{ height: '100%' }}
      />
    </Box>
  );
}
