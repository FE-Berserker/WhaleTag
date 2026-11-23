import { useMemo } from 'react';
import { Box, Typography } from '@mui/material';
import { isToday, weekDays } from '../../domain/calendar';
import type { SubViewProps } from './types';
import { EMPTY_ENTRIES } from './constants';
import { DayCell } from './DayCell';

interface WeekViewProps extends SubViewProps {
  labels: string[];
}

export function WeekView({
  cursor,
  weekStartsOn,
  labels,
  buckets,
  data,
  onOpenCalendarMenu,
  entryTimeLabel,
  showLunar,
}: WeekViewProps) {
  const days = useMemo(
    () => weekDays(cursor, weekStartsOn),
    [cursor, weekStartsOn]
  );

  return (
    <>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gap: 0.5,
          flexShrink: 0,
        }}
      >
        {days.map((day, i) => (
          <Box key={day.key} sx={{ textAlign: 'center' }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 500 }}>
              {labels[i]}
            </Typography>
            <Typography
              variant="body2"
              color={isToday(day.date) ? 'primary.main' : 'text.primary'}
              sx={{ fontWeight: isToday(day.date) ? 600 : 400 }}
            >
              {day.date.getDate()}
            </Typography>
          </Box>
        ))}
      </Box>
      <Box
        role="grid"
        aria-rowcount={1}
        aria-colcount={7}
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 0.5,
        }}
      >
        <Box
          role="row"
          aria-rowindex={1}
          sx={{
            flex: 1,
            minHeight: 0,
            display: 'grid',
            gridTemplateColumns: 'repeat(7, 1fr)',
            gap: 0.5,
          }}
        >
          {days.map((day) => (
            <DayCell
              key={day.key}
              day={day}
              entries={buckets.get(day.key) ?? EMPTY_ENTRIES}
              data={data}
              showEmptyHint={false}
              onOpenCalendarMenu={onOpenCalendarMenu}
              entryTimeLabel={entryTimeLabel}
              showLunar={showLunar}
            />
          ))}
        </Box>
      </Box>
    </>
  );
}
