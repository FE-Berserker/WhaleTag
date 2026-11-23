import { Box, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useTranslation } from 'react-i18next';
import { useSelector } from 'react-redux';
import type { RootState } from '-/reducers';
import type { ExtensionTab } from '-/hooks/ExtensionContextProvider';

interface ExtensionTabButtonProps {
  tab: ExtensionTab;
  active: boolean;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
}

/** One tab in the strip.
 *
 *  Subscribes to the primitive `dirty` boolean instead of the whole editState
 *  map: editors report dirty on every keystroke boundary, and a map selector
 *  re-rendered every tab for each report even when only one flag changed. */
export default function ExtensionTabButton({
  tab,
  active,
  onActivate,
  onClose,
}: ExtensionTabButtonProps) {
  const { t } = useTranslation();
  const dirty = useSelector(
    (s: RootState) => s.extensions.editState[tab.id]?.dirty === true
  );

  return (
    <Stack
      direction="row"
      role="tab"
      tabIndex={0}
      aria-selected={active}
      title={tab.filePath}
      onClick={() => onActivate(tab.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate(tab.id);
        }
      }}
      sx={{
        alignItems: 'center',
        gap: 0.5,
        px: 0.75,
        py: 0.25,
        borderRadius: 1,
        cursor: 'pointer',
        maxWidth: 200,
        flexShrink: 0,
        bgcolor: active ? 'action.selected' : 'transparent',
        '&:hover': { bgcolor: 'action.hover' },
        '&:focus-visible': { outline: '1px solid', outlineColor: 'primary.main' },
      }}
    >
      <Box
        sx={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          bgcolor: tab.manifest.color ?? 'action.active',
          flexShrink: 0,
        }}
      />
      <Typography
        variant="caption"
        component="span"
        sx={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontWeight: active ? 600 : 400,
        }}
      >
        {tab.title}
        {dirty ? ' •' : ''}
      </Typography>
      <Tooltip title={t('close')}>
        <IconButton
          size="small"
          aria-label={t('close')}
          onClick={(e) => {
            e.stopPropagation();
            onClose(tab.id);
          }}
          sx={{ p: 0.25 }}
        >
          <CloseIcon sx={{ fontSize: 14 }} />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}
