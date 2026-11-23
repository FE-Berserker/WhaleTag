import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import Module from 'module';
import { promises as fsp, existsSync } from 'fs';

/**
 * `persist-storage` resolves `<userData>/persist` lazily through Electron's
 * `app`. Stub `electron` before the dynamic import (same pattern as
 * mcp-config.test.ts) so the module writes into a scratch directory.
 */
const originalLoad = (Module as any)._load;
let userData = '';

(Module as any)._load = function (request: string, ...rest: unknown[]) {
  if (request === 'electron') {
    return { app: { getPath: () => userData } };
  }
  return originalLoad.apply(Module, [request, ...rest]);
};

type PersistModule = typeof import('./persist-storage');
let mod: PersistModule;

before(async () => {
  mod = await import('./persist-storage');
});

async function tmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'whale-persist-'));
}

describe('redux-persist file storage', () => {
  it('round-trips a blob and deletes it (ENOENT on the second delete is fine)', async () => {
    userData = await tmpDir();
    try {
      await mod.persistWrite('whale-root', '{"a":1}');
      assert.equal(await mod.persistRead('whale-root'), '{"a":1}');
      await mod.persistDelete('whale-root');
      assert.equal(await mod.persistRead('whale-root'), null);
      await mod.persistDelete('whale-root'); // absent → resolves, not an error
    } finally {
      await fsp.rm(userData, { recursive: true, force: true });
    }
  });

  it('rejects a non-ENOENT read failure instead of returning null', async () => {
    // A directory in the blob's place makes readFile fail with EISDIR — the
    // non-first-run case that used to be collapsed into null (and then let
    // redux-persist rewrite defaults over the real file).
    const dir = path.join(userData, 'persist', 'read-fail.json');
    try {
      await fsp.mkdir(dir, { recursive: true });
      await assert.rejects(mod.persistRead('read-fail'));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps a one-time .bak of the blob that was read at session start', async () => {
    const file = path.join(userData, 'persist', 'backup-test.json');
    const bak = `${file}.bak`;
    try {
      await mod.persistWrite('backup-test', 'v1');
      assert.equal(existsSync(bak), false, 'first write has nothing to back up');

      await mod.persistWrite('backup-test', 'v2');
      assert.equal(await fsp.readFile(bak, 'utf8'), 'v1');

      await mod.persistWrite('backup-test', 'v3');
      assert.equal(
        await fsp.readFile(bak, 'utf8'),
        'v1',
        'later writes must not overwrite the pre-session backup'
      );
    } finally {
      await fsp.rm(file, { force: true });
      await fsp.rm(bak, { force: true });
    }
  });

  it('rejects when the blob cannot be removed (purge must not fake success)', async () => {
    // `persistDir()` caches on first use, so reuse the first test's userData
    // directory and pick a different key.
    const dir = path.join(userData, 'persist', 'purge-fail.json');
    try {
      // A directory in the blob's place makes unlink fail with EPERM/EISDIR —
      // a non-ENOENT error that used to be logged and swallowed.
      await fsp.mkdir(dir, { recursive: true });
      await assert.rejects(mod.persistDelete('purge-fail'));
      assert.ok(existsSync(dir), 'failed delete must leave the path untouched');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
