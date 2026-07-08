import { useCallback } from 'react';
import type { DirEntry } from '../../shared/ipc-types';
import { nextAvailableName } from '../../shared/dedupe-name';
import { joinPath } from '-/services/path-util';
import { useCurrentLocationContext } from '-/hooks/CurrentLocationContextProvider';
import { useDirectoryContentContext } from '-/hooks/DirectoryContentContextProvider';
import { useIOActionsContext } from '-/hooks/IOActionsContextProvider';
import { useExtensionContext } from '-/hooks/ExtensionContextProvider';

/** Minimal valid empty Excalidraw scene, written when creating a new drawing. */
const EMPTY_EXCALIDRAW = JSON.stringify({
  type: 'excalidraw',
  version: 2,
  source: 'whale',
  elements: [],
  appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
  files: {},
});

/**
 * Shared "new Excalidraw drawing" action: creates a deduplicated `.excalidraw`
 * file in the current directory and opens it in the excalidraw-editor extension.
 * Used by both the file-list blank-area menu and the sidebar button.
 */
export function useNewExcalidraw() {
  const { currentDirectoryPath, currentLocation } = useCurrentLocationContext();
  const { entries } = useDirectoryContentContext();
  const { createFile } = useIOActionsContext();
  const { openWithExtension, registry } = useExtensionContext();

  const available = !!registry?.extensions.some(
    (m) => m.id === 'excalidraw-editor'
  );
  const canCreate =
    available &&
    !!currentLocation &&
    !currentLocation.isReadOnly &&
    !!currentDirectoryPath;

  const create = useCallback(async () => {
    const manifest = registry?.extensions.find(
      (m) => m.id === 'excalidraw-editor'
    );
    if (!manifest || !currentDirectoryPath) return;
    const taken = new Set(entries.map((e) => e.name));
    const name = nextAvailableName('Drawing.excalidraw', taken);
    const filePath = joinPath(currentDirectoryPath, name);
    await createFile(name, EMPTY_EXCALIDRAW);
    const entry: DirEntry = {
      name,
      path: filePath,
      isDirectory: false,
      isFile: true,
      size: EMPTY_EXCALIDRAW.length,
      modified: new Date().toISOString(),
      extension: 'excalidraw',
    };
    await openWithExtension(entry, manifest);
  }, [registry, currentDirectoryPath, entries, createFile, openWithExtension]);

  return { create, available, canCreate };
}
