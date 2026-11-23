import { Box, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DriveFileMoveIcon from '@mui/icons-material/DriveFileMove';
import RefreshIcon from '@mui/icons-material/Refresh';
import SaveIcon from '@mui/icons-material/Save';
import type { TFunction } from 'i18next';

export interface MapiqueToolbarProps {
  t: TFunction;
  /** Map export (PNG save) is in flight. */
  saving: boolean;
  /** Recursive folder scan is in flight — export + refresh must not race it. */
  loadingRecursive: boolean;
  readOnly: boolean;
  /** EXIF extraction batch in flight. */
  extractingActive: boolean;
  /** A folder is open, so the EXIF cache refresh has something to refresh. */
  hasLocation: boolean;
  onSave: () => void;
  onSaveAs: () => void;
  onCopyMap: () => void;
  onRefreshExif: () => void;
}

/**
 * Mapique top toolbar: title + save / save-as / copy-map / refresh-EXIF.
 * Extracted from MapiqueView (P2 split); behaviour/JSX are unchanged.
 */
export default function MapiqueToolbar({
  t,
  saving,
  loadingRecursive,
  readOnly,
  extractingActive,
  hasLocation,
  onSave,
  onSaveAs,
  onCopyMap,
  onRefreshExif,
}: MapiqueToolbarProps) {
  return (
    <Stack
      direction="row"
      sx={{
        alignItems: 'center',
        gap: 2,
        flexShrink: 0,
        flexWrap: 'wrap',
        px: 1.5,
        py: 0.75,
      }}
    >
      <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
        {t('mapique')}
      </Typography>
      <Box sx={{ flex: 1 }} />

      <Tooltip title={t('saveImage')}>
        <span>
          <IconButton
            size="small"
            onClick={() => void onSave()}
            disabled={saving || loadingRecursive || readOnly}
            aria-label={t('saveImage')}
          >
            <SaveIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>

      <Tooltip title={t('saveImageAs')}>
        <span>
          <IconButton
            size="small"
            onClick={() => void onSaveAs()}
            disabled={saving || loadingRecursive || readOnly}
            aria-label={t('saveImageAs')}
          >
            <DriveFileMoveIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>

      <Tooltip title={t('mapiqueCopyMap')}>
        <span>
          <IconButton
            size="small"
            onClick={() => void onCopyMap()}
            disabled={saving || loadingRecursive}
            aria-label={t('mapiqueCopyMap')}
          >
            <ContentCopyIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>

      {/* P3-4: wipe the persisted EXIF cache and re-trigger extraction.
          Useful after sidecar / GPS-tag edits that the cache would
          otherwise mask. Disabled while a batch is mid-flight. */}
      <Tooltip title={t('mapiqueRefreshExifTooltip')}>
        <span>
          <IconButton
            size="small"
            onClick={() => void onRefreshExif()}
            disabled={extractingActive || loadingRecursive || !hasLocation}
            aria-label={t('mapiqueRefreshExif')}
          >
            <RefreshIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </Stack>
  );
}
