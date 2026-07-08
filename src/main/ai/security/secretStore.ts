/**
 * Encrypted secret store for the AI assistant. Uses Electron `safeStorage`
 * (DPAPI on Windows, Keychain on macOS, libsecret on Linux), so plaintext keys
 * NEVER enter redux-persist (localStorage) or cross to the renderer. The
 * renderer only sets/clears via IPC and sees a boolean "is set" status.
 *
 * Named secrets so multiple providers can each keep a key (Anthropic, OpenAI,
 * …). The encrypted blob lives at `<userData>/ai-secrets.json`.
 *
 * Must be used after `app.whenReady()` (safeStorage needs it).
 */
import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const SECRETS_FILE = 'ai-secrets.json';

/** Well-known secret names. */
export const SECRET_NAMES = {
  anthropic: 'anthropic',
  openai: 'openai',
} as const;
export type SecretName = (typeof SECRET_NAMES)[keyof typeof SECRET_NAMES];

function secretsPath(): string {
  return path.join(app.getPath('userData'), SECRETS_FILE);
}

type SecretsBlob = Record<string, string>;

function readAll(): SecretsBlob {
  try {
    const raw = fs.readFileSync(secretsPath(), 'utf8');
    const parsed = JSON.parse(raw) as SecretsBlob;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(blob: SecretsBlob): void {
  fs.writeFileSync(secretsPath(), JSON.stringify(blob, null, 2), {
    mode: 0o600,
  });
}

function decryptValue(encrypted: string): string {
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    return '';
  }
}

function assertEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS keychain/encryption is unavailable; cannot store the key securely.'
    );
  }
}

/** Persist a named secret (encrypted). Empty value removes it. */
export function setSecret(name: string, value: string): void {
  assertEncryptionAvailable();
  const trimmed = value.trim();
  const blob = readAll();
  if (!trimmed) {
    delete blob[name];
  } else {
    blob[name] = safeStorage.encryptString(trimmed).toString('base64');
  }
  writeAll(blob);
}

/** Remove a named secret. */
export function clearSecret(name: string): void {
  const blob = readAll();
  if (name in blob) {
    delete blob[name];
    writeAll(blob);
  }
}

/** True if a named secret is stored AND decryptable. A blob left over from a
 *  different OS user/machine (DPAPI/keychain are account-bound — e.g. after
 *  reinstalling the app or copying userData across machines) is NOT decryptable
 *  here; treat it as "not set" so the UI doesn't claim the key is set while
 *  getSecret() actually returns an empty string. A stale undecryptable blob is
 *  also dropped so it doesn't linger. */
export function hasSecret(name: string): boolean {
  const blob = readAll();
  const encrypted = blob[name];
  if (!encrypted) return false;
  if (decryptValue(encrypted) !== '') return true;
  // Stale undecryptable blob — drop it so it doesn't linger, then report unset.
  delete blob[name];
  try {
    writeAll(blob);
  } catch {
    // Best-effort cleanup; reporting "not set" is what matters.
  }
  return false;
}

/** Return the plaintext secret (main-process only). Empty string if none. */
export function getSecret(name: string): string {
  const encrypted = readAll()[name];
  if (!encrypted) return '';
  return decryptValue(encrypted);
}

// --- Back-compat wrappers for the Anthropic key (Claude Code CLI provider) ---

export const setApiKey = (key: string): void => setSecret(SECRET_NAMES.anthropic, key);
export const clearApiKey = (): void => clearSecret(SECRET_NAMES.anthropic);
export const hasApiKey = (): boolean => hasSecret(SECRET_NAMES.anthropic);
export const getApiKey = (): string => getSecret(SECRET_NAMES.anthropic);
