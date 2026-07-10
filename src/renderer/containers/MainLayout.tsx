import { lazy, Suspense, useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Box, IconButton, Tab, Tabs, Tooltip, useMediaQuery } from '@mui/material';
import CreateNewFolderIcon from '@mui/icons-material/CreateNewFolder';

import { useCurrentLocationContext } from '-/hooks/CurrentLocationContextProvider';
import { FileSelectionProvider } from '-/hooks/FileSelectionContextProvider';
import { addLocation } from '-/reducers/locations';
import { setTrayVisible } from '-/reducers/settings';
import Sidebar from '-/components/Sidebar';
import DirectoryTree from '-/components/DirectoryTree';
import FileToolbar from '-/components/FileToolbar';
import TitleBar from '-/components/TitleBar';
import FileList from '-/components/FileList';
import ExtensionViewPanel from '-/components/ExtensionViewPanel';
import WelcomePanel from '-/components/WelcomePanel';
import AddLocationDialog from '-/components/AddLocationDialog';
import BackgroundPlayerDock from '-/components/BackgroundPlayerDock';
import { PeriodTagDialogProvider } from '-/components/PeriodTagDialog';
import { SettingsDialogProvider } from '-/components/SettingsDialogProvider';
import { useResolvedThemeMode } from '-/theme/useResolvedThemeMode';
import { useExtensionContext } from '-/hooks/ExtensionContextProvider';
import { useBackgroundPlayer } from '-/hooks/BackgroundPlayerContextProvider';
import { useSelector } from 'react-redux';
import { RootState } from '-/reducers';

// AI panel pulls marked + dompurify + the streaming UI. Lazy-load so the weight
// is only paid when AI is enabled and the panel is opened.
const AiPanel = lazy(() => import('../components/ai/AiPanel'));

/**
 * Top-level layout: sidebar (locations) + main area (toolbar + file list, or a
 * welcome prompt when no location exists). Owns the "add location" dialog
 * and (via SettingsDialogProvider) the settings dialog.
 *
 * Rendered inside the provider stack in Root.tsx.
 */
export default function MainLayout() {
  const dispatch = useDispatch();
  const { currentLocation } = useCurrentLocationContext();
  const { activeView } = useExtensionContext();
  const backgroundPlayer = useBackgroundPlayer();
  const themeMode = useSelector((s: RootState) => s.settings.themeMode);
  // ExtensionViewPanel (and the extension iframe it hosts) only understand a
  // concrete 'light' | 'dark' — resolve 'system' before handing it down.
  const resolvedThemeMode = useResolvedThemeMode(themeMode);
  const [addOpen, setAddOpen] = useState(false);
  const { t } = useTranslation();
  const aiPanelOpen = useSelector((s: RootState) => s.settings.aiPanelOpen);
  const aiEnabled = useSelector((s: RootState) => s.settings.aiEnabled);

  // Narrow viewport: collapse the Sidebar (locations) + DirectoryTree into one
  // tabbed panel so the left side takes a single column (~240px) instead of
  // two (~500px), giving the workspace room. Each renders "embedded" (no own
  // header — the tab bar below replaces it).
  const narrow = useMediaQuery('(max-width: 1200px)');
  const [leftTab, setLeftTab] = useState<'locations' | 'tree'>(
    currentLocation ? 'tree' : 'locations'
  );
  // If the location is deselected while the tree tab is active, fall back to
  // locations (the tree tab is also disabled then).
  const activeTab: 'locations' | 'tree' =
    leftTab === 'tree' && !currentLocation ? 'locations' : leftTab;

  // The AI panel shares the right edge with the PropertiesTray (which lives
  // inside FileList). When the AI panel is open, hide the tray so the two
  // "right-side detail" surfaces don't stack; it returns when the panel closes.
  useEffect(() => {
    if (aiEnabled && aiPanelOpen) dispatch(setTrayVisible(false));
  }, [aiEnabled, aiPanelOpen, dispatch]);

  const handleAdd = (name: string, path: string, readOnly: boolean) => {
    dispatch(addLocation(name, path, readOnly));
    setAddOpen(false);
  };

  return (
    <FileSelectionProvider>
      <PeriodTagDialogProvider>
        {/* SettingsDialogProvider owns the `<SettingsDialog>` mount so any
            context menu (Sidebar / EntryContextMenu / KanbanEntryMenu /
            CalendarEntryMenu) can deep-link to a section via
            `useSettingsDialog().openDialog({ section })`. Sidebar's gear
            icon now goes through this hook too. */}
        <SettingsDialogProvider>
          {/* Background-music dock lives at the bottom of the workspace column
              only, so it never spans under Sidebar/DirectoryTree. The workspace
              content area above it uses flex:1 to absorb the remaining height.
              The dock is hidden when the queue is empty AND the user hasn't
              collapsed it (BackgroundPlayerContext). */}
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              height: '100vh',
              overflow: 'hidden',
            }}
          >
            <TitleBar />
            <Box
              sx={{
                flex: 1,
                minHeight: 0,
                display: 'flex',
                overflow: 'hidden',
              }}
            >
              {narrow ? (
                <Box
                  sx={{
                    width: 240,
                    flexShrink: 0,
                    borderRight: 1,
                    borderColor: 'divider',
                    display: 'flex',
                    flexDirection: 'column',
                  }}
                >
                  {/* Tab bar: Locations / Folders + an add-location glyph (the
                      Sidebar's own add button is hidden in embedded mode). */}
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      borderBottom: 1,
                      borderColor: 'divider',
                      flexShrink: 0,
                      pr: 0.5,
                    }}
                  >
                    <Tabs
                      value={activeTab}
                      onChange={(_e, v: 'locations' | 'tree') => setLeftTab(v)}
                      variant="fullWidth"
                      sx={{ minHeight: 40, flex: 1 }}
                    >
                      <Tab
                        value="locations"
                        label={t('locations')}
                        sx={{ minHeight: 40, textTransform: 'none' }}
                      />
                      <Tab
                        value="tree"
                        label={t('folders')}
                        disabled={!currentLocation}
                        sx={{ minHeight: 40, textTransform: 'none' }}
                      />
                    </Tabs>
                    <Tooltip title={t('addLocation')}>
                      <IconButton size="small" onClick={() => setAddOpen(true)}>
                        <CreateNewFolderIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Box>
                  {/* Both mounted, one shown via display — preserves the tree's
                      scroll / expand state across tab switches (unmounting the
                      DirectoryTree would reset it). Absolute fill avoids flex
                      sizing quirks between the two embedded components. */}
                  <Box
                    sx={{
                      flex: 1,
                      minHeight: 0,
                      position: 'relative',
                      overflow: 'hidden',
                    }}
                  >
                    <Box
                      sx={{
                        position: 'absolute',
                        inset: 0,
                        display: activeTab === 'locations' ? 'flex' : 'none',
                      }}
                    >
                      <Sidebar embedded onAddLocation={() => setAddOpen(true)} />
                    </Box>
                    <Box
                      sx={{
                        position: 'absolute',
                        inset: 0,
                        display: activeTab === 'tree' ? 'flex' : 'none',
                      }}
                    >
                      {currentLocation ? <DirectoryTree embedded /> : null}
                    </Box>
                  </Box>
                </Box>
              ) : (
                <>
                  <Sidebar onAddLocation={() => setAddOpen(true)} />
                  {currentLocation ? <DirectoryTree /> : null}
                </>
              )}
              <Box
                sx={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  minWidth: 0,
                }}
              >
                <Box
                  sx={{
                    flex: 1,
                    minHeight: 0,
                    display: 'flex',
                    flexDirection: 'column',
                  }}
                >
                  {currentLocation ? (
                    <>
                      <FileToolbar />
                      {activeView ? (
                        <ExtensionViewPanel theme={resolvedThemeMode} />
                      ) : (
                        <FileList />
                      )}
                    </>
                  ) : (
                    <WelcomePanel onAddLocation={() => setAddOpen(true)} />
                  )}
                </Box>
                {backgroundPlayer.visible ? <BackgroundPlayerDock /> : null}
              </Box>
              {aiEnabled && aiPanelOpen ? (
                <Suspense fallback={null}>
                  <AiPanel />
                </Suspense>
              ) : null}
            </Box>
            <AddLocationDialog
              open={addOpen}
              onClose={() => setAddOpen(false)}
              onAdd={handleAdd}
            />
          </Box>
        </SettingsDialogProvider>
      </PeriodTagDialogProvider>
    </FileSelectionProvider>
  );
}
