import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import {
  assertWithinAllowedRoot,
  getAllowedRoots,
  isConfiguredRoot,
  isReadOnlyPath,
  setAllowedRoots,
  setReadOnlyRoots,
} from '../allowed-roots';
import {
  __resetKnownRootsForTest,
  flushKnownRootsWrites,
  initKnownRoots,
  rememberPickedRoot,
} from '../known-roots';
import { CASE_INSENSITIVE_FS } from '../path-fold';

/**
 * `fs:setAllowedRoots` is the one place the renderer's location list enters
 * the main process, so the handler is pinned end to end: the known-roots
 * filter, the removal diff that closes a location's index.db, the LAN
 * invalidation, the read-only subset and the watcher / migration hand-off.
 * Everything the handler reaches outside this folder is a mock; known-roots
 * and allowed-roots are the real modules.
 */

const require_ = createRequire(__filename);
const TARGET = './fs-roots';
const SAVED_CACHE = new Map<string, NodeJS.Module | undefined>();

type Handler = (event: unknown, ...args: unknown[]) => unknown;

interface RootsRig {
  handlers: Map<string, Handler>;
  /** The renderer's sync push. */
  push: (roots: string[], readOnlyRoots?: string[]) => void;
  closedDbs: string[];
  watched: string[][];
  lanStops: number;
  migrations: string[][];
}

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

function buildRig(): RootsRig {
  const rig: RootsRig = {
    handlers: new Map(),
    push: () => undefined,
    closedDbs: [],
    watched: [],
    lanStops: 0,
    migrations: [],
  };
  rig.push = (roots, readOnlyRoots) => {
    rig.handlers.get('fs:setAllowedRoots')!({}, roots, readOnlyRoots);
  };
  injectMock('electron', {
    ipcMain: {
      handle: (channel: string, handler: Handler) => {
        rig.handlers.set(channel, handler);
      },
    },
  });
  injectMock('../index-worker-host', {
    closeIndexDb: (rootPath: string) => {
      rig.closedDbs.push(rootPath);
      return Promise.resolve();
    },
  });
  injectMock('../dir-watcher', {
    syncWatchedRoots: (roots: string[]) => {
      rig.watched.push(roots);
    },
  });
  injectMock('../migrate-date-tags', {
    triggerStartupMigration: (roots: string[]) => {
      rig.migrations.push(roots);
      return Promise.resolve();
    },
  });
  injectMock('../lan', {
    stopLanServer: () => {
      rig.lanStops += 1;
      return Promise.resolve();
    },
  });
  // A fresh copy of the handler module gives a fresh `lastSyncedRoots`.
  delete require_.cache[require_.resolve(TARGET)];
  require_(TARGET).registerFsRootsHandlers();
  return rig;
}

function captureWarnings(run: () => void): string[] {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    run();
  } finally {
    console.warn = original;
  }
  return lines;
}

async function tmpdir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'whale-roots-ipc-'));
}

describe('ipc/fs-roots', () => {
  let userData: string;
  let rootA: string;
  let rootB: string;
  let stranger: string;

  beforeEach(async () => {
    userData = await tmpdir();
    rootA = await tmpdir();
    rootB = await tmpdir();
    stranger = await tmpdir();
    initKnownRoots(userData);
    setAllowedRoots([]);
    setReadOnlyRoots([]);
  });

  afterEach(async () => {
    clearInjectedMocks();
    // Let the record's fire-and-forget write finish before its directory goes.
    await flushKnownRootsWrites().catch(() => undefined);
    __resetKnownRootsForTest();
    setAllowedRoots([]);
    setReadOnlyRoots([]);
    for (const dir of [userData, rootA, rootB, stranger]) {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  describe('fs:parentDir', () => {
    it('answers with the directory above the probe', () => {
      const rig = buildRig();
      const probe = path.join(rootA, 'sub');
      assert.equal(
        rig.handlers.get('fs:parentDir')!({}, probe),
        path.dirname(probe)
      );
    });
  });

  describe('fs:setAllowedRoots', () => {
    it('seeds the location record from the first push and registers every absolute root', async () => {
      const rig = buildRig();
      const relative = path.join('relative', 'dir');
      rig.push([rootA, rootB, relative, '   ', 42 as unknown as string]);

      assert.equal(isConfiguredRoot(rootA), true);
      assert.equal(isConfiguredRoot(rootB), true);
      assert.doesNotThrow(() =>
        assertWithinAllowedRoot(path.join(rootA, 'a.txt'))
      );
      assert.deepEqual(rig.watched, [[rootA, rootB]]);

      await flushKnownRootsWrites();
      const doc = JSON.parse(
        await fsp.readFile(path.join(userData, 'known-roots.json'), 'utf8')
      ) as { roots: string[] };
      assert.deepEqual(doc.roots, [rootA, rootB]);
    });

    it('refuses a location the user never picked once the record is seeded', () => {
      const rig = buildRig();
      rig.push([rootA]);

      const warnings = captureWarnings(() => rig.push([rootA, stranger]));

      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /never picked by the user/);
      assert.equal(isConfiguredRoot(rootA), true);
      assert.equal(isConfiguredRoot(stranger), false);
      assert.throws(
        () => assertWithinAllowedRoot(path.join(stranger, 's.txt')),
        /Refused: path is outside any configured location/
      );
      assert.deepEqual(rig.watched.at(-1), [rootA]);
    });

    it('accepts a location picked in the native dialog after seeding', () => {
      const rig = buildRig();
      rig.push([rootA]);
      rememberPickedRoot(rootB);

      const warnings = captureWarnings(() => rig.push([rootA, rootB]));

      assert.deepEqual(warnings, []);
      assert.equal(isConfiguredRoot(rootB), true);
    });

    it('keeps read-only marks to accepted locations only', () => {
      const rig = buildRig();
      rig.push([rootA, rootB]);
      rig.push([rootA, rootB], [rootA, stranger]);

      assert.equal(isReadOnlyPath(path.join(rootA, 'a.txt')), true);
      assert.equal(isReadOnlyPath(path.join(rootB, 'b.txt')), false);
      assert.equal(isReadOnlyPath(stranger), false);
    });

    it('drops a read-only mark together with its location', () => {
      const rig = buildRig();
      rig.push([rootA, rootB], [rootB]);
      assert.equal(isReadOnlyPath(path.join(rootB, 'b.txt')), true);

      // The stale entry for the removed location must not outlive it.
      rig.push([rootA], [rootB]);

      assert.equal(isReadOnlyPath(path.join(rootB, 'b.txt')), false);
    });

    it('closes the index of a removed location and invalidates LAN sessions', () => {
      const rig = buildRig();
      rig.push([rootA, rootB]);
      const lanStopsBefore = rig.lanStops;

      rig.push([rootA]);

      assert.deepEqual(rig.closedDbs, [rootB]);
      assert.equal(rig.lanStops, lanStopsBefore + 1);
      assert.equal(isConfiguredRoot(rootA), true);
      assert.equal(isConfiguredRoot(rootB), false);
      assert.deepEqual(rig.watched.at(-1), [rootA]);
    });

    it('leaves the index and LAN sessions alone when the same locations come back in another order', () => {
      const rig = buildRig();
      rig.push([rootA, rootB]);
      const lanStopsBefore = rig.lanStops;

      rig.push([rootB, rootA]);

      assert.deepEqual(rig.closedDbs, []);
      assert.equal(rig.lanStops, lanStopsBefore);
      assert.equal(isConfiguredRoot(rootA), true);
      assert.equal(isConfiguredRoot(rootB), true);
    });

    it('treats a trailing separator as the same location', () => {
      const rig = buildRig();
      rig.push([rootA, rootB]);
      const lanStopsBefore = rig.lanStops;

      rig.push([`${rootA}${path.sep}`, rootB]);

      assert.deepEqual(rig.closedDbs, []);
      assert.equal(rig.lanStops, lanStopsBefore);
    });

    it(
      'treats another letter case as the same location',
      { skip: !CASE_INSENSITIVE_FS },
      () => {
        const rig = buildRig();
        rig.push([rootA, rootB]);
        const lanStopsBefore = rig.lanStops;

        rig.push([rootA.toUpperCase(), rootB]);

        assert.deepEqual(rig.closedDbs, []);
        assert.equal(rig.lanStops, lanStopsBefore);
      }
    );

    it('invalidates LAN sessions when a location is added', () => {
      const rig = buildRig();
      rig.push([rootA]);
      rememberPickedRoot(rootB);
      const lanStopsBefore = rig.lanStops;

      rig.push([rootA, rootB]);

      assert.deepEqual(rig.closedDbs, []);
      assert.equal(rig.lanStops, lanStopsBefore + 1);
    });

    it('hands the accepted roots to the watcher and the startup migration on every push', () => {
      const rig = buildRig();
      rig.push([rootA]);
      rig.push([rootA, stranger]);

      assert.equal(rig.migrations.length, 2);
      assert.deepEqual(rig.migrations[0], getAllowedRoots());
      assert.deepEqual(rig.migrations[1], getAllowedRoots());
      assert.deepEqual(rig.watched, [[rootA], [rootA]]);
    });
  });
});
