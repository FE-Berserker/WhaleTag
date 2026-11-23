import { ipcMain } from 'electron';
import {
  getLanStatus,
  startLanServer,
  stopLanServer,
} from '../lan';

/** Desktop-only controls. None of these channels are exposed to the Web client. */
export function registerLanHandlers(): void {
  ipcMain.handle('lan:getStatus', () => getLanStatus());
  ipcMain.handle('lan:start', () => startLanServer());
  ipcMain.handle('lan:stop', () => stopLanServer());
}
