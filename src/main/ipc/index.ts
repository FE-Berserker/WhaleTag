import { registerFsReadHandlers } from './fs-read';
import { registerFsWriteHandlers } from './fs-write';
import { registerFsRootsHandlers } from './fs-roots';
import { registerDialogHandlers } from './dialogs';
import { registerShellHandlers } from './shell';
import { registerSearchIndexHandlers } from './search-index';
import { registerMetaHandlers } from './meta';
import { registerThumbnailHandlers } from './thumbnails';
import { registerExtensionHandlers } from './extensions';
import { registerWindowHandlers } from './window';
import { registerPersistHandlers } from './persist';

/**
 * IPC registrar — thin composition root after the 2026-07-18 god-file split
 * (docs/01 §12). The old 1.4k-line `ipc.ts` mixed 87 inline handlers with
 * ~600 lines of business logic; each domain now owns a module in this
 * directory and this file only wires them up. Behavior is unchanged.
 *
 * Called once from main.ts after the app is ready.
 */
export function registerIpcHandlers(): void {
  registerFsReadHandlers();
  registerFsWriteHandlers();
  registerFsRootsHandlers();
  registerDialogHandlers();
  registerShellHandlers();
  registerSearchIndexHandlers();
  registerMetaHandlers();
  registerThumbnailHandlers();
  registerExtensionHandlers();
  registerWindowHandlers();
  registerPersistHandlers();
}
