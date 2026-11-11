import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fsp, existsSync } from 'fs';
import {
  writeSidecar,
  readSidecar,
  readSidecars,
  readSidecardsForPaths,
  removeSidecar,
  moveSidecar,
  copySidecar,
  updateFileTags,
} from './sidecar';
import { META_DIR, SIDECAR_VERSION } from '../shared/whale-meta';

/** Per-test scratch directory under the OS temp root. */
async function tmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'whale-sidecar-'));
}

const filePath = (dir: string, name: string) => path.join(dir, name);
const wsd = (dir: string) => path.join(dir, META_DIR, 'wsd.json');

describe('aggregated sidecar store (wsd.json)', () => {
  it('writes and reads a single file sidecar', async () => {
    const dir = await tmpDir();
    try {
      await writeSidecar(filePath(dir, 'a.txt'), { tags: ['x', 'y'] });
      const meta = await readSidecar(filePath(dir, 'a.txt'));
      assert.deepEqual(meta?.tags, ['x', 'y']);
      assert.ok(existsSync(wsd(dir)), 'wsd.json created');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed wsd.json without overwriting existing metadata', async () => {
    const dir = await tmpDir();
    try {
      await fsp.mkdir(path.dirname(wsd(dir)), { recursive: true });
      const malformed = '{"version":1,"files":{"keep.txt":{"tags":["keep"]}}';
      await fsp.writeFile(wsd(dir), malformed, 'utf8');
      await assert.rejects(readSidecar(filePath(dir, 'keep.txt')), SyntaxError);
      await assert.rejects(writeSidecar(filePath(dir, 'other.txt'), { tags: ['new'] }));
      assert.equal(await fsp.readFile(wsd(dir), 'utf8'), malformed);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a structurally invalid wsd.json instead of treating it as empty', async () => {
    const dir = await tmpDir();
    try {
      await fsp.mkdir(path.dirname(wsd(dir)), { recursive: true });
      await fsp.writeFile(wsd(dir), '{"version":1,"files":null}', 'utf8');
      await assert.rejects(
        readSidecar(filePath(dir, 'a.txt')),
        /Invalid aggregated sidecar format/
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('surfaces non-ENOENT wsd.json read failures', async () => {
    const dir = await tmpDir();
    try {
      await fsp.mkdir(wsd(dir), { recursive: true });
      await assert.rejects(readSidecar(filePath(dir, 'a.txt')));
      await assert.rejects(writeSidecar(filePath(dir, 'a.txt'), { tags: ['new'] }));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('rebuilds a blank wsd.json left by a truncated write', async () => {
    const dir = await tmpDir();
    try {
      await fsp.mkdir(path.dirname(wsd(dir)), { recursive: true });
      await fsp.writeFile(wsd(dir), '  \n', 'utf8');
      const file = filePath(dir, 'fresh.txt');
      await writeSidecar(file, { tags: ['fresh'] });
      assert.deepEqual((await readSidecar(file))?.tags, ['fresh']);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('reads many sidecars via a single wsd.json read', async () => {
    const dir = await tmpDir();
    try {
      await writeSidecar(filePath(dir, 'a.txt'), { tags: ['1'] });
      await writeSidecar(filePath(dir, 'b.txt'), { tags: ['2'] });
      await writeSidecar(filePath(dir, 'c.txt'), { color: '#f00' });
      const map = await readSidecars(dir, ['a.txt', 'b.txt', 'c.txt', 'none.txt']);
      assert.deepEqual(map['a.txt']?.tags, ['1']);
      assert.deepEqual(map['b.txt']?.tags, ['2']);
      assert.equal(map['c.txt']?.color, '#f00');
      assert.equal(map['none.txt'], undefined);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('omits empty sidecars so the store stays sparse', async () => {
    const dir = await tmpDir();
    try {
      await writeSidecar(filePath(dir, 'a.txt'), { tags: [] });
      assert.ok(!existsSync(wsd(dir)), 'no wsd.json for empty meta');
      await writeSidecar(filePath(dir, 'b.txt'), { tags: ['keep'] });
      await writeSidecar(filePath(dir, 'b.txt'), { tags: [] });
      assert.ok(!existsSync(wsd(dir)), 'wsd.json deleted once every entry is cleared');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent writes to the same directory (no lost updates)', async () => {
    const dir = await tmpDir();
    try {
      const names = Array.from({ length: 30 }, (_, i) => `f${i}.txt`);
      await Promise.all(
        names.map((n) => writeSidecar(filePath(dir, n), { tags: [n] }))
      );
      const map = await readSidecars(dir, names);
      for (const n of names) {
        assert.deepEqual(map[n]?.tags, [n], `${n} survived concurrent writes`);
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('removes a file entry on delete', async () => {
    const dir = await tmpDir();
    try {
      await writeSidecar(filePath(dir, 'a.txt'), { tags: ['x'] });
      await writeSidecar(filePath(dir, 'b.txt'), { tags: ['y'] });
      await removeSidecar(filePath(dir, 'a.txt'));
      const map = await readSidecars(dir, ['a.txt', 'b.txt']);
      assert.equal(map['a.txt'], undefined);
      assert.deepEqual(map['b.txt']?.tags, ['y']);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('renames a sidecar within the same directory', async () => {
    const dir = await tmpDir();
    try {
      await writeSidecar(filePath(dir, 'old.txt'), { tags: ['t'] });
      await moveSidecar(filePath(dir, 'old.txt'), filePath(dir, 'new.txt'));
      const map = await readSidecars(dir, ['old.txt', 'new.txt']);
      assert.equal(map['old.txt'], undefined);
      assert.deepEqual(map['new.txt']?.tags, ['t']);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('moves a sidecar across directories', async () => {
    const src = await tmpDir();
    const dst = await tmpDir();
    try {
      await writeSidecar(filePath(src, 'a.txt'), { tags: ['t'] });
      await moveSidecar(filePath(src, 'a.txt'), filePath(dst, 'a.txt'));
      assert.equal(await readSidecar(filePath(src, 'a.txt')), null);
      assert.deepEqual((await readSidecar(filePath(dst, 'a.txt')))?.tags, ['t']);
    } finally {
      await fsp.rm(src, { recursive: true, force: true });
      await fsp.rm(dst, { recursive: true, force: true });
    }
  });

  it('copies a sidecar without removing the source', async () => {
    const src = await tmpDir();
    const dst = await tmpDir();
    try {
      await writeSidecar(filePath(src, 'a.txt'), { tags: ['t'] });
      await copySidecar(filePath(src, 'a.txt'), filePath(dst, 'a.txt'));
      assert.deepEqual((await readSidecar(filePath(src, 'a.txt')))?.tags, ['t']);
      assert.deepEqual((await readSidecar(filePath(dst, 'a.txt')))?.tags, ['t']);
    } finally {
      await fsp.rm(src, { recursive: true, force: true });
      await fsp.rm(dst, { recursive: true, force: true });
    }
  });

  it('migrates legacy per-file sidecars into wsd.json on first read', async () => {
    const dir = await tmpDir();
    try {
      // Seed the old layout: <dir>/.whale/<file>.json
      const metaDir = path.join(dir, META_DIR);
      await fsp.mkdir(metaDir, { recursive: true });
      await fsp.writeFile(
        path.join(metaDir, 'legacy.txt.json'),
        JSON.stringify({ tags: ['old'], description: 'migrated' }),
        'utf8'
      );
      assert.ok(!existsSync(wsd(dir)));

      const meta = await readSidecar(filePath(dir, 'legacy.txt'));
      assert.deepEqual(meta?.tags, ['old']);
      assert.equal(meta?.description, 'migrated');

      assert.ok(existsSync(wsd(dir)), 'wsd.json created by migration');
      assert.ok(
        !existsSync(path.join(metaDir, 'legacy.txt.json')),
        'legacy file removed'
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('never deletes a malformed legacy sidecar during migration', async () => {
    const dir = await tmpDir();
    try {
      const metaDir = path.join(dir, META_DIR);
      await fsp.mkdir(metaDir, { recursive: true });
      await fsp.writeFile(
        path.join(metaDir, 'good.txt.json'),
        JSON.stringify({ tags: ['kept'] }),
        'utf8'
      );
      const broken = path.join(metaDir, 'broken.txt.json');
      await fsp.writeFile(broken, '{ "tags": [', 'utf8');

      const meta = await readSidecar(filePath(dir, 'good.txt'));
      assert.deepEqual(meta?.tags, ['kept'], 'parsed legacy migrated');

      assert.ok(
        !existsSync(path.join(metaDir, 'good.txt.json')),
        'parsed legacy removed'
      );
      const quarantined = (await fsp.readdir(metaDir)).filter((n) =>
        n.startsWith('broken.txt.json.corrupt-')
      );
      assert.equal(quarantined.length, 1, 'malformed legacy preserved');
      assert.equal(
        await fsp.readFile(path.join(metaDir, quarantined[0]), 'utf8'),
        '{ "tags": [',
        'malformed bytes preserved verbatim'
      );

      // The renamed file no longer matches the `.json` legacy scan, so a
      // second load must not try to migrate it again.
      const again = await readSidecar(filePath(dir, 'broken.txt'));
      assert.equal(again, null);
      const stillThere = (await fsp.readdir(metaDir)).filter((n) =>
        n.startsWith('broken.txt.json.corrupt-')
      );
      assert.equal(stillThere.length, 1);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('does not re-migrate once wsd.json exists (idempotent)', async () => {
    const dir = await tmpDir();
    try {
      await writeSidecar(filePath(dir, 'a.txt'), { tags: ['new'] });
      // A legacy file dropped in AFTER wsd.json exists must be ignored on read
      // (the fast path serves wsd.json without scanning the folder).
      const metaDir = path.join(dir, META_DIR);
      await fsp.writeFile(
        path.join(metaDir, 'stale.txt.json'),
        JSON.stringify({ tags: ['stale'] }),
        'utf8'
      );
      const map = await readSidecars(dir, ['a.txt', 'stale.txt']);
      assert.deepEqual(map['a.txt']?.tags, ['new']);
      assert.equal(map['stale.txt'], undefined);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to per-file legacy sidecars when wsd.json is missing (H.24 R7 bug #1)', async () => {
    // Regression for the H.24 PR3 bug: at depth > 1, subdirs usually have
    // no wsd.json yet (it's created lazily on first tag write). Their files
    // may still carry the legacy per-file format `.whale/<name>.json`. The
    // bulk `readSidecards` only reads wsd.json, so without the fallback the
    // entire recursive scan would silently lose every sidecar in a
    // never-tagged subdir. After the fix `readSidecardsForPaths` falls back
    // to the per-file reader and returns the legacy meta.
    const root = await tmpDir();
    const sub = path.join(root, 'sub');
    await fsp.mkdir(sub, { recursive: true });
    try {
      // Write legacy per-file sidecar in the subdir (no wsd.json exists).
      const metaDir = path.join(sub, META_DIR);
      await fsp.mkdir(metaDir, { recursive: true });
      await fsp.writeFile(
        path.join(metaDir, 'note.txt.json'),
        JSON.stringify({ tags: ['legacy-tag'] }),
        'utf8'
      );
      const result = await readSidecardsForPaths([
        path.join(sub, 'note.txt'),
      ]);
      assert.deepEqual(
        result[path.join(sub, 'note.txt')]?.tags,
        ['legacy-tag'],
        'per-file legacy sidecar in a subdir with no wsd.json must be picked up'
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});


describe('readSidecar lat/lng migration concurrency', () => {
  it('migrates and returns the current map read inside the directory lock', async (t) => {
    const dir = await tmpDir();
    try {
      const target = wsd(dir);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(
        target,
        JSON.stringify({
          version: SIDECAR_VERSION,
          files: {
            'a.txt': { lat: 1, lng: 2 },
            'b.txt': { tags: ['stale'] },
          },
        }),
        'utf8'
      );
      const originalRead = fsp.readFile;
      let aggregateReads = 0;
      t.mock.method(fsp, 'readFile', async (file, options) => {
        if (path.resolve(String(file)) === target) {
          aggregateReads += 1;
          if (aggregateReads === 2) {
            // A concurrent writer won before the migration lock: a.txt vanished
            // and b.txt changed. The old stale-key loop dereferenced undefined.
            await fsp.writeFile(
              target,
              JSON.stringify({
                version: SIDECAR_VERSION,
                files: { 'b.txt': { tags: ['current'] } },
              }),
              'utf8'
            );
          }
        }
        return originalRead(file, options);
      });

      const result = await readSidecars(dir, ['a.txt', 'b.txt']);
      assert.equal(aggregateReads, 2);
      assert.deepEqual(result, { 'b.txt': { tags: ['current'] } });
      assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')).files, {
        'b.txt': { tags: ['current'] },
      });
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('readSidecardsForPaths (H.24 R7: cross-dir batch read)', () => {
  it('returns an empty map for an empty input list', async () => {
    const result = await readSidecardsForPaths([]);
    assert.deepEqual(result, {});
  });

  it('reads sidecars across multiple directories in one round trip', async () => {
    const root = await tmpDir();
    const subA = path.join(root, 'a');
    const subB = path.join(root, 'b');
    await fsp.mkdir(subA, { recursive: true });
    await fsp.mkdir(subB, { recursive: true });
    try {
      await writeSidecar(filePath(subA, 'one.md'), { tags: ['t1'] });
      await writeSidecar(filePath(subB, 'two.md'), { tags: ['t2'] });
      const result = await readSidecardsForPaths([
        filePath(subA, 'one.md'),
        filePath(subB, 'two.md'),
      ]);
      assert.equal(Object.keys(result).length, 2);
      assert.deepEqual(result[filePath(subA, 'one.md')]?.tags, ['t1']);
      assert.deepEqual(result[filePath(subB, 'two.md')]?.tags, ['t2']);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('keys results by the FULL input path so same-named files do not collide', async () => {
    // Regression for H.24 R1: at depth > 1 two subdirs can each contain a
    // `notes.md`. Keying by basename would overwrite; keying by path keeps them
    // distinct.
    const root = await tmpDir();
    const subA = path.join(root, 'dir-a');
    const subB = path.join(root, 'dir-b');
    await fsp.mkdir(subA, { recursive: true });
    await fsp.mkdir(subB, { recursive: true });
    try {
      await writeSidecar(filePath(subA, 'notes.md'), { tags: ['from-a'] });
      await writeSidecar(filePath(subB, 'notes.md'), { tags: ['from-b'] });
      const result = await readSidecardsForPaths([
        filePath(subA, 'notes.md'),
        filePath(subB, 'notes.md'),
      ]);
      assert.deepEqual(result[filePath(subA, 'notes.md')]?.tags, ['from-a']);
      assert.deepEqual(result[filePath(subB, 'notes.md')]?.tags, ['from-b']);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('omits files that have no sidecar', async () => {
    const dir = await tmpDir();
    try {
      await writeSidecar(filePath(dir, 'tagged.txt'), { tags: ['k'] });
      const result = await readSidecardsForPaths([
        filePath(dir, 'tagged.txt'),
        filePath(dir, 'untagged.txt'),
      ]);
      assert.equal(Object.keys(result).length, 1);
      assert.ok(result[filePath(dir, 'tagged.txt')]);
      assert.ok(!result[filePath(dir, 'untagged.txt')]);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps healthy directory results when another directory is malformed', async () => {
    const goodDir = await tmpDir();
    const badDir = await tmpDir();
    const originalWarn = console.warn;
    console.warn = () => undefined;
    try {
      const goodFile = filePath(goodDir, 'same.txt');
      const badFile = filePath(badDir, 'same.txt');
      await writeSidecar(goodFile, { tags: ['healthy'] });
      await fsp.mkdir(path.dirname(wsd(badDir)), { recursive: true });
      await fsp.writeFile(wsd(badDir), '{malformed', 'utf8');
      const result = await readSidecardsForPaths([goodFile, badFile]);
      assert.deepEqual(result[goodFile]?.tags, ['healthy']);
      assert.equal(result[badFile], undefined);
    } finally {
      console.warn = originalWarn;
      await fsp.rm(goodDir, { recursive: true, force: true });
      await fsp.rm(badDir, { recursive: true, force: true });
    }
  });

  it('silently skips empty-string entries (defensive against malformed input)', async () => {
    const dir = await tmpDir();
    try {
      await writeSidecar(filePath(dir, 'a.txt'), { tags: ['x'] });
      const result = await readSidecardsForPaths([
        '',
        filePath(dir, 'a.txt'),
        '',
      ]);
      assert.equal(Object.keys(result).length, 1);
      assert.deepEqual(result[filePath(dir, 'a.txt')]?.tags, ['x']);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('updateFileTags', () => {
  it('adds a tag to a file with no sidecar (creates .whale/wsd.json)', async () => {
    const dir = await tmpDir();
    try {
      const r = await updateFileTags(filePath(dir, 'a.txt'), (cur) => [...cur, 'idea']);
      assert.deepEqual(r.before, []);
      assert.deepEqual(r.after, ['idea']);
      assert.deepEqual((await readSidecar(filePath(dir, 'a.txt')))?.tags, ['idea']);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves color / description / created when merging tags', async () => {
    const dir = await tmpDir();
    try {
      const p = filePath(dir, 'a.txt');
      await writeSidecar(p, { tags: ['idea'], color: '#ff0000', description: 'd' });
      const r = await updateFileTags(p, (cur) => [...cur, 'wip']);
      assert.deepEqual(r.before, ['idea']);
      assert.deepEqual(r.after, ['idea', 'wip']);
      const meta = await readSidecar(p);
      assert.equal(meta?.color, '#ff0000');
      assert.equal(meta?.description, 'd');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('lets the mutator remove tags', async () => {
    const dir = await tmpDir();
    try {
      const p = filePath(dir, 'a.txt');
      await writeSidecar(p, { tags: ['idea', 'wip'] });
      const r = await updateFileTags(p, (cur) => cur.filter((t) => t !== 'idea'));
      assert.deepEqual(r.before, ['idea', 'wip']);
      assert.deepEqual(r.after, ['wip']);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('drops the entry (sparse store) when all metadata becomes empty after tag clear', async () => {
    const dir = await tmpDir();
    try {
      const p = filePath(dir, 'a.txt');
      await writeSidecar(p, { tags: ['idea'] });
      // Clear tags + no other metadata → entry goes away so the store stays sparse.
      await updateFileTags(p, () => []);
      assert.equal(await readSidecar(p), null);
      assert.equal(existsSync(wsd(dir)), false);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the entry if non-tag metadata survives a tag clear', async () => {
    const dir = await tmpDir();
    try {
      const p = filePath(dir, 'a.txt');
      await writeSidecar(p, { tags: ['idea'], color: '#ff0000' });
      await updateFileTags(p, () => []);
      const meta = await readSidecar(p);
      assert.deepEqual(meta?.tags ?? [], []);
      assert.equal(meta?.color, '#ff0000');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('dedupes repeated tags, preserving caller order', async () => {
    const dir = await tmpDir();
    try {
      const p = filePath(dir, 'a.txt');
      const r = await updateFileTags(p, () => ['b', 'a', 'b', 'c', 'a']);
      assert.deepEqual(r.after, ['b', 'a', 'c']);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
