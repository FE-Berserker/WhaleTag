import { useCallback, useMemo, useState } from 'react';
import { Box } from '@mui/material';
import ExtensionHost from '-/components/ExtensionHost';
import ExtensionTabBar from '-/components/ExtensionTabBar';
import RevisionHistoryDialog from '-/components/RevisionHistoryDialog';
import { useExtensionContext } from '-/hooks/ExtensionContextProvider';
import { useDirectoryContent } from '-/hooks/DirectoryContentContextProvider';
import type { DirEntry } from '../../shared/ipc-types';

interface ExtensionViewPanelProps {
  theme: 'light' | 'dark';
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export default function ExtensionViewPanel({ theme }: ExtensionViewPanelProps) {
  const { tabs, activeTabId, activateTab, closeTab, reloadContent, openFile } =
    useExtensionContext();
  const { entries } = useDirectoryContent();
  const [historyOpen, setHistoryOpen] = useState(false);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  // Sibling paths the active extension can navigate to (e.g. image-viewer's
  // prev/next within the current directory). Only computed for the active tab
  // — background tabs never receive `siblings`/`onRequestFile`, so a hidden
  // tab can't accidentally navigate.
  const siblings = useMemo<string[] | undefined>(() => {
    if (!activeTab) return undefined;
    const accept = new Set(activeTab.manifest.fileTypes);
    const out: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      if (accept.has(extOf(entry.name))) out.push(entry.path);
    }
    return out.length > 0 ? out : undefined;
  }, [activeTab, entries]);

  // Re-open the active tab's extension with a different sibling path (the
  // extension's `requestFile` navigation). We reuse the active manifest so the
  // dedup key is `${path}::${manifestId}` — navigating to an already-open
  // sibling just focuses its tab instead of reloading.
  const handleRequestFile = useCallback(
    (target: string) => {
      if (!activeTab) return;
      const entry: DirEntry | undefined = entries.find((e) => e.path === target);
      if (!entry) return;
      void openFile(entry, activeTab.manifest);
    },
    [activeTab, entries, openFile]
  );

  if (tabs.length === 0) return null;

  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        // Opaque backdrop: FileList stays mounted underneath (its MediaLightbox
        // must survive tab open/close), so without this the file grid bleeds
        // through the tab bar and the gaps around the viewer iframe.
        bgcolor: 'background.default',
      }}
    >
      <ExtensionTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onActivate={activateTab}
        onClose={(id) => void closeTab(id)}
      />
      {/* Stack every tab's host absolutely; hide inactive ones with display:none
          so their iframes stay mounted (switching back is instant, no reload). */}
      <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <Box
              key={tab.id}
              sx={{
                position: 'absolute',
                inset: 0,
                display: isActive ? 'flex' : 'none',
                flexDirection: 'column',
              }}
            >
              <ExtensionHost
                tabId={tab.id}
                manifest={tab.manifest}
                filePath={tab.filePath}
                fileContent={tab.fileContent}
                encoding={tab.encoding}
                readOnly={tab.readOnly}
                fileSize={tab.fileSize}
                siblings={isActive ? siblings : undefined}
                theme={theme}
                onClose={() => void closeTab(tab.id)}
                onRequestRevisionHistory={() => setHistoryOpen(true)}
                onRequestFile={isActive ? handleRequestFile : undefined}
              />
            </Box>
          );
        })}
      </Box>
      {activeTab ? (
        <RevisionHistoryDialog
          filePath={activeTab.filePath}
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          onRestored={() => {
            reloadContent().catch(() => undefined);
          }}
        />
      ) : null}
    </Box>
  );
}
