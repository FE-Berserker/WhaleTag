import { Box } from '@mui/material';
import { useTranslation } from 'react-i18next';
import ExtensionTabButton from '-/components/ExtensionTabButton';
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
 *  glance. Tabs with unsaved edits show a trailing "•".
 *
 *  Each tab subscribes to its own dirty flag in `ExtensionTabButton`; the bar
 *  itself renders no edit state, so a keystroke in one tab re-renders only that
 *  tab. */
export default function ExtensionTabBar({
  tabs,
  activeTabId,
  onActivate,
  onClose,
}: ExtensionTabBarProps) {
  const { t } = useTranslation();

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
      {tabs.map((tab) => (
        <ExtensionTabButton
          key={tab.id}
          tab={tab}
          active={tab.id === activeTabId}
          onActivate={onActivate}
          onClose={onClose}
        />
      ))}
    </Box>
  );
}
