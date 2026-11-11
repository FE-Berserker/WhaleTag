import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { existsSync, promises as fsp } from 'fs';

import { setAllowedRoots } from '../allowed-roots';
import { copyEntry, createTextFile, moveEntry } from './fs-write';

describe('fs-write createTextFile', () => {
  it('rejects an existing file without changing its bytes', async () => {
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-fs-write-'));
    const root = await fsp.realpath(scratch);
    const file = path.join(root, 'existing.txt');
    setAllowedRoots([root]);
    try {
      await fsp.writeFile(file, 'original', 'utf8');
      await assert.rejects(
        createTextFile(file, 'replacement'),
        /File already exists/
      );
      assert.equal(await fsp.readFile(file, 'utf8'), 'original');
    } finally {
      setAllowedRoots([]);
      await fsp.rm(scratch, { recursive: true, force: true });
    }
  });

  it('allows only one winner when concurrent creates target the same path', async () => {
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-fs-write-'));
    const root = await fsp.realpath(scratch);
    const file = path.join(root, 'race.txt');
    setAllowedRoots([root]);
    try {
      const results = await Promise.allSettled([
        createTextFile(file, 'first'),
        createTextFile(file, 'second'),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
      assert.ok(['first', 'second'].includes(await fsp.readFile(file, 'utf8')));
    } finally {
      setAllowedRoots([]);
      await fsp.rm(scratch, { recursive: true, force: true });
    }
  });
});

/**
 * The approval dialog serializes only one call at a time, but MCP clients can
 * issue parallel calls. Two copies/moves that both pass the "destination does
 * not exist" check must not silently replace each other (merge-over-wipe).
 */
describe('fs-write concurrent copies/moves to one destination', () => {
  it('lets exactly one concurrent copy win and never overwrites the loser', async () => {
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-fs-write-'));
    const root = await fsp.realpath(scratch);
    setAllowedRoots([root]);
    try {
      const a = path.join(root, 'a.txt');
      const b = path.join(root, 'b.txt');
      const dest = path.join(root, 'out.txt');
      await fsp.writeFile(a, 'AAAA', 'utf8');
      await fsp.writeFile(b, 'BBBB', 'utf8');

      const results = await Promise.allSettled([
        copyEntry(a, dest),
        copyEntry(b, dest),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
      // Whichever won, the destination holds that source's exact bytes.
      assert.ok(['AAAA', 'BBBB'].includes(await fsp.readFile(dest, 'utf8')));
    } finally {
      setAllowedRoots([]);
      await fsp.rm(scratch, { recursive: true, force: true });
    }
  });

  it('lets exactly one concurrent move win and keeps both sources otherwise', async () => {
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-fs-write-'));
    const root = await fsp.realpath(scratch);
    setAllowedRoots([root]);
    try {
      const a = path.join(root, 'a.txt');
      const b = path.join(root, 'b.txt');
      const dest = path.join(root, 'moved.txt');
      await fsp.writeFile(a, 'AAAA', 'utf8');
      await fsp.writeFile(b, 'BBBB', 'utf8');

      const results = await Promise.allSettled([
        moveEntry(a, dest),
        moveEntry(b, dest),
      ]);
      const won = results.filter((r) => r.status === 'fulfilled').length;
      assert.equal(won, 1);
      // Exactly one source disappeared; the other is untouched.
      const survivors = [a, b].filter((p) => existsSync(p));
      assert.equal(survivors.length, 1);
      // The destination holds the bytes of the source that MOVED, not the one
      // that stayed — so derive the expected content from the missing source.
      assert.equal(await fsp.readFile(dest, 'utf8'), survivors[0] === a ? 'BBBB' : 'AAAA');
    } finally {
      setAllowedRoots([]);
      await fsp.rm(scratch, { recursive: true, force: true });
    }
  });

  it('refuses to replace an existing destination and keeps its bytes', async () => {
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-fs-write-'));
    const root = await fsp.realpath(scratch);
    setAllowedRoots([root]);
    try {
      const src = path.join(root, 'src.txt');
      const dest = path.join(root, 'keep.txt');
      await fsp.writeFile(src, 'SOURCE', 'utf8');
      await fsp.writeFile(dest, 'KEEP', 'utf8');

      await assert.rejects(copyEntry(src, dest), /file already exists/i);
      assert.equal(await fsp.readFile(dest, 'utf8'), 'KEEP');
    } finally {
      setAllowedRoots([]);
      await fsp.rm(scratch, { recursive: true, force: true });
    }
  });
});
