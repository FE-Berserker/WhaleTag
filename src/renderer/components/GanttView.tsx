/**
 * Gantt view (Tasks §3.3) — pure-DOM timeline replacement for the old
 * ECharts custom-series implementation.
 *
 * Layout (top to bottom):
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ [Day | Week | Month] [1w | 2w | 1m | 1q]    Today              │ ← toolbar
 *   ├──────────────────────────────────────────────────────────────┤
 *   │ [thumb] a.txt   ──────[█████]─────────────────                │
 *   │ [thumb] b.txt   ──[███]────                                    │ ← GanttTimeline
 *   │ [thumb] c.txt       ─────────[████████]──                     │
 *   │─│ today                                              ─│       │ ← red today line
 *   ├──────────────────────────────────────────────────────────────┤
 *   │ No schedule (Triage, horizontal EntryCards)                  │ ← Triage
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Why pure-DOM:
 *   The ECharts version (this file's previous 954-line incarnation) used
 *   `series.type: 'custom'` with `renderItem`, which fights ECharts'
 *   internal hit-test pipeline: every `mouseup` / `mouseout` triggers
 *   `CustomSeriesModel.getDataParams` whose first read is
 *   `dataIndex.getRawIndex()` — and our child elements (image / text /
 *   rect / group) carry no data hookup, so dataIndex is undefined and
 *   the call throws. The fix was a `silent: true` patch but the
 *   underlying coupling — px-per-day round-tripping through
 *   `convertToPixel` / `convertFromPixel`, `notMerge: true` thrashing
 *   on every pointermove, a Today button that did nothing — stayed.
 *
 *   The replacement is a horizontally-scrolling `<div>` with rows as
 *   absolutely-positioned children, native scrollbars for pan, and a
 *   three-state pointer-drag state machine in `useBarDrag`. The other
 *   3 ECharts consumers (`CalendarView`, `TagCloudView`, `FolderVizView`)
 *   still import echarts — `echarts-for-react` stays in package.json.
 *
 * Toolbar:
 *   - Day / Week / Month `Select` — persisted via `useGanttZoom` to
 *     `localStorage[whale-task-gantt-zoom]` (key reused for back-compat).
 *   - Today IconButton — calls `scrollToToday` on the scroller ref. This
 *     is the fix for the legacy `setZoomState((z) => z); void today;`
 *     no-op at the old L682-L690.
 *
 * Triage:
 *   Unchanged — same react-dnd `useDrop(DND_TYPE_FILE)` pattern. Drop
 *   still calls `data.onRemoveEntryDateTag?.(e)` per source (NOT
 *   `onMoveToColumn(null, …)` — distinct path; see `renderer/domain/gantt.ts`
 *   invariant #3).
 *
 * Right-click menu:
 *   `<GanttEntryMenu>` unchanged; same props the legacy version wired.
 *
 * `data-testid`s preserved (legacy loader relied on them):
 *   - `gantt-view`       — outer container
 *   - `gantt-today`      — toolbar Today button
 *   - `gantt-scroll`     — scroller (was ReactECharts wrapper parent)
 *   - `gantt-triage`     — Triage tray root
 *   - `gantt-triage-readonly` — lock icon in Triage when readOnly
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useDrop } from 'react-dnd';
import {
  Box,
  Button,
  Chip,
  FormControl,
  IconButton,
  ListItemText,
  MenuItem,
  Select,
  Snackbar,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DriveFileMoveIcon from '@mui/icons-material/DriveFileMove';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import SaveIcon from '@mui/icons-material/Save';
import TodayIcon from '@mui/icons-material/Today';

import type { DirEntry } from '../../shared/ipc-types';
import type { WorkflowStage } from '../domain/workflow';
import {
  QUADRANT_COLORS,
  QUADRANT_VALUES,
} from '../../shared/smart-tags';
import { getTagColor } from '../domain/tag-colors';
import {
  PX_PER_DAY,
  chartRowsFromEntries,
  dayKeyDiff,
  entriesWithoutPeriod,
  entryPeriod,
  periodTagFromRange,
  scaleForRange,
  todayKey,
  type GanttPeriod,
  type GanttZoom,
} from '../domain/gantt';
import { DND_TYPE_FILE, type FileDragItem } from '-/services/dnd';
import { NativeTypes } from 'react-dnd-html5-backend';
import type { FileCellData } from '-/components/file-cell';
import { useImageExport, base64FromDataUrl, type ClipboardKind } from '-/hooks/useImageExport';
import { useTheme } from '@mui/material/styles';
import EntryCard from '-/components/EntryCard';
import GanttEntryMenu from '-/components/GanttEntryMenu';
import { useIOActionsContext } from '-/hooks/IOActionsContextProvider';

import GanttTimeline from './gantt/GanttTimeline';
import { useGanttZoom } from './gantt/useGanttZoom';
import {
  useGanttRange,
  ganttRangeToBounds,
  RANGE_LABEL_KEYS,
  type GanttRangePreset,
} from './gantt/useGanttRange';
import { useGanttTagFilter } from './gantt/useGanttTagFilter';
import { tagDisplayLabel } from '-/services/tag-display';
import { usePeriodTagDialog } from './PeriodTagDialog';

interface GanttViewProps {
  /** Same shared per-cell handler bag Kanban / Matrix use. */
  data: FileCellData;
  stages: WorkflowStage[];
  onMoveToColumn: (
    sources: DirEntry[],
    targetValue: string | null,
    stageValues: string[]
  ) => void;
}

// Default zoom for the toolbar; the localStorage-persisted value from
// `useGanttZoom` overrides on mount.
const DEFAULT_ZOOM: GanttZoom = 'day';

export default function GanttView({ data, stages, onMoveToColumn }: GanttViewProps) {
  const {
    entries,
    tagsByName,
    thumbCache,
    t,
    readOnly,
    tagColors,
    groups,
    activeTag,
    onClickTag,
    onTagContextMenu,
  } = data;

  // ── Scheduled / triage split (same data-shaping the legacy view had) ─
  const scheduled = useMemo(
    () => chartRowsFromEntries(entries, tagsByName, thumbCache),
    [entries, tagsByName, thumbCache]
  );
  const triage = useMemo(
    () => entriesWithoutPeriod(entries, tagsByName),
    [entries, tagsByName]
  );

  // ── Zoom + scale ─
  const [zoom, setZoom] = useGanttZoom(DEFAULT_ZOOM);
  const { range, setRange } = useGanttRange();
  const pxPerDay = PX_PER_DAY[zoom];

  // ── Filter dimensions (P0 #5 + #6) ───────────────────────────────
  // Workflow filter mirrors Kanban's column axis; quadrant filter
  // mirrors Matrix's quadrant axis. Each is independent — the row is
  // filtered IN iff BOTH dimensions let it pass. See
  // [useGanttTagFilter.ts](./gantt/useGanttTagFilter.ts) for the
  // "passes" predicate (which keeps tag-less rows visible).
  const stageValues = useMemo(() => stages.map((s) => s.value), [stages]);
  const workflowFilter = useGanttTagFilter<string>('workflow', stageValues);
  const quadrantFilter = useGanttTagFilter<string>('quadrant', QUADRANT_VALUES);

  /** True iff the row's tags fail any active filter — the row should
   *  render at opacity 0.3 and become non-interactive. */
  const isRowFilteredOut = useCallback(
    (tags: readonly string[]): boolean => {
      if (!workflowFilter.passes(tags)) return true;
      if (!quadrantFilter.passes(tags)) return true;
      return false;
    },
    [workflowFilter, quadrantFilter]
  );

  /** True iff every scheduled row is filtered out — used to render the
   *  "all rows filtered" empty state below the toolbar. */
  const allFilteredOut = useMemo(
    () =>
      scheduled.length > 0 &&
      scheduled.every((r) => isRowFilteredOut(r.tags)),
    [scheduled, isRowFilteredOut]
  );

  // Visible time range. When a quick-range preset is selected it drives
  // the span (start/end) while zoom controls px-per-day. Otherwise fall
  // back to the natural schedule range padded around today.
  const scale = useMemo(() => {
    if (range) {
      const { startKey, endKey } = ganttRangeToBounds(range);
      return scaleForRange(zoom, startKey, endKey);
    }
    if (scheduled.length === 0) {
      return scaleForRange(zoom, todayKey(), todayKey());
    }
    let lo = scheduled[0].period.startKey;
    let hi = scheduled[0].period.endKey;
    for (const r of scheduled) {
      if (r.period.startKey < lo) lo = r.period.startKey;
      if (r.period.endKey > hi) hi = r.period.endKey;
    }
    return scaleForRange(zoom, lo, hi);
  }, [scheduled, zoom, range]);

  // ── Scroller ref + scroll-to-Today ─
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const exportRef = useRef<HTMLDivElement | null>(null);
  const scrollToToday = useCallback(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    // Center today in the viewport. The today-line px offset lives in the
    // timeline; here we just scroll so it lands in the middle. Pure math
    // via the shared helper.
    const offsetDays = dayKeyDiff(scale.startKey, todayKey());
    const targetLeft = offsetDays * pxPerDay - sc.clientWidth / 2;
    sc.scrollTo({
      left: Math.max(0, targetLeft),
      behavior: 'smooth',
    });
  }, [scale.startKey, pxPerDay]);

  // ── P1 #9: PNG export of the visible timeline ──────────────────────
  // modern-screenshot turns the inner chart-content DOM into a PNG.
  // Dynamic import keeps it out of the test bundle and only loads when
  // the user actually exports.
  const theme = useTheme();
  const capture = useCallback(async () => {
    if (!exportRef.current) return null;
    const { domToPng } = await import('modern-screenshot');
    const dataUrl = await domToPng(exportRef.current, {
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
    prefix: 'whale-gantt',
  });
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const onCopyGanttToClipboard = useCallback(async () => {
    try {
      const kind: ClipboardKind = await handleCopyToClipboard();
      setExportNotice(kind === 'image' ? t('ganttExportCopied') : t('ganttExportCopiedAsBase64'));
    } catch (e) {
      setExportNotice(e instanceof Error ? e.message : String(e));
    }
  }, [handleCopyToClipboard, t]);

  // ── Bar fill color (#10 立 revert 2026-07-06) ─────────────────────
  // Tag-derive chain (P1 #8, 2026-07-05) is REVERTED: it pulled bar color
  // from `getTagColor(tags)`, which made the color depend on tag array
  // order (fragile), pulled workflow tags through (clashing with swim
  // lane tint), and conflated "what color is this bar" with "what tags
  // does this entry have". The replacement (P1 #10) lets the user set
  // a per-entry override via the bar right-click menu; until that lands
  // we fall back to a single primary-ish blue for every bar.
  //
  // The signature is already on the new shape `(entry: DirEntry) => string`
  // so the call sites in `GanttRow` and `GanttTimeline` don't need to
  // change again when #10 lands — only this body will.
  const colorFor = useCallback((_entry: DirEntry): string => '#3b82f6', []);

  // ── Per-card right-click menu (identical surface to the legacy view) ─
  const [ganttMenu, setGanttMenu] = useState<{
    x: number;
    y: number;
    entry: DirEntry;
  } | null>(null);

  // P0-4 (perf audit): stable right-click opener for the Triage <EntryCard>
  // stack. `setGanttMenu` is a stable useState setter, so this never
  // re-creates — keeping the memo'd <EntryCard> from busting on unrelated
  // GanttView re-renders (zoom / range / export notice / menu state). (The
  // GanttRow onContextMenu closure is the same shape but is stabilized as
  // part of P1-5's GanttRow callback cleanup.)
  const openEntryMenu = useCallback(
    (entry: DirEntry, x: number, y: number) => {
      setGanttMenu({ entry, x, y });
    },
    []
  );

  // P1-5 (perf audit): stable GanttTimeline-bound handlers so memo'd
  // <GanttRow> children bail out on menu / notice state changes. Both depend
  // only on stable inputs (readOnly primitive + cellData's onSetEntryDateTag,
  // itself a FileList useCallback), so they never re-create.
  const handleDropEntry = useCallback(
    (entry: DirEntry, dayKey: string | null) => {
      if (!dayKey) return;
      if (readOnly) return;
      if (!data.onSetEntryDateTag) return;
      const tag = periodTagFromRange({ startKey: dayKey, endKey: dayKey });
      data.onSetEntryDateTag(entry, tag);
    },
    [readOnly, data.onSetEntryDateTag]
  );

  const handleCommit = useCallback(
    (entry: DirEntry, next: GanttPeriod) => {
      const tag = periodTagFromRange(next);
      data.onSetEntryDateTag?.(entry, tag);
    },
    [data.onSetEntryDateTag]
  );

  const menuSources = useMemo<DirEntry[]>(() => {
    if (!ganttMenu) return [];
    const selected = data.selectedPaths;
    if (selected && selected.has(ganttMenu.entry.path)) {
      return entries.filter((e) => selected.has(e.path));
    }
    return [ganttMenu.entry];
  }, [ganttMenu, entries, data.selectedPaths]);

  const menuCurrentTags = useMemo<string[]>(() => {
    if (!ganttMenu) return [];
    return tagsByName.get(ganttMenu.entry.path) ?? [];
  }, [ganttMenu, tagsByName]);

  /** True iff at least one of the menu's target sources is filtered
   *  out by the workflow/quadrant filters. The menu uses this to
   *  disable write actions — acting on a row the user just hid would
   *  be confusing (silent skip vs. partial apply).
   *
   *  Selection-aware: if the right-clicked entry is part of a multi-
   *  selection that includes a filtered entry, the whole batch is
   *  gated. The alternative (only operate on the non-filtered
   *  subset) is "partial apply" semantics that are harder to reason
   *  about for the user — and not what's documented in §9. */
  const menuHasFilteredSource = useMemo(() => {
    if (menuSources.length === 0) return false;
    for (const e of menuSources) {
      const tags = tagsByName.get(e.path) ?? [];
      if (isRowFilteredOut(tags)) return true;
    }
    return false;
  }, [menuSources, tagsByName, isRowFilteredOut]);

  const onMoreFileActions = useCallback(
    (entry: DirEntry, x: number, y: number) => {
      data.onMoreFileActions?.(entry, x, y);
    },
    [data.onMoreFileActions]
  );

  // ── Single-click on a taskbar pops the shared PeriodTagDialog, with
  // the entry's current period pre-filled AND anchored to the click
  // point so the dialog appears where the user clicked (instead of the
  // MUI default — centered, often at the very top of the viewport,
  // which feels disconnected from the bar they just clicked). Same
  // dialog the right-click menu's "Set period" item uses (see
  // GanttEntryMenu.openPeriod) — reusing it keeps a single source of
  // truth for date-tag editing and the互斥 family rule in
  // useListCommands runs as usual on commit.
  //
  // We keep `targetsRef` so the onConfirm closure (defined inside the
  // openDialog call) doesn't capture a stale `entry` if the user
  // opens the dialog, leaves it open, then re-opens for a different
  // entry — the ref is re-pointed at every open so the latest targets
  // win. Same pattern GanttEntryMenu uses.
  const { openDialog: openPeriodDialog } = usePeriodTagDialog();
  const periodTargetsRef = useRef<DirEntry[] | null>(null);
  const handleClickPeriod = useCallback(
    (entry: DirEntry, e: React.PointerEvent) => {
      if (readOnly) return;
      if (!data.onSetEntryDateTag) return;
      const period = entryPeriod(entry, tagsByName);
      if (!period) return;
      periodTargetsRef.current = [entry];
      openPeriodDialog({
        defaultStart: period.startKey,
        defaultEnd: period.endKey,
        // Anchor near the cursor: a small offset to the right + down so
        // the dialog doesn't sit under the cursor (which would hide
        // the start input on first paint). The dialog clamps itself to
        // the viewport in PeriodTagDialog so off-screen anchors still
        // produce a visible popup.
        anchorPosition: { top: e.clientY + 8, left: e.clientX + 8 },
        onConfirm: (compactPeriod) => {
          const targets = periodTargetsRef.current;
          periodTargetsRef.current = null;
          if (!targets) return;
          for (const t of targets) data.onSetEntryDateTag?.(t, compactPeriod);
        },
      });
    },
    [readOnly, tagsByName, data, openPeriodDialog]
  );

  // ── Triage drop — clears period (NOT onMoveToColumn). Invariant #3
  // in renderer/domain/gantt.ts ─
  // Also accepts native OS files: import them into the current directory
  // WITHOUT stamping a date tag (Triage = "no schedule", which matches the
  // internal-card semantics of clearing the period tag).
  const { importExternalFiles } = useIOActionsContext();
  const [{ isOver: triageIsOver, canDrop: triageCanDrop }, triageDropRef] =
    useDrop<
      FileDragItem | { files: File[] },
      unknown,
      { isOver: boolean; canDrop: boolean }
    >(() => ({
      accept: [DND_TYPE_FILE, NativeTypes.FILE],
      canDrop: () => !readOnly,
      drop: (item) => {
        if ('files' in item) {
          // Native: import only, no tag — matches the "Triage = no schedule"
          // mental model and the internal card behavior (which clears any
          // existing period tag without stamping a new one).
          importExternalFiles(item.files, { tagToApply: null }).catch(
            () => undefined
          );
          return;
        }
        const sources = item.paths
          .map(
            (p) =>
              data.resolveEntry?.(p) ?? data.entries.find((e) => e.path === p)
          )
          .filter(Boolean) as DirEntry[];
        if (sources.length === 0) return;
        for (const e of sources) data.onRemoveEntryDateTag?.(e);
      },
      collect: (monitor) => ({
        isOver: monitor.isOver(),
        canDrop: monitor.canDrop(),
      }),
    }),
    [
      data.entries,
      data.resolveEntry,
      readOnly,
      data.onRemoveEntryDateTag,
      importExternalFiles,
    ]
  );
  const triageDropActive = triageIsOver && triageCanDrop;

  // ── P0 #3: empty-state + breathing Triage pulse ───────────────────
  // When the timeline is empty but Triage still has cards, show the
  // richer hint AND a one-shot (per-session) breathing outline on the
  // Triage tray so the user knows where to drag from. The flag is
  // persisted to `sessionStorage` — survives in-app navigation
  // (Kanban ↔ Gantt ↔ Matrix) but resets on app restart. Trigger
  // re-runs whenever the empty+has-triage condition flips, so the
  // user gets another nudge after they re-enter an empty Gantt after
  // clearing their schedule.
  const SESSION_HINT_KEY = 'whale-gantt-triage-hint-shown';
  const [triageBreathing, setTriageBreathing] = useState(false);
  useEffect(() => {
    if (scheduled.length !== 0 || triage.length === 0) return undefined;
    if (typeof sessionStorage === 'undefined') return undefined;
    if (sessionStorage.getItem(SESSION_HINT_KEY) === '1') return undefined;
    sessionStorage.setItem(SESSION_HINT_KEY, '1');
    setTriageBreathing(true);
    const timer = window.setTimeout(() => setTriageBreathing(false), 3000);
    return () => window.clearTimeout(timer);
  }, [scheduled.length, triage.length]);

  return (
    <Box
      data-testid="gantt-view"
      sx={{
        height: '100%',
        width: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      {/* Toolbar: zoom picker + quick-range presets + workflow/quadrant
       * filters + Today jump.
       *
       * The two filter Selects are multi-select with a checkmark +
       * count chip rendering, mirroring the size + look of the zoom
       * Select. "Reset" appears only when at least one dimension is
       * partial (i.e. the user has actively un-selected something) —
       * pure default state hides it so the toolbar stays compact for
       * the common case. The "all rows filtered" Alert below the
       * toolbar tells the user *why* the chart is empty when they
       * overshoot. */}
      <Box
        sx={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          px: 1.5,
          py: 0.5,
          borderBottom: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
          height: 40,
        }}
      >
        <FormControl size="small" sx={{ minWidth: 96 }}>
          <Select
            data-testid="gantt-zoom"
            value={zoom}
            onChange={(e) => setZoom(e.target.value as GanttZoom)}
            inputProps={{ 'aria-label': t('ganttZoomLabel') }}
          >
            <MenuItem value="day" data-testid="gantt-zoom-day">
              {t('ganttZoomDay')}
            </MenuItem>
            <MenuItem value="week" data-testid="gantt-zoom-week">
              {t('ganttZoomWeek')}
            </MenuItem>
            <MenuItem value="month" data-testid="gantt-zoom-month">
              {t('ganttZoomMonth')}
            </MenuItem>
          </Select>
        </FormControl>

        {/* P1 #8: quick-range presets (1w / 2w / 1m / 1q). When selected,
            the range dictates the visible span; zoom still controls the
            pixel width of a day. Clicking the active preset again clears
            the override and falls back to the natural task range. */}
        <ToggleButtonGroup
          size="small"
          value={range}
          exclusive
          onChange={(_, value) => setRange((value as GanttRangePreset) ?? null)}
          aria-label={t('ganttRangeLabel')}
          data-testid="gantt-range"
        >
          {(['1w', '2w', '1m', '1q'] as GanttRangePreset[]).map((r) => (
            <ToggleButton
              key={r}
              value={r}
              data-testid={`gantt-range-${r}`}
              aria-label={t(RANGE_LABEL_KEYS[r])}
              sx={{ textTransform: 'none', px: 1.5, minWidth: 36 }}
            >
              {t(RANGE_LABEL_KEYS[r])}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        {/* Spacer pushes the right-side action group (filters + Today)
            to the far end of the toolbar — matches the standard pattern
            "left = orientation, right = actions". */}
        <Box sx={{ flex: 1 }} />

        {/* ─── Workflow filter (P0 #5) ───
            Multi-select dropdown; empty selection = nothing passes. */}
        <FormControl size="small" sx={{ minWidth: 130 }}>
          <Select
            multiple
            displayEmpty
            data-testid="gantt-filter-workflow"
            value={Array.from(workflowFilter.selected)}
            onChange={(e) => {
              // MUI multi-select gives us the full new value array; we
              // diff against the previous state to derive toggles, so
              // each click only writes one new prefs entry. The hook's
              // `toggle` is the public API for that; here we use
              // `setAll` for simplicity (one prefs write per menu
              // change instead of N), which is fine because the menu
              // only commits on close.
              const next = new Set(e.target.value as string[]);
              const prev = workflowFilter.selected;
              // Compute symmetric diff → call toggle once per flipped
              // value. This keeps the hook's invariant ("toggle is
              // the only mutation API") intact at the call site.
              for (const v of prev) if (!next.has(v)) workflowFilter.toggle(v);
              for (const v of next) if (!prev.has(v)) workflowFilter.toggle(v);
            }}
            inputProps={{ 'aria-label': t('ganttFilterWorkflow') }}
            renderValue={(selected) => {
              const arr = selected as string[];
              if (arr.length === 0) {
                return (
                  <Typography variant="body2" color="text.disabled">
                    {t('ganttFilterNone')}
                  </Typography>
                );
              }
              if (arr.length === stageValues.length) {
                return (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <FilterAltIcon fontSize="small" color="action" />
                    <Typography variant="body2">
                      {t('ganttFilterAll')}
                    </Typography>
                  </Box>
                );
              }
              return (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <FilterAltIcon fontSize="small" color="primary" />
                  <Typography variant="body2">{arr.length}</Typography>
                </Box>
              );
            }}
          >
            {stageValues.map((sv) => {
              const checked = workflowFilter.selected.has(sv);
              const color = getTagColor(sv, tagColors, groups);
              return (
                <MenuItem
                  key={sv}
                  value={sv}
                  data-testid={`gantt-filter-workflow-${sv}`}
                  dense
                >
                  {checked ? (
                    <CheckIcon fontSize="small" sx={{ mr: 1 }} />
                  ) : (
                    <Box
                      sx={{
                        width: 18,
                        height: 18,
                        mr: 1,
                        borderRadius: '50%',
                        bgcolor: color ?? 'text.disabled',
                      }}
                    />
                  )}
                  <ListItemText>{tagDisplayLabel(sv, t)}</ListItemText>
                </MenuItem>
              );
            })}
          </Select>
        </FormControl>

        {/* ─── Quadrant filter (P0 #6) ───
            Same multi-select pattern as workflow; the four values are
            fixed (URGENT×IMPORTANT matrix), so no `knownValues` race. */}
        <FormControl size="small" sx={{ minWidth: 130 }}>
          <Select
            multiple
            displayEmpty
            data-testid="gantt-filter-quadrant"
            value={Array.from(quadrantFilter.selected)}
            onChange={(e) => {
              const next = new Set(e.target.value as string[]);
              const prev = quadrantFilter.selected;
              for (const v of prev) if (!next.has(v)) quadrantFilter.toggle(v);
              for (const v of next) if (!prev.has(v)) quadrantFilter.toggle(v);
            }}
            inputProps={{ 'aria-label': t('ganttFilterQuadrant') }}
            renderValue={(selected) => {
              const arr = selected as string[];
              if (arr.length === 0) {
                return (
                  <Typography variant="body2" color="text.disabled">
                    {t('ganttFilterNone')}
                  </Typography>
                );
              }
              if (arr.length === QUADRANT_VALUES.length) {
                return (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <FilterAltIcon fontSize="small" color="action" />
                    <Typography variant="body2">
                      {t('ganttFilterAll')}
                    </Typography>
                  </Box>
                );
              }
              return (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <FilterAltIcon fontSize="small" color="primary" />
                  <Typography variant="body2">{arr.length}</Typography>
                </Box>
              );
            }}
          >
            {QUADRANT_VALUES.map((q) => {
              const checked = quadrantFilter.selected.has(q);
              const color = QUADRANT_COLORS[q] ?? 'text.disabled';
              return (
                <MenuItem
                  key={q}
                  value={q}
                  data-testid={`gantt-filter-quadrant-${q}`}
                  dense
                >
                  {checked ? (
                    <CheckIcon fontSize="small" sx={{ mr: 1 }} />
                  ) : (
                    <Box
                      sx={{
                        width: 18,
                        height: 18,
                        mr: 1,
                        borderRadius: '50%',
                        bgcolor: color,
                      }}
                    />
                  )}
                  <ListItemText>{tagDisplayLabel(q, t)}</ListItemText>
                </MenuItem>
              );
            })}
          </Select>
        </FormControl>

        {/* "Reset" button — visible only when at least one dimension
            has been narrowed (i.e. NOT the default "all"). Click → both
            dimensions back to "all". Persists via the hook's setAll. */}
        {(() => {
          const workflowNarrowed =
            workflowFilter.selected.size < stageValues.length;
          const quadrantNarrowed =
            quadrantFilter.selected.size < QUADRANT_VALUES.length;
          if (!workflowNarrowed && !quadrantNarrowed) return null;
          return (
            <Tooltip title={t('ganttFilterReset')}>
              <Button
                size="small"
                variant="text"
                onClick={() => {
                  workflowFilter.setAll(stageValues);
                  quadrantFilter.setAll(QUADRANT_VALUES);
                }}
                data-testid="gantt-filter-reset"
                sx={{ minWidth: 'auto', textTransform: 'none' }}
              >
                {t('ganttFilterReset')}
              </Button>
            </Tooltip>
          );
        })()}

        {/* P1 #9: PNG export cluster — mirrors Calendar's toolbar pattern.
            Capture target is the inner chart-content Box (no scrollbars). */}
        <Tooltip title={exportError ? t('ganttExportFail') : t('saveImage')}>
          <span>
            <IconButton
              size="small"
              onClick={() => void handleSave()}
              disabled={exporting}
              aria-label={t('saveImage')}
              data-testid="gantt-export-save"
            >
              <SaveIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={exportError ? t('ganttExportFail') : t('saveImageAs')}>
          <span>
            <IconButton
              size="small"
              onClick={() => void handleSaveAs()}
              disabled={exporting}
              aria-label={t('saveImageAs')}
              data-testid="gantt-export-save-as"
            >
              <DriveFileMoveIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={exportError ? t('ganttExportFail') : t('calendarCopyImage')}>
          <span>
            <IconButton
              size="small"
              onClick={() => void onCopyGanttToClipboard()}
              disabled={exporting}
              aria-label={t('calendarCopyImage')}
              data-testid="gantt-export-copy"
            >
              <ContentCopyIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip title={t('ganttToday')}>
          <span>
            <IconButton
              size="small"
              onClick={scrollToToday}
              aria-label={t('ganttToday')}
              data-testid="gantt-today"
            >
              <TodayIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Box>

      {/* Timeline (pure-DOM, with scroller ref forwarded for the
          scroll-to-Today callback). */}
      {allFilteredOut ? (
        <Box
          data-testid="gantt-filtered-empty"
          sx={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1.5,
            px: 2,
            py: 1,
            bgcolor: 'warning.main',
            color: 'warning.contrastText',
          }}
        >
          <Typography variant="body2">{t('ganttFilteredEmpty')}</Typography>
          <Button
            size="small"
            variant="contained"
            color="inherit"
            onClick={() => {
              workflowFilter.setAll(stageValues);
              quadrantFilter.setAll(QUADRANT_VALUES);
            }}
            data-testid="gantt-filtered-empty-reset"
            sx={{ textTransform: 'none' }}
          >
            {t('ganttFilterReset')}
          </Button>
        </Box>
      ) : null}
      <GanttTimeline
        scrollerRef={scrollerRef}
        scheduled={scheduled}
        scale={scale}
        pxPerDay={pxPerDay}
        readOnly={readOnly}
        entries={entries}
        t={t}
        thumbCache={thumbCache}
        tagColors={tagColors}
        tagsByName={tagsByName}
        groups={groups}
        activeTag={activeTag}
        isRowFilteredOut={isRowFilteredOut}
        stages={stages}
        onClickTag={onClickTag}
        onTagContextMenu={onTagContextMenu}
        onOpen={data.onOpen}
        // Drop target for unscheduled files: GanttTimeline resolves the
        // drag item to DirEntry[] + a dayKey under the cursor; we just
        // translate to a 1-day period (startKey=endKey=dayKey) and
        // route through `data.onSetEntryDateTag` so the互斥 family rule
        // (one period per file) and any sidecar persistence run as usual.
        // `dayKey === null` means the cursor was over the thumb column
        // or past the chart's right edge — we treat that as a no-op
        // (GanttTimeline also bails when the scroller ref is unmounted,
        // which covers the rare race during fast unmounts).
        // P1-5: stabilized as `handleDropEntry` so memo'd <GanttRow> bails
        // out on unrelated re-renders.
        onDropEntry={handleDropEntry}
        resolveEntry={data.resolveEntry}
        // Single-click on a taskbar opens the period-edit dialog
        // (populated with the entry's current start/end). Drag-to-move
        // / drag-to-resize commit through `onCommit` unchanged. File
        // opening moves to right-click → GanttEntryMenu → "Open" (or
        // any external double-click handler the parent may wire up).
        onClick={handleClickPeriod}
        onCommit={handleCommit}
        onContextMenu={openEntryMenu}
        colorFor={colorFor}
        hasTriageHint={triage.length > 0}
        // P1 #9: ref to the inner chart-content Box for PNG export.
        exportRef={exportRef}
        // P0 #4: keyboard 'T' shortcut reuses the toolbar Today button
        // handler — same scroll math, same behavior.
        onJumpToToday={scrollToToday}
      />

      {/* Triage: entries with no period. Same horizontal-card tray pattern
          Matrix's UntaggedTray uses. Always rendered — a tray that vanishes
          when empty leaves no drop target to drag a bar back to unscheduled. */}
      {(
        <Box
          ref={triageDropRef}
          data-testid="gantt-triage"
          sx={{
            flexShrink: 0,
            maxHeight: 160,
            display: 'flex',
            flexDirection: 'column',
            borderTop: 1,
            borderColor: 'divider',
            bgcolor: triageDropActive ? 'action.hover' : 'action.selected',
            outline: triageDropActive ? 2 : 0,
            outlineColor: 'primary.main',
            outlineOffset: -2,
            // P0 #3: one-shot per-session breathing outline (3s) when the
            // user first lands on an empty Gantt with triage cards waiting.
            // The keyframes are emitted inline so we don't need a separate
            // stylesheet; MUI's `sx` accepts a `keyframes` object via
            // emotion. The animation self-removes when `triageBreathing`
            // flips back to false.
            ...(triageBreathing
              ? {
                  animation: 'whale-gantt-breath 1.2s ease-in-out 0s 3',
                  '@keyframes whale-gantt-breath': {
                    '0%, 100%': { outlineColor: 'transparent' },
                    '50%': { outlineColor: 'primary.main' },
                  },
                }
              : null),
          }}
        >
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              px: 1.5,
              py: 0.75,
              flexShrink: 0,
            }}
          >
            <Typography variant="subtitle2" noWrap sx={{ flex: 1, minWidth: 0 }}>
              {t('ganttNoSchedule')}
            </Typography>
            {readOnly ? (
              <Tooltip title={t('readOnly')}>
                <LockOutlinedIcon
                  fontSize="small"
                  color="disabled"
                  data-testid="gantt-triage-readonly"
                />
              </Tooltip>
            ) : null}
            <Chip label={triage.length} size="small" variant="outlined" />
          </Box>
          <Box
            sx={{
              flex: 1,
              minHeight: 0,
              overflowX: 'auto',
              overflowY: 'hidden',
              display: 'flex',
              gap: 1,
              px: 1,
              pb: 1,
              alignItems: 'flex-start',
            }}
          >
            {triage.length === 0 ? (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ px: 0.5, py: 1 }}
              >
                {t('ganttTriageEmpty')}
              </Typography>
            ) : (
              triage.map((entry) => (
                <Box key={entry.path} sx={{ width: 220, flexShrink: 0 }}>
                  <EntryCard
                    entry={entry}
                    data={data}
                    renderContextMenu={openEntryMenu}
                  />
                </Box>
              ))
            )}
          </Box>
        </Box>
      )}

      {/* Domain right-click menu. Identical props to the legacy view. */}
      <GanttEntryMenu
        ctx={ganttMenu}
        onClose={() => setGanttMenu(null)}
        stageValues={stageValues}
        tagColors={data.tagColors}
        groups={data.groups}
        sources={menuSources}
        currentTags={menuCurrentTags}
        t={data.t}
        readOnly={data.readOnly}
        // P0 #5/#6: gate write actions when any source is filtered
        // out (acts as "selectively disabled" without conflating with
        // the location-level readOnly).
        hasFilteredSource={menuHasFilteredSource}
        onMoveToColumn={onMoveToColumn}
        onAddTag={(entry, tag) => data.onAddTag?.(entry, tag)}
        onRemoveTag={(entry, tag) => data.onRemoveTag?.(entry, tag)}
        onSetEntryDateTag={(entry, tag) =>
          data.onSetEntryDateTag?.(entry, tag)
        }
        onRemoveEntryDateTag={(entry) =>
          data.onRemoveEntryDateTag?.(entry)
        }
        onOpen={(entry) => data.onOpen(entry)}
        onDelete={(entry) => data.onDelete(entry)}
        onMoreFileActions={onMoreFileActions}
      />

      {/* P1 #9: PNG export notice (mirrors CalendarView's snackbar). The
          state is set inside `onCopyGanttToClipboard`; the Snackbar itself
          is autoHide so it doesn't persist after a click. The save / save-as
          buttons rely on the `exportError` tooltip for failure feedback
          rather than surfacing a notice here — the dialog / write result
          already speaks for itself. */}
      <Snackbar
        open={exportNotice !== null}
        autoHideDuration={2400}
        onClose={() => setExportNotice(null)}
        message={exportNotice ?? ''}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  );
}
