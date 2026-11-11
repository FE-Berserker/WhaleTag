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

/**
 * Coerce an arbitrary parsed JSON document into a usable config. Exported so
 * the validation matrix (non-object documents, bad ports, unusable tokens)
 * can be unit-tested without touching the filesystem or Electron.
 */
export function normalizeMcpConfig(loaded: unknown): McpConfig {
  const doc =
    loaded && typeof loaded === 'object' && !Array.isArray(loaded)
      ? (loaded as Partial<McpConfig>)
      : {};
  const port = doc.port;
  return {
    enabled: doc.enabled === true,
    port:
      typeof port === 'number' && Number.isFinite(port) && port > 0 && port < 65536
        ? Math.floor(port)
        : DEFAULT_PORT,
    token: isUsableToken(doc.token) ? doc.token : generateToken(),
    readOnly: doc.readOnly !== false, // default ON: safest first run
  };
}

let cached: McpConfig | null = null;

/**
 * Serialize every atomic write so a load-triggered persist can't interleave
 * with a settings toggle, and so `flushMcpConfigWrites()` gives tests (and an
 * orderly quit) a single promise to await.
 */
let writeQueue: Promise<void> = Promise.resolve();

export function loadMcpConfig(): McpConfig {
  if (cached) return cached;
  let loaded: unknown = null;
  const p = configPath();
  try {
    if (existsSync(p)) {
      const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
      // `null`, an array or a scalar is valid JSON but not a config object.
      // Without this guard `loaded.enabled` throws on a null document and the
      // whole bootstrap (which loads MCP config before any window exists)
      // would fail to start.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        loaded = parsed;
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          '[mcp] config file is not a JSON object; falling back to defaults'
        );
      }
    }
  } catch (e) {
    // Corrupt JSON or unreadable file: fall through to defaults + persist a
    // fresh one. This regenerates the bearer token, so say it out loud —
    // otherwise every configured client starts failing with 401 for no
    // visible reason.
    // eslint-disable-next-line no-console
    console.warn('[mcp] config unreadable, regenerating with defaults:', e);
  }
  cached = normalizeMcpConfig(loaded);
  schedulePersist();
  return cached;
}

async function persist(): Promise<void> {
  if (!cached) return;
  try {
    await atomicWriteJson(configPath(), cached);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[mcp] failed to persist config:', e);
    // Re-throw so the settings IPC call fails loudly: resolving here makes the
    // renderer show a new switch/token that disk never received, which then
    // silently reverts on restart (or 401s clients holding the "current" token).
    throw e;
  }
}

function schedulePersist(): void {
  // Bootstrap write: nothing awaits it, so keep a failure from becoming an
  // unhandled rejection (it is logged by persist()).
  writeQueue = writeQueue.then(persist).catch(() => undefined);
}

/** Queue a write behind any in-flight one and await its completion. */
async function persistNow(): Promise<void> {
  const write = writeQueue.then(persist);
  writeQueue = write.catch(() => undefined);
  await write;
}

/** Await every queued config write (tests / orderly shutdown). */
export async function flushMcpConfigWrites(): Promise<void> {
  await writeQueue;
}

export async function setMcpEnabled(enabled: boolean): Promise<McpConfig> {
  loadMcpConfig().enabled = enabled;
  await persistNow();
  return { ...loadMcpConfig() };
}

export async function setMcpReadOnly(readOnly: boolean): Promise<McpConfig> {
  loadMcpConfig().readOnly = readOnly;
  await persistNow();
  return { ...loadMcpConfig() };
}

export async function regenerateMcpToken(): Promise<McpConfig> {
  loadMcpConfig().token = generateToken();
  await persistNow();
  return { ...loadMcpConfig() };
}
