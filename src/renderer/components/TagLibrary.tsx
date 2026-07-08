import { useState } from 'react';
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
import type { TFunction } from 'i18next';

import { RootState } from '-/reducers';
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
} from '../../shared/tag-colors';
import {
  smartTagColor,
  smartTagGlyph,
  smartTagI18nKey,
  type SmartFunctionality,
} from '../../shared/smart-tags';
import TagMetaDialog from '-/components/TagMetaDialog';

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
  const tagColors = useSelector((s: RootState) => s.settings?.tagColors ?? {});
  const groups = useSelector((s: RootState) => s.taglibrary?.groups ?? []);

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
        maxHeight: 280,
        minHeight: 0,
        overflow: 'auto',
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
            sx={{ mb: 0.5 }}
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
          <Stack
            direction="row"
            sx={{ flexWrap: 'wrap', gap: 0.75, alignItems: 'center' }}
          >
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
          </Stack>
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

/**
 * Renders the library's chip row with a **visual cluster** around the
 * date-related fold chips (`smart:<fn>` × 7, `period:`, `date:`), per the
 * plan: "把 7 个 smart: chip 与 1 个 period: chip 包进同一个视觉簇
 * (渲染容器)" — shared border + borderRadius + light background +
 * "日期 / Date" overline. `geo:` is rendered separately (its own
 * coordinate family, not date-related). All other (plain) tags render
 * as draggable chips after the cluster.
 *
 * Phase 5.6 / hotfix 2026-07-04: prior implementation had the chips in
 * one flex row without the shared wrapper, so `period:` looked visually
 * orphaned. The user-expected cluster is now realised.
 */
function TagLibraryChips(props: {
  shown: { tag: string; count: number }[];
  activeTag: string | null;
  setActiveTag: (t: string | null) => void;
  setEditTag: (t: string) => void;
  tagColors: Record<string, string>;
  groups: { id: string; title: string; expanded: boolean; color?: string; tags: string[] }[];
  tagDescriptions: Record<string, string>;
  t: TFunction;
}) {
  const { shown, activeTag, setActiveTag, setEditTag, tagColors, groups, tagDescriptions, t } = props;

  // Partition the shown list. Cluster = anything date-family (smart:*, period:,
  // date:). The user wanted the cluster to be visually separate from the
  // plain / draggable tags (per Phase 2 §6 "放到smart一组").
  const isCluster = (tag: string) =>
    tag.startsWith('smart:') || tag === 'period:' || tag === 'date:';
  const clusterTags = shown.filter((s) => isCluster(s.tag));
  const otherTags = shown.filter((s) => !isCluster(s.tag));

  return (
    <>
      {clusterTags.length > 0 ? (
        // Visual cluster: shared border + soft background + overline.
        // Each child chip is still independently clickable / draggable
        // (it's just a Chip inside the box, not a transformed one).
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
            bgcolor: (t) =>
              t.palette.mode === 'dark'
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
      ) : null}

      {otherTags.map(({ tag, count }) => {
        // `geo:` is its own coordinate family — rendered with the location
        // icon + blue accent, sits adjacent to the cluster (not inside it).
        if (tag === 'geo:') {
          return (
            <Chip
              key={tag}
              icon={
                <LocationOnIcon
                  fontSize="small"
                  sx={{
                    color:
                      activeTag === tag
                        ? 'inherit'
                        : `${GEO_TAG_COLOR} !important`,
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
        // Plain tags: draggable onto files.
        return (
          <DraggableTag
            key={tag}
            tag={tag}
            count={count}
            active={activeTag === tag}
            color={getTagColor(tag, tagColors, groups)}
            description={tagDescriptions[tag]}
            onToggleActive={(tg) =>
              setActiveTag(activeTag === tg ? null : tg)
            }
            onEdit={setEditTag}
          />
        );
      })}
    </>
  );
}
