import { ipcMain, dialog } from 'electron';

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
  return result.filePaths[0];
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

/** Shows the native "select AI component (.whaleai)" dialog. Returns null if cancelled. */
async function openComponentFileDialog(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'WhaleTag AI Component', extensions: ['whaleai'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

export function registerDialogHandlers(): void {
  ipcMain.handle('dialog:openDirectory', () => openDirectoryDialog());
  ipcMain.handle('dialog:openImageFile', () => openImageFileDialog());
  ipcMain.handle('dialog:openComponentFile', () => openComponentFileDialog());

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
