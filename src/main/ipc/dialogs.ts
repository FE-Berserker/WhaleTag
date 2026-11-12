import { ipcMain, dialog } from 'electron';
import { rememberPickedRoot } from '../known-roots';

/**
 * Native file/folder dialog handlers (`dialog:*`). Split out of the old
 * god-registrar `ipc.ts` (docs/01 §12) — behavior is verbatim.
 */

/** Shows the native "select folder" dialog. Returns null if cancelled. */
async function openDirectoryDialog(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const picked = result.filePaths[0];
  // Provenance for the location guard (known-roots.ts): only directories the
  // user picked here become registrable locations.
  rememberPickedRoot(picked);
  return picked;
}

/** Shows the native "select image file" dialog. Returns null if cancelled. */
async function openImageFileDialog(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

export function registerDialogHandlers(): void {
  ipcMain.handle('dialog:openDirectory', () => openDirectoryDialog());
  ipcMain.handle('dialog:openImageFile', () => openImageFileDialog());

  ipcMain.handle(
    'dialog:saveImage',
    async (_event, defaultPath: string) => {
      const result = await dialog.showSaveDialog({
        defaultPath,
        filters: [
          {
            name: 'Images',
            extensions: ['jpg', 'jpeg', 'png', 'webp', 'tiff', 'tif', 'avif'],
          },
        ],
      });
      return result.canceled || !result.filePath ? null : result.filePath;
    }
  );
}
