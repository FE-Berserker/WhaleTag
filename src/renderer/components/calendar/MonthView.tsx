import { useMemo } from 'react';
import { Box, Typography } from '@mui/material';
import { calendarDays } from '../../domain/calendar';
import type { SubViewProps } from './types';
import { EMPTY_ENTRIES } from './constants';
import { DayCell } from './DayCell';

interface MonthViewProps extends SubViewProps {
  labels: string[];
}

export function MonthView({
  cursor,
  weekStartsOn,
  labels,
  buckets,
  data,
  onOpenCalendarMenu,
  entryTimeLabel,
  showLunar,
}: MonthViewProps) {
  const days = useMemo(
    () => calendarDays(cursor.getFullYear(), cursor.getMonth(), weekStartsOn),
    [cursor, weekStartsOn]
  );
  // H.24 a11y: chunk the flat day list into week-rows so the grid exposes a
  // spec-correct role="grid" > role="row" > role="gridcell" hierarchy (orphan
  // gridcells with no grid/row ancestor confuse screen readers).
  const weeks = useMemo(() => {
    const rows: typeof days[] = [];
    for (let i = 0; i < days.length; i += 7) rows.push(days.slice(i, i + 7));
    return rows;
  }, [days]);

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
        {labels.map((label) => (
          <Typography
            key={label}
            variant="caption"
            color="text.secondary"
            sx={{ textAlign: 'center', fontWeight: 500 }}
          >
            {label}
          </Typography>
        ))}
      </Box>
      <Box
        role="grid"
        aria-rowcount={weeks.length}
        aria-colcount={7}
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 0.5,
        }}
      >
        {weeks.map((week, rowIdx) => (
          <Box
            key={rowIdx}
            role="row"
            aria-rowindex={rowIdx + 1}
            sx={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 0.5,
            }}
          >
            <Box
              sx={{
                flex: 1,
                minHeight: 0,
                display: 'grid',
                gridTemplateColumns: 'repeat(7, 1fr)',
                gap: 0.5,
              }}
            >
              {week.map((day) => (
                <DayCell
                  key={day.key}
                  day={day}
                  entries={buckets.get(day.key) ?? EMPTY_ENTRIES}
                  data={data}
                  showEmptyHint
                  onOpenCalendarMenu={onOpenCalendarMenu}
                  entryTimeLabel={entryTimeLabel}
                  showLunar={showLunar}
                />
              ))}
            </Box>
          </Box>
        ))}
      </Box>
    </>
  );
}
