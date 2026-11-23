import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(__filename);

type LoadRegistry = (registryPath?: string) => Promise<unknown>;

let loadExtensionRegistry: LoadRegistry;
const savedCache = new Map<string, NodeJS.Module | undefined>();
let tempDir = '';

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
  injectMock('electron', { ipcMain: { handle: () => undefined } });
  injectMock('../revisions', {
    backupRevision: async () => null,
    listRevisions: async () => [],
    restoreRevision: async () => undefined,
    cleanupRevisionsForLocation: async () => undefined,
    deleteRevision: async () => undefined,
  });
  injectMock('../atomic-write', { atomicWriteText: async () => undefined });
  injectMock('../allowed-roots', {
    assertWritable: () => undefined,
    assertWithinAllowedRoot: () => undefined,
    getAllowedRoots: () => [],
    isReadOnlyPath: () => false,
  });
  tempDir = mkdtempSync(join(tmpdir(), 'whale-registry-'));
  try {
    delete require_.cache[require_.resolve('./extensions')];
  } catch {
    // Not loaded yet.
  }
  ({ loadExtensionRegistry } = require_('./extensions'));
});

after(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  for (const [modulePath, original] of savedCache.entries()) {
    if (original) require_.cache[modulePath] = original;
    else delete require_.cache[modulePath];
  }
});

function registryFile(name: string, contents: string): string {
  const file = join(tempDir, name);
  writeFileSync(file, contents, 'utf8');
  return file;
}

describe('loadExtensionRegistry', () => {
  it('returns null when the registry file is absent (legitimate empty install)', async () => {
    assert.equal(
      await loadExtensionRegistry(join(tempDir, 'does-not-exist.json')),
      null
    );
  });

  it('returns the parsed registry for a valid file', async () => {
    const registry = {
      extensions: [
        {
          id: 'text-editor',
          name: 'Text Editor',
          type: 'editor',
          color: '#000000',
          fileTypes: ['txt'],
          entryPoint: 'index.html',
          enabled: true,
          isDefault: true,
        },
      ],
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    const file = registryFile('registry.json', JSON.stringify(registry));
    assert.deepEqual(await loadExtensionRegistry(file), registry);
  });

  it('throws a path-bearing error for malformed JSON instead of pretending there are no extensions', async () => {
    const file = registryFile('broken.json', '{ not json');
    await assert.rejects(loadExtensionRegistry(file), (error: Error) => {
      assert.match(error.message, /Malformed extension registry at/);
      assert.ok(error.message.includes(file), 'error must name the file');
      return true;
    });
  });

  it('throws a path-bearing error when an existing registry cannot be read', async () => {
    const dirPath = join(tempDir, 'registry-dir');
    mkdirSync(dirPath);
    await assert.rejects(loadExtensionRegistry(dirPath), (error: Error) => {
      assert.match(error.message, /Failed to read extension registry at/);
      assert.ok(error.message.includes(dirPath), 'error must name the path');
      return true;
    });
  });

  it('uses the packaged dist location when no path is given', async () => {
    // In the dev tree src/main/extensions/registry.json does not exist, so the
    // default path resolves to the legitimate "no registry" case.
    assert.equal(await loadExtensionRegistry(), null);
  });
});
