import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { app, safeStorage } from 'electron';
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
 *
 * At-rest token: the bearer token grants read access to every configured
 * location (and, with approval, writes), so the file never stores it in clear
 * text when Electron's OS-backed `safeStorage` can encrypt. The persisted
 * document carries either `tokenEncrypted` (`tokenStorage: "safeStorage"`) or
 * — on machines without a usable keyring — a plaintext `token`
 * (`tokenStorage: "plain"`). Legacy plaintext documents are migrated to
 * encrypted storage on the next write. See docs/21 §4.
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

/** Encrypt/decrypt surface, injectable so the vault path is testable. */
export interface TokenCipher {
  isAvailable(): boolean;
  encrypt(plain: string): string;
  decrypt(encoded: string): string;
}

/** Shape written to `mcp-config.json`; `McpConfig` is the in-memory view. */
interface PersistedMcpConfig {
  enabled: boolean;
  port: number;
  readOnly: boolean;
  tokenStorage: 'safeStorage' | 'plain';
  tokenEncrypted?: string;
  token?: string;
}

const DEFAULT_PORT = 7433;

/** Cipher used where encryption must be assumed unavailable (pure parsing). */
const UNAVAILABLE_CIPHER: TokenCipher = {
  isAvailable: () => false,
  encrypt: () => {
    throw new Error('encryption is unavailable');
  },
  decrypt: () => {
    throw new Error('encryption is unavailable');
  },
};

/**
 * OS-backed cipher. `safeStorage` is only usable after the app is ready —
 * `loadMcpConfig()` is called from `initMcpServer()`, which runs inside
 * `bootstrap()` after `whenReady()`, so that holds in production. On Linux
 * without a keyring Electron falls back to a hardcoded key ("basic_text");
 * `isEncryptionAvailable()` still reports true there, which keeps configs
 * readable but only obfuscates the token — docs/21 says so.
 */
const electronCipher: TokenCipher = {
  isAvailable() {
    try {
      return (
        typeof safeStorage?.isEncryptionAvailable === 'function' &&
        safeStorage.isEncryptionAvailable()
      );
    } catch {
      return false;
    }
  },
  encrypt(plain) {
    return safeStorage.encryptString(plain).toString('base64');
  },
  decrypt(encoded) {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  },
};

let cipherOverride: TokenCipher | null = null;

function currentCipher(): TokenCipher {
  return cipherOverride ?? electronCipher;
}

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

function asConfigObject(loaded: unknown): Partial<PersistedMcpConfig> {
  return loaded && typeof loaded === 'object' && !Array.isArray(loaded)
    ? (loaded as Partial<PersistedMcpConfig>)
    : {};
}

/**
 * Resolve the bearer token from a persisted document. Order: encrypted value
 * (when the cipher can read it) → plaintext value (legacy or keyring-less
 * install) → a freshly generated one. Every fallback that loses a previously
 * stored token is logged, because clients holding the old token will start
 * failing with 401 and the log is the only place that explains why.
 */
function resolveToken(
  doc: Partial<PersistedMcpConfig>,
  cipher: TokenCipher
): string {
  const encrypted =
    typeof doc.tokenEncrypted === 'string' && doc.tokenEncrypted.length > 0
      ? doc.tokenEncrypted
      : null;
  let failure = '';
  if (encrypted) {
    if (cipher.isAvailable()) {
      try {
        const decrypted = cipher.decrypt(encrypted);
        if (isUsableToken(decrypted)) return decrypted;
        failure = 'the decrypted token is not usable';
      } catch (e) {
        failure = `decryption failed: ${String(e)}`;
      }
    } else {
      failure = 'encryption is unavailable on this machine';
    }
  }
  if (isUsableToken(doc.token)) {
    if (failure) {
      // eslint-disable-next-line no-console
      console.warn(
        `[mcp] falling back to the plaintext token (${failure}); it will be re-encrypted on the next write`
      );
    }
    return doc.token;
  }
  if (failure || doc.token !== undefined) {
    // eslint-disable-next-line no-console
    console.warn(
      `[mcp] a new bearer token was generated because the stored one could not be read (${failure || 'malformed token'})`
    );
  }
  return generateToken();
}

/**
 * Coerce an arbitrary parsed JSON document into a usable config. Exported so
 * the validation matrix (non-object documents, bad ports, unusable tokens)
 * can be unit-tested without touching the filesystem or Electron. Passing a
 * cipher exercises the encrypted-token branch.
 */
export function normalizeMcpConfig(
  loaded: unknown,
  cipher: TokenCipher = UNAVAILABLE_CIPHER
): McpConfig {
  const doc = asConfigObject(loaded);
  const port = doc.port;
  return {
    enabled: doc.enabled === true,
    port:
      typeof port === 'number' && Number.isFinite(port) && port > 0 && port < 65536
        ? Math.floor(port)
        : DEFAULT_PORT,
    token: resolveToken(doc, cipher),
    readOnly: doc.readOnly !== false, // default ON: safest first run
  };
}

/** The document written to disk; never contains both token forms. */
function toPersistedDoc(cfg: McpConfig, cipher: TokenCipher): PersistedMcpConfig {
  const base = {
    enabled: cfg.enabled,
    port: cfg.port,
    readOnly: cfg.readOnly,
  };
  if (cipher.isAvailable()) {
    try {
      return {
        ...base,
        tokenStorage: 'safeStorage',
        tokenEncrypted: cipher.encrypt(cfg.token),
      };
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(
        '[mcp] could not encrypt the bearer token; storing it in plain text:',
        e
      );
    }
  }
  return { ...base, tokenStorage: 'plain', token: cfg.token };
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
  cached = normalizeMcpConfig(loaded, currentCipher());
  schedulePersist();
  return cached;
}

async function persist(): Promise<void> {
  if (!cached) return;
  try {
    await atomicWriteJson(configPath(), toPersistedDoc(cached, currentCipher()));
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

/**
 * Test seams: swap the cipher (the production one needs a real Electron app)
 * and drop the in-memory cache so a re-read hits the file again. Await
 * `flushMcpConfigWrites()` before resetting, or a queued write may see
 * `cached === null` and be skipped.
 */
export function __setTokenCipherForTest(cipher: TokenCipher | null): void {
  cipherOverride = cipher;
}

export function __resetMcpConfigForTest(): void {
  cached = null;
}
