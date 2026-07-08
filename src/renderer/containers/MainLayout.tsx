import { useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';
import { Box } from '@mui/material';

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
import AiPanel from '-/components/ai/AiPanel';
import AddLocationDialog from '-/components/AddLocationDialog';
import BackgroundPlayerDock from '-/components/BackgroundPlayerDock';
import { PeriodTagDialogProvider } from '-/components/PeriodTagDialog';
import { SettingsDialogProvider } from '-/components/SettingsDialogProvider';
import { useResolvedThemeMode } from '-/theme/useResolvedThemeMode';
import { useExtensionContext } from '-/hooks/ExtensionContextProvider';
import { useBackgroundPlayer } from '-/hooks/BackgroundPlayerContextProvider';
import { useSelector } from 'react-redux';
import { RootState } from '-/reducers';

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
  const aiPanelOpen = useSelector((s: RootState) => s.settings.aiPanelOpen);
  const aiEnabled = useSelector((s: RootState) => s.settings.aiEnabled);

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
              <Sidebar onAddLocation={() => setAddOpen(true)} />
              {currentLocation ? <DirectoryTree /> : null}
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
              {aiEnabled && aiPanelOpen ? <AiPanel /> : null}
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
