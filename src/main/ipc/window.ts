import { ipcMain, nativeImage, BrowserWindow } from 'electron';
import { getCanvas } from '../lazy-native';

/**
 * Window-control handlers (`window:*`) + the native file-drag bridge
 * (`drag:startFile`). Split out of the old god-registrar `ipc.ts`
 * (docs/01 §12) — behavior is verbatim.
 */

/** Cached generic "document" drag icon (Electron's startDrag rejects an empty or
 *  tiny icon, so non-previewable files need a real one). Built once on demand. */
let dragFallbackIcon: Electron.NativeImage | null = null;
function getDragFallbackIcon(): Electron.NativeImage {
  if (dragFallbackIcon) return dragFallbackIcon;
  const c = getCanvas().createCanvas(64, 64);
  const g = c.getContext('2d');
  g.fillStyle = '#eef0f5';
  g.fillRect(12, 6, 40, 52);
  g.strokeStyle = '#9aa0b4';
  g.lineWidth = 2;
  g.strokeRect(12, 6, 40, 52);
  g.fillStyle = '#c5cad8';
  g.beginPath();
  g.moveTo(40, 6);
  g.lineTo(52, 18);
  g.lineTo(40, 18);
  g.closePath();
  g.fill();
  dragFallbackIcon = nativeImage.createFromBuffer(c.toBuffer('image/png'));
  return dragFallbackIcon;
}

export function registerWindowHandlers(): void {
  ipcMain.handle(
    'window:captureRegion',
    async (event, rect: { x: number; y: number; width: number; height: number }) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) {
        throw new Error('No source window available for captureRegion');
      }
      const image = await win.webContents.capturePage(rect);
      return image.toPNG().toString('base64');
    }
  );

  // Frameless title-bar window controls. Each resolves the focused window from
  // the sender so the handlers work regardless of which window called them.
  ipcMain.handle('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle('window:maximizeToggle', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle('window:isMaximized', (event) =>
    BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  );

  // Native OS drag of a file, so it can be dropped into sandboxed extension
  // iframes (e.g. dragging an image into the Excalidraw editor) where an
  // in-page HTML5 drag would not expose dataTransfer.files. Fire-and-forget
  // (ipcMain.on) because startDrag must run during the renderer's dragstart.
  ipcMain.on('drag:startFile', (event, filePath: string) => {
    try {
      let icon = nativeImage.createFromPath(filePath);
      if (icon.isEmpty()) {
        // Non-image (or unreadable) files have no preview → generic doc icon.
        icon = getDragFallbackIcon();
      } else {
        icon = icon.resize({ width: 64 });
      }
      event.sender.startDrag({ file: filePath, icon });
    } catch {
      // Drag is best-effort; ignore failures (e.g. file removed mid-drag).
    }
  });
}
