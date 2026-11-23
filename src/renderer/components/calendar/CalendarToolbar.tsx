import type { TFunction } from 'i18next';
import {
  Button,
  FormControl,
  IconButton,
  MenuItem,
  Select,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import TodayIcon from '@mui/icons-material/Today';
import SaveIcon from '@mui/icons-material/Save';
import DriveFileMoveIcon from '@mui/icons-material/DriveFileMove';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import type { CalendarRange } from '../../domain/calendar';
import type { CalendarViewMode, GroupingSource } from './types';

/** Handler bag for the calendar toolbar (extracted verbatim in task-17). */
export interface CalendarToolbarProps {
  viewMode: CalendarViewMode;
  grouping: GroupingSource;
  range: CalendarRange;
  yearVariant: 'tiles' | 'heatmap';
  title: string;
  prevLabelKey: string;
  nextLabelKey: string;
  exporting: boolean;
  exportFailed: boolean;
  onOpenDatePicker: (el: HTMLElement) => void;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onGroupingChange: (grouping: GroupingSource) => void;
  onRangeChange: (range: CalendarRange) => void;
  onViewModeChange: (viewMode: CalendarViewMode) => void;
  onYearVariantChange: (variant: 'tiles' | 'heatmap') => void;
  onSave: () => void;
  onSaveAs: () => void;
  onCopyImage: () => void;
  t: TFunction;
}

export function CalendarToolbar({
  viewMode,
  grouping,
  range,
  yearVariant,
  title,
  prevLabelKey,
  nextLabelKey,
  exporting,
  exportFailed,
  onOpenDatePicker,
  onPrev,
  onNext,
  onToday,
  onGroupingChange,
  onRangeChange,
  onViewModeChange,
  onYearVariantChange,
  onSave,
  onSaveAs,
  onCopyImage,
  t,
}: CalendarToolbarProps) {
  return (
  <Stack
    direction="row"
    data-testid="calendar-toolbar"
    sx={{
      alignItems: 'center',
      gap: 1,
      flexShrink: 0,
      flexWrap: 'wrap',
      rowGap: 1.5,
    }}
  >
    {viewMode !== 'agenda' ? (
      <Stack
        direction="row"
        sx={{ alignItems: 'center', gap: 1, flexShrink: 0 }}
      >
        <Tooltip title={t('calendarPickDate')}>
          <Button
            size="small"
            color="inherit"
            onClick={(e) => onOpenDatePicker(e.currentTarget)}
            aria-label={t('calendarPickDate')}
            data-testid="calendar-date-picker-btn"
            sx={{
              textTransform: 'none',
              // Size to content (was minWidth:200 — wasted space + crowded
              // narrow windows). The nav cluster carries flexShrink:0 so the
              // title keeps its full width regardless.
              p: 0,
              '&:hover': { textDecoration: 'underline' },
            }}
          >
            <Typography variant="h6" component="span" sx={{ fontWeight: 500 }}>
              {title}
            </Typography>
          </Button>
        </Tooltip>

        <Tooltip title={t(prevLabelKey)}>
          <IconButton
            size="small"
            onClick={onPrev}
            aria-label={t(prevLabelKey)}
            data-testid="calendar-prev"
          >
            <ChevronLeftIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title={t(nextLabelKey)}>
          <IconButton
            size="small"
            onClick={onNext}
            aria-label={t(nextLabelKey)}
            data-testid="calendar-next"
          >
            <ChevronRightIcon />
          </IconButton>
        </Tooltip>
        <Button
          size="small"
          startIcon={<TodayIcon fontSize="small" />}
          onClick={onToday}
          aria-label={t('calendarTodayAria')}
          sx={{ textTransform: 'none' }}
        >
          {t('calendarToday')}
        </Button>
      </Stack>
    ) : null}

    {/* H.24 responsive: grouping + range filter wrap together. */}
    <Stack
      direction="row"
      sx={{ alignItems: 'center', gap: 1, flexShrink: 0 }}
    >
      <ToggleButtonGroup
        size="small"
        exclusive
        value={grouping}
        onChange={(_e, value: GroupingSource | null) => {
          if (value) onGroupingChange(value);
        }}
      >
        <ToggleButton value="modified">{t('calendarGroupModified')}</ToggleButton>
        <ToggleButton value="dateTag">{t('calendarGroupDateTag')}</ToggleButton>
        <ToggleButton value="auto">{t('calendarGroupAuto')}</ToggleButton>
      </ToggleButtonGroup>

      {/* H.24 P1-4: relative time-window filter. A range is anchored to today,
          so in period views (month / week / year) selecting one also jumps
          the cursor — otherwise the grid could sit on a far-past period and
          look empty. The jump is SKIPPED in `agenda` (cursor not used to
          position content) and `week-timeline` (cursor anchors the displayed
          week — jumping to today would yank the user away from the
          historical week they're inspecting while applying the range). */}
      <FormControl size="small" sx={{ minWidth: 100 }}>
        <Select
          value={range}
          onChange={(e) => {
            onRangeChange(e.target.value as CalendarRange);
          }}
          aria-label={t('calendarRange')}
          data-testid="calendar-range-select"
        >
          <MenuItem value="all">{t('calendarRangeAll')}</MenuItem>
          <MenuItem value="today">{t('calendarRangeToday')}</MenuItem>
          <MenuItem value="week">{t('calendarRangeThisWeek')}</MenuItem>
          <MenuItem value="month">{t('calendarRangeThisMonth')}</MenuItem>
          <MenuItem value="last30">{t('calendarRangeLast30Days')}</MenuItem>
        </Select>
      </FormControl>
    </Stack>

    {/* H.24 responsive: view-mode + year variant + export cluster. Wraps as a
        unit on narrow windows (flexWrap on the toolbar), and sits right via
        `ml: auto` when there's room. */}
    <Stack
      direction="row"
      sx={{ alignItems: 'center', gap: 1, flexShrink: 0, ml: 'auto' }}
    >
      <ToggleButtonGroup
        size="small"
        exclusive
        value={viewMode}
        onChange={(_e, value: CalendarViewMode | null) => {
          if (value) onViewModeChange(value);
        }}
      >
        <ToggleButton value="month">{t('calendarViewMonth')}</ToggleButton>
        <ToggleButton value="week">{t('calendarViewWeek')}</ToggleButton>
        <ToggleButton value="year">{t('calendarViewYear')}</ToggleButton>
        <ToggleButton value="agenda">{t('calendarViewAgenda')}</ToggleButton>
        <ToggleButton value="week-timeline">{t('calendarViewWeekTimeline')}</ToggleButton>
      </ToggleButtonGroup>

      {/* H.24 P2-2: year variant switch — tiles vs heatmap. */}
      {viewMode === 'year' ? (
        <ToggleButtonGroup
          size="small"
          exclusive
          value={yearVariant}
          onChange={(_e, value: 'tiles' | 'heatmap' | null) => {
            if (value) onYearVariantChange(value);
          }}
        >
          <ToggleButton value="tiles">{t('calendarYearTiles')}</ToggleButton>
          <ToggleButton value="heatmap">{t('calendarYearHeatmap')}</ToggleButton>
        </ToggleButtonGroup>
      ) : null}

      {/* H.24 P2-4 + 2026-07-03: export the calendar body as a PNG:
          save / save-as / copy-to-clipboard (mirrors Mapique toolbar). */}
      <Tooltip title={exportFailed ? t('calendarExportFail') : t('saveImage')}>
        <span>
          <IconButton
            size="small"
            onClick={() => void onSave()}
            disabled={exporting}
            aria-label={t('saveImage')}
            data-testid="calendar-save"
          >
            <SaveIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title={exportFailed ? t('calendarExportFail') : t('saveImageAs')}>
        <span>
          <IconButton
            size="small"
            onClick={() => void onSaveAs()}
            disabled={exporting}
            aria-label={t('saveImageAs')}
            data-testid="calendar-save-as"
          >
            <DriveFileMoveIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title={t('calendarCopyImage')}>
        <span>
          <IconButton
            size="small"
            onClick={() => void onCopyImage()}
            disabled={exporting}
            aria-label={t('calendarCopyImage')}
            data-testid="calendar-copy-image"
          >
            <ContentCopyIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </Stack>
  </Stack>
  );
}
