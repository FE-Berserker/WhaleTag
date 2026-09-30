import { ipcMain } from 'electron';
import {
  readSidecars,
  readSidecardsForPaths,
  writeSidecar,
} from '../sidecar';
import { readFolderMeta, writeFolderMeta } from '../folder-meta';
import {
  readTagLibrary,
  setTagLibraryDescription,
  clearTagLibraryDescription,
} from '../tag-library';
import { assertWithinAllowedRoot } from '../allowed-roots';
import type { SidecarMeta, FolderMeta } from '../../shared/whale-meta';

/**
 * `.whale/` metadata handlers: sidecars, folder meta, per-location tag
 * library. Split out of the old god-registrar `ipc.ts` (docs/01 §12) —
 * behavior is verbatim.
 */

export function registerMetaHandlers(): void {
  // ---- Sidecar metadata (`.whale/<file>.json`) ----
  ipcMain.handle(
    'sidecar:readMany',
    (_event, dirPath: string, names: string[]) => readSidecars(dirPath, names)
  );
  // H.24 R7: batch-read sidecars for a recursive scan (files spread across
  // many subdirs) in one IPC round trip. Falls back to per-file legacy reads
  // for subdirs whose aggregated wsd.json doesn't exist yet (plan §N1).
  ipcMain.handle(
    'sidecar:readForPaths',
    (_event, filePaths: string[]) => readSidecardsForPaths(filePaths)
  );

  ipcMain.handle(
    'sidecar:write',
    (_event, filePath: string, meta: SidecarMeta) => {
      assertWithinAllowedRoot(filePath); // writes <dir>/.whale/
      return writeSidecar(filePath, meta);
    }
  );

  // ---- Folder metadata (`.whale/wsm.json`): tags/color/description + view prefs ----
  ipcMain.handle('folderMeta:read', (_event, dirPath: string) =>
    readFolderMeta(dirPath)
  );

  ipcMain.handle(
    'folderMeta:write',
    (_event, dirPath: string, patch: Partial<FolderMeta>) => {
      assertWithinAllowedRoot(dirPath); // writes under <dir>/.whale/
      return writeFolderMeta(dirPath, patch);
    }
  );

  // ---- Per-location tag library (`.whale/wtaglib.json`): one description per tag ----
  ipcMain.handle('tagLibrary:read', (_event, locationRoot: string) => {
    assertWithinAllowedRoot(locationRoot); // wtaglib lives under <root>/.whale/
    return readTagLibrary(locationRoot);
  });

  ipcMain.handle(
    'tagLibrary:setDescription',
    (
      _event,
      locationRoot: string,
      tag: string,
      description: string
    ) => {
      assertWithinAllowedRoot(locationRoot);
      return setTagLibraryDescription(locationRoot, tag, description);
    }
  );

  ipcMain.handle(
    'tagLibrary:clearDescription',
    (_event, locationRoot: string, tag: string) => {
      assertWithinAllowedRoot(locationRoot);
      return clearTagLibraryDescription(locationRoot, tag);
    }
  );
}
