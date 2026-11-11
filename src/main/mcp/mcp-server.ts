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

async function doStartListening(): Promise<void> {
  if (httpServer) return;
  const config = loadMcpConfig();
  // Build the protocol core locally and only publish it once the listener is
  // actually bound: a failed bind (EACCES, exhausted ports) must not leave a
  // half-initialised core behind — a retry would otherwise leak it and the
  // status snapshot would claim sessions the server can't serve.
  const newCore = createMcpHttpCore({
    token: () => loadMcpConfig().token,
    registerTools: registerMcpTools,
    serverInfo: { name: 'whaletag', version: getWhaleAppVersion() },
    instructions:
      'WhaleTag is a local-first file manager with tag-based organization. ' +
      'Start with whale_roots to discover configured locations. Metadata edits ' +
      '(tags, descriptions) are the preferred way to organize — they never touch ' +
      'user files. File operations require explicit user approval in the app window.',
  });
  try {
    const server = await new Promise<http.Server>((resolve, reject) => {
      const candidate = http.createServer((req, res) =>
        newCore.handler(req, res)
      );
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const tryBind = (port: number): void => {
        candidate.once('error', (e: NodeJS.ErrnoException) => {
          if (e.code === 'EADDRINUSE' && port !== 0) {
            // Configured port taken — fall back to an ephemeral port rather
            // than failing to come up at all (the settings UI shows the real
            // endpoint, so clients are configured from what's displayed).
            tryBind(0);
            return;
          }
          fail(e);
        });
        candidate.listen(port, '127.0.0.1', () => {
          if (settled) return;
          settled = true;
          resolve(candidate);
        });
      };
      tryBind(config.port);
    });
    httpServer = server;
    core = newCore;
    boundPort = (server.address() as { port: number }).port;
    // A post-listen server error (rare) must not become an unhandled 'error'
    // event and take down the main process.
    server.on('error', (e) => {
      // eslint-disable-next-line no-console
      console.error('[mcp] server error:', e);
    });
    // eslint-disable-next-line no-console
    console.log(`[mcp] listening on http://127.0.0.1:${boundPort}/mcp`);
  } catch (error) {
    await newCore.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Serialize startup: `initMcpServer()` and a settings toggle can both decide
 * to bring the listener up. Two concurrent binds would see `httpServer` null,
 * and the loser's EADDRINUSE would silently fall back to a second ephemeral
 * port — one listener leaked, status pointing at the other.
 */
let starting: Promise<void> | null = null;

function startListening(): Promise<void> {
  if (httpServer) return Promise.resolve();
  if (starting) return starting;
  starting = doStartListening().finally(() => {
    starting = null;
  });
  return starting;
}

export async function stopMcpServer(): Promise<void> {
  denyAllPending();
  await core?.close().catch(() => undefined);
  core = null;
  const server = httpServer;
  // Flip the observable state before awaiting the close callback so
  // getMcpStatus() reports "stopped" immediately.
  httpServer = null;
  boundPort = null;
  if (!server) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // A connected MCP client keeps its HTTP socket alive; server.close()
    // alone waits for every socket to drain, which would hang a settings
    // toggle (and before-quit) for as long as the client stays connected.
    server.closeAllConnections();
  });
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
    else if (kind === 'readOnly') {
      await persistReadOnly(value === true);
      // Turning read-only ON invalidates every pending file operation: their
      // approve() re-check would refuse them anyway, so deny the open dialogs
      // now instead of leaving them on screen for up to 60 s.
      if (value === true) denyAllPending();
    } else if (kind === 'token') await persistRegenerate();
    const config = loadMcpConfig();
    const running = httpServer !== null;
    if (config.enabled && !running) {
      // A bind failure (port exhausted, permissions) must not reject the IPC
      // call: the renderer only needs the fresh status — which honestly
      // reports running=false — and the reason belongs in the log.
      await startListening().catch((e) => {
        // eslint-disable-next-line no-console
        console.error('[mcp] failed to start:', e);
      });
    } else if (!config.enabled && running) {
      await stopMcpServer().catch((e) => {
        // eslint-disable-next-line no-console
        console.error('[mcp] failed to stop:', e);
      });
    }
  });
  // Chain onto lifecycle even if this caller doesn't await, so the next
  // change queues behind this one.
  lifecycle = run.catch(() => undefined);
  // Rejection here means the atomic persist failed — surface it to the caller
  // (the renderer shows an error) instead of returning a status that pretends
  // the toggle took effect.
  return run.then(() => getMcpStatus());
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
