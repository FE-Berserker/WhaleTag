/**
 * AI IPC — always-on CORE handlers. Has NO SDK value import, so it is safe
 * to load + register at startup regardless of whether the AI component is
 * installed. Covers:
 *
 *  - API key storage (Anthropic + OpenAI-compatible), via safeStorage
 *  - CLI binary discovery (`ai:discoverCli`)
 *  - Component lifecycle: `ai:getComponentState` / `ai:installComponent` /
 *    `ai:uninstallComponent`
 *
 * The SDK-backed runtime handlers (query / prewarm / inline-edit / …) live in
 * `ipc-ai-runtime.ts` and are registered on-demand by
 * {@link maybeRegisterAiRuntimeHandlers} — only once the AI component is
 * detected, so the `ClaudeChatRuntime → loadClaudeSdk` chain never enters a
 * component-less install.
 */
import { ipcMain } from 'electron';

import { findClaudeCLIPath } from './providers/claude/cli/findClaudeCliPath';
import {
  SECRET_NAMES,
  clearApiKey,
  clearSecret,
  hasApiKey,
  hasSecret,
  setApiKey,
  setSecret,
} from './security/secretStore';
import { getAiComponentState, isAiComponentInstalled } from './component-resolver';
import { installAiComponent, uninstallAiComponent } from './component-installer';

export function registerAiCoreHandlers(): void {
  // --- API keys (Anthropic) ---
  ipcMain.handle('ai:setApiKey', (_event, key: string) => {
    setApiKey(key);
    return { ok: true };
  });
  ipcMain.handle('ai:clearApiKey', () => {
    clearApiKey();
    return { ok: true };
  });
  ipcMain.handle('ai:hasApiKey', () => hasApiKey());

  // --- API keys (OpenAI-compatible: ollama / openai providers) ---
  ipcMain.handle('ai:setOpenaiKey', (_event, key: string) => {
    setSecret(SECRET_NAMES.openai, key);
    return { ok: true };
  });
  ipcMain.handle('ai:clearOpenaiKey', () => {
    clearSecret(SECRET_NAMES.openai);
    return { ok: true };
  });
  ipcMain.handle('ai:hasOpenaiKey', () => hasSecret(SECRET_NAMES.openai));

  // --- CLI discovery (unchanged contract: { path }) ---
  ipcMain.handle('ai:discoverCli', (_event, override: string | null) => ({
    path: findClaudeCLIPath(override || undefined),
  }));

  // --- Component lifecycle ---
  ipcMain.handle('ai:getComponentState', () => getAiComponentState());

  ipcMain.handle('ai:installComponent', async (_event, filePath: string) => {
    const result = await installAiComponent(filePath);
    // Hot-load the runtime handlers now that the component is present, so the
    // user can use AI immediately without a restart. Idempotent (guarded by
    // `runtimeRegistered`), so re-installs don't double-register.
    if (result.ok) {
      await maybeRegisterAiRuntimeHandlers();
    }
    return result;
  });

  ipcMain.handle('ai:uninstallComponent', async () => uninstallAiComponent());
}

// Track whether the runtime handlers have been registered this process
// lifetime. `ipcMain.handle` throws if the same channel is registered twice,
// so this guard makes `maybeRegisterAiRuntimeHandlers` idempotent — callable
// on boot AND after a component install without risk.
let runtimeRegistered = false;

/**
 * Register the SDK-backed runtime handlers iff the AI component is installed.
 *
 * Dynamic-imports `ipc-ai-runtime` so the SDK resolution chain only enters the
 * process when there's actually a component to load from. Idempotent.
 *
 * @returns true if the runtime was (or already had been) registered.
 */
export async function maybeRegisterAiRuntimeHandlers(): Promise<boolean> {
  if (runtimeRegistered) return true;
  if (!isAiComponentInstalled()) return false;
  const { registerAiRuntimeHandlers } = await import('./ipc-ai-runtime');
  registerAiRuntimeHandlers();
  runtimeRegistered = true;
  return true;
}
