import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { getAllowedRoots, setAllowedRoots } from '../allowed-roots';

const require_ = createRequire(__filename);
const MODULE_SPECS = ['./thumbnails', './search-index', './extensions'];

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown> | unknown;
type CallLog = unknown[][];

type ThumbnailCallName =
  | 'loadFolderThumbnail'
  | 'loadFolderBackground'
  | 'setFolderThumbnail'
  | 'setFolderBackground';

interface TestRig {
  handlers: Map<string, Handler>;
  thumbnailCalls: Record<ThumbnailCallName, CallLog>;
  workerCalls: { channel: string; payload: unknown }[];
  revisionCalls: {
    listRevisions: CallLog;
    cleanupRevisionsForLocation: CallLog;
  };
}

const SAVED_CACHE = new Map<string, NodeJS.Module | undefined>();

function injectMock(moduleName: string, exports: unknown): void {
  const modulePath = require_.resolve(moduleName);
  if (!SAVED_CACHE.has(modulePath)) {
    SAVED_CACHE.set(modulePath, require_.cache[modulePath]);
  }
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

function clearInjectedMocks(): void {
  for (const [modulePath, original] of SAVED_CACHE.entries()) {
    if (original) require_.cache[modulePath] = original;
    else delete require_.cache[modulePath];
  }
  SAVED_CACHE.clear();
}

function clearTargetModuleCache(): void {
  for (const spec of MODULE_SPECS) {
    try {
      delete require_.cache[require_.resolve(spec)];
    } catch {
      // The module has not been loaded yet.
    }
  }
}

function buildRig(): TestRig {
  const handlers = new Map<string, Handler>();
  injectMock('electron', {
    ipcMain: {
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    },
  });

  const thumbnailCalls: TestRig['thumbnailCalls'] = {
    loadFolderThumbnail: [],
    loadFolderBackground: [],
    setFolderThumbnail: [],
    setFolderBackground: [],
  };
  const record = (calls: CallLog) => (...args: unknown[]) => {
    calls.push(args);
  };
  injectMock('../thumbnail', {
    generateThumbnail: () => undefined,
    loadThumbnail: () => undefined,
    loadFolderThumbnail: record(thumbnailCalls.loadFolderThumbnail),
    loadFolderBackground: record(thumbnailCalls.loadFolderBackground),
    setFolderThumbnail: record(thumbnailCalls.setFolderThumbnail),
    setFolderBackground: record(thumbnailCalls.setFolderBackground),
    clearFolderThumbnail: () => undefined,
    clearFolderBackground: () => undefined,
  });

  const workerCalls: TestRig['workerCalls'] = [];
  injectMock('../index-worker-host', {
    request: (channel: string, payload: unknown) => {
      workerCalls.push({ channel, payload });
      return Promise.resolve([]);
    },
  });
  injectMock('../dir-watcher', { setFulltextRoots: () => undefined });

  const revisionCalls: TestRig['revisionCalls'] = {
    listRevisions: [],
    cleanupRevisionsForLocation: [],
  };
  injectMock('../revisions', {
    backupRevision: () => undefined,
    listRevisions: record(revisionCalls.listRevisions),
    restoreRevision: () => undefined,
    cleanupRevisionsForLocation: record(revisionCalls.cleanupRevisionsForLocation),
    deleteRevision: () => undefined,
  });

  clearTargetModuleCache();
  require_('./thumbnails').registerThumbnailHandlers();
  require_('./search-index').registerSearchIndexHandlers();
  require_('./extensions').registerExtensionHandlers();
  return { handlers, thumbnailCalls, workerCalls, revisionCalls };
}

describe('IPC boundary guards', () => {
  let rig: TestRig;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-ipc-root-'));
    outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-ipc-outside-'));
    setAllowedRoots([root]);
    rig = buildRig();
  });

  afterEach(async () => {
    setAllowedRoots([]);
    clearInjectedMocks();
    clearTargetModuleCache();
    await Promise.all([
      fsp.rm(root, { recursive: true, force: true }),
      fsp.rm(outside, { recursive: true, force: true }),
    ]);
  });

  const folderLoads = [
    ['thumbnail:loadFolder', 'loadFolderThumbnail'],
    ['thumbnail:loadFolderBackground', 'loadFolderBackground'],
  ] as const;
  for (const [channel, functionName] of folderLoads) {
    it(`${channel} rejects an outside dirPath without reading through the service`, async () => {
      await assert.rejects(async () => rig.handlers.get(channel)!({}, outside), /Refused/);
      assert.equal(rig.thumbnailCalls[functionName].length, 0);
    });
  }

  const folderSets = [
    ['thumbnail:setFolderThumbnail', 'setFolderThumbnail'],
    ['thumbnail:setFolderBackground', 'setFolderBackground'],
  ] as const;
  for (const [channel, functionName] of folderSets) {
    it(`${channel} guards the destination but accepts a user-picked outside source`, async () => {
      const handler = rig.handlers.get(channel)!;
      const insideSource = path.join(root, 'source.jpg');
      const outsideSource = path.join(outside, 'source.jpg');
      await assert.rejects(async () => handler({}, outside, insideSource), /Refused/);
      assert.equal(rig.thumbnailCalls[functionName].length, 0);

      await handler({}, root, outsideSource);
      assert.deepEqual(rig.thumbnailCalls[functionName], [[root, outsideSource]]);
    });
  }

  it('folder thumbnail handlers still call through when every path is allowed', async () => {
    const source = path.join(root, 'source.jpg');
    for (const [channel, functionName] of folderLoads) {
      await rig.handlers.get(channel)!({}, root);
      assert.deepEqual(rig.thumbnailCalls[functionName], [[root]]);
    }
    for (const [channel, functionName] of folderSets) {
      await rig.handlers.get(channel)!({}, root, source);
      assert.deepEqual(rig.thumbnailCalls[functionName], [[root, source]]);
    }
  });

  const searchCases = [
    ['index:query', ['query']],
    ['index:advanced', [{}]],
    ['index:tags', []],
    ['index:status', []],
    ['fulltext:search', ['query']],
    ['fulltext:has', []],
  ] as const;
  for (const [channel, extraArgs] of searchCases) {
    it(`${channel} rejects an outside rootPath without calling the index worker`, async () => {
      const handler = rig.handlers.get(channel)!;
      await assert.rejects(async () => handler({}, outside, ...extraArgs), /Refused/);
      assert.equal(rig.workerCalls.length, 0);
    });
  }

  it('search handlers still forward allowed roots and their original arguments', async () => {
    for (const [channel, extraArgs] of searchCases) {
      await rig.handlers.get(channel)!({}, root, ...extraArgs);
    }
    assert.deepEqual(
      rig.workerCalls.map((call) => call.channel),
      searchCases.map(([channel]) => channel)
    );
    for (const call of rig.workerCalls) {
      assert.equal((call.payload as { rootPath: string }).rootPath, root);
    }
  });

  it('ext:listRevisions rejects an outside filePath without calling the revision service', async () => {
    const handler = rig.handlers.get('ext:listRevisions')!;
    await assert.rejects(
      async () => handler({}, path.join(outside, 'doc.txt')),
      /Refused/
    );
    assert.equal(rig.revisionCalls.listRevisions.length, 0);
  });

  it('ext:listRevisions still calls through for an allowed filePath', async () => {
    const filePath = path.join(root, 'doc.txt');
    await rig.handlers.get('ext:listRevisions')!({}, filePath);
    assert.deepEqual(rig.revisionCalls.listRevisions, [[filePath]]);
  });

  const invalidAges: [string, unknown][] = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a negative number', -1],
    ['a string', '30'],
    ['null', null],
    ['undefined', undefined],
  ];
  for (const [label, value] of invalidAges) {
    it(`ext:cleanupRevisions rejects ${label} without starting any deletion`, async () => {
      const handler = rig.handlers.get('ext:cleanupRevisions')!;
      await assert.rejects(async () => handler({}, value), /Invalid maxAgeDays/);
      assert.equal(rig.revisionCalls.cleanupRevisionsForLocation.length, 0);
    });
  }

  it('ext:cleanupRevisions preserves finite non-negative values, including zero', async () => {
    const handler = rig.handlers.get('ext:cleanupRevisions')!;
    for (const value of [0, 0.5, 30]) await handler({}, value);

    const expectedRoot = getAllowedRoots()[0];
    assert.deepEqual(
      rig.revisionCalls.cleanupRevisionsForLocation,
      [0, 0.5, 30].map((value) => [expectedRoot, value])
    );
  });
});
