import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSelector } from 'react-redux';
import {
  Box,
  Chip,
  InputAdornment,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import LabelIcon from '@mui/icons-material/LabelOutlined';
import SearchIcon from '@mui/icons-material/Search';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import LocationOnIcon from '@mui/icons-material/LocationOn';
import DateRangeIcon from '@mui/icons-material/DateRange';
import HistoryIcon from '@mui/icons-material/History';
import { useDrag } from 'react-dnd';
import {
  List as VirtualList,
  useDynamicRowHeight,
  type RowComponentProps,
} from 'react-window';
import type { TFunction } from 'i18next';

import { RootState } from '-/reducers';
import { EMPTY_ARR, EMPTY_OBJ } from '-/constants';
import { useTagMetaContext } from '-/hooks/TagMetaContextProvider';
import { useLocationTagLibrary } from '-/hooks/LocationTagLibraryContextProvider';
import { DND_TYPE_TAG, type TagDragItem } from '-/services/dnd';
import {
  getTagColor,
  readableTextOn,
  tagShapeSx,
  tagShapeBoxPadding,
  GEO_TAG_COLOR,
  PERIOD_COLOR,
  STALE_DATE_FOLD_COLOR,
} from '../domain/tag-colors';
import {
  smartTagColor,
  smartTagGlyph,
  smartTagI18nKey,
  type SmartFunctionality,
} from '../../shared/smart-tags';
import TagMetaDialog from '-/components/TagMetaDialog';
import {
  packTagRows,
  estListHeight,
  EST_CHIP_ROW_HEIGHT,
  type PackedRow,
  type TagCount,
} from './tag-library-pack';

interface DraggableTagProps {
  tag: string;
  count: number;
  active: boolean;
  color: string | undefined;
  description?: string;
  onToggleActive: (tag: string) => void;
  onEdit: (tag: string) => void;
}

/**
 * One tag in the library. Filled with its color (contrasting text), draggable
 * onto a file row to apply, click toggles the active filter, right-click opens
 * the tag editor (color + description). Hover shows the description tooltip.
 */
function DraggableTag({
  tag,
  count,
  active,
  color,
  description,
  onToggleActive,
  onEdit,
}: DraggableTagProps) {
  const [{ isDragging }, dragRef] = useDrag<
    TagDragItem,
    unknown,
    { isDragging: boolean }
  >(
    () => ({
      type: DND_TYPE_TAG,
      item: { tag },
      collect: (monitor) => ({ isDragging: monitor.isDragging() }),
    }),
    [tag]
  );

  const tooltip = description || tag;
  const tagShape = useSelector((s: RootState) => s.settings?.tagShape ?? 'rounded');

  return (
    <Tooltip title={tooltip} disableInteractive>
      <Box
        ref={dragRef}
        onClick={() => onToggleActive(tag)}
        onContextMenu={(e) => {
          e.preventDefault();
          onEdit(tag);
        }}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.25,
          borderRadius: 5,
          px: 0.5,
          py: '1px',
          border: 1,
          borderColor: active ? 'primary.main' : 'divider',
          cursor: 'grab',
          userSelect: 'none',
          fontSize: 11,
          lineHeight: 1.3,
          fontWeight: 500,
          opacity: isDragging ? 0.4 : 1,
          ...(active
            ? { bgcolor: 'primary.main', color: 'common.white' }
            : color
              ? { bgcolor: color, color: readableTextOn(color) }
              : { bgcolor: 'background.paper' }),
          ...tagShapeSx(tagShape),
          ...tagShapeBoxPadding(tagShape),
        }}
      >
        <Box component="span" sx={{ whiteSpace: 'nowrap' }}>
          {tag}
        </Box>
        <Box component="span" sx={{ fontSize: 10, opacity: 0.7 }}>
          {count}
        </Box>
      </Box>
    </Tooltip>
  );
}

/** Panel chrome below the header+filter the virtual list must fit inside. */
const PANEL_MAX_HEIGHT = 280;
const CHROME_HEIGHT = 66;

/**
 * Tag library panel: every tag in the current directory with its file count.
 * Header collapses the panel; a filter box narrows the list by name (handy when
 * a directory has many tags). Click a chip to filter; right-click to edit its
 * color & description; drag onto a file row to apply. Per-tag colors &
 * descriptions live in settings.
 */
export default function TagLibrary() {
  const { t } = useTranslation();
  const { allTags, activeTag, setActiveTag } = useTagMetaContext();
  const { descriptions: tagDescriptions } = useLocationTagLibrary();
  const tagColors = useSelector(
    (s: RootState) => s.settings?.tagColors ?? EMPTY_OBJ
  );
  const groups = useSelector(
    (s: RootState) => s.taglibrary?.groups ?? EMPTY_ARR
  );

  const [collapsed, setCollapsed] = useState(false);
  const [filter, setFilter] = useState('');
  const [editTag, setEditTag] = useState<string | null>(null);

  if (allTags.length === 0) return null;

  const q = filter.trim().toLowerCase();
  const shown = q ? allTags.filter(({ tag }) => tag.toLowerCase().includes(q)) : allTags;

  return (
    <Box
      sx={{
        borderTop: 1,
        borderColor: 'divider',
        maxHeight: PANEL_MAX_HEIGHT,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        p: 1,
      }}
    >
      <Stack
        direction="row"
        onClick={() => setCollapsed((c) => !c)}
        sx={{
          alignItems: 'center',
          gap: 0.5,
          mb: collapsed ? 0 : 0.5,
          cursor: 'pointer',
          userSelect: 'none',
          flexShrink: 0,
        }}
      >
        {collapsed ? (
          <ChevronRightIcon fontSize="small" sx={{ color: 'text.secondary' }} />
        ) : (
          <ExpandMoreIcon fontSize="small" sx={{ color: 'text.secondary' }} />
        )}
        <LabelIcon fontSize="small" sx={{ color: 'text.secondary' }} />
        <Typography variant="overline" color="text.secondary">
          {t('tagLibrary')}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          ({allTags.length})
        </Typography>
      </Stack>

      {!collapsed ? (
        <>
          <TextField
            size="small"
            fullWidth
            placeholder={t('filterTags')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            sx={{ mb: 0.5, flexShrink: 0 }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              },
            }}
          />
          {shown.length === 0 ? (
            <Typography variant="caption" color="text.secondary">
              {t('noResults')}
            </Typography>
          ) : (
            <TagLibraryChips
              shown={shown}
              activeTag={activeTag}
              setActiveTag={setActiveTag}
              setEditTag={setEditTag}
              tagColors={tagColors}
              groups={groups}
              tagDescriptions={tagDescriptions}
              t={t}
            />
          )}
        </>
      ) : null}

      <TagMetaDialog
        open={editTag !== null}
        tag={editTag ?? ''}
        onClose={() => setEditTag(null)}
      />
    </Box>
  );
}

interface ChipsProps {
  shown: TagCount[];
  activeTag: string | null;
  setActiveTag: (t: string | null) => void;
  setEditTag: (t: string) => void;
  tagColors: Record<string, string>;
  groups: { id: string; title: string; expanded: boolean; color?: string; tags: string[] }[];
  tagDescriptions: Record<string, string>;
  t: TFunction;
}

interface RowData extends ChipsProps {
  rows: PackedRow[];
  clusterTags: TagCount[];
}

/**
 * One virtualized row of the library: the leading cluster row, or a packed
 * row of plain-tag chips. Plain function (not memo'd) — react-window v2's
 * `rowComponent` expects a function; each `<DraggableTag>` / `<Chip>` inside
 * does its own work (DnD + color memo lookups are cheap per visible row).
 */
function TagLibraryRow({
  index,
  style,
  rows,
  clusterTags,
  ...chipProps
}: RowComponentProps<RowData>) {
  const row = rows[index];
  if (!row) return <div style={style} />;
  if (row.kind === 'cluster') {
    return (
      <div style={{ ...style, display: 'flex', alignItems: 'flex-start' }}>
        <ClusterBox clusterTags={clusterTags} {...chipProps} />
      </div>
    );
  }
  return (
    <div style={{ ...style, display: 'flex', alignItems: 'center', gap: 6 }}>
      {row.tags.map(({ tag, count }) =>
        tag === 'geo:' ? (
          <GeoChip key={tag} count={count} {...chipProps} />
        ) : (
          <DraggableTag
            key={tag}
            tag={tag}
            count={count}
            active={chipProps.activeTag === tag}
            color={getTagColor(tag, chipProps.tagColors, chipProps.groups)}
            description={chipProps.tagDescriptions[tag]}
            onToggleActive={(tg) =>
              chipProps.setActiveTag(chipProps.activeTag === tg ? null : tg)
            }
            onEdit={chipProps.setEditTag}
          />
        )
      )}
    </div>
  );
}

/**
 * The library's chip area (docs/03 §12 virtualization): the date-fold
 * cluster renders as row 0 of a react-window `List`; the plain tags are
 * greedily packed into width-fitting rows (`packTagRows`) so a 1000-tag
 * library mounts only the visible window + overscan instead of every chip.
 * Before 2026-07-18 both lists rendered their full `.map` — fine for dozens
 * of tags, a real stall at hundreds+.
 */
function TagLibraryChips(props: ChipsProps) {
  const {
    shown,
    activeTag,
    setActiveTag,
    setEditTag,
    tagColors,
    groups,
    tagDescriptions,
    t,
  } = props;

  // Partition the shown list. Cluster = anything date-family (smart:*, period:,
  // date:). The user wanted the cluster to be visually separate from the
  // plain / draggable tags (per Phase 2 §6 "放到smart一组"). Memoized so the
  // arrays are identity-stable across unrelated parent renders (the rows memo
  // below keys off them).
  const [clusterTags, otherTags] = useMemo(() => {
    const isCluster = (tag: string) =>
      tag.startsWith('smart:') || tag === 'period:' || tag === 'date:';
    const cluster: TagCount[] = [];
    const other: TagCount[] = [];
    for (const s of shown) (isCluster(s.tag) ? cluster : other).push(s);
    return [cluster, other];
  }, [shown]);

  // Measure the available width so chips pack into exact-fit rows.
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(360);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setWidth(w);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows = useMemo<PackedRow[]>(
    () => [
      ...(clusterTags.length > 0 ? [{ kind: 'cluster' } as const] : []),
      ...packTagRows(otherTags, width - 8),
    ],
    [clusterTags, otherTags, width]
  );

  // `key` invalidates the measured-height cache on every repack (filter edit,
  // resize, tag add/remove) so stale per-index heights don't bleed across.
  const rowHeight = useDynamicRowHeight({
    defaultRowHeight: EST_CHIP_ROW_HEIGHT,
    key: `${rows.length}:${width}`,
  });

  const rowData = useMemo<RowData>(
    () => ({
      shown,
      activeTag,
      setActiveTag,
      setEditTag,
      tagColors,
      groups,
      tagDescriptions,
      t,
      rows,
      clusterTags,
    }),
    [
      shown,
      activeTag,
      setActiveTag,
      setEditTag,
      tagColors,
      groups,
      tagDescriptions,
      t,
      rows,
      clusterTags,
    ]
  );

  return (
    <Box ref={containerRef} sx={{ flex: 1, minHeight: 0 }}>
      <VirtualList
        style={{ height: Math.min(estListHeight(rows), PANEL_MAX_HEIGHT - CHROME_HEIGHT) }}
        rowCount={rows.length}
        rowHeight={rowHeight}
        rowComponent={TagLibraryRow}
        rowProps={rowData}
      />
    </Box>
  );
}

/** The `geo:` fold chip — its own coordinate family (location pin + blue
 *  accent), packed inline with the plain tags. */
function GeoChip({
  count,
  activeTag,
  setActiveTag,
  t,
}: {
  count: number;
  activeTag: string | null;
  setActiveTag: (t: string | null) => void;
  t: TFunction;
}) {
  const tag = 'geo:';
  return (
    <Chip
      icon={
        <LocationOnIcon
          fontSize="small"
          sx={{
            color:
              activeTag === tag ? 'inherit' : `${GEO_TAG_COLOR} !important`,
          }}
        />
      }
      label={`${t('geoLocation')} (${count})`}
      size="small"
      color={activeTag === tag ? 'primary' : 'default'}
      variant={activeTag === tag ? 'filled' : 'outlined'}
      onClick={() => setActiveTag(activeTag === tag ? null : tag)}
      sx={{
        border: 1,
        borderColor: 'divider',
        ...(activeTag !== tag ? { color: GEO_TAG_COLOR } : {}),
      }}
    />
  );
}

/**
 * The visual cluster around the date-related fold chips (`smart:<fn>` × 7,
 * `period:`, `date:`), per the plan: "把 7 个 smart: chip 与 1 个 period:
 * chip 包进同一个视觉簇(渲染容器)" — shared border + borderRadius + light
 * background + "日期 / Date" overline. `geo:` is rendered separately (its
 * own coordinate family, not date-related).
 */
function ClusterBox({
  clusterTags,
  activeTag,
  setActiveTag,
  t,
}: {
  clusterTags: TagCount[];
  activeTag: string | null;
  setActiveTag: (t: string | null) => void;
  t: TFunction;
}) {
  return (
    <Box
      data-testid="tag-library-cluster"
      sx={{
        display: 'inline-flex',
        flexDirection: 'column',
        gap: 0.5,
        px: 0.75,
        py: 0.5,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1.5,
        bgcolor: (theme) =>
          theme.palette.mode === 'dark'
            ? 'rgba(255,255,255,0.03)'
            : 'rgba(0,0,0,0.025)',
      }}
    >
      <Typography
        variant="overline"
        sx={{
          fontSize: 10,
          lineHeight: 1.2,
          color: 'text.secondary',
          letterSpacing: 0.5,
        }}
      >
        {/* en: "Date · Date" / zh: "日期" — short cluster label, no count
            here (each child chip carries its own count). */}
        {t('tagClusterLabel', { defaultValue: 'Date · 日期' })}
      </Typography>
      <Stack
        direction="row"
        sx={{ flexWrap: 'wrap', gap: 0.5, alignItems: 'center' }}
      >
        {clusterTags.map(({ tag, count }) => {
          if (tag.startsWith('smart:')) {
            const fn = tag.slice(6) as SmartFunctionality;
            const glyph = smartTagGlyph(fn);
            const label = glyph ?? t(smartTagI18nKey(fn));
            const accent = smartTagColor(fn);
            return (
              <Chip
                key={tag}
                label={`${label} (${count})`}
                size="small"
                color={activeTag === tag ? 'primary' : 'default'}
                variant={activeTag === tag ? 'filled' : 'outlined'}
                onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                sx={{
                  border: 1,
                  borderColor: 'divider',
                  ...(accent && activeTag !== tag ? { color: accent } : {}),
                }}
              />
            );
          }
          if (tag === 'period:') {
            return (
              <Chip
                key={tag}
                icon={
                  <DateRangeIcon
                    fontSize="small"
                    sx={{
                      color:
                        activeTag === tag
                          ? 'inherit'
                          : `${PERIOD_COLOR} !important`,
                    }}
                  />
                }
                label={`${t('tagPeriod')} (${count})`}
                size="small"
                color={activeTag === tag ? 'primary' : 'default'}
                variant={activeTag === tag ? 'filled' : 'outlined'}
                onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                sx={{
                  border: 1,
                  borderColor: 'divider',
                  ...(activeTag !== tag ? { color: PERIOD_COLOR } : {}),
                }}
              />
            );
          }
          if (tag === 'date:') {
            return (
              <Chip
                key={tag}
                icon={
                  <HistoryIcon
                    fontSize="small"
                    sx={{
                      color:
                        activeTag === tag
                          ? 'inherit'
                          : `${STALE_DATE_FOLD_COLOR} !important`,
                    }}
                  />
                }
                label={`${t('tagStaleDateFold')} (${count})`}
                size="small"
                color={activeTag === tag ? 'primary' : 'default'}
                variant={activeTag === tag ? 'filled' : 'outlined'}
                onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                sx={{
                  border: 1,
                  borderColor: 'divider',
                  ...(activeTag !== tag
                    ? { color: STALE_DATE_FOLD_COLOR }
                    : {}),
                }}
              />
            );
          }
          return null;
        })}
      </Stack>
    </Box>
  );
}
