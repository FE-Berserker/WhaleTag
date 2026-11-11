import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fsp, existsSync } from 'fs';
import { readJsonForMerge } from './merge-read';

async function tmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'whale-merge-read-'));
}

const isObject = (v: unknown) =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

describe('readJsonForMerge (merge-safe metadata reads)', () => {
  it('returns null when the file is absent (nothing to lose)', async () => {
    const dir = await tmpDir();
    try {
      assert.equal(await readJsonForMerge(path.join(dir, 'nope.json'), isObject), null);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns the parsed value for a valid document', async () => {
    const dir = await tmpDir();
    try {
      const file = path.join(dir, 'meta.json');
      await fsp.writeFile(file, JSON.stringify({ a: 1 }));
      assert.deepEqual(await readJsonForMerge(file, isObject), { a: 1 });
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('quarantines invalid JSON instead of treating it as empty', async () => {
    const dir = await tmpDir();
    try {
      const file = path.join(dir, 'wsm.json');
      await fsp.writeFile(file, '{ not json');
      assert.equal(await readJsonForMerge(file, isObject), null);
      assert.ok(!existsSync(file), 'corrupt file moved aside');
      const backups = (await fsp.readdir(dir)).filter((n) =>
        n.startsWith('wsm.json.corrupt-')
      );
      assert.equal(backups.length, 1, 'exactly one quarantine sibling');
      assert.equal(
        await fsp.readFile(path.join(dir, backups[0]), 'utf8'),
        '{ not json',
        'original bytes preserved verbatim'
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('quarantines valid JSON that fails the shape check', async () => {
    const dir = await tmpDir();
    try {
      const file = path.join(dir, 'wsm.json');
      await fsp.writeFile(file, '[]');
      assert.equal(await readJsonForMerge(file, isObject), null);
      const backups = (await fsp.readdir(dir)).filter((n) =>
        n.startsWith('wsm.json.corrupt-')
      );
      assert.equal(backups.length, 1);
      assert.equal(await fsp.readFile(path.join(dir, backups[0]), 'utf8'), '[]');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('throws (never falls back to null) for a non-ENOENT read error', async () => {
    const dir = await tmpDir();
    try {
      // Reading a directory raises EISDIR/EPERM on every platform — an IO
      // error the merge path must propagate rather than overwrite.
      await assert.rejects(
        readJsonForMerge(dir, isObject),
        /Cannot read .* for a merge/
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
