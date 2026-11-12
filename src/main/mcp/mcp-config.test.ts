import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Module from 'node:module';
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Config-loading and persistence tests for the MCP server.
 *
 * `mcp-config.ts` reads `<userData>/mcp-config.json` through Electron's
 * `app.getPath`, so `electron` is stubbed before the module is imported (the
 * same pattern mcp-http.test.ts uses). The validation matrix is exercised
 * through the exported `normalizeMcpConfig`, which is deliberately
 * filesystem-free; the persistence half runs against a throwaway userData dir.
 */

const TMP_USER_DATA = path.join(
  os.tmpdir(),
  `whaletag-mcp-config-${process.pid}-${Date.now()}`
);
fs.mkdirSync(TMP_USER_DATA, { recursive: true });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const electronStub: any = {
  app: {
    getPath: () => TMP_USER_DATA,
    setName: () => undefined,
    isPackaged: true,
  },
  ipcMain: { handle: () => undefined, on: () => undefined },
  shell: {},
  BrowserWindow: { getAllWindows: () => [] },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: unknown[]) {
  if (request === 'electron') return electronStub;
  return originalLoad.apply(Module, [request, ...rest]);
};

import type { TokenCipher } from './mcp-config';

type McpConfigModule = typeof import('./mcp-config');
let mod: McpConfigModule;

const VALID_TOKEN = 'A'.repeat(32);

before(async () => {
  fs.writeFileSync(
    path.join(TMP_USER_DATA, 'mcp-config.json'),
    JSON.stringify({
      enabled: true,
      port: 8123,
      token: VALID_TOKEN,
      readOnly: false,
    })
  );
  mod = await import('./mcp-config');
});

describe('mcp-config — normalizeMcpConfig', () => {
  it('keeps a fully valid document', () => {
    const cfg = mod.normalizeMcpConfig({
      enabled: true,
      port: 9000,
      token: VALID_TOKEN,
      readOnly: false,
    });
    assert.deepEqual(cfg, {
      enabled: true,
      port: 9000,
      token: VALID_TOKEN,
      readOnly: false,
    });
  });

  it('defaults to disabled + read-only on an empty document', () => {
    const cfg = mod.normalizeMcpConfig({});
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.readOnly, true);
    assert.equal(cfg.port, 7433);
    assert.ok(cfg.token.length >= 16);
  });

  it('survives non-object documents (null / array / scalar)', () => {
    for (const doc of [null, undefined, [], 42, 'nope']) {
      const cfg = mod.normalizeMcpConfig(doc);
      assert.equal(cfg.enabled, false, `enabled for ${JSON.stringify(doc)}`);
      assert.equal(cfg.port, 7433, `port for ${JSON.stringify(doc)}`);
      assert.equal(cfg.readOnly, true, `readOnly for ${JSON.stringify(doc)}`);
    }
  });

  it('rejects unusable ports and falls back to the default', () => {
    for (const port of [0, -1, 65536, 70000, Number.NaN, Number.POSITIVE_INFINITY, '8123']) {
      assert.equal(
        mod.normalizeMcpConfig({ port }).port,
        7433,
        `port ${String(port)}`
      );
    }
    assert.equal(mod.normalizeMcpConfig({ port: 8080.9 }).port, 8080);
  });

  it('regenerates a short or whitespace-bearing token', () => {
    for (const token of ['short', 'has space here and is long', 42, null]) {
      const cfg = mod.normalizeMcpConfig({ token });
      assert.ok(cfg.token.length >= 16, `token ${String(token)}`);
      assert.ok(!/\s/.test(cfg.token), `token ${String(token)}`);
      assert.notEqual(cfg.token, token);
    }
    // Whitespace anywhere is disqualifying, even mid-token.
    assert.notEqual(mod.normalizeMcpConfig({ token: `${VALID_TOKEN} ` }).token, `${VALID_TOKEN} `);
  });

  it('treats readOnly: undefined as ON but an explicit false as OFF', () => {
    assert.equal(mod.normalizeMcpConfig({}).readOnly, true);
    assert.equal(mod.normalizeMcpConfig({ readOnly: false }).readOnly, false);
    assert.equal(mod.normalizeMcpConfig({ readOnly: true }).readOnly, true);
    assert.equal(mod.normalizeMcpConfig({ readOnly: 0 }).readOnly, true);
  });
});

describe('mcp-config — load + persist', () => {
  it('reads the on-disk config once and caches it', () => {
    const cfg = mod.loadMcpConfig();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.port, 8123);
    assert.equal(cfg.token, VALID_TOKEN);
    assert.equal(cfg.readOnly, false);
    // The second call must not re-read the file (mutating the cached object is
    // the documented contract for the setters).
    cfg.port = 8124;
    assert.equal(mod.loadMcpConfig().port, 8124);
    cfg.port = 8123;
  });

  it('persists the first load atomically as valid JSON', async () => {
    mod.loadMcpConfig();
    await mod.flushMcpConfigWrites();
    const file = path.join(TMP_USER_DATA, 'mcp-config.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<
      string,
      unknown
    >;
    assert.equal(parsed.token, VALID_TOKEN);
    assert.equal(parsed.enabled, true);
    // Atomic write = no tmp leftovers next to the config.
    const leftovers = fs
      .readdirSync(TMP_USER_DATA)
      .filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  it('setMcpEnabled persists immediately and is visible to status reads', async () => {
    const cfg = await mod.setMcpEnabled(false);
    assert.equal(cfg.enabled, false);
    assert.equal(mod.loadMcpConfig().enabled, false);
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(TMP_USER_DATA, 'mcp-config.json'), 'utf8')
    ) as { enabled: boolean };
    assert.equal(onDisk.enabled, false);
  });

  it('setMcpReadOnly flips the write gate default', async () => {
    const cfg = await mod.setMcpReadOnly(true);
    assert.equal(cfg.readOnly, true);
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(TMP_USER_DATA, 'mcp-config.json'), 'utf8')
    ) as { readOnly: boolean };
    assert.equal(onDisk.readOnly, true);
  });

  it('regenerateMcpToken rotates to a new usable token and persists it', async () => {
    const before = mod.loadMcpConfig().token;
    const cfg = await mod.regenerateMcpToken();
    assert.notEqual(cfg.token, before);
    assert.ok(cfg.token.length >= 16);
    assert.ok(!/\s/.test(cfg.token));
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(TMP_USER_DATA, 'mcp-config.json'), 'utf8')
    ) as { token: string };
    assert.equal(onDisk.token, cfg.token);
  });
});

describe('mcp-config — bearer token at rest', () => {
  const file = path.join(TMP_USER_DATA, 'mcp-config.json');
  const TOKEN_B = 'B'.repeat(32);
  const TOKEN_C = 'C'.repeat(32);

  const encrypting: TokenCipher = {
    isAvailable: () => true,
    encrypt: (plain) => `enc:${Buffer.from(plain, 'utf8').toString('base64')}`,
    decrypt: (encoded) => {
      if (!encoded.startsWith('enc:')) throw new Error('not our ciphertext');
      return Buffer.from(encoded.slice(4), 'base64').toString('utf8');
    },
  };
  const plaintextOnly: TokenCipher = {
    isAvailable: () => false,
    encrypt: () => {
      throw new Error('encryption is unavailable');
    },
    decrypt: () => {
      throw new Error('encryption is unavailable');
    },
  };

  const writePlaintext = (token: string): void => {
    fs.writeFileSync(
      file,
      JSON.stringify({ enabled: false, port: 7434, token, readOnly: true })
    );
  };
  const readDoc = (): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

  it('re-encrypts a legacy plaintext config on load and reads it back', async () => {
    writePlaintext(TOKEN_B);
    mod.__setTokenCipherForTest(encrypting);
    mod.__resetMcpConfigForTest();

    assert.equal(mod.loadMcpConfig().token, TOKEN_B);
    await mod.flushMcpConfigWrites();

    const doc = readDoc();
    assert.equal(doc.tokenStorage, 'safeStorage');
    assert.equal(typeof doc.tokenEncrypted, 'string');
    assert.equal('token' in doc, false, 'plaintext token must not be written');
    assert.notEqual(doc.tokenEncrypted, TOKEN_B);

    mod.__resetMcpConfigForTest();
    assert.equal(mod.loadMcpConfig().token, TOKEN_B);
    await mod.flushMcpConfigWrites();
  });

  it('falls back to plaintext storage when encryption is unavailable', async () => {
    writePlaintext(TOKEN_B);
    mod.__setTokenCipherForTest(plaintextOnly);
    mod.__resetMcpConfigForTest();

    const token = mod.loadMcpConfig().token;
    await mod.flushMcpConfigWrites();

    const doc = readDoc();
    assert.equal(doc.tokenStorage, 'plain');
    assert.equal(doc.token, token);
    assert.equal('tokenEncrypted' in doc, false);
  });

  it('uses the plaintext token when the encrypted one cannot be decrypted', async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        enabled: true,
        port: 7435,
        readOnly: false,
        tokenStorage: 'safeStorage',
        tokenEncrypted: 'not-a-real-ciphertext',
        token: TOKEN_C,
      })
    );
    mod.__setTokenCipherForTest(encrypting);
    mod.__resetMcpConfigForTest();

    const cfg = mod.loadMcpConfig();
    assert.equal(cfg.token, TOKEN_C, 'plaintext fallback keeps clients working');
    await mod.flushMcpConfigWrites();
    // The next write upgrades the fallback back to encrypted storage.
    const doc = readDoc();
    assert.equal(doc.tokenStorage, 'safeStorage');
    assert.equal('token' in doc, false);
  });

  it('generates a fresh token when an encrypted config cannot be unlocked at all', async () => {
    writePlaintext(TOKEN_B);
    mod.__setTokenCipherForTest(encrypting);
    mod.__resetMcpConfigForTest();
    mod.loadMcpConfig();
    await mod.flushMcpConfigWrites();

    mod.__setTokenCipherForTest(plaintextOnly);
    mod.__resetMcpConfigForTest();
    const cfg = mod.loadMcpConfig();
    assert.notEqual(cfg.token, TOKEN_B);
    assert.ok(cfg.token.length >= 16);
    await mod.flushMcpConfigWrites();
    assert.equal(readDoc().token, cfg.token);

    mod.__setTokenCipherForTest(null);
  });

  it('decrypts through normalizeMcpConfig without touching the filesystem', () => {
    const doc = {
      enabled: true,
      port: 7433,
      readOnly: true,
      tokenStorage: 'safeStorage',
      tokenEncrypted: encrypting.encrypt(TOKEN_C),
    };
    assert.equal(mod.normalizeMcpConfig(doc, encrypting).token, TOKEN_C);
    assert.notEqual(mod.normalizeMcpConfig(doc).token, TOKEN_C);
  });
});
