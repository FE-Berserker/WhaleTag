import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { existsSync, promises as fsp } from 'fs';
import { loadRecursiveScan, invalidateRecursiveScan } from './recursive-cache';
import { META_DIR, INDEX_RECURSIVE_DIR } from '../shared/whale-meta';
import type { DirEntry } from '../shared/ipc-types';

async function tmpRoot(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'whale-rc-'));
}

/** Every managed folder in the real app already has `.whale/` (sidecars,
 *  folder-meta, index.db all create it on first use). Pre-creating it here means
 *  the cache write (which mkdir's `<root>/.whale/index-recursive/`) does NOT
 *  create `<root>/.whale` itself — so the key folder's mtime is stable across
 *  the first cache write, matching production. */
async function setup(root: string): Promise<void> {
  await fsp.mkdir(path.join(root, META_DIR), { recursive: true });
}

function fakeEntry(dir: string, name: string): DirEntry {
  return {
    name,
    path: path.join(dir, name),
    isDirectory: false,
    isFile: true,
    size: 10,
    modified: '2026-01-01T00:00:00.000Z',
    extension: 'txt',
  };
}

describe('recursive-cache (P1-3)', () => {
  it('caches the scan: a second load with unchanged folder mtime does NOT re-scan', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      let scans = 0;
      const scan = async (dir: string, _depth: number) => {
        scans += 1;
        return [fakeEntry(dir, 'a.txt'), fakeEntry(dir, 'b.txt')];
      };
      const first = await loadRecursiveScan(root, 3, scan);
      assert.equal(scans, 1);
      assert.equal(first.length, 2);

      // Same (folder, depth), folder unchanged → cache HIT, scanner NOT called.
      const second = await loadRecursiveScan(root, 3, scan);
      assert.equal(scans, 1);
      assert.deepEqual(second, first);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('re-scans when the folder mtime changes (direct-child edit detected)', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      let scans = 0;
      const scan = async () => {
        scans += 1;
        return [];
      };
      await loadRecursiveScan(root, 2, scan);
      assert.equal(scans, 1);

      // Bump the key folder's mtime (simulates a direct-child add/remove, the
      // signal the read-time guard uses).
      const later = Date.now() / 1000 + 120;
      await fsp.utimes(root, later, later);

      await loadRecursiveScan(root, 2, scan);
      assert.equal(scans, 2); // mtime changed → MISS → re-scan
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('re-scans when the folder moved (stored dirPath no longer matches)', async () => {
    // A folder move carries its `.whale/index-recursive/` cache along, but the
    // cached entries carry the OLD absolute paths. The stored `dirPath` guard
    // must catch this and force a rebuild.
    const root = await tmpRoot();
    const moved = await tmpRoot();
    try {
      await setup(root);
      let scans = 0;
      const scan = async () => {
        scans += 1;
        return [];
      };
      await loadRecursiveScan(root, 3, scan);
      assert.equal(scans, 1);

      // Move the cache file to a different folder (simulating the cache
      // following a moved folder) and load there.
      const cacheFile = path.join(root, META_DIR, INDEX_RECURSIVE_DIR, 'd3.json');
      const movedCacheFile = path.join(
        moved,
        META_DIR,
        INDEX_RECURSIVE_DIR,
        'd3.json'
      );
      await fsp.mkdir(path.dirname(movedCacheFile), { recursive: true });
      await fsp.copyFile(cacheFile, movedCacheFile);

      await loadRecursiveScan(moved, 3, scan);
      assert.equal(scans, 2); // dirPath mismatch → MISS → rebuild
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
      await fsp.rm(moved, { recursive: true, force: true });
    }
  });

  it('invalidateRecursiveScan clears ancestor caches', async () => {
    const root = await tmpRoot();
    const sub = path.join(root, 'sub');
    try {
      await fsp.mkdir(sub, { recursive: true });
      await setup(root);
      let scans = 0;
      const scan = async () => {
        scans += 1;
        return [];
      };
      await loadRecursiveScan(root, 3, scan); // builds root's cache
      assert.equal(scans, 1);
      assert.ok(
        existsSync(path.join(root, META_DIR, INDEX_RECURSIVE_DIR, 'd3.json'))
      );

      // A change inside `sub` must invalidate root's (ancestor) cache.
      await invalidateRecursiveScan(path.join(sub, 'file.txt'));
      assert.equal(
        existsSync(path.join(root, META_DIR, INDEX_RECURSIVE_DIR)),
        false
      );

      await loadRecursiveScan(root, 3, scan);
      assert.equal(scans, 2); // root cache was cleared → re-scan
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('different depths are cached under independent keys', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      let scans = 0;
      const scan = async (_dir: string, depth: number) => {
        scans += 1;
        return [fakeEntry(root, `d${depth}.txt`)];
      };
      await loadRecursiveScan(root, 2, scan);
      await loadRecursiveScan(root, 4, scan);
      assert.equal(scans, 2); // different depth → different cache key → 2 scans
      // Both cached now; reloading either is a HIT.
      await loadRecursiveScan(root, 2, scan);
      await loadRecursiveScan(root, 4, scan);
      assert.equal(scans, 2);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
