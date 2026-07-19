import { ipcMain } from 'electron';
import {
  generateThumbnail,
  loadThumbnail,
  loadFolderThumbnail,
  loadFolderBackground,
  setFolderThumbnail,
  setFolderBackground,
  clearFolderThumbnail,
  clearFolderBackground,
} from '../thumbnail';
import { assertWithinAllowedRoot } from '../allowed-roots';

/**
 * Thumbnail handlers (`thumbnail:*`): single-file + folder thumbnails and
 * backgrounds. Split out of the old god-registrar `ipc.ts` (docs/01 §12) —
 * behavior is verbatim.
 */

export function registerThumbnailHandlers(): void {
  // ---- Image thumbnails (`.whale/thumbs/<file>.jpg`) ----
  ipcMain.handle(
    'thumbnail:generate',
    (_event, filePath: string, options?: { sofficePath?: string | null }) => {
      assertWithinAllowedRoot(filePath); // writes under .whale/thumbs/
      return generateThumbnail(filePath, options);
    }
  );

  ipcMain.handle('thumbnail:load', (_event, filePath: string) =>
    loadThumbnail(filePath)
  );

  // ---- Folder thumbnails / backgrounds (`.whale/wst.jpg` / `.whale/wsb.jpg`) ----
  ipcMain.handle('thumbnail:loadFolder', (_event, dirPath: string) =>
    loadFolderThumbnail(dirPath)
  );
  ipcMain.handle('thumbnail:loadFolderBackground', (_event, dirPath: string) =>
    loadFolderBackground(dirPath)
  );
  ipcMain.handle(
    'thumbnail:setFolderThumbnail',
    (_event, dirPath: string, sourcePath: string) => {
      assertWithinAllowedRoot(dirPath);
      return setFolderThumbnail(dirPath, sourcePath);
    }
  );
  ipcMain.handle(
    'thumbnail:setFolderBackground',
    (_event, dirPath: string, sourcePath: string) => {
      assertWithinAllowedRoot(dirPath);
      return setFolderBackground(dirPath, sourcePath);
    }
  );
  ipcMain.handle(
    'thumbnail:clearFolderThumbnail',
    (_event, dirPath: string) => {
      assertWithinAllowedRoot(dirPath);
      return clearFolderThumbnail(dirPath);
    }
  );
  ipcMain.handle(
    'thumbnail:clearFolderBackground',
    (_event, dirPath: string) => {
      assertWithinAllowedRoot(dirPath);
      return clearFolderBackground(dirPath);
    }
  );
}
