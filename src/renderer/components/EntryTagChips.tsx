import { useState } from 'react';
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
import type { TagGroup } from '../../shared/tag-library';
import { getTagColor, GEO_TAG_COLOR } from '../../shared/tag-colors';
import { isGeoTag, parseGeoTag } from '../../shared/geo-tag';
import type { RootState } from '-/reducers';
import { chipSx, tagDisplayLabel } from '-/services/tag-display';

/**
 * Renders an entry's applied tags as compact chips, capped at `max` with a
 * `+N` overflow chip. Shared by the list rows and grid cells so the chip
 * styling, color fallback, click-to-filter, and right-click-to-remove behavior
 * stay identical across views.
 */
export default function EntryTagChips({
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
      {shownTags.map((tag) => {
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
        const label = tagDisplayLabel(tag, t);
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
              {overflowTags.map((tag) => {
                const active = activeTag === tag;
                const label = tagDisplayLabel(tag, t);
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
