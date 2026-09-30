import { ipcMain } from 'electron';
import {
  getMcpStatus,
  applyMcpConfigChange,
  resolveApproval,
  pendingApprovals,
} from './mcp-server';

/**
 * `mcp:*` IPC handlers — the settings UI (enable toggle, read-only switch,
 * token display/regeneration) and the approval dialog's allow/deny answers.
 * Config lives in the main process (mcp-config.ts); the renderer only polls
 * status and pushes decisions, it never holds the authoritative state.
 */
export function registerMcpHandlers(): void {
  ipcMain.handle('mcp:getStatus', () => getMcpStatus());

  ipcMain.handle(
    'mcp:setEnabled',
    (_event, enabled: boolean) => applyMcpConfigChange('enabled', enabled)
  );

  ipcMain.handle(
    'mcp:setReadOnly',
    (_event, readOnly: boolean) => applyMcpConfigChange('readOnly', readOnly)
  );

  ipcMain.handle('mcp:regenerateToken', () => applyMcpConfigChange('token'));

  ipcMain.handle(
    'mcp:resolveApproval',
    (_event, reqId: string, allowed: boolean) => {
      resolveApproval(reqId, allowed);
      return { ok: true } as const;
    }
  );

  // A window (re)loading mid-approval pulls the current queue on mount so
  // its dialogs survive a dev reload (pending approvals auto-deny after 60s).
  ipcMain.handle('mcp:pendingApprovals', () => pendingApprovals());
}
