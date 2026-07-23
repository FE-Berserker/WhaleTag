import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { alpha, lighten, useTheme } from '@mui/material/styles';
import {
  Box,
  Button,
  FormControl,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Popover,
  Select,
  Snackbar,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CreateNewFolderIcon from '@mui/icons-material/CreateNewFolder';
import NoteAddIcon from '@mui/icons-material/NoteAdd';
import TodayIcon from '@mui/icons-material/Today';
import SaveIcon from '@mui/icons-material/Save';
import DriveFileMoveIcon from '@mui/icons-material/DriveFileMove';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useDrag, useDrop } from 'react-dnd';
import { NativeTypes } from 'react-dnd-html5-backend';
import { List as VirtualList, type RowComponentProps } from 'react-window';
import ReactECharts from 'echarts-for-react';
// On-demand echarts instance (Bar + 5 components + Canvas + SVG renderers).
// Replaces `import * as echarts from 'echarts'` which pulled the full UMD
// distribution (~1 MB).
import { echarts } from '../services/echarts-setup';

import { DND_TYPE_FILE, type FileDragItem } from '-/services/dnd';
import type { DirEntry } from '../../shared/ipc-types';
import {
  addDays,
  addMonths,
  bucketByDate,
  bucketByDateAndHour,
  calendarDays,
  dateTagDateKey,
  detectWeekStartsOn,
  formatMonthYear,
  formatWeekRange,
  formatYear,
  isDateTypedTag,
  isToday,
  modifiedDateKey,
  rangeBounds,
  type CalendarRange,
  startOfDay,
  startOfWeek,
  tagOrModifiedDateKey,
  weekDays,
  weekdayLabels,
  yearHeatmapGrid,
  heatIntensity,
  yearMonths,
  ymd,
} from '../domain/calendar';
import { resolveSmartTag } from '../../shared/smart-tags';
import type { FileCellData } from '-/components/file-cell';
import { useIOActionsContext } from '-/hooks/IOActionsContextProvider';
import ThumbIcon from '-/components/ThumbIcon';
import CalendarEntryMenu, {
  type CalendarEntryContext,
} from '-/components/CalendarEntryMenu';
import { useCurrentLocationContext } from '-/hooks/CurrentLocationContextProvider';
import { readPrefs, writePrefs } from '../domain/perspective-prefs';
import { useSelector } from 'react-redux';
import { RootState } from '-/reducers';
import { lunarDayLabel } from '../domain/lunar';
import { useImageExport, base64FromDataUrl, type ClipboardKind } from '-/hooks/useImageExport';

interface CalendarViewProps {
  /** The shared per-cell handler bag from FileList. */
  data: FileCellData;
}

type CalendarViewMode = 'month' | 'week' | 'year' | 'agenda' | 'week-timeline';
// H.24 P0-5: 'auto' prefers date tags, falls back to modified date.
type GroupingSource = 'modified' | 'dateTag' | 'auto';

/**
 * H.24 P1-4: should picking a non-`all` range filter also snap the cursor to
 * today? Yes in period views (month / week / year) — otherwise the grid sits
 * on a far-past period and looks empty. No in `agenda` (cursor doesn't
 * position content) and `week-timeline` (cursor anchors the displayed week;
 * jumping would yank the user away from the historical week they're
 * inspecting while applying the range).
 *
 * Extracted as a pure function so the contract is testable independently of
 * the MUI Select popup (which doesn't render reliably under jsdom — see
 * CalendarView.test.tsx #11).
 */
export function shouldJumpCursor(
  range: CalendarRange,
  viewMode: CalendarViewMode
): boolean {
  if (range === 'all') return false;
  if (viewMode === 'agenda') return false;
  if (viewMode === 'week-timeline') return false;
  return true;
}

const CELL_MIN_HEIGHT = 96;
const ENTRY_THUMB = 24;

// H.24 PA-3: per-location persisted view state. Keyed `whale.calendar.<locationId>`
// to match `whale.folderViz.*` / `whale.tagCloud.*`. `cursor` is deliberately NOT
// persisted — re-entering a location should land on today, not on whatever day
// was focused last time (avoids "where did the calendar go?" confusion).
const PREFS_KEY_PREFIX = 'whale.calendar.';
interface CalendarPrefs {
  viewMode: CalendarViewMode;
  grouping: GroupingSource;
}

/** Load + validate persisted prefs. Returns null on miss / parse error / bad values. */
function loadCalendarPrefs(locationId: string): CalendarPrefs | null {
  const p = readPrefs<CalendarPrefs>(PREFS_KEY_PREFIX + locationId);
  if (!p) return null;
  const vm = p.viewMode;
  const gr = p.grouping;
  const okVm =
    vm === 'month' ||
    vm === 'week' ||
    vm === 'year' ||
    vm === 'agenda' ||
    vm === 'week-timeline';
  const okGr = gr === 'modified' || gr === 'dateTag' || gr === 'auto';
  return okVm && okGr ? { viewMode: vm, grouping: gr } : null;
}

/**
 * Calendar perspective: month / week / year grids showing files grouped by
 * their modification date (local timezone). Reuses the FileCellData handler
 * bag so clicks, selection, and context menus behave like the other views.
 */
export default function CalendarView({ data }: CalendarViewProps) {
  const { entries, tagsByName, t } = data;
  const { i18n } = useTranslation();
  const locale = i18n.language;
  // H.24 P2-6: lunar labels are opt-in (settings) AND zh-locale-only.
  const showLunar = useSelector((s: RootState) => s.settings?.showLunar ?? false);
  const showLunarLabel = showLunar && locale.toLowerCase().startsWith('zh');

  // H.24 P2-4: PNG export of the calendar body (not the toolbar). modern-screenshot
  // turns the DOM subtree into a PNG; useImageExport handles save/save-as/clipboard.
  const theme = useTheme();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const capture = useCallback(async () => {
    if (!bodyRef.current) return null;
    // Dynamic import: modern-screenshot is a browser-DOM lib that doesn't load
    // under the Node/jsdom test runner, and code-splits it out of the main
    // bundle (only fetched when the user actually exports).
    const { domToPng } = await import('modern-screenshot');
    const dataUrl = await domToPng(bodyRef.current, {
      backgroundColor: theme.palette.background.default,
    });
    return base64FromDataUrl(dataUrl);
  }, [theme.palette.background.default]);
  const {
    saving: exporting,
    error: exportError,
    handleSave,
    handleSaveAs,
    handleCopyToClipboard,
  } = useImageExport({
    capture,
    prefix: 'whale-calendar',
  });
  // H.24 P2-4: image-export notice surfaced after copy-to-clipboard (mirrors
  // Mapique / TagCloud / KnowledgeGraph).
  const [notice, setNotice] = useState<string | null>(null);

  const weekStartsOn = detectWeekStartsOn(locale);
  const { currentLocation } = useCurrentLocationContext();

  const onCopyToClipboard = useCallback(async () => {
    try {
      const kind: ClipboardKind = await handleCopyToClipboard();
      setNotice(kind === 'image' ? t('tagCloudCopied') : t('tagCloudCopiedAsBase64'));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }, [handleCopyToClipboard, t]);

  const [viewMode, setViewMode] = useState<CalendarViewMode>('month');
  const [grouping, setGrouping] = useState<GroupingSource>('modified');
  // `cursor` is a single "focused" local date. Each view displays the period
  // (month / week / year) that contains this date. This keeps navigation
  // intuitive when switching views: month shows the month containing cursor,
  // week shows the week containing cursor, year shows the year containing cursor.
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  // H.24 P0-1: domain right-click menu state. Owned here so the menu can
  // dispatch jump-to-date (which needs setCursor) without bouncing through
  // FileList.
  const [calMenu, setCalMenu] = useState<CalendarEntryContext | null>(null);
  // H.24 P1-4: relative time-window filter (今天/本周/本月/最近30天/全部).
  const [range, setRange] = useState<CalendarRange>('all');
  // H.24 P1-3: anchor element for the date-picker popover (null = closed).
  const [datePickerEl, setDatePickerEl] = useState<HTMLElement | null>(null);
  // H.24 P2-2: year view variant — 12 month tiles, or a GitHub-style heatmap.
  const [yearVariant, setYearVariant] = useState<'tiles' | 'heatmap'>('tiles');

  // Bucket every entry by its date key (modified / dateTag / auto), then apply
  // the range window. Bucket keys are YYYY-MM-DD so the range filter is a plain
  // string compare — independent of which grouping source produced the key.
  const bucketsAll = useMemo(() => {
    if (grouping === 'dateTag') {
      return bucketByDate(entries, (e) => dateTagDateKey(e, tagsByName));
    }
    if (grouping === 'auto') {
      return bucketByDate(entries, (e) => tagOrModifiedDateKey(e, tagsByName));
    }
    return bucketByDate(entries, modifiedDateKey);
  }, [entries, grouping, tagsByName]);

  const buckets = useMemo(() => {
    if (range === 'all') return bucketsAll;
    const bounds = rangeBounds(range, new Date(), weekStartsOn);
    if (!bounds) return bucketsAll;
    const filtered = new Map<string, DirEntry[]>();
    for (const [key, list] of bucketsAll) {
      if (key >= bounds.min && key <= bounds.max) filtered.set(key, list);
    }
    return filtered;
  }, [bucketsAll, range, weekStartsOn]);

  const labels = useMemo(
    () => weekdayLabels(weekStartsOn, locale),
    [weekStartsOn, locale]
  );

  // H.24 P2-1: per-day × per-hour buckets for the week-timeline view. Same
  // grouping extractor as the day buckets; entries further split by hour-of-day
  // of their modified timestamp (so the timeline is most meaningful in modified
  // grouping — date-tagged entries carry no time-of-day signal).
  //
  // 2026-07-04: apply the range filter here too, matching what `buckets`
  // does for month/week/year/agenda. Without it, picking range='today' in
  // week-timeline would still show entries from yesterday / last week —
  // inconsistent with the other views. Week-timeline's grid keeps showing
  // the cursor's full week (24×7 cells always render); only the entries
  // inside each cell are filtered, so a filtered-out day still has empty
  // hour cells visible.
  const hourBuckets = useMemo(() => {
    const getKey =
      grouping === 'dateTag'
        ? (e: DirEntry) => dateTagDateKey(e, tagsByName)
        : grouping === 'auto'
          ? (e: DirEntry) => tagOrModifiedDateKey(e, tagsByName)
          : modifiedDateKey;
    const all = bucketByDateAndHour(entries, getKey);
    if (range === 'all') return all;
    const bounds = rangeBounds(range, new Date(), weekStartsOn);
    if (!bounds) return all;
    const filtered: Map<string, DirEntry[][]> = new Map();
    for (const [key, hours] of all) {
      if (key >= bounds.min && key <= bounds.max) filtered.set(key, hours);
    }
    return filtered;
  }, [entries, grouping, tagsByName, range, weekStartsOn]);

  // H.24 P1-6: per-entry HH:MM label, shown only when grouping by modified date
  // (in dateTag mode the modified-time of day carries no signal). Computed once
  // per locale/grouping change and threaded down to CalendarEntryItem.
  const entryTimeLabel = useMemo(() => {
    if (grouping !== 'modified') return undefined;
    const fmt = new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
    });
    return (entry: DirEntry) => {
      const d = new Date(entry.modified);
      return Number.isNaN(d.getTime()) ? null : fmt.format(d);
    };
  }, [grouping, locale]);

  // H.24 PA-3: hydrate viewMode + grouping when the active location changes.
  // cursor is intentionally NOT restored — always today on entry.
  useEffect(() => {
    if (!currentLocation?.id) return;
    const prefs = loadCalendarPrefs(currentLocation.id);
    if (prefs) {
      setViewMode(prefs.viewMode);
      setGrouping(prefs.grouping);
    }
  }, [currentLocation?.id]);

  // H.24 PA-3: persist (debounced) on state change. Best-effort — a failed save
  // (quota / private mode) is swallowed inside writePrefs and never surfaces.
  useEffect(() => {
    if (!currentLocation?.id) return;
    const handle = setTimeout(() => {
      writePrefs(PREFS_KEY_PREFIX + currentLocation.id, { viewMode, grouping });
    }, 200);
    return () => clearTimeout(handle);
  }, [currentLocation?.id, viewMode, grouping]);

  const goToday = useCallback(() => setCursor(startOfDay(new Date())), []);

  const goPrev = useCallback(() => {
    setCursor((prev) => {
      if (viewMode === 'month') return startOfDay(addMonths(prev, -1));
      if (viewMode === 'week') return startOfDay(addDays(prev, -7));
      return startOfDay(addMonths(prev, -12));
    });
  }, [viewMode]);

  const goNext = useCallback(() => {
    setCursor((prev) => {
      if (viewMode === 'month') return startOfDay(addMonths(prev, 1));
      if (viewMode === 'week') return startOfDay(addDays(prev, 7));
      return startOfDay(addMonths(prev, 12));
    });
  }, [viewMode]);

  const title = useMemo(() => {
    if (viewMode === 'month') return formatMonthYear(cursor, locale);
    if (viewMode === 'week') {
      const start = startOfWeek(cursor, weekStartsOn);
      const end = addDays(start, 6);
      return formatWeekRange(start, end, locale);
    }
    return formatYear(cursor, locale);
  }, [viewMode, cursor, locale, weekStartsOn]);

  // H.24 P0-2: prev/next tooltips track the active view mode so users see
  // "previous week" / "previous year" in week/year views instead of the stale
  // "previous month" copy.
  const prevLabelKey = useMemo(() => {
    if (viewMode === 'week') return 'calendarPrevWeek';
    if (viewMode === 'year') return 'calendarPrevYear';
    return 'calendarPrevMonth';
  }, [viewMode]);

  const nextLabelKey = useMemo(() => {
    if (viewMode === 'week') return 'calendarNextWeek';
    if (viewMode === 'year') return 'calendarNextYear';
    return 'calendarNextMonth';
  }, [viewMode]);

  // H.24 P0-1: resolve the menu entry's date key for the "Set as date" action.
  const calMenuDateKey = useMemo(() => {
    if (!calMenu) return '';
    // "Set as date" means "mark for TODAY". Deriving from entry.modified
    // silently moved entries to their modified day in dateTag grouping (the
    // entry would jump cells right after the sidecar write).
    return resolveSmartTag('today', new Date()) ?? '';
  }, [calMenu]);

  const calMenuHasDateTag = useMemo(() => {
    if (!calMenu) return false;
    const tags = tagsByName.get(calMenu.entry.path) ?? [];
    return tags.some(isDateTypedTag);
  }, [calMenu, tagsByName]);

  return (
    <Box
      sx={{
        height: '100%',
        width: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        p: 1.5,
        overflow: 'hidden',
      }}
    >
      {/* Toolbar */}
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
                onClick={(e) => setDatePickerEl(e.currentTarget)}
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
                onClick={goPrev}
                aria-label={t(prevLabelKey)}
                data-testid="calendar-prev"
              >
                <ChevronLeftIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title={t(nextLabelKey)}>
              <IconButton
                size="small"
                onClick={goNext}
                aria-label={t(nextLabelKey)}
                data-testid="calendar-next"
              >
                <ChevronRightIcon />
              </IconButton>
            </Tooltip>
            <Button
              size="small"
              startIcon={<TodayIcon fontSize="small" />}
              onClick={goToday}
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
              if (value) setGrouping(value);
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
                const next = e.target.value as CalendarRange;
                setRange(next);
                if (shouldJumpCursor(next, viewMode)) {
                  setCursor(startOfDay(new Date()));
                }
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
              if (value) setViewMode(value);
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
                if (value) setYearVariant(value);
              }}
            >
              <ToggleButton value="tiles">{t('calendarYearTiles')}</ToggleButton>
              <ToggleButton value="heatmap">{t('calendarYearHeatmap')}</ToggleButton>
            </ToggleButtonGroup>
          ) : null}

          {/* H.24 P2-4 + 2026-07-03: export the calendar body as a PNG:
              save / save-as / copy-to-clipboard (mirrors Mapique toolbar). */}
          <Tooltip title={exportError ? t('calendarExportFail') : t('saveImage')}>
            <span>
              <IconButton
                size="small"
                onClick={() => void handleSave()}
                disabled={exporting}
                aria-label={t('saveImage')}
                data-testid="calendar-save"
              >
                <SaveIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={exportError ? t('calendarExportFail') : t('saveImageAs')}>
            <span>
              <IconButton
                size="small"
                onClick={() => void handleSaveAs()}
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
                onClick={() => void onCopyToClipboard()}
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

      {/* H.24 P2-4: body wrapped for PNG export (excludes the toolbar). */}
      <Box ref={bodyRef} sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>

      {/* H.24 P1-7: mode-aware banner. Two cases — (a) dateTag grouping with no
          date tags anywhere, (b) a range filter that excludes every bucketed
          day. Both surface once above the grid instead of per-empty-cell. */}
      {entries.length > 0 && bucketsAll.size === 0 && grouping === 'dateTag' ? (
        <Box
          sx={{ flexShrink: 0, p: 1, borderRadius: 1, bgcolor: 'action.hover' }}
        >
          <Typography variant="body2">{t('calendarEmptyDateTag')}</Typography>
          <Typography variant="caption" color="text.secondary">
            {t('calendarEmptyDateTagHint')}
          </Typography>
        </Box>
      ) : range !== 'all' && bucketsAll.size > 0 && buckets.size === 0 ? (
        <Box
          sx={{ flexShrink: 0, p: 1, borderRadius: 1, bgcolor: 'action.hover' }}
        >
          <Typography variant="body2">{t('calendarEmptyRange')}</Typography>
          <Typography variant="caption" color="text.secondary">
            {t('calendarEmptyRangeHint')}
          </Typography>
        </Box>
      ) : null}

      {/* Body */}
      {viewMode === 'month' ? (
        <MonthView
          cursor={cursor}
          weekStartsOn={weekStartsOn}
          labels={labels}
          buckets={buckets}
          data={data}
          entryTimeLabel={entryTimeLabel}
          showLunar={showLunarLabel}
          onOpenCalendarMenu={setCalMenu}
        />
      ) : viewMode === 'week' ? (
        <WeekView
          cursor={cursor}
          weekStartsOn={weekStartsOn}
          labels={labels}
          buckets={buckets}
          data={data}
          entryTimeLabel={entryTimeLabel}
          showLunar={showLunarLabel}
          onOpenCalendarMenu={setCalMenu}
        />
      ) : viewMode === 'agenda' ? (
        <AgendaView
          buckets={buckets}
          locale={locale}
          data={data}
          entryTimeLabel={entryTimeLabel}
          onOpenCalendarMenu={setCalMenu}
        />
      ) : viewMode === 'week-timeline' ? (
        <TimelineView
          cursor={cursor}
          weekStartsOn={weekStartsOn}
          labels={labels}
          hourBuckets={hourBuckets}
          data={data}
          entryTimeLabel={entryTimeLabel}
          onOpenCalendarMenu={setCalMenu}
        />
      ) : (
        <YearView
          cursor={cursor}
          weekStartsOn={weekStartsOn}
          buckets={buckets}
          locale={locale}
          data={data}
          yearVariant={yearVariant}
          onSelectMonth={(month) => {
            setCursor(startOfDay(month));
            setViewMode('month');
          }}
          onSelectDate={(d) => {
            setCursor(startOfDay(d));
            setViewMode('month');
          }}
        />
      )}

      </Box>

      {/* H.24 P0-1: domain right-click menu. Lives at the top level so it can
          dispatch set-date directly. */}
      <CalendarEntryMenu
        ctx={calMenu}
        onClose={() => setCalMenu(null)}
        dateKey={calMenuDateKey}
        hasDateTag={calMenuHasDateTag}
        onSetDate={(entry, dateKey) => {
          data.onSetEntryDateTag?.(entry, dateKey);
          setCalMenu(null);
        }}
        onRemoveDate={(entry) => {
          data.onRemoveEntryDateTag?.(entry);
          setCalMenu(null);
        }}
        onCopy={(entry) => {
          data.onCopy?.(entry);
          setCalMenu(null);
        }}
        onMoreFileActions={(entry, x, y) => {
          data.onContextEntry(entry, x, y);
          setCalMenu(null);
        }}
        readOnly={data.readOnly}
        t={t}
      />

      {/* H.24 P1-3: date-picker popover (jump to arbitrary date). Rendered only
          while open so its internal view-month resets to cursor on each open. */}
      {datePickerEl ? (
        <DatePickerPopover
          anchorEl={datePickerEl}
          cursor={cursor}
          locale={locale}
          weekStartsOn={weekStartsOn}
          onSelect={(d) => setCursor(startOfDay(d))}
          onClose={() => setDatePickerEl(null)}
        />
      ) : null}

      <Snackbar
        open={notice !== null}
        autoHideDuration={2400}
        onClose={() => setNotice(null)}
        message={notice ?? ''}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  );
}

interface SubViewProps {
  cursor: Date;
  weekStartsOn: 0 | 1;
  buckets: Map<string, DirEntry[]>;
  data: FileCellData;
  /** Required for month/week (renders DayCell); unused by year view. */
  onOpenCalendarMenu?: (ctx: CalendarEntryContext) => void;
  /** H.24 P1-6: per-entry HH:MM formatter; undefined in dateTag grouping. */
  entryTimeLabel?: (entry: DirEntry) => string | null;
  /** H.24 P2-6: render lunar day labels (already locale-gated by the caller). */
  showLunar?: boolean;
}

interface MonthViewProps extends SubViewProps {
  labels: string[];
}

function MonthView({
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
                  entries={buckets.get(day.key) ?? []}
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

interface WeekViewProps extends SubViewProps {
  labels: string[];
}

function WeekView({
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
              entries={buckets.get(day.key) ?? []}
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
function TimelineView({
  cursor,
  weekStartsOn,
  labels,
  hourBuckets,
  data,
  onOpenCalendarMenu,
}: TimelineViewProps) {
  const { t } = data;
  const days = useMemo(() => weekDays(cursor, weekStartsOn), [cursor, weekStartsOn]);
  const hours = Array.from({ length: 24 }, (_, h) => h);
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
      {hours.map((hour) => (
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
            const list = hourBuckets.get(day.key)?.[hour] ?? [];
            const visible = list.slice(0, 2);
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
function AgendaView({
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
function YearHeatmap({
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
function YearTrendChart({
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
        formatter: (params: any) => {
          const p = Array.isArray(params) ? params[0] : params;
          return `${p.name}<br/>${t('files')}: ${p.value}`;
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
            color: new (echarts as any).graphic.LinearGradient(0, 0, 0, 1, [
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

interface YearViewProps extends SubViewProps {
  locale: string;
  onSelectMonth: (month: Date) => void;
  yearVariant: 'tiles' | 'heatmap';
  onSelectDate: (date: Date) => void;
}

function YearView({
  cursor,
  weekStartsOn,
  buckets,
  locale,
  data,
  onSelectMonth,
  yearVariant,
  onSelectDate,
}: YearViewProps) {
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

interface DayCellProps {
  day: { date: Date; inCurrentMonth: boolean; key: string };
  entries: DirEntry[];
  data: FileCellData;
  showEmptyHint: boolean;
  onOpenCalendarMenu: (ctx: CalendarEntryContext) => void;
  entryTimeLabel?: (entry: DirEntry) => string | null;
  showLunar?: boolean;
}

function DayCell({
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
  // H.24 P2-6: lunar label is pre-gated on zh locale by the caller; empty
  // string (no data / out of range) renders nothing.
  const lunarLabel = showLunar ? lunarDayLabel(day.date) : '';
  const [dayCtx, setDayCtx] = useState<{ x: number; y: number } | null>(null);
  const autoTag = resolveSmartTag('today', day.date) ?? day.key.replace(/-/g, '');

  // H.24 P1-5: drop target — dragging a file onto this day re-dates it
  // (overwrites its date tag with this day's smart tag). Reuses
  // `onSetEntryDateTag` so the sidecar write + non-date-tag filtering is
  // shared with the domain menu's "Set as date". No confirm dialog — matches
  // Kanban's direct-drop behavior, and it's reversible (right-click → clear).
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
        for (const p of item.paths) {
          const ent = data.entries.find((e) => e.path === p);
          if (ent) data.onSetEntryDateTag?.(ent, autoTag);
        }
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
}

function CalendarEntryItem({
  entry,
  data,
  onOpenCalendarMenu,
  entryTimeLabel,
}: {
  entry: DirEntry;
  data: FileCellData;
  onOpenCalendarMenu: (ctx: CalendarEntryContext) => void;
  entryTimeLabel?: (entry: DirEntry) => string | null;
}) {
  const { entries, onOpen, onSelectRow, isSelected, thumbCache, t, selectedPaths, readOnly } =
    data;
  const selected = isSelected(entry);
  // H.24 P1-6: HH:MM only renders in modified grouping (undefined otherwise).
  const timeLabel = entryTimeLabel?.(entry) ?? null;

  // H.24 P1-5: drag source — drag this entry (or, if it's selected, the whole
  // selection) onto another day cell to re-date it. Mirrors Row.tsx's item shape
  // so the DayCell drop target (and FileList folder-drop) accept it identically.
  const dragItem = useMemo<FileDragItem>(() => {
    if (selectedPaths?.has(entry.path)) {
      const paths: string[] = [];
      const names: string[] = [];
      for (const e of entries) {
        if (selectedPaths.has(e.path)) {
          paths.push(e.path);
          names.push(e.name);
        }
      }
      return { paths, names };
    }
    return { paths: [entry.path], names: [entry.name] };
  }, [selectedPaths, entries, entry.path, entry.name]);

  const [{ isDragging }, dragRef] = useDrag(
    () => ({
      type: DND_TYPE_FILE,
      item: dragItem,
      collect: (monitor) => ({ isDragging: monitor.isDragging() }),
      canDrag: () => !readOnly,
    }),
    [dragItem, readOnly]
  );

  // Single-click selects (consistent with list/grid/gallery); double-click
  // opens. Click-to-open made it impossible to select or start a drag
  // without the file popping open.
  const handleClick = () => {
    const index = entries.findIndex((e) => e.path === entry.path);
    if (index >= 0) {
      onSelectRow(index, { shift: false, toggle: false });
    }
  };
  const handleDoubleClick = () => {
    onOpen(entry);
  };

  // H.24 P0-1: the entry's right-click opens the calendar domain menu (not the
  // generic EntryContextMenu). The generic file menu is still reachable via the
  // domain menu's "more" item, which the parent wires to `data.onContextEntry`.
  const handleContext = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onOpenCalendarMenu({ x: e.clientX, y: e.clientY, entry });
  };

  return (
    <Box
      ref={dragRef}
      aria-label={t('calendarEntryAria', { name: entry.name })}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContext}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        px: 0.5,
        py: 0.25,
        borderRadius: 0.5,
        cursor: readOnly ? 'default' : 'grab',
        userSelect: 'none',
        opacity: isDragging ? 0.4 : 1,
        '&:hover': { bgcolor: 'action.hover' },
        ...(selected && {
          bgcolor: 'action.selected',
          outline: 1,
          outlineColor: 'primary.main',
        }),
      }}
    >
      <ThumbIcon entry={entry} thumbCache={thumbCache} size={ENTRY_THUMB} />
      <Typography
        variant="caption"
        noWrap
        sx={{ flex: 1, minWidth: 0 }}
        title={entry.name}
      >
        {entry.name}
      </Typography>
      {timeLabel ? (
        <Typography
          variant="caption"
          sx={{ flexShrink: 0, color: 'text.secondary', fontSize: '0.7rem' }}
        >
          {timeLabel}
        </Typography>
      ) : null}
    </Box>
  );
}

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
function DatePickerPopover({
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
          onClick={() => setView((v) => startOfDay(addMonths(v, -1)))}
          aria-label={t('calendarPrevMonth')}
        >
          <ChevronLeftIcon />
        </IconButton>
        <Typography variant="subtitle2" sx={{ fontWeight: 500 }}>
          {formatMonthYear(view, locale)}
        </Typography>
        <IconButton
          size="small"
          onClick={() => setView((v) => startOfDay(addMonths(v, 1)))}
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