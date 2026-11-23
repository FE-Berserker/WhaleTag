import { Box, Button, Divider, Stack, Typography } from '@mui/material';
import LocationOnIcon from '@mui/icons-material/LocationOn';
import type { TFunction } from 'i18next';

import type { DirEntry } from '../../../shared/ipc-types';
import type { TagGroup } from '../../domain/tag-library';
import BatchPanel from './BatchPanel';
import { PREVIEW_HEIGHT } from './constants';
import InlineTagInput from '../InlineTagInput';
import ThumbIcon from '../ThumbIcon';

export interface MapiqueDetailPanelProps {
  t: TFunction;
  selectedCount: number;
  selectedEntries: DirEntry[];
  activeEntry: DirEntry | null;
  activeGeo: { lat: number; lng: number } | null;
  activeTags: string[];
  canEdit: boolean;
  thumbCache: Map<string, string>;
  tagsByName: Map<string, string[]>;
  tagColors: Record<string, string>;
  groups: TagGroup[];
  onOpen?: (entry: DirEntry) => void;
  onAddTag?: (entry: DirEntry, tag: string) => void;
  onRemoveTag?: (entry: DirEntry, tag: string) => void;
  /** BatchPanel passthrough (optional in MapiqueViewProps). */
  onClearGeo?: (entry: DirEntry) => void;
  /** Wrapped clear with undo-notice plumbing (MapiqueView.applyClearGeo). */
  applyClearGeo: (entry: DirEntry) => void;
  setNotice: (notice: { message: string; undoable?: boolean } | null) => void;
}

/**
 * Mapique right-panel content below the tray: empty hint / batch tag editor /
 * single-entry preview with coordinates, clear-location and inline tags.
 * Extracted from MapiqueView (P2 split); behaviour/JSX are unchanged.
 */
export default function MapiqueDetailPanel({
  t,
  selectedCount,
  selectedEntries,
  activeEntry,
  activeGeo,
  activeTags,
  canEdit,
  thumbCache,
  tagsByName,
  tagColors,
  groups,
  onOpen,
  onAddTag,
  onRemoveTag,
  onClearGeo,
  applyClearGeo,
  setNotice,
}: MapiqueDetailPanelProps) {
  return (
    <Box sx={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
      {selectedCount === 0 ? (
        <Box sx={{ p: 3, textAlign: 'center' }}>
          <Typography variant="body2" color="text.secondary">
            {t('selectFileHint')}
          </Typography>
        </Box>
      ) : selectedCount > 1 ? (
        <BatchPanel
          entries={selectedEntries}
          tagColors={tagColors}
          groups={groups}
          t={t}
          canEdit={canEdit}
          onAddTag={onAddTag}
          onRemoveTag={onRemoveTag}
          onClearGeo={onClearGeo}
          tagsByName={tagsByName}
        />
      ) : (
        <Stack spacing={0}>
          <Box
            sx={{
              width: '100%',
              height: PREVIEW_HEIGHT,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              bgcolor: 'action.hover',
              cursor: onOpen ? 'pointer' : 'default',
              overflow: 'hidden',
              p: 1,
              flexShrink: 0,
            }}
            onClick={() => activeEntry && onOpen?.(activeEntry)}
          >
            <ThumbIcon
              entry={activeEntry!}
              thumbCache={thumbCache}
              size={PREVIEW_HEIGHT - 16}
              rounded={4}
              objectFit="contain"
            />
          </Box>

          <Typography
            variant="subtitle2"
            noWrap
            title={activeEntry?.name}
            sx={{ px: 1.5, pt: 1, pb: 0.5, flexShrink: 0 }}
          >
            {activeEntry?.name}
          </Typography>

          <Stack
            direction="row"
            spacing={1}
            sx={{ px: 1.5, alignItems: 'center', flexShrink: 0 }}
          >
            <LocationOnIcon
              fontSize="small"
              sx={{ color: activeGeo ? '#1976d2' : 'text.disabled' }}
            />
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ flex: 1, fontSize: 12 }}
            >
              {activeGeo
                ? `${activeGeo.lat.toFixed(6)}, ${activeGeo.lng.toFixed(6)}`
                : t('noLocationSet')}
            </Typography>
            {activeGeo && canEdit && (
              <Button
                size="small"
                onClick={() => {
                  if (selectedCount > 0) {
                    selectedEntries.forEach((e) => applyClearGeo(e));
                    setNotice({
                      message: t('mapiqueGeoUpdatedMulti', {
                        count: selectedCount,
                      }),
                      undoable: true,
                    });
                  } else {
                    applyClearGeo(activeEntry!);
                    setNotice({
                      message: t('mapiqueGeoUpdated'),
                      undoable: true,
                    });
                  }
                }}
              >
                {t('clearLocation')}
              </Button>
            )}
          </Stack>

          {canEdit && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ px: 1.5, display: 'block', flexShrink: 0 }}
            >
              {t('clickMapToPlace')}
            </Typography>
          )}

          <Divider sx={{ mt: 1, mb: 0.5, flexShrink: 0 }} />

          <InlineTagInput
            tags={activeTags}
            tagColors={tagColors}
            groups={groups}
            t={t}
            onAdd={(tag) => onAddTag?.(activeEntry!, tag)}
            onRemove={(tag) => onRemoveTag?.(activeEntry!, tag)}
            readOnly={!canEdit}
          />
        </Stack>
      )}
    </Box>
  );
}

