import http from 'node:http';
import { BrowserWindow } from 'electron';

import {
  loadMcpConfig,
  setMcpEnabled as persistEnabled,
  setMcpReadOnly as persistReadOnly,
  regenerateMcpToken as persistRegenerate,
} from './mcp-config';
import { createMcpHttpCore, type McpHttpCore } from './mcp-http';
import {
  bindApprovalTransport,
  denyAllPending,
  pendingApprovals,
  resolveApproval,
} from './mcp-approval';
import { registerMcpTools, watchRawRoots } from './mcp-tools';
import { getWhaleAppVersion } from '../app-version';
import type { McpStatus } from '../../shared/mcp-types';

/**
 * Electron-facing shell of the local MCP server (docs/21): lifecycle
 * (bootstrap / quit / settings toggles), the approval push channel and the
 * status snapshot. The protocol core — bearer auth, sessions, transport —
 * lives in the electron-free mcp-http.ts.
 *
 * Listens on 127.0.0.1 only, never exposed to the network. Opt-in (config
 * defaults to disabled + read-only), main-process owned config file.
 */

let httpServer: http.Server | null = null;
let core: McpHttpCore | null = null;
let boundPort: number | null = null;
let unwatchRoots: (() => void) | null = null;

function startListening(): Promise<void> {
  const config = loadMcpConfig();
  core = createMcpHttpCore({
    token: () => loadMcpConfig().token,
    registerTools: registerMcpTools,
    serverInfo: { name: 'whaletag', version: getWhaleAppVersion() },
    instructions:
      'WhaleTag is a local-first file manager with tag-based organization. ' +
      'Start with whale_roots to discover configured locations. Metadata edits ' +
      '(tags, descriptions) are the preferred way to organize — they never touch ' +
      'user files. File operations require explicit user approval in the app window.',
  });
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => core!.handler(req, res));
    const tryBind = (port: number): void => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' && port !== 0) {
          // Configured port taken — fall back to an ephemeral port rather
          // than failing to come up at all (the settings UI shows the real
          // endpoint, so clients are configured from what's displayed).
          tryBind(0);
          return;
        }
        reject(e);
      });
      server.listen(port, '127.0.0.1', () => {
        httpServer = server;
        boundPort = (server.address() as { port: number }).port;
        // eslint-disable-next-line no-console
        console.log(`[mcp] listening on http://127.0.0.1:${boundPort}/mcp`);
        resolve();
      });
    };
    tryBind(config.port);
  });
}

export async function stopMcpServer(): Promise<void> {
  denyAllPending();
  await core?.close().catch(() => undefined);
  core = null;
  if (httpServer) {
    await new Promise<void>((resolve) => {
      httpServer!.close(() => resolve());
    });
    httpServer = null;
  }
  boundPort = null;
}

export function getMcpStatus(): McpStatus {
  const config = loadMcpConfig();
  return {
    running: httpServer !== null,
    port: boundPort,
    endpoint:
      boundPort !== null ? `http://127.0.0.1:${boundPort}/mcp` : null,
    token: config.token,
    readOnly: config.readOnly,
    sessions: core?.sessionCount() ?? 0,
  };
}

/**
 * Apply an enabled/readOnly/token change coming from the settings UI:
 * persist it and bring the listener up/down to match. Returns fresh status.
 *
 * Lifecycle changes are serialized through `lifecycle`: two concurrent
 * toggles would otherwise both observe the pre-toggle state and race — a
 * double-enable leaks a second listener; a disable racing an in-flight
 * enable orphans one (module state nulled while the port stays bound).
 */
let lifecycle: Promise<void> = Promise.resolve();

export function applyMcpConfigChange(
  kind: 'enabled' | 'readOnly' | 'token',
  value?: boolean
): Promise<McpStatus> {
  const run = lifecycle.then(async () => {
    // Mutate + await the atomic persist INSIDE the serialized run: rapid
    // toggles apply in call order, and the config file is on disk before the
    // listener reflects the change (a crash right after a toggle can't lose it).
    if (kind === 'enabled') await persistEnabled(value === true);
    else if (kind === 'readOnly') await persistReadOnly(value === true);
    else if (kind === 'token') await persistRegenerate();
    const config = loadMcpConfig();
    const running = httpServer !== null;
    if (config.enabled && !running) await startListening();
    else if (!config.enabled && running) await stopMcpServer();
  });
  // Chain onto lifecycle even if this caller doesn't await, so the next
  // change queues behind this one. Swallow here — the caller gets status.
  lifecycle = run.catch(() => undefined);
  return run.then(getMcpStatus, getMcpStatus);
}

/** Boot hook — call once from main.ts bootstrap(). */
export async function initMcpServer(): Promise<void> {
  // The approval gate needs to reach the renderer (dialog) and know whether
  // a live window exists to show it.
  bindApprovalTransport({
    broadcast: (req) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('mcp:approvalRequest', req);
      }
    },
    hasWindows: () =>
      BrowserWindow.getAllWindows().some((w) => !w.isDestroyed()),
  });
  unwatchRoots = watchRawRoots();
  if (loadMcpConfig().enabled) {
    await startListening().catch((e) => {
      // Never block app startup on the MCP listener — surface and continue.
      // eslint-disable-next-line no-console
      console.error('[mcp] failed to start:', e);
    });
  }
}

/** Quit hook — deny pending approvals and release the port. */
export async function shutdownMcpServer(): Promise<void> {
  unwatchRoots?.();
  unwatchRoots = null;
  await stopMcpServer();
}

export { resolveApproval, pendingApprovals };
