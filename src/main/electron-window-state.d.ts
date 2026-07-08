/**
 * Ambient declaration for `electron-window-state` (ships no bundled types and
 * we don't pull in @types). Minimal surface matching how main.ts uses it.
 */
declare module 'electron-window-state' {
  import type { BrowserWindow } from 'electron';

  export interface WindowStateOptions {
    defaultWidth?: number;
    defaultHeight?: number;
    path?: string;
    file?: string;
    maximize?: boolean;
    fullscreen?: boolean;
  }

  export interface WindowState {
    x: number;
    y: number;
    width: number;
    height: number;
    isMaximized?: boolean;
    isFullScreen?: boolean;
    manage(window: BrowserWindow): void;
    unmanage(): void;
    saveState(): void;
  }

  function windowStateKeeper(options: WindowStateOptions): WindowState;

  export default windowStateKeeper;
}
