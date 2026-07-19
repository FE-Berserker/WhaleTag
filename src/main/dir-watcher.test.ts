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

  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-watch-'));
    await fsp.mkdir(path.join(root, '.whale'), { recursive: true });
    events = [];
    requestCalls = [];
    fulltextHas = true;
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
      if (op === 'index:status') return { count: 5, ready: true };
      if (op === 'fulltext:has') return fulltextHas;
      return undefined;
    };
  });

  after(async () => {
    closeAllWatchers();
    setDirChangedBroadcast(null);
    setFulltextRoots([]);
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

  it('unwatches roots removed from the config', () => {
    syncWatchedRoots([root]);
    assert.equal(_watchCountForTest(), 1);
    syncWatchedRoots([]);
    assert.equal(_watchCountForTest(), 0);
  });
});
