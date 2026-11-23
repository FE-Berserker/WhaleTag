import { useMemo } from 'react';
import { Box, Typography } from '@mui/material';
import type { DirEntry } from '../../../shared/ipc-types';
import { calendarDays, formatMonthYear, isToday, yearMonths } from '../../domain/calendar';
import type { SubViewProps } from './types';
import { YearHeatmap, YearTrendChart } from './YearCharts';

interface YearViewProps extends SubViewProps {
  locale: string;
  onSelectMonth: (month: Date) => void;
  yearVariant: 'tiles' | 'heatmap';
  onSelectDate: (date: Date) => void;
}

export function YearView({
  cursor,
  weekStartsOn,
  buckets,
  locale,
  data,
  onSelectMonth,
  yearVariant,
  onSelectDate,
}: YearViewProps) {
  // Hooks must run unconditionally, before the heatmap early return below:
  // calling them after it violates the Rules of Hooks and crashes with
  // "Rendered more hooks than during the previous render" as soon as the user
  // toggles the year variant. Both memos only depend on props, so hoisting is
  // behavior-preserving.
  const months = useMemo(
    () => yearMonths(cursor.getFullYear()),
    [cursor]
  );
  // H.24 P0-3: weekday single-character labels follow the active locale.
  // `Intl.DateTimeFormat({ weekday: 'narrow' })` returns "M/T/W/..." for en
  // and "一/二/三/..." for zh -- crucially NOT "周周周周..." which is what
  // `Intl({ weekday: 'short' }).charAt(0)` produced in zh.
  const dayLabels = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) =>
        new Intl.DateTimeFormat(locale, { weekday: 'narrow' }).format(
          new Date(2024, 0, 1 + i)
        )
      ),
    [locale]
  );

  if (yearVariant === 'heatmap') {
    return (
      // 2026-07-04: stack at the top (`flex-start`) and trim the top padding
      // so the heatmap hugs the toolbar above instead of floating in the
      // middle when the body is taller than the content.
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          width: '100%',
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-start',
          alignItems: 'center',
          pt: 0.5,
          px: 1.5,
          pb: 1.5,
        }}
      >
        <YearHeatmap
          cursor={cursor}
          weekStartsOn={weekStartsOn}
          buckets={buckets}
          locale={locale}
          onSelectDate={onSelectDate}
          t={data.t}
        />
        <YearTrendChart
          year={cursor.getFullYear()}
          buckets={buckets}
          locale={locale}
          t={data.t}
        />
      </Box>
    );
  }

  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: 1.5,
        alignContent: 'start',
      }}
    >
      {months.map((month) => (
        <YearMonthTile
          key={month.getMonth()}
          month={month}
          weekStartsOn={weekStartsOn}
          dayLabels={dayLabels}
          buckets={buckets}
          locale={locale}
          onClick={() => onSelectMonth(month)}
        />
      ))}
    </Box>
  );
}

function YearMonthTile({
  month,
  weekStartsOn,
  dayLabels,
  buckets,
  locale,
  onClick,
}: {
  month: Date;
  weekStartsOn: 0 | 1;
  dayLabels: string[];
  buckets: Map<string, DirEntry[]>;
  locale: string;
  onClick: () => void;
}) {
  const days = useMemo(
    () => calendarDays(month.getFullYear(), month.getMonth(), weekStartsOn),
    [month, weekStartsOn]
  );

  return (
    <Box
      onClick={onClick}
      sx={{
        p: 1,
        borderRadius: 1,
        border: 1,
        borderColor: 'divider',
        cursor: 'pointer',
        bgcolor: 'background.paper',
        '&:hover': { bgcolor: 'action.hover' },
      }}
    >
      <Typography variant="subtitle2" sx={{ mb: 0.5, fontWeight: 500 }}>
        {/* H.24 P0-3: was hardcoded 'en'; now uses the active locale so zh users
            see "一月" / "二月" instead of "January" / "February". */}
        {formatMonthYear(month, locale)}
      </Typography>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gap: 0.25,
        }}
      >
        {dayLabels.map((l, i) => (
          <Typography
            key={i}
            variant="caption"
            color="text.secondary"
            sx={{ textAlign: 'center', fontSize: 10 }}
          >
            {l}
          </Typography>
        ))}
        {days.map((day) => {
          const count = (buckets.get(day.key) ?? []).length;
          return (
            <Box
              key={day.key}
              sx={{
                aspectRatio: '1',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                position: 'relative',
                borderRadius: 0.5,
                opacity: day.inCurrentMonth ? 1 : 0.35,
                bgcolor: isToday(day.date) ? 'primary.main' : 'transparent',
                color: isToday(day.date) ? 'primary.contrastText' : 'text.primary',
              }}
            >
              <Typography variant="caption" sx={{ fontSize: 10 }}>
                {day.date.getDate()}
              </Typography>
              {count > 0 ? (
                <Box
                  sx={{
                    position: 'absolute',
                    bottom: 2,
                    width: 4,
                    height: 4,
                    borderRadius: '50%',
                    bgcolor: isToday(day.date)
                      ? 'primary.contrastText'
                      : 'primary.main',
                  }}
                />
              ) : null}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
