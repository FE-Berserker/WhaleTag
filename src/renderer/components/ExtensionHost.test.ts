import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require_ = createRequire(__filename);
const IPC_API_MODULE = '-/services/ipc-api';
const HOST_MODULE = './ExtensionHost';
const BINARY_BASE64 = 'AAECf4D+/w==';

let readImageFileAsDataUrl: (filePath: string) => Promise<string>;
let readFileBase64Impl: (filePath: string) => Promise<string>;
let base64Calls: string[];
let legacyReadCalls: number;
let btoaCalls: number;
let originalBtoa: typeof globalThis.btoa | undefined;

const savedCache = new Map<string, NodeJS.Module | undefined>();

function injectMock(moduleName: string, exports: unknown): void {
  const modulePath = require_.resolve(moduleName);
  savedCache.set(modulePath, require_.cache[modulePath]);
  const existing = require_.cache[modulePath];
  require_.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
    children: existing?.children ?? [],
    paths: existing?.paths ?? [],
  } as NodeJS.Module;
}

before(() => {
  base64Calls = [];
  legacyReadCalls = 0;
  btoaCalls = 0;
  readFileBase64Impl = async () => BINARY_BASE64;
  injectMock(IPC_API_MODULE, {
    ipcApi: {
      readFileBase64: (filePath: string) => readFileBase64Impl(filePath),
      readFile: async () => {
        legacyReadCalls += 1;
        throw new Error('legacy byte-array read must not be used');
      },
    },
  });
  try {
    delete require_.cache[require_.resolve(HOST_MODULE)];
  } catch {
    // The host has not been loaded yet.
  }
  ({ readImageFileAsDataUrl } = require_(HOST_MODULE));

  originalBtoa = globalThis.btoa;
  globalThis.btoa = () => {
    btoaCalls += 1;
    throw new Error('renderer base64 encoding must not be used');
  };
});

after(() => {
  if (originalBtoa) globalThis.btoa = originalBtoa;
  else delete (globalThis as { btoa?: typeof globalThis.btoa }).btoa;
  for (const [modulePath, original] of savedCache.entries()) {
    if (original) require_.cache[modulePath] = original;
    else delete require_.cache[modulePath];
  }
  try {
    delete require_.cache[require_.resolve(HOST_MODULE)];
  } catch {
    // Nothing to clear.
  }
});

describe('ExtensionHost image embed base64 transport', () => {
  it('uses the Main base64 string verbatim, without byte reads or btoa', async () => {
    base64Calls = [];
    legacyReadCalls = 0;
    btoaCalls = 0;
    readFileBase64Impl = async (filePath) => {
      base64Calls.push(filePath);
      return BINARY_BASE64;
    };

    const result = await readImageFileAsDataUrl('/root/pixel.png');

    assert.equal(result, `data:image/png;base64,${BINARY_BASE64}`);
    assert.deepEqual(base64Calls, ['/root/pixel.png']);
    assert.equal(legacyReadCalls, 0);
    assert.equal(btoaCalls, 0);
  });

  it('maps every supported original-image extension to its actual MIME type', async () => {
    readFileBase64Impl = async () => BINARY_BASE64;
    const cases = [
      ['avif', 'image/avif'],
      ['tiff', 'image/tiff'],
      ['tif', 'image/tiff'],
      ['ico', 'image/x-icon'],
    ];
    for (const [extension, mime] of cases) {
      assert.equal(
        await readImageFileAsDataUrl(`/root/pixel.${extension}`),
        `data:${mime};base64,${BINARY_BASE64}`
      );
    }
  });

  it('keeps read failures rejecting into the existing generic-icon fallback', async () => {
    legacyReadCalls = 0;
    btoaCalls = 0;
    readFileBase64Impl = async () => {
      throw new Error('read denied');
    };

    await assert.rejects(readImageFileAsDataUrl('/root/pixel.png'), /read denied/);
    assert.equal(legacyReadCalls, 0);
    assert.equal(btoaCalls, 0);
  });
});
