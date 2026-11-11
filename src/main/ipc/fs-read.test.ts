import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { setAllowedRoots } from '../allowed-roots';

const require_ = createRequire(__filename);
const FS_READ_MODULE = './fs-read';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown> | unknown;

const savedElectron = new Map<string, NodeJS.Module | undefined>();

function registerHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const electronPath = require_.resolve('electron');
  if (!savedElectron.has(electronPath)) {
    savedElectron.set(electronPath, require_.cache[electronPath]);
  }
  const existing = require_.cache[electronPath];
  require_.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      ipcMain: {
        handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
      },
    },
    children: existing?.children ?? [],
    paths: existing?.paths ?? [],
  } as NodeJS.Module;

  try {
    delete require_.cache[require_.resolve(FS_READ_MODULE)];
  } catch {
    // The module has not been loaded yet.
  }
  require_(FS_READ_MODULE).registerFsReadHandlers();
  return handlers;
}

describe('fs:readFileBase64', () => {
  let handlers: Map<string, Handler>;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-fs-read64-'));
    root = await fsp.realpath(scratch);
    outside = await fsp.realpath(
      await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-fs-read64-outside-'))
    );
    setAllowedRoots([root]);
    handlers = registerHandlers();
  });

  afterEach(async () => {
    setAllowedRoots([]);
    for (const [modulePath, original] of savedElectron.entries()) {
      if (original) require_.cache[modulePath] = original;
      else delete require_.cache[modulePath];
    }
    savedElectron.clear();
    try {
      delete require_.cache[require_.resolve(FS_READ_MODULE)];
    } catch {
      // Nothing to clear.
    }
    await Promise.all([
      fsp.rm(root, { recursive: true, force: true }),
      fsp.rm(outside, { recursive: true, force: true }),
    ]);
  });

  it('returns canonical base64 as one string, never a byte array', async () => {
    const filePath = path.join(root, 'all-bytes.bin');
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    await fsp.writeFile(filePath, bytes);

    const result = await handlers.get('fs:readFileBase64')!({}, filePath);

    assert.equal(typeof result, 'string');
    assert.equal(Array.isArray(result), false);
    assert.equal(Buffer.isBuffer(result), false);
    assert.equal(result, Buffer.from(bytes).toString('base64'));
  });

  it('refuses an outside path before reading it', async () => {
    const filePath = path.join(outside, 'secret.bin');
    await fsp.writeFile(filePath, Uint8Array.from([0, 255, 1, 254]));

    await assert.rejects(
      async () => handlers.get('fs:readFileBase64')!({}, filePath),
      /Refused/
    );
  });
});
