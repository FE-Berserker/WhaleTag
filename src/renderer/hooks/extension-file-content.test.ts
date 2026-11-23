import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require_ = createRequire(__filename);
const IPC_API_MODULE = '-/services/ipc-api';
const MODULE = './extension-file-content';
const BINARY_BASE64 = 'AAECf4D+/w=='; // 7 bytes

type ExtensionFileContent = {
  content: string;
  encoding: string;
  size: number;
};

let readExtensionFileContent: (filePath: string) => Promise<ExtensionFileContent>;
let base64ByteLength: (base64: string) => number;
let readFileBase64Calls: string[];
let readTextFileCalls: string[];
let legacyReadCalls: number;
let readFileBase64Impl: (filePath: string) => Promise<string>;
let readTextFileImpl: (filePath: string) => Promise<string>;

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
  readFileBase64Calls = [];
  readTextFileCalls = [];
  legacyReadCalls = 0;
  readFileBase64Impl = async () => BINARY_BASE64;
  readTextFileImpl = async () => 'text';
  injectMock(IPC_API_MODULE, {
    ipcApi: {
      readFileBase64: (filePath: string) => {
        readFileBase64Calls.push(filePath);
        return readFileBase64Impl(filePath);
      },
      readTextFile: (filePath: string) => {
        readTextFileCalls.push(filePath);
        return readTextFileImpl(filePath);
      },
      readFile: async () => {
        legacyReadCalls += 1;
        throw new Error('legacy byte-array read must not be used');
      },
    },
  });
  try {
    delete require_.cache[require_.resolve(MODULE)];
  } catch {
    // Not loaded yet.
  }
  ({ readExtensionFileContent, base64ByteLength } = require_(MODULE));
});

beforeEach(() => {
  readFileBase64Calls.length = 0;
  readTextFileCalls.length = 0;
  legacyReadCalls = 0;
  readFileBase64Impl = async () => BINARY_BASE64;
  readTextFileImpl = async () => 'text';
});

after(() => {
  for (const [modulePath, original] of savedCache.entries()) {
    if (original) require_.cache[modulePath] = original;
    else delete require_.cache[modulePath];
  }
});

describe('readExtensionFileContent', () => {
  it('reads binary files through Main base64, never the legacy ArrayBuffer read', async () => {
    const result = await readExtensionFileContent('/root/pixel.heic');

    assert.deepEqual(readFileBase64Calls, ['/root/pixel.heic']);
    assert.deepEqual(readTextFileCalls, []);
    assert.equal(legacyReadCalls, 0);
    assert.deepEqual(result, {
      content: BINARY_BASE64,
      encoding: 'base64',
      size: 7,
    });
  });

  it('detects binary extensions case-insensitively', async () => {
    await readExtensionFileContent('/root/IMAGE.HEIC');
    assert.deepEqual(readFileBase64Calls, ['/root/IMAGE.HEIC']);
    assert.equal(legacyReadCalls, 0);
  });

  it('reads text files as utf8 and reports decoded UTF-8 byte length', async () => {
    readTextFileImpl = async () => 'héllo';

    const result = await readExtensionFileContent('/root/notes.txt');

    assert.deepEqual(readTextFileCalls, ['/root/notes.txt']);
    assert.deepEqual(readFileBase64Calls, []);
    assert.deepEqual(result, {
      content: 'héllo',
      encoding: 'utf8',
      size: 6,
    });
  });

  it('propagates read failures instead of swallowing them', async () => {
    readFileBase64Impl = async () => {
      throw new Error('read denied');
    };
    await assert.rejects(
      readExtensionFileContent('/root/secret.pdf'),
      /read denied/
    );
    assert.equal(legacyReadCalls, 0);
  });
});

describe('base64ByteLength', () => {
  it('computes decoded byte length from padding', () => {
    assert.equal(base64ByteLength(''), 0);
    assert.equal(base64ByteLength('TQ=='), 1);
    assert.equal(base64ByteLength('TWE='), 2);
    assert.equal(base64ByteLength('TWFu'), 3);
    assert.equal(base64ByteLength(BINARY_BASE64), 7);
    // Large payload: 4 chars per 3 bytes, no padding.
    assert.equal(base64ByteLength('A'.repeat(4096)), 3072);
  });
});
