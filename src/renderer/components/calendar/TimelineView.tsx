import { useMemo } from 'react';
import { Box, Typography } from '@mui/material';
import type { DirEntry } from '../../../shared/ipc-types';
import type { FileCellData } from '-/components/file-cell';
import type { CalendarEntryContext } from '-/components/CalendarEntryMenu';
import { isToday, weekDays } from '../../domain/calendar';
import { EMPTY_ENTRIES, HOURS } from './constants';
import { CalendarEntryItem } from './CalendarEntryItem';

interface TimelineViewProps {
  cursor: Date;
  weekStartsOn: 0 | 1;
  labels: string[];
  hourBuckets: Map<string, DirEntry[][]>;
  data: FileCellData;
  entryTimeLabel?: (entry: DirEntry) => string | null;
  onOpenCalendarMenu: (ctx: CalendarEntryContext) => void;
}

/**
 * H.24 P2-1: week timeline — a 24-hour × 7-day grid. Each row is an hour,
 * each column a weekday; entries land in the cell matching their modified
 * hour + day. Good for "what did I work on this week, and roughly when".
 * Cells cap at 2 visible entries + a `+N` overflow (full list via agenda).
 */
export function TimelineView({
  cursor,
  weekStartsOn,
  labels,
  hourBuckets,
  data,
  onOpenCalendarMenu,
}: TimelineViewProps) {
  const { t } = data;
  const days = useMemo(() => weekDays(cursor, weekStartsOn), [cursor, weekStartsOn]);
  // 2026-07-04: when the range filter excludes every day in this week
  // (e.g. cursor is on a past week and range='today'), the grid would
  // otherwise render 168 empty cells — show a centered empty banner
  // instead so the user knows it's a filter result, not a glitch.
  const hasAnyEntry = useMemo(() => {
    for (const hours_ of hourBuckets.values()) {
      for (const list of hours_) {
        if (list.length > 0) return true;
      }
    }
    return false;
  }, [hourBuckets]);

  if (!hasAnyEntry) {
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
    <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', p: 0.5 }}>
      {/* header row: empty corner + 7 weekday labels */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: '44px repeat(7, minmax(0, 1fr))',
          gap: 0.5,
          position: 'sticky',
          top: 0,
          bgcolor: 'background.paper',
          zIndex: 1,
          pb: 0.5,
        }}
      >
        <Box />
        {labels.map((l) => (
          <Typography
            key={l}
            variant="caption"
            color="text.secondary"
            sx={{ textAlign: 'center', fontWeight: 500 }}
          >
            {l}
          </Typography>
        ))}
      </Box>
      {HOURS.map((hour) => (
        <Box
          key={hour}
          sx={{
            display: 'grid',
            gridTemplateColumns: '44px repeat(7, minmax(0, 1fr))',
            gap: 0.5,
            minHeight: 28,
            mb: 0.25,
          }}
        >
          <Typography variant="caption" color="text.disabled" sx={{ pr: 0.5, textAlign: 'right', lineHeight: '24px' }}>
            {`${String(hour).padStart(2, '0')}:00`}
          </Typography>
          {days.map((day) => {
            const list = hourBuckets.get(day.key)?.[hour] ?? EMPTY_ENTRIES;
            // Avoid an allocation for the common case of a 0-2 entry cell.
            const visible = list.length > 2 ? list.slice(0, 2) : list;
            const extra = list.length - visible.length;
            const todayCell = isToday(day.date);
            return (
              <Box
                key={day.key}
                sx={{
                  borderRadius: 0.5,
                  border: 1,
                  borderColor: todayCell ? 'primary.main' : 'divider',
                  bgcolor: todayCell ? 'action.selected' : 'background.paper',
                  px: 0.5,
                  minHeight: 24,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  overflow: 'hidden',
                }}
              >
                {visible.map((entry) => (
                  <CalendarEntryItem
                    key={entry.path}
                    entry={entry}
                    data={data}
                    onOpenCalendarMenu={onOpenCalendarMenu}
                  />
                ))}
                {extra > 0 ? (
                  <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.65rem' }}>
                    +{extra}
                  </Typography>
                ) : null}
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
