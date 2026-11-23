import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@mui/material/styles';
import { Box, Snackbar, Typography } from '@mui/material';
import { useSelector } from 'react-redux';

import type { DirEntry } from '../../shared/ipc-types';
import {
  addDays,
  addMonthsClamped,
  bucketByDate,
  bucketByDateAndHour,
  dateTagDateKey,
  detectWeekStartsOn,
  formatMonthYear,
  formatWeekRange,
  formatYear,
  isDateTypedTag,
  modifiedDateKey,
  rangeBounds,
  type CalendarRange,
  startOfDay,
  startOfWeek,
  tagOrModifiedDateKey,
  weekdayLabels,
} from '../domain/calendar';
import { resolveSmartTag } from '../../shared/smart-tags';
import type { FileCellData } from '-/components/file-cell';
import CalendarEntryMenu, {
  type CalendarEntryContext,
} from '-/components/CalendarEntryMenu';
import { useCurrentLocationContext } from '-/hooks/CurrentLocationContextProvider';
import { writePrefs } from '../domain/perspective-prefs';
import { RootState } from '-/reducers';
import { useImageExport, base64FromDataUrl, type ClipboardKind } from '-/hooks/useImageExport';

import { PREFS_KEY_PREFIX, loadCalendarPrefs } from './calendar/prefs';
import type { CalendarViewMode, GroupingSource } from './calendar/types';
import { CalendarToolbar } from './calendar/CalendarToolbar';
import { MonthView } from './calendar/MonthView';
import { WeekView } from './calendar/WeekView';
import { TimelineView } from './calendar/TimelineView';
import { AgendaView } from './calendar/AgendaView';
import { YearView } from './calendar/YearView';
import { DatePickerPopover } from './calendar/DatePickerPopover';


interface CalendarViewProps {
  /** The shared per-cell handler bag from FileList. */
  data: FileCellData;
}

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
      if (viewMode === 'month') return startOfDay(addMonthsClamped(prev, -1));
      if (viewMode === 'week') return startOfDay(addDays(prev, -7));
      return startOfDay(addMonthsClamped(prev, -12));
    });
  }, [viewMode]);

  const goNext = useCallback(() => {
    setCursor((prev) => {
      if (viewMode === 'month') return startOfDay(addMonthsClamped(prev, 1));
      if (viewMode === 'week') return startOfDay(addDays(prev, 7));
      return startOfDay(addMonthsClamped(prev, 12));
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


  // H.24 P1-4: selecting a non-all range also snaps the cursor to today in
  // period views (see shouldJumpCursor). The jump is SKIPPED in agenda and
  // week-timeline - cursor does not position content there / it anchors the
  // displayed week, so jumping would yank the user away from it.
  const handleRangeChange = useCallback(
    (next: CalendarRange) => {
      setRange(next);
      if (shouldJumpCursor(next, viewMode)) {
        setCursor(startOfDay(new Date()));
      }
    },
    [viewMode]
  );

  return (
    <Box
      data-testid="calendar-view"
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
      <CalendarToolbar
        viewMode={viewMode}
        grouping={grouping}
        range={range}
        yearVariant={yearVariant}
        title={title}
        prevLabelKey={prevLabelKey}
        nextLabelKey={nextLabelKey}
        exporting={exporting}
        exportFailed={exportError !== null}
        onOpenDatePicker={setDatePickerEl}
        onPrev={goPrev}
        onNext={goNext}
        onToday={goToday}
        onGroupingChange={setGrouping}
        onRangeChange={handleRangeChange}
        onViewModeChange={setViewMode}
        onYearVariantChange={setYearVariant}
        onSave={handleSave}
        onSaveAs={handleSaveAs}
        onCopyImage={onCopyToClipboard}
        t={t}
      />

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
