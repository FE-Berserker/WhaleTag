import { useCallback } from 'react';
import { Box, Button, Chip, Link, Stack, Typography } from '@mui/material';
import type { TFunction } from 'i18next';

import type { DirEntry } from '../../../shared/ipc-types';
import type { TagGroup } from '../../domain/tag-library';
import { getTagColor } from '../../domain/tag-colors';
import type { GeoEntry } from '../../domain/mapique';
import type { MapProvider } from '-/reducers/settings';
import { chipSx, tagDisplayLabel } from '-/services/tag-display';
import ThumbIcon from '../ThumbIcon';

export default function MapPopup({
  geo,
  thumbCache,
  tags,
  tagColors,
  groups,
  t,
  provider,
  onOpen,
}: {
  geo: GeoEntry;
  thumbCache: Map<string, string>;
  /** P3-7 (reverted): tag list for this entry. Kept as an optional prop
   *  with the existing tag-chip rendering path so the parent doesn't have
   *  to change if a future iteration of the popup-exif feature ships. */
  tags?: string[];
  tagColors?: Record<string, string>;
  groups?: TagGroup[];
  /** Pre-bound i18n function (avoids re-calling useTranslation per popup). */
  t: TFunction;
  /**
   * Active map provider (mirrors Settings → Map source). When `'gaode'`,
   * the "open in OSM" button is relabeled "open in AMap" and points at
   * `uri.amap.com/marker` instead of `openstreetmap.org/?mlat=…` —
   * otherwise a Gaode-only user (mainland China, no OSM access) clicks
   * the button and gets a 451/timeout. Defaults to `'gaode'` to match
   * `reducers/settings.ts:315` — the existing default.
   */
  provider?: MapProvider;
  onOpen?: (entry: DirEntry) => void;
}) {
  const { entry, lat, lng } = geo;

  const handleOpen = useCallback(() => {
    onOpen?.(entry);
  }, [entry, onOpen]);

  // Provider-aware marker URL. AMap's `uri.amap.com/marker` opens the
  // web map at the marker (and `callnative=1` falls through to the
  // mobile app when available). `coordinate=wgs84` tells AMap the input
  // is WGS-84 so the marker lands on the right spot (MapiqueView
  // stores GPS lat/lng directly from EXIF, which is WGS-84).
  // OpenStreetMap uses the `?mlat=/mlon=&=#map=` hash scheme which is
  // stable across all OSM-hosted frontends.
  const mapUrl =
    provider === 'gaode'
      ? `https://uri.amap.com/marker?position=${lng},${lat}&src=WhaleTag&coordinate=wgs84&callnative=1`
      : `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
  const mapLabelKey =
    provider === 'gaode' ? 'openInGaode' : 'openInOsm';

  const showTags = tags && tags.length > 0;

  return (
    <Stack spacing={1} sx={{ minWidth: 180 }}>
      <Box
        sx={{
          width: '100%',
          height: 140,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'action.hover',
          borderRadius: 1,
          overflow: 'hidden',
          cursor: onOpen ? 'pointer' : 'default',
        }}
        onClick={handleOpen}
      >
        <ThumbIcon entry={entry} thumbCache={thumbCache} size={140} />
      </Box>

      <Typography variant="caption" noWrap title={entry.name} sx={{ fontWeight: 500 }}>
        {entry.name}
      </Typography>

      {showTags && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, pt: 0.25 }}>
          {tags!.map((tag) => (
            <Chip
              key={tag}
              label={tagDisplayLabel(tag, t)}
              size="small"
              sx={chipSx(
                getTagColor(tag, tagColors ?? {}, groups ?? []),
                false,
                'rounded'
              )}
            />
          ))}
        </Box>
      )}

      <Typography variant="caption" color="text.secondary">
        {lat.toFixed(5)}, {lng.toFixed(5)}
      </Typography>

      <Stack direction="row" spacing={1} sx={{ pt: 0.5, alignItems: 'center' }}>
        {onOpen && (
          <Button size="small" variant="outlined" onClick={handleOpen}>
            {t('openFile')}
          </Button>
        )}
        <Link href={mapUrl} target="_blank" rel="noopener noreferrer" underline="none">
          <Button size="small" variant="outlined">
            {t(mapLabelKey)}
          </Button>
        </Link>
      </Stack>
    </Stack>
  );
}
