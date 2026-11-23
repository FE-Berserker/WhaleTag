import { useCallback, useMemo, useState } from 'react';
import { Box } from '@mui/material';
import { useSelector } from 'react-redux';
import ExtensionHost from '-/components/ExtensionHost';
import ExtensionTabBar from '-/components/ExtensionTabBar';
import RevisionHistoryDialog from '-/components/RevisionHistoryDialog';
import { useExtensionContext } from '-/hooks/ExtensionContextProvider';
import { useDirectoryContent } from '-/hooks/DirectoryContentContextProvider';
import type { RootState } from '-/reducers';
import type { DirEntry } from '../../shared/ipc-types';
import {
  MAX_MOUNTED_TABS,
  selectMountedTabIds,
} from './extension-host/tab-mount-policy';

interface ExtensionViewPanelProps {
  theme: 'light' | 'dark';
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export default function ExtensionViewPanel({ theme }: ExtensionViewPanelProps) {
  const {
    tabs,
    activeTabId,
    activateTab,
    closeTab,
    reloadContent,
    reloadTokens,
    openFile,
  } = useExtensionContext();
  const { entries } = useDirectoryContent();
  const [historyOpen, setHistoryOpen] = useState(false);
  // Restoring a revision replaces the file on disk and forces the editor to
  // take it — which would throw away an unsaved buffer. The tab's dirty flag
  // lives in redux, next to the flag ExtensionHost reads for close/save.
  const activeDirty = useSelector(
    (s: RootState) => s.extensions.editState[activeTabId ?? '']?.dirty === true
  );

  const activeTab = tabs.find((t) => t.id === activeTabId);

  // Which tab iframes stay mounted (see extension-host/tab-mount-policy): the
  // active tab plus the most recently used clean tabs; dirty tabs are pinned
  // because their unsaved buffer lives inside the iframe. The selector returns
  // a flat id string so typing (which re-dispatches `dirty: true` every
  // keystroke) re-renders this panel only when a tab actually flips clean ↔
  // dirty, not on every character — the same reason ExtensionHost/ExtensionTab
  // Button subscribe to primitives instead of `editState[tabId]`.
  const dirtyTabKey = useSelector((s: RootState) => {
    const editState = s.extensions.editState;
    let key = '';
    for (const id of Object.keys(editState)) {
      if (editState[id]?.dirty === true) key += `${id}\u0000`;
    }
    return key;
  });
  const pinnedTabIds = useMemo(() => {
    const pinned = new Set<string>();
    for (const id of dirtyTabKey.split('\u0000')) {
      if (id) pinned.add(id);
    }
    return pinned;
  }, [dirtyTabKey]);
  const mountedTabIds = useMemo(
    () =>
      selectMountedTabIds(
        tabs.map((tab) => ({ id: tab.id, lastAccessed: tab.lastAccessed })),
        activeTabId,
        pinnedTabIds,
        MAX_MOUNTED_TABS
      ),
    [tabs, activeTabId, pinnedTabIds]
  );

  // Sibling paths the active extension can navigate to (e.g. image-viewer's
  // prev/next within the current directory). Only computed for the active tab
  // — background tabs never receive `siblings`/`onRequestFile`, so a hidden
  // tab can't accidentally navigate. An EMPTY array is meaningful: it tells the
  // viewer there is nothing to navigate to, and it disables prev/next. (This
  // used to collapse to `undefined`, so a viewer that had multiple siblings and
  // then landed in a single-file directory kept its buttons enabled.)
  const siblings = useMemo<string[]>(() => {
    if (!activeTab) return [];
    const accept = new Set(activeTab.manifest.fileTypes);
    const out: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      if (accept.has(extOf(entry.name))) out.push(entry.path);
    }
    return out;
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
      {/* One absolutely-positioned slot per tab; only the mounted ones hold an
          iframe (bounded by selectMountedTabIds). Inactive but mounted tabs stay
          display:none so switching back is instant, and dirty tabs are never
          unmounted, so an unsaved buffer or the window-close save handler can't
          be lost to eviction. */}
      <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const isMounted = mountedTabIds.has(tab.id);
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
              {isMounted ? (
                <ExtensionHost
                  tabId={tab.id}
                  manifest={tab.manifest}
                  filePath={tab.filePath}
                  fileContent={tab.fileContent}
                  encoding={tab.encoding}
                  readOnly={tab.readOnly}
                  fileSize={tab.fileSize}
                  siblings={isActive ? siblings : undefined}
                  reloadToken={reloadTokens[tab.id]}
                  theme={theme}
                  onRequestRevisionHistory={() => setHistoryOpen(true)}
                  onRequestFile={isActive ? handleRequestFile : undefined}
                />
              ) : null}
            </Box>
          );
        })}
      </Box>
      {activeTab ? (
        <RevisionHistoryDialog
          filePath={activeTab.filePath}
          open={historyOpen}
          dirty={activeDirty}
          onClose={() => setHistoryOpen(false)}
          onRestored={() => {
            // reloadContent reports its own failures (notifyApp) and forces the
            // editor to take the restored bytes even when the tab is dirty.
            void reloadContent();
          }}
        />
      ) : null}
    </Box>
  );
}
