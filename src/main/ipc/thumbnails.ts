import { ipcMain } from 'electron';
import {
  generateThumbnail,
  loadThumbnail,
  loadFolderThumbnail,
  setFolderThumbnail,
  setFolderBackground,
  clearFolderThumbnail,
  clearFolderBackground,
} from '../thumbnail';
import { assertWithinAllowedRoot, assertWritable } from '../allowed-roots';

/**
 * Thumbnail handlers (`thumbnail:*`): single-file + folder thumbnails and
 * backgrounds. Split out of the old god-registrar `ipc.ts` (docs/01 §12) —
 * behavior is verbatim.
 */

export function registerThumbnailHandlers(): void {
  // ---- Image thumbnails (`.whale/thumbs/<file>.jpg`) ----
  ipcMain.handle('thumbnail:generate', (_event, filePath: string) => {
    assertWithinAllowedRoot(filePath); // writes under .whale/thumbs/
    return generateThumbnail(filePath);
  });

  ipcMain.handle('thumbnail:load', (_event, filePath: string) => {
    assertWithinAllowedRoot(filePath); // reads <dir>/.whale/thumbs/
    return loadThumbnail(filePath);
  });

  // ---- Folder thumbnails / backgrounds (`.whale/wst.jpg` / `.whale/wsb.jpg`) ----
  ipcMain.handle('thumbnail:loadFolder', (_event, dirPath: string) => {
    assertWithinAllowedRoot(dirPath);
    return loadFolderThumbnail(dirPath);
  });
  // A set/clear rewrites `.whale/` inside the folder, so a read-only location
  // refuses it like every other metadata write. The `sourcePath` of a set is a
  // user-picked image and may live outside every location: only the
  // destination folder is fenced.
  ipcMain.handle(
    'thumbnail:setFolderThumbnail',
    (_event, dirPath: string, sourcePath: string) => {
      assertWithinAllowedRoot(dirPath);
      assertWritable(dirPath);
      return setFolderThumbnail(dirPath, sourcePath);
    }
  );
  ipcMain.handle(
    'thumbnail:setFolderBackground',
    (_event, dirPath: string, sourcePath: string) => {
      assertWithinAllowedRoot(dirPath);
      assertWritable(dirPath);
      return setFolderBackground(dirPath, sourcePath);
    }
  );
  ipcMain.handle(
    'thumbnail:clearFolderThumbnail',
    (_event, dirPath: string) => {
      assertWithinAllowedRoot(dirPath);
      assertWritable(dirPath);
      return clearFolderThumbnail(dirPath);
    }
  );
  ipcMain.handle(
    'thumbnail:clearFolderBackground',
    (_event, dirPath: string) => {
      assertWithinAllowedRoot(dirPath);
      assertWritable(dirPath);
      return clearFolderBackground(dirPath);
    }
  );
}
