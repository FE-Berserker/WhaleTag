import { memo, useState } from 'react';
import {
  Box,
  Chip,
  Popover,
  Stack,
  type SxProps,
  type Theme,
} from '@mui/material';
import LocationOnIcon from '@mui/icons-material/LocationOn';
import { useSelector } from 'react-redux';
import type { TFunction } from 'i18next';

import type { DirEntry } from '../../shared/ipc-types';
import type { TagGroup } from '../domain/tag-library';
import { getTagColor, GEO_TAG_COLOR } from '../domain/tag-colors';
import { isGeoTag, parseGeoTag } from '../domain/geo-tag';
import type { RootState } from '-/reducers';
import { chipSx } from '-/services/tag-display';
import { useTagDisplayLabels } from '-/hooks/useTagDisplayLabels';

/**
 * Renders an entry's applied tags as compact chips, capped at `max` with a
 * `+N` overflow chip. Shared by the list rows and grid cells so the chip
 * styling, color fallback, click-to-filter, and right-click-to-remove behavior
 * stay identical across views.
 */
function EntryTagChipsBase({
  entry,
  tags,
  activeTag,
  tagColors,
  groups,
  max,
  t,
  onClickTag,
  onTagContextMenu,
  containerSx,
}: {
  entry: DirEntry;
  tags: string[];
  activeTag: string | null;
  tagColors: Record<string, string>;
  groups: TagGroup[];
  max: number;
  t: TFunction;
  /** Click a chip: toggle it as the active filter. */
  onClickTag: (tag: string) => void;
  /** Right-click a chip: open the per-tag menu (remove) at (x, y). */
  onTagContextMenu: (entry: DirEntry, tag: string, x: number, y: number) => void;
  containerSx?: SxProps<Theme>;
}) {
  const tagShape = useSelector((s: RootState) => s.settings?.tagShape ?? 'rounded');
  const [overflowAnchor, setOverflowAnchor] = useState<HTMLElement | null>(null);

  // H.23 P1-6: render the first `max - 1` chips, then a `+N` chip that opens
  // a Popover with the rest. Previously the row just `slice(0, max)`'d,
  // silently throwing away any extra tags — 5+ tag rows lost information.
  const hasOverflow = tags.length > max;
  const shownCount = hasOverflow ? Math.max(0, max - 1) : max;
  const shownTags = tags.slice(0, shownCount);
  const overflowTags = tags.slice(shownCount);

  // docs/03: freshness-aware labels, index-aligned with `tags` (shownTags
  // are [0..shownCount), overflowTags the rest). Subscribes to the per-minute
  // tick only when a date-shaped tag is present.
  const labels = useTagDisplayLabels(tags);

  return (
    <Box
      sx={{
        display: 'flex',
        gap: 0.5,
        minWidth: 0,
        overflow: 'hidden',
        ...containerSx,
      }}
    >
      {shownTags.map((tag, i) => {
        const active = activeTag === tag;
        // Geo coordinate tags render as a frameless location pin (no chip
        // border/background) — the full lat/lng is noisy and the outline looks
        // heavy. Click still toggles the filter; right-click still removes it.
        if (isGeoTag(tag)) {
          const pt = parseGeoTag(tag);
          return (
            <LocationOnIcon
              key={tag}
              fontSize="small"
              titleAccess={pt ? `${pt.lat}, ${pt.lng}` : tag}
              sx={{
                fontSize: 18,
                cursor: 'pointer',
                color: active ? 'primary.main' : (getTagColor(tag, tagColors, groups) ?? GEO_TAG_COLOR),
                flexShrink: 0,
              }}
              onClick={(e) => {
                e.stopPropagation();
                onClickTag(tag);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onTagContextMenu(entry, tag, e.clientX, e.clientY);
              }}
            />
          );
        }
        // Ratings/workflow get a localized label; the stored value + accent
        // color are unchanged. Right-click a chip to remove the tag.
        const label = labels[i];
        return (
          <Chip
            key={tag}
            label={label}
            size="small"
            color={active ? 'primary' : 'default'}
            variant={active ? 'filled' : 'outlined'}
            sx={chipSx(getTagColor(tag, tagColors, groups), active, tagShape)}
            onClick={(e) => {
              e.stopPropagation();
              onClickTag(tag);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onTagContextMenu(entry, tag, e.clientX, e.clientY);
            }}
          />
        );
      })}
      {hasOverflow ? (
        <>
          <Chip
            size="small"
            label={`+${overflowTags.length}`}
            variant="outlined"
            color="default"
            onClick={(e) => {
              e.stopPropagation();
              setOverflowAnchor(e.currentTarget);
            }}
            // Keyboard parity with mouse click — Enter/Space opens the list.
            // We don't preventDefault on the row-level keyboard handler.
            role="button"
            aria-label={t('moreTags', { count: overflowTags.length })}
            sx={chipSx(undefined, false, tagShape)}
          />
          <Popover
            open={overflowAnchor !== null}
            anchorEl={overflowAnchor}
            onClose={() => setOverflowAnchor(null)}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
            slotProps={{ paper: { sx: { p: 1, maxWidth: 360 } } }}
          >
            <Stack
              direction="row"
              spacing={0.5}
              useFlexGap
              sx={{ flexWrap: 'wrap', maxWidth: 320 }}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.stopPropagation()}
            >
              {overflowTags.map((tag, j) => {
                const active = activeTag === tag;
                const label = labels[shownCount + j];
                if (isGeoTag(tag)) {
                  const pt = parseGeoTag(tag);
                  return (
                    <LocationOnIcon
                      key={tag}
                      fontSize="small"
                      titleAccess={pt ? `${pt.lat}, ${pt.lng}` : tag}
                      sx={{
                        fontSize: 18,
                        cursor: 'pointer',
                        color: active
                          ? 'primary.main'
                          : (getTagColor(tag, tagColors, groups) ??
                              GEO_TAG_COLOR),
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onClickTag(tag);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onTagContextMenu(entry, tag, e.clientX, e.clientY);
                      }}
                    />
                  );
                }
                return (
                  <Chip
                    key={tag}
                    label={label}
                    size="small"
                    color={active ? 'primary' : 'default'}
                    variant={active ? 'filled' : 'outlined'}
                    sx={chipSx(
                      getTagColor(tag, tagColors, groups),
                      active,
                      tagShape
                    )}
                    onClick={(e) => {
                      e.stopPropagation();
                      onClickTag(tag);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onTagContextMenu(entry, tag, e.clientX, e.clientY);
                    }}
                  />
                );
              })}
            </Stack>
          </Popover>
        </>
      ) : null}
    </Box>
  );
}

/**
 * P2-5 (perf audit): memo'd so a row/grid/gantt cell re-rendering on hover or
 * drag doesn't re-render its chip strip when none of the inputs changed. The
 * strip is mounted once per visible cell (dozens to hundreds of instances) and
 * each subscribes to redux (`tagShape`), so skipping unrelated re-renders is
 * worth it. Props are reference-stable from the call sites:
 *   - `entry` / `tags` / `tagColors` / `groups` / `activeTag` / `t` and the two
 *     callbacks come from FileList's `cellData` useMemo (or a memoized `row` in
 *     GanttRow) — see P0-4 / P1-5. Call sites hoist `containerSx` to a
 *     module-level constant so it is not a fresh object each render.
 */
export default memo(EntryTagChipsBase);
