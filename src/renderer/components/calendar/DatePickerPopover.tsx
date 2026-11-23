import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, IconButton, Popover, Stack, Typography } from '@mui/material';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import {
  addMonthsClamped,
  calendarDays,
  formatMonthYear,
  isToday,
  startOfDay,
  weekdayLabels,
  ymd,
} from '../../domain/calendar';

interface DatePickerPopoverProps {
  anchorEl: HTMLElement;
  cursor: Date;
  locale: string;
  weekStartsOn: 0 | 1;
  onSelect: (date: Date) => void;
  onClose: () => void;
}

/**
 * H.24 P1-3: mini month calendar in a Popover, opened from the toolbar title.
 * Click a day → onSelect. The displayed month starts at `cursor` and pages with
 * the header chevrons; today + the cursor day are highlighted. Reuses the same
 * `calendarDays` / `weekdayLabels` as the main grid (no @mui/x-date-pickers).
 */
export function DatePickerPopover({
  anchorEl,
  cursor,
  locale,
  weekStartsOn,
  onSelect,
  onClose,
}: DatePickerPopoverProps) {
  const { t } = useTranslation();
  const [view, setView] = useState(() => startOfDay(cursor));
  const days = useMemo(
    () => calendarDays(view.getFullYear(), view.getMonth(), weekStartsOn),
    [view, weekStartsOn]
  );
  const labels = useMemo(
    () => weekdayLabels(weekStartsOn, locale),
    [weekStartsOn, locale]
  );
  const selectedKey = ymd(cursor);
  // Chunk the flat day list into week-rows (role="row") for a11y parity with
  // the main month grid.
  const weeks = useMemo(() => {
    const rows: typeof days[] = [];
    for (let i = 0; i < days.length; i += 7) rows.push(days.slice(i, i + 7));
    return rows;
  }, [days]);

  return (
    <Popover
      open
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      slotProps={{ paper: { sx: { width: 296, p: 1.5 } } }}
    >
      <Stack
        direction="row"
        sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}
      >
        <IconButton
          size="small"
          onClick={() => setView((v) => startOfDay(addMonthsClamped(v, -1)))}
          aria-label={t('calendarPrevMonth')}
        >
          <ChevronLeftIcon />
        </IconButton>
        <Typography variant="subtitle2" sx={{ fontWeight: 500 }}>
          {formatMonthYear(view, locale)}
        </Typography>
        <IconButton
          size="small"
          onClick={() => setView((v) => startOfDay(addMonthsClamped(v, 1)))}
          aria-label={t('calendarNextMonth')}
        >
          <ChevronRightIcon />
        </IconButton>
      </Stack>
      <Box
        role="grid"
        aria-rowcount={weeks.length}
        aria-colcount={7}
        sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}
      >
        <Box
          role="row"
          sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}
        >
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
        {weeks.map((week, rowIdx) => (
          <Box
            key={rowIdx}
            role="row"
            aria-rowindex={rowIdx + 2}
            sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 0.25 }}
          >
            {week.map((day) => {
              const isSel = day.key === selectedKey;
              const today = isToday(day.date);
              return (
                <IconButton
                  key={day.key}
                  size="small"
                  onClick={() => {
                    onSelect(day.date);
                    onClose();
                  }}
                  aria-label={t('calendarJumpToDate')}
                  aria-current={today ? 'date' : undefined}
                  sx={{
                    borderRadius: 1,
                    opacity: day.inCurrentMonth ? 1 : 0.35,
                    bgcolor: isSel ? 'primary.main' : 'transparent',
                    color: isSel ? 'primary.contrastText' : 'text.primary',
                    '&:hover': {
                      bgcolor: isSel ? 'primary.dark' : 'action.hover',
                    },
                  }}
                >
                  <Typography variant="caption" sx={{ fontSize: '0.75rem' }}>
                    {day.date.getDate()}
                  </Typography>
                </IconButton>
              );
            })}
          </Box>
        ))}
      </Box>
    </Popover>
  );
}
