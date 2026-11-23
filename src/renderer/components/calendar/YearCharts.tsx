import { Fragment, useCallback, useMemo } from 'react';
import type { TFunction } from 'i18next';
import { alpha, lighten, useTheme } from '@mui/material/styles';
import { Box, Typography } from '@mui/material';
import ReactECharts from 'echarts-for-react';
import type { DirEntry } from '../../../shared/ipc-types';
import { addDays, heatIntensity, yearHeatmapGrid, ymd } from '../../domain/calendar';
import { escapeHtml } from '-/services/escape-html';
import { echarts } from '../../services/echarts-setup';

/**
 * H.24 P2-2: GitHub-style year heatmap — 53 week-columns × 7 weekday-rows,
 * each cell colored by file count (sqrt-compressed intensity via heatIntensity).
 * Click a cell → jump to that day in month view. Out-of-year padding days are
 * dimmed; today gets a primary outline.
 *
 * Visual fixes (2026-07-02):
 * - Month labels are aligned to the column of the month's first day.
 * - Weekday labels are shown on the left (Mon/Wed/Fri).
 * - Empty cells use `divider` for consistent contrast across themes.
 * - Non-empty cells use a stronger alpha range so they remain visible in all
 *   presets.
 */
export function YearHeatmap({
  cursor,
  weekStartsOn,
  buckets,
  locale,
  onSelectDate,
  t,
}: {
  cursor: Date;
  weekStartsOn: 0 | 1;
  buckets: Map<string, DirEntry[]>;
  locale: string;
  onSelectDate: (date: Date) => void;
  t: TFunction;
}) {
  const theme = useTheme();
  const year = cursor.getFullYear();
  const grid = useMemo(
    () => yearHeatmapGrid(year, weekStartsOn),
    [year, weekStartsOn]
  );
  const maxCount = useMemo(() => {
    let m = 0;
    for (const d of grid) {
      const c = (buckets.get(d.key) ?? []).length;
      if (c > m) m = c;
    }
    return m;
  }, [grid, buckets]);

  // Month labels positioned at the week-column of each month's first day.
  const monthPositions = useMemo(() => {
    const yearStart = grid[0]?.date ?? new Date(year, 0, 1);
    return Array.from({ length: 12 }, (_, month) => {
      const firstDay = new Date(year, month, 1);
      const dayIndex = Math.floor(
        (firstDay.getTime() - yearStart.getTime()) / 86400000
      );
      const week = Math.floor(dayIndex / 7);
      return {
        label: new Intl.DateTimeFormat(locale, { month: 'short' }).format(
          firstDay
        ),
        week: Math.max(0, Math.min(52, week)),
      };
    });
  }, [grid, year, locale]);

  // Weekday labels for the left axis. Show Mon/Wed/Fri to match GitHub spacing.
  const weekdayLabels = useMemo(() => {
    // 2024-01-07 is a Sunday; shift by the displayed DOW to get a representative date.
    const base = new Date(2024, 0, 7);
    return Array.from({ length: 7 }, (_, i) => {
      const dow = (weekStartsOn + i) % 7;
      const d = addDays(base, dow);
      return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(d);
    });
  }, [locale, weekStartsOn]);

  const primary = theme.palette.primary.main;
  const emptyBg = theme.palette.divider;
  const todayKey = ymd(new Date());
  const isDark = theme.palette.mode === 'dark';

  // Legend sample counts: 0, 1, 25%, 50%, 75%, 100% of max (but at least 1).
  const legendCounts = useMemo(() => {
    const steps = [0, 1, Math.max(1, Math.round(maxCount * 0.25)), Math.max(1, Math.round(maxCount * 0.5)), Math.max(1, Math.round(maxCount * 0.75)), maxCount];
    // Deduplicate while preserving order.
    return steps.filter((v, i, a) => a.indexOf(v) === i);
  }, [maxCount]);

  const cellBg = useCallback(
    (count: number, intensity: number) => {
      if (count === 0) return emptyBg;
      // Dark mode: low-intensity cells are lightened so they pop against the
      // dark background. Light mode: low-intensity cells are desaturated pastels
      // so they remain visible against the light background.
      const lowColor = isDark ? lighten(primary, 0.5) : alpha(primary, 0.18);
      return `color-mix(in oklab, ${primary} ${Math.round(intensity * 100)}%, ${lowColor})`;
    },
    [emptyBg, primary, isDark]
  );

  return (
    // Shared CSS Grid for Y-axis + heatmap cells so each row's height is
    // determined by the cell (aspectRatio: 1/1) — Y-axis labels center
    // vertically via `alignItems: 'center'` and stay locked to the cells at
    // any viewport width. Previously Y-axis used a separate flex column with
    // fixed 11px label height, which drifted away from the cells once columns
    // got narrower than ~11px.
    <Box sx={{ width: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Month label row — same column template as the heatmap below
          (36px Y-axis stub + 53-col grid) so labels sit exactly above the
          column of each month's first day. columnGap matches the main grid
          below so each label aligns to the column its first day lands in. */}
      <Box sx={{ display: 'grid', gridTemplateColumns: '36px 1fr', columnGap: 2, mb: 0.5 }}>
        <Box />
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(53, 1fr)', columnGap: 2, height: 14 }}>
          {monthPositions.map((m, i) => (
            <Typography
              key={i}
              variant="caption"
              color="text.secondary"
              sx={{
                gridColumn: `${m.week + 1}`,
                fontSize: 9,
                lineHeight: '14px',
                whiteSpace: 'nowrap',
              }}
            >
              {m.label}
            </Typography>
          ))}
        </Box>
      </Box>

      {/* Main heatmap grid: 2 columns (Y-axis | cells) × 7 rows. Each row
          pairs one weekday label with one row of 53 square cells. Fragment
          lets us place two children per row without an extra wrapper.
          Tight columnGap (2 ≈ 8px) makes the cells wider; with aspectRatio
          1/1 they grow in both dimensions, which lifts the whole heatmap's
          vertical footprint. */}
      <Box sx={{ display: 'grid', gridTemplateColumns: '36px 1fr', columnGap: 2, rowGap: 1 }}>
        {[0, 1, 2, 3, 4, 5, 6].map((dow) => {
          const showLabel = dow === 1 || dow === 3 || dow === 5;
          return (
            <Fragment key={dow}>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  pr: 0.5,
                  minHeight: 0,
                }}
              >
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ fontSize: 9, lineHeight: '11px' }}
                >
                  {showLabel ? weekdayLabels[dow] : ''}
                </Typography>
              </Box>
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(53, 1fr)', columnGap: 2 }}>
                {Array.from({ length: 53 }, (_, week) => {
                  const day = grid[week * 7 + dow];
                  if (!day) {
                    return <Box key={week} sx={{ width: '100%', aspectRatio: '1 / 1' }} />;
                  }
                  const count = (buckets.get(day.key) ?? []).length;
                  const intensity = heatIntensity(count, maxCount);
                  const isTodayCell = day.key === todayKey;
                  return (
                    <Box
                      key={week}
                      role="button"
                      tabIndex={0}
                      aria-label={`${day.key}: ${count}`}
                      title={`${day.key} · ${count}`}
                      onClick={() => onSelectDate(day.date)}
                      onKeyDown={(e) => {
                        // role="button" cells don't fire click on Enter/Space —
                        // without this the 371 heatmap cells are focusable but
                        // never activatable by keyboard.
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onSelectDate(day.date);
                        }
                      }}
                      sx={{
                        width: '100%',
                        aspectRatio: '1 / 1',
                        borderRadius: 1,
                        cursor: 'pointer',
                        bgcolor: cellBg(count, intensity),
                        opacity: day.inCurrentMonth ? 1 : 0.35,
                        outline: isTodayCell ? `1px solid ${primary}` : 'none',
                        '&:hover': {
                          outline: `1px solid ${theme.palette.text.secondary}`,
                        },
                        '&:focus-visible': {
                          outline: `2px solid ${primary}`,
                        },
                      }}
                    />
                  );
                })}
              </Box>
            </Fragment>
          );
        })}
      </Box>

      {/* Legend: Less → More. Same 36px Y-axis stub for column alignment. */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: '36px 1fr',
          columnGap: 8,
          mt: 1.5,
        }}
      >
        <Box />
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 1,
            height: 16,
          }}
        >
          <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
            {t('calendarHeatmapLess')}
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'row', gap: 0.5 }}>
            {legendCounts.map((count, idx) => {
              const intensity = heatIntensity(count, maxCount);
              return (
                <Box
                  key={idx}
                  sx={{
                    width: 11,
                    height: 11,
                    borderRadius: 1,
                    bgcolor: cellBg(count, intensity),
                  }}
                  title={String(count)}
                />
              );
            })}
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
            {t('calendarHeatmapMore')}
          </Typography>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * H.24 P2-2 continuation: monthly trend bar chart shown below the year heatmap.
 * Aggregates the same date buckets by month and renders a compact bar chart so
 * users can see the distribution trend across the year at a glance.
 */
export function YearTrendChart({
  year,
  buckets,
  locale,
  t,
}: {
  year: number;
  buckets: Map<string, DirEntry[]>;
  locale: string;
  t: TFunction;
}) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';

  const { months, counts } = useMemo(() => {
    const monthsArr: string[] = [];
    const countsArr: number[] = [];
    for (let month = 0; month < 12; month += 1) {
      const label = new Intl.DateTimeFormat(locale, { month: 'short' }).format(
        new Date(year, month, 1)
      );
      monthsArr.push(label);
      let count = 0;
      // Sum counts for all days in this month.
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      for (let day = 1; day <= daysInMonth; day += 1) {
        const key = ymd(new Date(year, month, day));
        count += (buckets.get(key) ?? []).length;
      }
      countsArr.push(count);
    }
    return { months: monthsArr, counts: countsArr };
  }, [year, buckets, locale]);

  const option = useMemo(
    () => ({
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (
          params: { name?: string; value?: number } | Array<{ name?: string; value?: number }>
        ) => {
          const p = Array.isArray(params) ? params[0] : params;
          return `${escapeHtml(p.name)}<br/>${t('files')}: ${p.value}`;
        },
      },
      grid: { top: 12, right: 4, bottom: 20, left: 24 },
      xAxis: {
        type: 'category',
        data: months,
        axisLine: { lineStyle: { color: theme.palette.divider } },
        axisTick: { show: false },
        axisLabel: { color: theme.palette.text.secondary, fontSize: 10 },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        splitLine: { lineStyle: { color: theme.palette.divider, type: 'dashed' } },
        axisLabel: { color: theme.palette.text.secondary, fontSize: 10 },
      },
      series: [
        {
          type: 'bar',
          data: counts,
          // 2026-07-04: narrower bars so month labels don't crowd into the
          // bar tops on a 12-month chart at common widths.
          barWidth: '30%',
          itemStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: theme.palette.primary.main },
              {
                offset: 1,
                color: isDark
                  ? theme.palette.primary.dark
                  : (theme.palette.primary.light as string),
              },
            ]),
            borderRadius: [4, 4, 0, 0],
          },
          emphasis: {
            itemStyle: { color: theme.palette.primary.dark },
          },
        },
      ],
      animationDuration: 300,
    }),
    [months, counts, theme, isDark, t]
  );

  return (
    // 2026-07-04: taller than the original 160 so the 12 monthly bars have
    // breathing room and the y-axis ticks aren't crowded against the bars.
    <Box sx={{ width: '100%', height: 220, mt: 1 }}>
      <ReactECharts
        echarts={echarts}
        option={option}
        style={{ width: '100%', height: '100%' }}
        opts={{ renderer: 'svg' }}
      />
    </Box>
  );
}
