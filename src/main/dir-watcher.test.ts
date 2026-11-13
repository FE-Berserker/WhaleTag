import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';

import {
  isMetaPath,
  isSameOrDescendantPath,
  syncWatchedRoots,
  setFulltextRoots,
  closeAllWatchers,
  setDirChangedBroadcast,
  _watchCountForTest,
  _reindexDirtyForTest,
  _startWatchForcedPerDirForTest,
  _watchModeForTest,
  _dirWatcherCountForTest,
  _simulateWatcherErrorForTest,
  _reconnectPendingForTest,
  _setReconnectBaseDelayForTest,
  _setRetryBaseDelayForTest,
  type DirChangedEvent,
} from './dir-watcher';
import * as indexWorkerHost from './index-worker-host';

/**
 * dir-watcher tests (docs/04 §10). The pure path predicates are unit-tested;
 * the watch→debounce→broadcast→reindex chain is exercised end-to-end with a
 * real fs.watch on a temp dir (Windows recursive watch is available in the
 * test runner). The index worker's `request` is stubbed via its CommonJS
 * module binding — no real utilityProcess is spawned.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  condition: () => boolean,
  description: string,
  timeoutMs = 6000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${description}`);
    await sleep(25);
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('isMetaPath', () => {
  it('matches .whale at any depth, not lookalikes', () => {
    assert.equal(isMetaPath('.whale'), true);
    assert.equal(isMetaPath('.whale/wsd.json'), true);
    assert.equal(isMetaPath('sub/.whale/thumbs/a.jpg'), true);
    assert.equal(isMetaPath('photos/a.jpg'), false);
    assert.equal(isMetaPath('.whalefoo'), false);
    assert.equal(isMetaPath('sub/.whalefoo/x'), false);
  });
});

describe('isSameOrDescendantPath', () => {
  it('matches same/descendant across slash styles and case', () => {
    assert.equal(isSameOrDescendantPath('C:/Data', 'C:/Data'), true);
    assert.equal(isSameOrDescendantPath('C:/Data', 'C:/Data/sub/a.jpg'), true);
    assert.equal(isSameOrDescendantPath('C:/Data', 'C:/database/x'), false);
    assert.equal(isSameOrDescendantPath('C:/Data', 'c:/data/SUB'), true);
    assert.equal(
      isSameOrDescendantPath('C:\\Data\\Sub', 'C:/Data/Sub/child'),
      true
    );
    assert.equal(isSameOrDescendantPath('C:/Data', 'C:/Other'), false);
  });
});

describe('dir-watcher (real fs.watch on temp dir)', () => {
  let root = '';
  let events: DirChangedEvent[];
  let requestCalls: string[];
  let origRequest: typeof indexWorkerHost.request;
  let fulltextHas: boolean;
  let requestOverride:
    | ((op: string, arg?: { rootPath?: string }) => Promise<unknown> | unknown)
    | null;

  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-watch-'));
    await fsp.mkdir(path.join(root, '.whale'), { recursive: true });
    events = [];
    requestCalls = [];
    fulltextHas = true;
    requestOverride = null;
    setDirChangedBroadcast((ev) => events.push(ev));
    // Stub the worker: files index exists (ready) → the watcher rebuilds it;
    // fulltext index existence is toggled per test via `fulltextHas`.
    // The binding is restored in `after` (all test files share one process).
    origRequest = indexWorkerHost.request;
    (indexWorkerHost as { request: unknown }).request = async (
      op: string,
      arg?: { rootPath?: string }
    ) => {
      requestCalls.push(`${op} ${arg?.rootPath ?? ''}`.trim());
      if (requestOverride) return requestOverride(op, arg);
      if (op === 'index:status') return { count: 5, ready: true };
      if (op === 'fulltext:has') return fulltextHas;
      return undefined;
    };
  });

  after(async () => {
    closeAllWatchers();
    setDirChangedBroadcast(null);
    setFulltextRoots([]);
    requestOverride = null;
    (indexWorkerHost as { request: unknown }).request = origRequest;
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it('broadcasts real changes, suppresses .whale churn, rebuilds an existing index', async () => {
    syncWatchedRoots([root]);
    assert.equal(_watchCountForTest(), 1);

    // `.whale/` churn must be suppressed (self-echo guard).
    await fsp.writeFile(path.join(root, '.whale', 'wsd.json'), '{}');
    // A real file must surface.
    await fsp.writeFile(path.join(root, 'hello.txt'), 'hi');

    // Debounce is 500ms trailing; reindex follows after another 1500ms.
    await sleep(1200);
    assert.ok(events.length >= 1, 'expected at least one flush');
    const flushed = events.flatMap((e) => e.paths);
    assert.ok(
      flushed.some((p) => p.endsWith('hello.txt')),
      `hello.txt reported in ${JSON.stringify(flushed)}`
    );
    assert.ok(
      !flushed.some((p) => p.includes('.whale')),
      `.whale suppressed in ${JSON.stringify(flushed)}`
    );
    assert.ok(events.every((e) => e.rootPath === root));

    // Index existed (stubbed ready) → status probe + incremental rebuild.
    await sleep(2200);
    assert.ok(requestCalls.some((c) => c.startsWith('index:status')));
    assert.ok(requestCalls.some((c) => c.startsWith('index:build')));
  });

  it('retries a failed index rebuild on a quiet root (dirty flag + backoff)', async () => {
    let builds = 0;
    requestOverride = async (op: string) => {
      if (op === 'index:status') return { count: 5, ready: true };
      if (op === 'index:build') {
        builds += 1;
        // Fail the first attempt only: nothing else will touch the root, so a
        // second build proves the watcher re-armed itself instead of waiting
        // for an unrelated filesystem event.
        if (builds === 1) throw new Error('index worker unavailable');
        return undefined;
      }
      return undefined;
    };
    try {
      await fsp.writeFile(path.join(root, 'retry.txt'), 'x');
      const deadline = Date.now() + 12_000;
      while (builds < 2 && Date.now() < deadline) await sleep(250);
      assert.ok(
        builds >= 2,
        `expected a retry after the failed build (builds=${builds})`
      );
    } finally {
      requestOverride = null;
      await fsp.rm(path.join(root, 'retry.txt'), { force: true });
    }
  });


  it('fulltext root: change inside triggers fulltext:build, outside does not, has=false skips', async () => {
    const fp = path.join(root, 'ftsub');
    await fsp.mkdir(fp, { recursive: true });
    setFulltextRoots([fp]);
    requestCalls.length = 0;

    // Change INSIDE the fulltext root → has probe + build for fp.
    await fsp.writeFile(path.join(fp, 'a.txt'), 'x');
    await sleep(3600); // 500ms flush + 1500ms reindex debounce + slack
    assert.ok(
      requestCalls.some((c) => c.startsWith('fulltext:has')),
      `fulltext:has called: ${requestCalls.join(', ')}`
    );
    assert.ok(
      requestCalls.some((c) => c.startsWith('fulltext:build')),
      `fulltext:build called: ${requestCalls.join(', ')}`
    );

    // Change OUTSIDE fp (still inside the location) → no fulltext ops.
    requestCalls.length = 0;
    await fsp.writeFile(path.join(root, 'outside.txt'), 'x');
    await sleep(3600);
    assert.ok(
      !requestCalls.some((c) => c.startsWith('fulltext:')),
      `no fulltext ops outside fp: ${requestCalls.join(', ')}`
    );

    // Index missing (has=false) → probed but never built.
    fulltextHas = false;
    requestCalls.length = 0;
    await fsp.writeFile(path.join(fp, 'b.txt'), 'y');
    await sleep(3600);
    assert.ok(requestCalls.some((c) => c.startsWith('fulltext:has')));
    assert.ok(
      !requestCalls.some((c) => c.startsWith('fulltext:build')),
      'no build when the fulltext index does not exist'
    );
    fulltextHas = true;
  });

  it('schedules one final index rebuild when another change fires during a build', async () => {
    syncWatchedRoots([root]);
    setFulltextRoots([]);
    const firstBuild = deferred();
    let buildCount = 0;
    requestOverride = async (op: string) => {
      if (op === 'index:status') return { count: 5, ready: true };
      if (op === 'index:build') {
        buildCount += 1;
        if (buildCount === 1) await firstBuild.promise;
      }
      return undefined;
    };

    try {
      await fsp.writeFile(path.join(root, 'race-index-first.txt'), 'first');
      await waitFor(() => buildCount === 1, 'the first index build');

      // Wait for the second flush, then let its 1500ms reindex timer fire
      // while the first build is deliberately still blocked.
      events.length = 0;
      await fsp.writeFile(path.join(root, 'race-index-second.txt'), 'second');
      await waitFor(
        () => events.flatMap((e) => e.paths).some((p) => p.endsWith('race-index-second.txt')),
        'the second index-change flush'
      );
      await sleep(1700);
      assert.equal(buildCount, 1, 'the first build is still in flight');

      firstBuild.resolve();
      await waitFor(() => buildCount === 2, 'the dirty follow-up index build');

      // Dirty is consumed before rescheduling: no third build without a new event.
      await sleep(1700);
      assert.equal(buildCount, 2, 'a quiet root must not rebuild repeatedly');
    } finally {
      firstBuild.resolve();
      requestOverride = null;
    }
  });

  it('schedules one final fulltext rebuild independently of the files index', async () => {
    syncWatchedRoots([root]);
    const fp = path.join(root, 'ft-race');
    await fsp.mkdir(fp, { recursive: true });
    setFulltextRoots([fp]);
    const firstBuild = deferred();
    let buildCount = 0;
    requestOverride = async (op: string) => {
      if (op === 'index:status') return { count: 5, ready: true };
      if (op === 'fulltext:has') return true;
      if (op === 'fulltext:build') {
        buildCount += 1;
        if (buildCount === 1) await firstBuild.promise;
      }
      return undefined;
    };

    try {
      await fsp.writeFile(path.join(fp, 'first.txt'), 'first');
      await waitFor(() => buildCount === 1, 'the first fulltext build');

      events.length = 0;
      await fsp.writeFile(path.join(fp, 'second.txt'), 'second');
      await waitFor(
        () => events.flatMap((e) => e.paths).some((p) => p.endsWith('ft-race/second.txt')),
        'the second fulltext-change flush'
      );
      await sleep(1700);
      assert.equal(buildCount, 1, 'the first fulltext build is still in flight');

      firstBuild.resolve();
      await waitFor(() => buildCount === 2, 'the dirty follow-up fulltext build');

      await sleep(1700);
      assert.equal(buildCount, 2, 'a quiet fulltext root must not rebuild repeatedly');
    } finally {
      firstBuild.resolve();
      requestOverride = null;
      setFulltextRoots([]);
    }
  });

  it('does not reschedule a root removed while a rebuild is in flight', async () => {
    syncWatchedRoots([root]);
    setFulltextRoots([]);
    const firstBuild = deferred();
    let buildCount = 0;
    requestOverride = async (op: string) => {
      if (op === 'index:status') return { count: 5, ready: true };
      if (op === 'index:build') {
        buildCount += 1;
        if (buildCount === 1) await firstBuild.promise;
      }
      return undefined;
    };

    try {
      await fsp.writeFile(path.join(root, 'removed-first.txt'), 'first');
      await waitFor(() => buildCount === 1, 'the first index build');

      events.length = 0;
      await fsp.writeFile(path.join(root, 'removed-second.txt'), 'second');
      await waitFor(
        () => events.flatMap((e) => e.paths).some((p) => p.endsWith('removed-second.txt')),
        'the change made while the build is in flight'
      );
      await waitFor(
        () => _reindexDirtyForTest(root) === true,
        'the deferred rebuild to be marked dirty'
      );
      assert.equal(buildCount, 1);

      syncWatchedRoots([]);
      assert.equal(_watchCountForTest(), 0);
      assert.equal(_reindexDirtyForTest(root), null, 'removed root state is gone');
      firstBuild.resolve();
      await sleep(1700);
      assert.equal(buildCount, 1, 'a removed root must not be rescheduled');
    } finally {
      firstBuild.resolve();
      requestOverride = null;
      setFulltextRoots([]);
    }
  });

  it('unwatches roots removed from the config', () => {
    syncWatchedRoots([root]);
    assert.equal(_watchCountForTest(), 1);
    syncWatchedRoots([]);
    assert.equal(_watchCountForTest(), 0);
  });
});

/**
 * Linux has no `fs.watch {recursive:true}`; the fallback walks the tree and
 * watches every folder. Forced on any OS through the test seam, because the
 * per-dir code path is identical everywhere.
 */
describe('dir-watcher per-directory fallback (Linux path)', () => {
  let root = '';
  let events: DirChangedEvent[];
  let origRequest: typeof indexWorkerHost.request;

  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-watch-pd-'));
    events = [];
    setDirChangedBroadcast((ev) => events.push(ev));
    origRequest = indexWorkerHost.request;
    (indexWorkerHost as { request: unknown }).request = async (op: string) => {
      if (op === 'index:status') return { count: 1, ready: true };
      return undefined;
    };
  });

  after(async () => {
    closeAllWatchers();
    setDirChangedBroadcast(null);
    (indexWorkerHost as { request: unknown }).request = origRequest;
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it('walks nested folders, follows new subtrees, releases deleted ones', async () => {
    await fsp.mkdir(path.join(root, 'a', 'b'), { recursive: true });
    await fsp.mkdir(path.join(root, '.whale'), { recursive: true });
    await fsp.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });

    assert.equal(_startWatchForcedPerDirForTest(root), true);
    assert.equal(_watchModeForTest(root), 'per-dir');
    // root + a + a/b; `.whale` and `node_modules` are never descended into.
    await waitFor(
      () => (_dirWatcherCountForTest(root) ?? 0) === 3,
      'one watcher per real folder'
    );

    await fsp.writeFile(path.join(root, 'a', 'b', 'one.txt'), 'one');
    await waitFor(
      () => events.flatMap((e) => e.paths).includes('a/b/one.txt'),
      'a change two levels down'
    );

    // A folder created after the initial walk must be followed, including its
    // children created in the same call (mkdir -p style).
    events.length = 0;
    await fsp.mkdir(path.join(root, 'a', 'fresh', 'inner'), { recursive: true });
    await waitFor(
      () => (_dirWatcherCountForTest(root) ?? 0) >= 5,
      'watchers attached to the new subtree'
    );
    await fsp.writeFile(path.join(root, 'a', 'fresh', 'inner', 'deep.txt'), 'deep');
    await waitFor(
      () => events.flatMap((e) => e.paths).includes('a/fresh/inner/deep.txt'),
      'a change inside the newly created subtree'
    );

    // Deleting the subtree must release its watchers (not leak one per delete).
    await fsp.rm(path.join(root, 'a', 'fresh'), { recursive: true, force: true });
    await waitFor(
      () => (_dirWatcherCountForTest(root) ?? 0) === 3,
      'watchers released for the deleted subtree'
    );

    // Churn in the excluded trees never reaches the watcher or the renderer.
    // Wait out the debounced flush from the delete above first, otherwise its
    // trailing flush lands in this observation window.
    await sleep(800);
    events.length = 0;
    await fsp.writeFile(path.join(root, 'node_modules', 'pkg', 'x.js'), 'x');
    await fsp.writeFile(path.join(root, '.whale', 'wsd.json'), '{}');
    await sleep(800);
    assert.equal(events.length, 0, `excluded trees produced ${JSON.stringify(events)}`);
  });
});

/**
 * Recovery paths (docs/04 §10): a watcher error must not leave the location
 * silently unwatched, and a root removed mid-rebuild must stop retrying.
 */
describe('dir-watcher self-heal', () => {
  let root = '';
  let origRequest: typeof indexWorkerHost.request;
  let buildGate: { promise: Promise<void>; resolve: () => void } | null = null;
  let buildCount = 0;

  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-watch-heal-'));
    origRequest = indexWorkerHost.request;
    (indexWorkerHost as { request: unknown }).request = async (op: string) => {
      if (op === 'index:status') return { count: 1, ready: true };
      if (op === 'index:build') {
        buildCount += 1;
        if (buildGate && buildCount === 1) {
          await buildGate.promise;
          throw new Error('simulated build failure');
        }
      }
      return undefined;
    };
  });

  after(async () => {
    closeAllWatchers();
    _setReconnectBaseDelayForTest(5_000);
    _setRetryBaseDelayForTest(1_500);
    (indexWorkerHost as { request: unknown }).request = origRequest;
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it('re-attaches a root whose watcher errored out', async () => {
    _setReconnectBaseDelayForTest(25);
    syncWatchedRoots([root]);
    assert.equal(_watchCountForTest(), 1);

    assert.equal(_simulateWatcherErrorForTest(root), true);
    assert.equal(_watchCountForTest(), 0, 'dead watcher dropped');
    assert.equal(_reconnectPendingForTest(root), true, 'retry armed');

    await waitFor(() => _watchCountForTest() === 1, 'watcher re-attached', 3000);
    assert.equal(_reconnectPendingForTest(root), false, 'retry consumed');
  });

  it('drops the pending retry when the root leaves the config', async () => {
    _setReconnectBaseDelayForTest(25);
    syncWatchedRoots([root]);
    _simulateWatcherErrorForTest(root);
    assert.equal(_reconnectPendingForTest(root), true);

    syncWatchedRoots([]);
    assert.equal(_reconnectPendingForTest(root), false, 'retry cancelled');
    await sleep(120);
    assert.equal(_watchCountForTest(), 0, 'removed root stays unwatched');
  });

  it('stops retrying a failing rebuild after the root is removed', async () => {
    _setRetryBaseDelayForTest(25);
    buildCount = 0;
    buildGate = deferred();
    syncWatchedRoots([root]);
    setFulltextRoots([]);

    try {
      await fsp.writeFile(path.join(root, 'heal-fail.txt'), 'x');
      await waitFor(() => buildCount === 1, 'the first rebuild', 5000);

      // Remove the root while the rebuild is still running, then let it fail.
      syncWatchedRoots([]);
      assert.equal(_watchCountForTest(), 0);
      buildGate.resolve();
      await sleep(250); // > retryDelay(1) with the 25 ms test base

      assert.equal(buildCount, 1, 'a removed root must not retry its rebuild');
    } finally {
      buildGate?.resolve();
      buildGate = null;
    }
  });
});
