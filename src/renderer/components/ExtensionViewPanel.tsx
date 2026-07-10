import { useCallback, useMemo, useState } from 'react';
import { Box } from '@mui/material';
import ExtensionHost from '-/components/ExtensionHost';
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
  const { activeView, closeView, reloadContent, openFile } =
    useExtensionContext();
  const { entries } = useDirectoryContent();
  const [historyOpen, setHistoryOpen] = useState(false);

  // Sibling paths the active extension can navigate to (e.g. image-viewer's
  // prev/next within the current directory). Filter the current directory's
  // entries down to the ones the active manifest accepts, in display order.
  // Omit for extensions whose `fileTypes` doesn't match anything in the view
  // (the ExtensionHost skips the `siblings` envelope when the list is empty).
  const siblings = useMemo<string[] | undefined>(() => {
    if (!activeView) return undefined;
    const accept = new Set(activeView.manifest.fileTypes);
    const out: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      if (accept.has(extOf(entry.name))) out.push(entry.path);
    }
    return out.length > 0 ? out : undefined;
  }, [activeView, entries]);

  // Re-open the active extension view with a different path (called when the
  // extension sends `requestFile` to navigate to a sibling). We synthesize a
  // DirEntry from the matching entry in the current directory so the
  // extension's `openWithExtension` path is reused; the active view's manifest
  // + read-only flag are preserved.
  const handleRequestFile = useCallback(
    (target: string) => {
      if (!activeView) return;
      const entry: DirEntry | undefined = entries.find(
        (e) => e.path === target
      );
      if (!entry) return;
      void openFile(entry, activeView.manifest);
    },
    [activeView, entries, openFile]
  );

  if (!activeView) return null;

  return (
    <Box sx={{ width: '100%', height: '100%' }}>
      <ExtensionHost
        manifest={activeView.manifest}
        filePath={activeView.filePath}
        fileContent={activeView.fileContent}
        encoding={activeView.encoding}
        readOnly={activeView.readOnly}
        fileSize={activeView.fileSize}
        siblings={siblings}
        theme={theme}
        onClose={closeView}
        onRequestRevisionHistory={() => setHistoryOpen(true)}
        onRequestFile={handleRequestFile}
      />
      <RevisionHistoryDialog
        filePath={activeView.filePath}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onRestored={() => {
          reloadContent().catch(() => undefined);
        }}
      />
    </Box>
  );
}
