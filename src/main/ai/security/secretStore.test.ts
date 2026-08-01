import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

// --- Mock electron's `app` + `safeStorage` BEFORE requiring secretStore. ---
// secretStore does `import { app, safeStorage } from 'electron'` at module
// top, and under ELECTRON_RUN_AS_NODE those APIs aren't usable. Inject a
// stub into require.cache (same technique ipc.test.ts uses) that hands
// secretStore a REVERSIBLE cipher — not identity: a prefix tag proves the
// stored blob holds the cipher output rather than the raw key. (Real
// encryption strength is Electron/OS-keychain's job; this pins the contract
// that secretStore routes through encrypt/decrypt and never stores plaintext.)
let userDataDir = '';
const require_ = createRequire(__filename);
const electronPath = require_.resolve('electron');
const savedElectron = require_.cache[electronPath];

const electronStub = {
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (b: Buffer) => {
      const s = b.toString('utf8');
      return s.startsWith('enc:') ? s.slice(4) : '';
    },
  },
};
require_.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: electronStub,
} as unknown as NodeJS.Module;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { setSecret, getSecret, hasSecret, clearSecret } =
  require_('./secretStore') as typeof import('./secretStore');

const SECRETS_FILE = 'ai-secrets.json';

describe('secretStore — encrypted secret storage', () => {
  let dir: string;
  let file: string;

  before(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-secret-'));
    userDataDir = dir;
    file = path.join(dir, SECRETS_FILE);
  });
  after(async () => {
    if (savedElectron) require_.cache[electronPath] = savedElectron;
    else delete require_.cache[electronPath];
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('round-trips a secret through encrypt/decrypt', () => {
    setSecret('anthropic', 'sk-test-12345');
    assert.equal(getSecret('anthropic'), 'sk-test-12345');
    assert.equal(hasSecret('anthropic'), true);
  });

  it('stores ciphertext, never plaintext (blob has no raw key)', async () => {
    setSecret('openai', 'sk-PLAINTEXT-CANARY');
    const raw = await fsp.readFile(file, 'utf8');
    assert.ok(!raw.includes('sk-PLAINTEXT-CANARY'), 'plaintext leaked into the blob');
    // …yet the secret is still recoverable through decrypt.
    assert.equal(getSecret('openai'), 'sk-PLAINTEXT-CANARY');
  });

  it('returns empty string for a missing secret', () => {
    assert.equal(getSecret('does-not-exist'), '');
    assert.equal(hasSecret('does-not-exist'), false);
  });

  it('setSecret with an empty/whitespace value removes the secret', () => {
    setSecret('anthropic', 'sk-test-12345');
    assert.equal(hasSecret('anthropic'), true);
    setSecret('anthropic', '   ');
    assert.equal(hasSecret('anthropic'), false);
    assert.equal(getSecret('anthropic'), '');
  });

  it('clearSecret removes a stored secret', () => {
    setSecret('openai', 'sk-keep');
    clearSecret('openai');
    assert.equal(hasSecret('openai'), false);
    assert.equal(getSecret('openai'), '');
  });

  it('drops a stale undecryptable blob and reports unset', async () => {
    // Simulate a blob left by a different OS user/machine (DPAPI/keychain are
    // account-bound): replace the ciphertext with bytes our cipher can't
    // decrypt. hasSecret must not claim it's set, and must drop the entry.
    setSecret('anthropic', 'sk-real');
    const blob = JSON.parse(await fsp.readFile(file, 'utf8'));
    blob.anthropic = Buffer.from('not-our-cipher', 'utf8').toString('base64');
    await fsp.writeFile(file, JSON.stringify(blob), 'utf8');
    assert.equal(hasSecret('anthropic'), false);
    const after = JSON.parse(await fsp.readFile(file, 'utf8'));
    assert.equal('anthropic' in after, false, 'stale blob was not dropped');
  });
});
