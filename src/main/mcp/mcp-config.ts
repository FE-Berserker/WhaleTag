import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { app } from 'electron';
import { atomicWriteJson } from '../atomic-write';

/**
 * MCP server configuration — owned and persisted BY THE MAIN PROCESS
 * (`<userData>/mcp-config.json`, atomic tmp+rename), not by the renderer's
 * redux-persist. Reason: the server must come up at bootstrap with its config
 * (enabled / port / token / readOnly) before any renderer IPC happens, and
 * the bearer token should not round-trip through renderer storage.
 *
 * The renderer reads/writes this via the `mcp:*` IPC handlers in
 * `ipc-mcp.ts`; nothing else touches the file.
 */

export interface McpConfig {
  /** Server listens when true. Default false — opt-in security posture. */
  enabled: boolean;
  /** Preferred port; falls back to a random free port when taken. */
  port: number;
  /** Bearer token required on every request. */
  token: string;
  /** When true, every mutating tool call is refused. */
  readOnly: boolean;
}

const DEFAULT_PORT = 7433;

function configPath(): string {
  return path.join(app.getPath('userData'), 'mcp-config.json');
}

function generateToken(): string {
  // base64url is whitespace/space-free by construction.
  return randomBytes(24).toString('base64url');
}

/** A usable bearer token: long enough and free of whitespace (a loaded token
 *  containing spaces could smuggle a "Bearer " scheme past naive parsers). */
function isUsableToken(token: unknown): token is string {
  return typeof token === 'string' && token.length >= 16 && !/\s/.test(token);
}

let cached: McpConfig | null = null;

export function loadMcpConfig(): McpConfig {
  if (cached) return cached;
  let loaded: Partial<McpConfig> = {};
  try {
    const p = configPath();
    if (existsSync(p)) {
      loaded = JSON.parse(readFileSync(p, 'utf8')) as Partial<McpConfig>;
    }
  } catch {
    // Corrupt config file: fall through to defaults + persist a fresh one.
  }
  cached = {
    enabled: loaded.enabled === true,
    port:
      typeof loaded.port === 'number' && loaded.port > 0 && loaded.port < 65536
        ? Math.floor(loaded.port)
        : DEFAULT_PORT,
    token: isUsableToken(loaded.token) ? loaded.token : generateToken(),
    readOnly: loaded.readOnly !== false, // default ON: safest first run
  };
  void persist();
  return cached;
}

async function persist(): Promise<void> {
  if (!cached) return;
  try {
    await atomicWriteJson(configPath(), cached);
  } catch (e) {
    // Never crash the app over config persistence — surface in dev console.
    console.error('[mcp] failed to persist config:', e);
  }
}

export async function setMcpEnabled(enabled: boolean): Promise<McpConfig> {
  loadMcpConfig().enabled = enabled;
  await persist();
  return { ...loadMcpConfig() };
}

export async function setMcpReadOnly(readOnly: boolean): Promise<McpConfig> {
  loadMcpConfig().readOnly = readOnly;
  await persist();
  return { ...loadMcpConfig() };
}

export async function regenerateMcpToken(): Promise<McpConfig> {
  loadMcpConfig().token = generateToken();
  await persist();
  return { ...loadMcpConfig() };
}
