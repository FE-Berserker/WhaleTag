import { ipcMain } from 'electron';
import {
  readSidecarsDetailed,
  readSidecardsForPathsDetailed,
  recoverCorruptSidecar,
  writeSidecar,
} from '../sidecar';
import { readFolderMeta, writeFolderMeta } from '../folder-meta';
import {
  readTagLibrary,
  setTagLibraryDescription,
  clearTagLibraryDescription,
} from '../tag-library';
import {
  assertNotLocationRoot,
  assertWritable,
  assertWithinAllowedRoot,
} from '../allowed-roots';
import type { SidecarMeta, FolderMeta } from '../../shared/whale-meta';
import type { RecoverCorruptSidecarRequest } from '../../shared/ipc-types';

/**
 * `.whale/` metadata handlers: sidecars, folder meta, per-location tag
 * library. Split out of the old god-registrar `ipc.ts` (docs/01 §12) —
 * behavior is verbatim; since then the two batch reads are fenced like every
 * other handler in this file.
 */

/** Every path must sit inside a configured location — one stray path rejects
 *  the whole batch before any read happens. */
function assertEachWithinAllowedRoot(paths: string[]): void {
  for (const target of paths) assertWithinAllowedRoot(target);
}

export function registerMetaHandlers(): void {
  // ---- Sidecar metadata (`.whale/<file>.json`) ----
  // H.24 R7: batch-read sidecars for a recursive scan (files spread across
  // many subdirs) in one IPC round trip. Falls back to per-file legacy reads
  // for subdirs whose aggregated wsd.json doesn't exist yet (plan §N1).
  // Reads are confined like every other handler in this file (docs/13 §2, §10).
  ipcMain.handle(
    'sidecar:readManyDetailed',
    (_event, dirPath: string, names: string[]) => {
      assertWithinAllowedRoot(dirPath);
      return readSidecarsDetailed(dirPath, names);
    }
  );
  ipcMain.handle('sidecar:readForPathsDetailed', (_event, filePaths: string[]) => {
    assertEachWithinAllowedRoot(filePaths);
    return readSidecardsForPathsDetailed(filePaths);
  });
  // Recovery is a separate explicit channel: only the renderer's confirmed
  // corrupt-issue action calls it. The service repeats all root/hash checks.
  ipcMain.handle(
    'sidecar:recoverCorrupt',
    (_event, request: RecoverCorruptSidecarRequest) => {
      assertWithinAllowedRoot(request.dirPath);
      assertWritable(request.dirPath); // recovery rewrites <dir>/.whale/
      return recoverCorruptSidecar(request);
    }
  );

  ipcMain.handle(
    'sidecar:write',
    (_event, filePath: string, meta: SidecarMeta) => {
      assertWithinAllowedRoot(filePath); // writes <dir>/.whale/
      // A sidecar for a location ROOT would land in `dirname(root)/.whale/` —
      // one directory above the boundary, outside every configured location.
      // Folders/tags on a root itself are not a thing the UI offers either.
      assertNotLocationRoot(filePath);
      // Read-only locations accept no metadata writes either: tags, folders
      // and descriptions all live in `<dir>/.whale/`, inside the location.
      assertWritable(filePath);
      return writeSidecar(filePath, meta);
    }
  );

  // ---- Folder metadata (`.whale/wsm.json`): tags/color/description + view prefs ----
  // Reads are confined too (docs/13 §13): the metadata of a directory is still
  // data about a location the user did not grant access to.
  ipcMain.handle('folderMeta:read', (_event, dirPath: string) => {
    assertWithinAllowedRoot(dirPath);
    return readFolderMeta(dirPath);
  });

  ipcMain.handle(
    'folderMeta:write',
    (_event, dirPath: string, patch: Partial<FolderMeta>) => {
      assertWithinAllowedRoot(dirPath); // writes under <dir>/.whale/
      assertWritable(dirPath);
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
      assertWritable(locationRoot); // wtaglib lives under <root>/.whale/
      return setTagLibraryDescription(locationRoot, tag, description);
    }
  );

  ipcMain.handle(
    'tagLibrary:clearDescription',
    (_event, locationRoot: string, tag: string) => {
      assertWithinAllowedRoot(locationRoot);
      assertWritable(locationRoot);
      return clearTagLibraryDescription(locationRoot, tag);
    }
  );
}
