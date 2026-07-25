import { Box, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useTranslation } from 'react-i18next';
import { useSelector } from 'react-redux';
import type { RootState } from '-/reducers';
import type { ExtensionTab } from '-/hooks/ExtensionContextProvider';

interface ExtensionTabBarProps {
  tabs: ExtensionTab[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
}

/** Horizontal strip of open-file tabs. Mirrors a browser's tab bar: click to
 *  focus, × to close (with the provider's dirty-check), and a leading dot in
 *  the extension's brand color so different extension types stay legible at a
 *  glance. Tabs with unsaved edits show a trailing "•". */
export default function ExtensionTabBar({
  tabs,
  activeTabId,
  onActivate,
  onClose,
}: ExtensionTabBarProps) {
  const { t } = useTranslation();
  // Read the whole editState map once; per-tab dirty is a map lookup in render.
  const editState = useSelector((s: RootState) => s.extensions.editState);

  if (tabs.length === 0) return null;

  return (
    <Box
      role="tablist"
      aria-label={t('openTabs')}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.25,
        px: 0.5,
        py: 0.25,
        borderBottom: 1,
        borderColor: 'divider',
        overflowX: 'auto',
        overflowY: 'hidden',
        flexShrink: 0,
        minHeight: 36,
        position: 'relative',
        zIndex: 2,
        // Keep the close button readable; hide the scrollbar ornament.
        '&::-webkit-scrollbar': { height: 4 },
      }}
    >
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        const dirty = editState[tab.filePath]?.dirty ?? false;
        return (
          <Stack
            key={tab.id}
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
      })}
    </Box>
  );
}
