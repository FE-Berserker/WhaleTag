import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Box,
  FormControl,
  IconButton,
  InputAdornment,
  InputLabel,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Select,
  Slider,
  Snackbar,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import CloudIcon from '@mui/icons-material/Cloud';
import SaveIcon from '@mui/icons-material/Save';
import DriveFileMoveIcon from '@mui/icons-material/DriveFileMove';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import SearchIcon from '@mui/icons-material/Search';
import CloseIcon from '@mui/icons-material/Close';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import GridViewIcon from '@mui/icons-material/GridView';
import ReactECharts from 'echarts-for-react';
// `echarts` is the on-demand configured instance (BarChart + HeatmapChart
// + TreemapChart + SunburstChart + 5 components + Canvas + SVG renderers,
// plus the `echarts-wordcloud` layout side-effect imported from
// `services/echarts-setup`). Replaces the previous `import * as echarts
// from 'echarts'` which pulled the full UMD distribution (~1 MB).
import { echarts } from '../services/echarts-setup';

import { tagCloudData, tagCooccurrenceMatrix, type TagCategory } from '../domain/tagcloud';
import { getTagColor } from '../domain/tag-colors';
import {
  CATEGORY_LABEL_KEY,
  DEFAULT_SHOWN_CATEGORIES,
  FILTERABLE_CATEGORIES,
  readPrefs,
  sanitizeShownCategories,
  writePrefs,
} from '../domain/perspective-prefs';
import { geoTagDisplayLabel, tagDisplayLabel } from '-/services/tag-display';
import { useDirectoryUI } from '-/hooks/DirectoryContentContextProvider';
import { useCurrentLocationContext } from '-/hooks/CurrentLocationContextProvider';
import { useImageExport, base64FromDataUrl } from '-/hooks/useImageExport';
import LoadingOverlay from '-/components/perspective/LoadingOverlay';
import EmptyHint from '-/components/perspective/EmptyHint';
import ErrorBanner from '-/components/perspective/ErrorBanner';
import type { FileCellData } from '-/components/file-cell';

interface TagCloudViewProps {
  /** The shared per-cell handler bag from FileList. */
  data: FileCellData;
}

/** Default font-size band (px). Used when the container hasn't been measured yet
 *  (P1-4 takes over once ResizeObserver reports the first size). */
const SIZE_RANGE_DEFAULT: [number, number] = [14, 72];
/** Hard cap on words — even with the slider set to "Unlimited" we never hand
 *  echarts-wordcloud more than this (it gets unreadable past ~1k). */
const MAX_WORDS_HARD_CAP = 1000;

/** Discrete options for the max-words slider (P1-2). */
const MAX_WORDS_OPTIONS = [100, 200, 300, 500, MAX_WORDS_HARD_CAP] as const;
/** Slider step uses index positions; mark labels show the actual word counts. */
const MAX_WORDS_DEFAULT_INDEX = 2; // 300

/** Shapes echarts-wordcloud natively supports (P1-3). */
const SHAPES = [
  'circle',
  'square',
  'diamond',
  'triangle',
  'pentagon',
  'star',
] as const;
type CloudShape = (typeof SHAPES)[number];

const SHAPE_LABEL: Record<CloudShape, string> = {
  circle: 'tagCloudShapeCircle',
  square: 'tagCloudShapeSquare',
  diamond: 'tagCloudShapeDiamond',
  triangle: 'tagCloudShapeTriangle',
  pentagon: 'tagCloudShapePentagon',
  star: 'tagCloudShapeStar',
};

/**
 * Fallback color for tags with no user/group/smart-tag color. Light-on-paper
 * in light mode, light-on-ink in dark mode so uncolored words stay readable
 * either way (P0-3, plan §H.22).
 */
const FALLBACK_COLOR_LIGHT = '#7e9cd8';
const FALLBACK_COLOR_DARK = '#a8c0e8';

/** How many top tags the keyboard-accessible jump Select lists (P1-5). */
const JUMP_LIST_SIZE = 50;
/** Maximum number of tags shown on the co-occurrence matrix axes. Larger values
 *  make the heatmap unreadable on normal monitors. */
const MATRIX_TAG_LIMIT = 40;
/** The two display modes for this perspective. */
type TagCloudViewMode = 'cloud' | 'matrix';

// localStorage key shape: `whale.tagCloud.${locationId}` → TagCloudPrefs.
// Persisted per-location (plan §H.22 P2-2, mirroring FolderViz §H.20 D) so a
// user with multiple Whale locations keeps independent cloud preferences.
const PREFS_KEY_PREFIX = 'whale.tagCloud.';

interface TagCloudPrefs {
  shown: TagCategory[];
  shape: CloudShape;
  maxWordsIdx: number;
  layoutAnimation: boolean;
  view?: TagCloudViewMode;
}

/**
 * TagCloud perspective: render the tags of the current directory's visible
 * files as a word cloud, sizing each tag by how many files carry it (square
 * root scale). Colors and labels match the list/grid chips; clicking a word
 * toggles it as the active tag filter. A category filter hides smart tags
 * (workflow/priority/date) that carry no meaning in a frequency cloud.
 *
 * H.13 adds a depth slider: depth 1 uses the current directory; deeper levels
 * recursively include subdirectories.
 * H.22 §P1 adds: search box, max-words slider, shape picker, layoutAnimation
 * toggle, copy-to-clipboard, right-click "copy tag / filter by tag", and a
 * ResizeObserver-driven auto-fit font-size band.
 */
export default function TagCloudView({ data }: TagCloudViewProps) {
  const {
    entries,
    tagsByName,
    tagColors,
    groups,
    activeTag,
    onClickTag,
    readOnly,
    t,
  } = data;
  const theme = useTheme();
  const { currentLocation } = useCurrentLocationContext();
  const chartRef = useRef<ReactECharts>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // P0-3: fallback word color follows theme so uncolored tags stay legible in
  // both modes (plan §H.22). Recomputed per-render because theme is reactive.
  const FALLBACK_COLOR =
    theme.palette.mode === 'dark' ? FALLBACK_COLOR_DARK : FALLBACK_COLOR_LIGHT;

  const [shown, setShown] = useState<TagCategory[]>(DEFAULT_SHOWN_CATEGORIES);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<TagCloudViewMode>('cloud');
  const [maxWordsIdx, setMaxWordsIdx] = useState(MAX_WORDS_DEFAULT_INDEX);
  const [shape, setShape] = useState<CloudShape>('circle');
  const [layoutAnimation, setLayoutAnimation] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    tag?: string;
  } | null>(null);
  // H.24 R4: depth now comes from the global `viewDepth` setting via the
  // directory content context (debounced + path-keyed there). No more local
  // slider or per-view recursion — the cloud consumes the same single source
  // as the list, so clicking a word always filters against a consistent set.
  // The recursive-scan truncation banner is rendered once at the FileList
  // level, so individual views only need the `loading` flag here.
  const { loading } = useDirectoryUI();

  // P2-2: keep a live ref to the latest prefs so the unmount cleanup can flush
  // them immediately. This prevents losing a just-toggled filter when the user
  // switches perspectives within the 200ms debounce window.
  const prefsRef = useRef<TagCloudPrefs>({
    shown,
    shape,
    maxWordsIdx,
    layoutAnimation,
    view,
  });
  useEffect(() => {
    prefsRef.current = { shown, shape, maxWordsIdx, layoutAnimation, view };
  });

  // P2-2: restore persisted prefs when the location changes (mount + cross-
  // location switch). Mirrors FolderViz: each setter is guarded by a sanitizer
  // so a corrupt / out-of-range stored value falls back to the current default
  // instead of breaking the view. Same-location subdirectory navigation keeps
  // the deps stable, so prefs survive `navigateTo` within a location.
  useEffect(() => {
    const id = currentLocation?.id;
    if (!id) return;
    const prefs = readPrefs<TagCloudPrefs>(PREFS_KEY_PREFIX + id);
    if (!prefs) return;
    const shownV = sanitizeShownCategories(prefs.shown);
    if (shownV !== null) setShown(shownV);
    if (typeof prefs.shape === 'string' && (SHAPES as readonly string[]).includes(prefs.shape)) {
      setShape(prefs.shape);
    }
    if (
      typeof prefs.maxWordsIdx === 'number' &&
      prefs.maxWordsIdx >= 0 &&
      prefs.maxWordsIdx < MAX_WORDS_OPTIONS.length
    ) {
      setMaxWordsIdx(prefs.maxWordsIdx);
    }
    if (typeof prefs.layoutAnimation === 'boolean') setLayoutAnimation(prefs.layoutAnimation);
    if (prefs.view === 'cloud' || prefs.view === 'matrix') setView(prefs.view);
  }, [currentLocation?.id]);

  // P2-2: persist prefs 200ms after the last change (debounced so dragging the
  // depth / max-words sliders doesn't hammer localStorage). The cleanup flushes
  // the latest prefs on unmount so quick perspective switches don't lose the
  // most recent filter toggle.
  useEffect(() => {
    const id = currentLocation?.id;
    if (!id) return undefined;
    const handle = window.setTimeout(() => {
      writePrefs<TagCloudPrefs>(PREFS_KEY_PREFIX + id, prefsRef.current);
    }, 200);
    return () => {
      window.clearTimeout(handle);
      writePrefs<TagCloudPrefs>(PREFS_KEY_PREFIX + id, prefsRef.current);
    };
  }, [currentLocation?.id, shown, shape, maxWordsIdx, layoutAnimation, view]);

  // P1-1: defer the search filter so each keystroke doesn't force a re-render
  // of the cloud. Cheap relative to the echarts layout, but keeps the toolbar
  // responsive on large clouds.
  const deferredSearch = useDeferredValue(search);
  const maxWords = MAX_WORDS_OPTIONS[maxWordsIdx];

  // One {name(label), value(sqrt), count, rawTag, color} item per distinct tag.
  const words = useMemo(() => {
    const lists = entries.map((e) => tagsByName.get(e.path));
    const exclude = FILTERABLE_CATEGORIES.filter((c) => !shown.includes(c));
    return tagCloudData(lists, { scale: 'sqrt', limit: maxWords, exclude }).map((d) => ({
      // P0-1: geo tags → 📍 coords (i18n key) instead of the raw `geo:lat,lng`
      // token. tagDisplayLabel handles everything else (date smart tags fall
      // through to today / this month via the smartFunctionalityOfTag branch).
      name: geoTagDisplayLabel(d.name, t) ?? tagDisplayLabel(d.name, t),
      value: d.value,
      count: d.count,
      rawTag: d.name,
      color: getTagColor(d.name, tagColors, groups) ?? FALLBACK_COLOR,
    }));
  }, [entries, tagsByName, tagColors, groups, shown, maxWords, t, FALLBACK_COLOR]);

  // Square co-occurrence matrix for the matrix view. Axis labels are the top-N
  // most frequent tags after applying the same category filter as the cloud.
  const matrixData = useMemo(() => {
    const lists = entries.map((e) => tagsByName.get(e.path));
    const exclude = FILTERABLE_CATEGORIES.filter((c) => !shown.includes(c));
    return tagCooccurrenceMatrix(lists, { limit: MATRIX_TAG_LIMIT, exclude });
  }, [entries, tagsByName, shown]);

  // Labels used on both axes of the matrix (same localized display form as the
  // cloud words).
  const matrixLabels = useMemo(
    () =>
      matrixData.tags.map(
        (tag) => geoTagDisplayLabel(tag, t) ?? tagDisplayLabel(tag, t)
      ),
    [matrixData.tags, t]
  );

  // P1-1 + P1-2 + P1-3: filtered list. Two-stage filter so the search box can
  // match the *display* label (e.g. user searches "今天" finds `today-20251223`)
  // and not just the raw stored value.
  const filteredWords = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    if (!needle) return words;
    return words.filter((w) => w.name.toLowerCase().includes(needle));
  }, [words, deferredSearch]);

  // P1-4: track container size and scale SIZE_RANGE off the smaller edge so
  // words stay readable when the panel is small (and don't grow past 72px on a
  // 4K monitor — `Math.min(width, height) / 12` caps the band reasonably).
  const [sizeRange, setSizeRange] = useState<[number, number]>(SIZE_RANGE_DEFAULT);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const recompute = () => {
      const { width, height } = el.getBoundingClientRect();
      const base = Math.min(width, height);
      if (base <= 0) return;
      // Headline size scales linearly with the shorter edge; clamp so a tiny
      // panel still gives the smallest word a fighting chance to render.
      const headline = Math.max(14, Math.min(72, Math.round(base / 12)));
      const tail = Math.max(10, Math.round(headline * 0.4));
      setSizeRange([tail, headline]);
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const option = useMemo(
    () => ({
      tooltip: {
        show: true,
        formatter: (params: any) =>
          `${params.name}<br/>${t('tagCloudCount', { count: params.data?.count ?? 0 })}`,
      },
      series: [
        {
          type: 'wordCloud',
          shape,
          left: 'center',
          top: 'center',
          width: '96%',
          height: '92%',
          sizeRange,
          rotationRange: [0, 0],
          gridSize: 10,
          drawOutOfBound: false,
          shrinkToFit: true,
          layoutAnimation,
          textStyle: {
            fontWeight: 600,
            color: (params: any) =>
              params.data?.rawTag === activeTag
                ? '#ffffff'
                : params.data?.color ?? FALLBACK_COLOR,
          },
          emphasis: {
            textStyle: { fontWeight: 800 },
          },
          data: filteredWords,
        },
      ],
    }),
    [filteredWords, activeTag, t, shape, sizeRange, layoutAnimation, FALLBACK_COLOR]
  );

  // ECharts heatmap option for the co-occurrence matrix view. Uses the same
  // localized tag labels as the cloud and shares the chart ref / export path.
  const matrixOption = useMemo(() => {
    const { tags, matrix } = matrixData;
    const data: [number, number, number][] = [];
    let maxCount = 0;
    for (let i = 0; i < tags.length; i += 1) {
      for (let j = 0; j < tags.length; j += 1) {
        const count = matrix[i]?.[j] ?? 0;
        data.push([i, j, count]);
        if (count > maxCount) maxCount = count;
      }
    }
    return {
      tooltip: {
        formatter: (params: any) => {
          const i = params.data[0] as number;
          const j = params.data[1] as number;
          const count = params.data[2] as number;
          if (i === j) {
            return `${matrixLabels[i]}<br/>${t('tagCloudCount', { count })}`;
          }
          return `${matrixLabels[i]} + ${matrixLabels[j]}<br/>${t('tagCloudCooccurrenceCount', { count })}`;
        },
      },
      grid: { top: 16, right: 16, bottom: 128, left: 128 },
      xAxis: {
        type: 'category',
        data: matrixLabels,
        splitArea: { show: true },
        axisLabel: { rotate: 45, interval: 0 },
      },
      yAxis: {
        type: 'category',
        data: matrixLabels,
        splitArea: { show: true },
        axisLabel: { interval: 0 },
      },
      visualMap: {
        min: 0,
        max: Math.max(1, maxCount),
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 16,
        itemWidth: 16,
        itemHeight: 80,
        inRange: {
          color: [
            theme.palette.background.paper,
            theme.palette.primary.light,
            theme.palette.primary.main,
            theme.palette.primary.dark,
          ],
        },
      },
      series: [
        {
          type: 'heatmap',
          data,
          label: { show: true, fontSize: 10 },
          emphasis: {
            itemStyle: { shadowBlur: 8, shadowColor: 'rgba(0,0,0,0.5)' },
          },
        },
      ],
    };
  }, [matrixData, matrixLabels, t, theme]);

  const getChartDataUrl = useCallback((): string | null => {
    const instance = chartRef.current?.getEchartsInstance();
    if (!instance) return null;
    return instance.getDataURL({
      type: 'png',
      pixelRatio: 2,
      backgroundColor: theme.palette.background.paper,
    });
  }, [theme]);

  const {
    saving,
    error,
    handleSave,
    handleSaveAs,
    handleCopyToClipboard,
  } = useImageExport({
    capture: useCallback(async () => {
      const url = getChartDataUrl();
      return url ? base64FromDataUrl(url) : null;
    }, [getChartDataUrl]),
    // P2-5: scope the auto-generated filename to the location so two locations'
    // exported clouds don't overwrite each other in the same directory.
    prefix: `tag-cloud-${currentLocation?.id ?? 'default'}`,
  });

  // P1-7: copy-to-clipboard with tailored notice. The hook returns 'image'
  // when the structured clipboard accepted the PNG blob, or 'text' when we
  // fell back to a base64 string — surface a different message for each so the
  // user knows whether they got a real image or something to paste manually.
  const onCopyToClipboard = useCallback(async () => {
    try {
      const kind = await handleCopyToClipboard();
      setNotice(kind === 'image' ? t('tagCloudCopied') : t('tagCloudCopiedAsBase64'));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }, [handleCopyToClipboard, t]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);

  // P1-6: when the right-click landed on a specific word, record which tag so
  // the menu can offer tag-specific actions (copy / filter-by-tag) in
  // addition to the chart-wide save / copy-to-clipboard options.
  const onEvents = useMemo(
    () => ({
      click: (params: any) => {
        const tag: string | undefined = params.data?.rawTag;
        if (tag) onClickTag(tag);
      },
      contextmenu: (params: any) => {
        const evt = params?.event?.event as MouseEvent | undefined;
        if (!evt) return;
        evt.preventDefault();
        evt.stopPropagation();
        setCtxMenu({
          x: evt.clientX,
          y: evt.clientY,
          tag: params.data?.rawTag,
        });
      },
    }),
    [onClickTag]
  );

  // Matrix interactions: clicking any cell filters by the row tag; right-click
  // opens the tag-specific context menu for the row tag.
  const onMatrixEvents = useMemo(
    () => ({
      click: (params: any) => {
        const i = params.data?.[0] as number | undefined;
        const tag = typeof i === 'number' ? matrixData.tags[i] : undefined;
        if (tag) onClickTag(tag);
      },
      contextmenu: (params: any) => {
        const evt = params?.event?.event as MouseEvent | undefined;
        if (!evt) return;
        evt.preventDefault();
        evt.stopPropagation();
        const i = params.data?.[0] as number | undefined;
        const tag = typeof i === 'number' ? matrixData.tags[i] : undefined;
        setCtxMenu({ x: evt.clientX, y: evt.clientY, tag });
      },
    }),
    [matrixData.tags, onClickTag]
  );

  const filtered = deferredSearch.trim().length > 0;
  const isChartEmpty =
    view === 'matrix' ? matrixData.tags.length === 0 : filteredWords.length === 0;

  return (
    <Box
      onContextMenu={handleContextMenu}
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
      <Stack
        direction="row"
        sx={{ alignItems: 'center', gap: 1.5, flexShrink: 0, flexWrap: 'wrap' }}
      >
        <CloudIcon color="action" />
        <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
          {t('tagCloud')}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {view === 'cloud'
            ? t('tagCloudSummary', { count: filteredWords.length })
            : t('tagCloudMatrixSummary', { count: matrixData.tags.length })}
        </Typography>

        <Box sx={{ flex: 1 }} />

        <ToggleButtonGroup
          size="small"
          value={view}
          exclusive
          onChange={(_e, next: TagCloudViewMode) => {
            if (next) setView(next);
          }}
          aria-label={t('tagCloudViewMode')}
        >
          <ToggleButton value="cloud" sx={{ px: 1, py: 0.25 }}>
            <CloudIcon fontSize="small" sx={{ mr: 0.5 }} />
            {t('tagCloudViewCloud')}
          </ToggleButton>
          <ToggleButton value="matrix" sx={{ px: 1, py: 0.25 }}>
            <GridViewIcon fontSize="small" sx={{ mr: 0.5 }} />
            {t('tagCloudViewMatrix')}
          </ToggleButton>
        </ToggleButtonGroup>

        <ToggleButtonGroup
          size="small"
          value={shown}
          onChange={(_e, next: TagCategory[]) => setShown(next)}
          aria-label={t('tagCloudFilter')}
        >
          {FILTERABLE_CATEGORIES.map((cat) => (
            <ToggleButton key={cat} value={cat} sx={{ px: 1, py: 0.25 }}>
              {t(CATEGORY_LABEL_KEY[cat])}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        {view === 'cloud' && (
          <>
            {/* P1-1: search. The TextField's clear button (×) shows only when
                non-empty; the needle is matched against the rendered label so
                searching "今天" surfaces date smart tags and "📍" surfaces geo.
                MUI v9 wants `slotProps.input.{start,end}Adornment` instead of
                the deprecated `InputProps` prop. */}
            <TextField
              size="small"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('tagCloudSearchPlaceholder')}
              sx={{ width: 180 }}
              slotProps={{
                htmlInput: { 'aria-label': t('tagCloudSearch') },
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" color="action" />
                    </InputAdornment>
                  ),
                  endAdornment: search ? (
                    <InputAdornment position="end">
                      <IconButton
                        size="small"
                        aria-label="clear"
                        onClick={() => setSearch('')}
                      >
                        <CloseIcon fontSize="small" />
                      </IconButton>
                    </InputAdornment>
                  ) : null,
                },
              }}
            />

            {/* P1-5: keyboard-accessible tag picker. echarts-wordcloud renders to a
                canvas (no DOM nodes to tab to), so this Select is the a11y entry
                point — arrow keys move through the top tags, Enter activates the
                highlighted one (equivalent to clicking the word). Lists the top
                JUMP_LIST_SIZE of the *filtered* words so it tracks the search box. */}
            <FormControl size="small" sx={{ minWidth: 150 }}>
              <InputLabel id="tag-cloud-jump-label" shrink>
                {t('tagCloudJumpToTag')}
              </InputLabel>
              <Select
                labelId="tag-cloud-jump-label"
                label={t('tagCloudJumpToTag')}
                value=""
                displayEmpty
                renderValue={() => '—'}
                disabled={filteredWords.length === 0}
                onChange={(e) => {
                  const tag = e.target.value;
                  if (tag) onClickTag(tag);
                }}
              >
                <MenuItem value="" disabled>
                  —
                </MenuItem>
                {filteredWords.slice(0, JUMP_LIST_SIZE).map((w) => (
                  <MenuItem key={w.rawTag} value={w.rawTag}>
                    {`${w.name} (${w.count})`}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            {/* P1-2: max-words slider over a discrete set of options. The slider's
                numeric value is an index into MAX_WORDS_OPTIONS; the label shows
                the actual word count so the user knows what 3 means. */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0, minWidth: 180 }}>
              <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                {t('tagCloudMaxWords')}
              </Typography>
              <Slider
                size="small"
                min={0}
                max={MAX_WORDS_OPTIONS.length - 1}
                step={1}
                value={maxWordsIdx}
                onChange={(_e, v) => setMaxWordsIdx(v as number)}
                marks={MAX_WORDS_OPTIONS.map((n, i) => ({ value: i, label: String(n) }))}
                sx={{ width: 120 }}
              />
            </Box>

            {/* P1-3: shape picker. echarts-wordcloud only supports a closed set
                (no "custom path"), so we restrict the Select to that set rather
                than letting the user type a string. */}
            <FormControl size="small" sx={{ minWidth: 110 }}>
              <InputLabel id="tag-cloud-shape-label">{t('tagCloudShape')}</InputLabel>
              <Select
                labelId="tag-cloud-shape-label"
                value={shape}
                label={t('tagCloudShape')}
                onChange={(e) => setShape(e.target.value as CloudShape)}
              >
                {SHAPES.map((s) => (
                  <MenuItem key={s} value={s}>{t(SHAPE_LABEL[s])}</MenuItem>
                ))}
              </Select>
            </FormControl>

            {/* P1-8: layout-animation toggle. Default ON for the pleasant reflow
                on filter changes; OFF for users who want a stable layout they can
                click through without words jumping around. */}
            <Tooltip title={t('tagCloudLayoutAnim')}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <Typography variant="caption" color="text.secondary">
                  {t('tagCloudLayoutAnim')}
                </Typography>
                <Switch
                  size="small"
                  checked={layoutAnimation}
                  onChange={(_e, v) => setLayoutAnimation(v)}
                />
              </Box>
            </Tooltip>
          </>
        )}

        <Tooltip title={t('tagCloudCopy')}>
          <span>
            <IconButton
              size="small"
              onClick={() => void onCopyToClipboard()}
              disabled={saving || loading || isChartEmpty || readOnly}
            >
              <ContentCopyIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip title={t('saveImage')}>
          <span>
            <IconButton
              size="small"
              onClick={() => void handleSave()}
              disabled={saving || loading || isChartEmpty || readOnly}
            >
              <SaveIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip title={t('saveImageAs')}>
          <span>
            <IconButton
              size="small"
              onClick={() => void handleSaveAs()}
              disabled={saving || loading || isChartEmpty || readOnly}
            >
              <DriveFileMoveIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      {error ? <ErrorBanner message={error} /> : null}

      {loading ? (
        <LoadingOverlay label={t('loading')} />
      ) : view === 'matrix' ? (
        matrixData.tags.length === 0 ? (
          <EmptyHint message={t('tagCloudEmpty')} />
        ) : (
          // `key={view}` forces a full unmount when switching back to cloud:
          // the matrix's xAxis/yAxis live on the ECharts instance bound to the
          // old DOM node, and merge mode (kept on purpose below) would otherwise
          // leave those axes visible in the cloud view. Tearing down the
          // subtree here gives the cloud view a fresh container.
          <Box key="matrix" ref={containerRef} tabIndex={-1} sx={{ flex: 1, minHeight: 0 }}>
            <ReactECharts
              ref={chartRef}
              echarts={echarts}
              option={matrixOption}
              onEvents={onMatrixEvents}
              style={{ height: '100%', width: '100%' }}
              lazyUpdate
            />
          </Box>
        )
      ) : words.length === 0 ? (
        <EmptyHint message={t('tagCloudEmpty')} />
      ) : filtered && filteredWords.length === 0 ? (
        // P1-1: separate empty state when the *filter* (not the underlying data)
        // produced no matches. Distinct message so users don't think the
        // directory is empty when it's just their search that doesn't match.
        <EmptyHint message={t('tagCloudEmpty')} />
      ) : (
        <Box key="cloud" ref={containerRef} tabIndex={-1} sx={{ flex: 1, minHeight: 0 }}>
          <ReactECharts
            ref={chartRef}
            echarts={echarts}
            option={option}
            onEvents={onEvents}
            style={{ height: '100%', width: '100%' }}
            // Merge (NOT notMerge): clicking a word rebuilds `option` (activeTag
            // changed). Under `notMerge` echarts disposes the old wordCloud
            // series model and builds a new one, but zrender keeps the old word
            // elements alive for a tick — the trailing dblclick/mouseout of the
            // same gesture then dispatches to a word whose (disposed) series
            // model returns `getData() === undefined`, crashing in
            // `getDataParams` ("getRawIndex of undefined"). Merging keeps the
            // same series model instance and removes stale elements cleanly.
            // The `key="cloud"` wrapper above guarantees a fresh instance on
            // view switch, so merge mode here is safe (and necessary) within
            // a single view.
            lazyUpdate
          />
        </Box>
      )}

      <Menu
        open={ctxMenu !== null}
        onClose={() => setCtxMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={
          ctxMenu ? { top: ctxMenu.y, left: ctxMenu.x } : undefined
        }
      >
        {ctxMenu?.tag ? (
          // P1-6: tag-specific actions. Only shown when the right-click landed
          // on a word (echarts contextmenu handler attached the tag). Empty-
          // chart right-clicks skip these and go straight to save / copy.
          <>
            <MenuItem
              onClick={() => {
                void navigator.clipboard?.writeText(ctxMenu.tag ?? '');
                setCtxMenu(null);
              }}
            >
              <ListItemIcon>
                <ContentCopyIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('tagCloudCopyTag')}</ListItemText>
            </MenuItem>
            <MenuItem
              onClick={() => {
                if (ctxMenu.tag) onClickTag(ctxMenu.tag);
                setCtxMenu(null);
              }}
            >
              <ListItemIcon>
                <FilterAltIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('tagCloudFilterByTag')}</ListItemText>
            </MenuItem>
          </>
        ) : null}
        <MenuItem
          onClick={() => {
            void handleSave();
            setCtxMenu(null);
          }}
          disabled={saving || loading || isChartEmpty}
        >
          <ListItemIcon>
            <SaveIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t('saveImage')}</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            void handleSaveAs();
            setCtxMenu(null);
          }}
          disabled={saving || loading || isChartEmpty}
        >
          <ListItemIcon>
            <DriveFileMoveIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t('saveImageAs')}</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            void onCopyToClipboard();
            setCtxMenu(null);
          }}
          disabled={isChartEmpty}
        >
          <ListItemIcon>
            <ContentCopyIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t('tagCloudCopy')}</ListItemText>
        </MenuItem>
      </Menu>

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