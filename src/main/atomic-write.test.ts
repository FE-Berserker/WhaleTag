import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';
import {
  atomicWriteText,
  atomicWriteBytes,
  atomicWriteJson,
} from './atomic-write';

/** Per-test scratch directory under the OS temp root. */
async function tmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'whale-atomic-'));
}

describe('atomic write helpers', () => {
  it('writes text and reads it back', async () => {
    const dir = await tmpDir();
    try {
      const file = path.join(dir, 'test.txt');
      await atomicWriteText(file, 'hello world');
      assert.equal(await fsp.readFile(file, 'utf8'), 'hello world');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('writes bytes and reads them back', async () => {
    const dir = await tmpDir();
    try {
      const file = path.join(dir, 'test.bin');
      const data = Buffer.from([0x00, 0x01, 0x02, 0xff]);
      await atomicWriteBytes(file, data);
      assert.deepEqual(await fsp.readFile(file), data);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('writes json and reads it back', async () => {
    const dir = await tmpDir();
    try {
      const file = path.join(dir, 'test.json');
      await atomicWriteJson(file, { a: 1, b: 'two' });
      const content = await fsp.readFile(file, 'utf8');
      assert.equal(content, JSON.stringify({ a: 1, b: 'two' }, null, 2));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('overwrites an existing file atomically', async () => {
    const dir = await tmpDir();
    try {
      const file = path.join(dir, 'existing.txt');
      await fsp.writeFile(file, 'old');
      await atomicWriteText(file, 'new');
      assert.equal(await fsp.readFile(file, 'utf8'), 'new');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('cleans up stale temp files for the same target before writing', async () => {
    const dir = await tmpDir();
    try {
      const file = path.join(dir, 'target.txt');
      const stale = [
        `${file}.12345.1.tmp`,
        `${file}.12345.2.tmp`,
        `${file}.99999.7.tmp`,
      ];
      await Promise.all(stale.map((p) => fsp.writeFile(p, 'garbage')));
      await atomicWriteText(file, 'fresh');
      assert.equal(await fsp.readFile(file, 'utf8'), 'fresh');
      const tmpFiles = (await fsp.readdir(dir)).filter((f) => f.endsWith('.tmp'));
      assert.equal(tmpFiles.length, 0, 'stale temp files removed');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('does not remove temp files belonging to other targets', async () => {
    const dir = await tmpDir();
    try {
      const file = path.join(dir, 'target.txt');
      const other = path.join(dir, 'other.txt');
      await fsp.writeFile(`${other}.12345.1.tmp`, 'garbage');
      await atomicWriteText(file, 'data');
      const tmpFiles = (await fsp.readdir(dir)).filter((f) => f.endsWith('.tmp'));
      assert.equal(tmpFiles.length, 1, 'other target temp kept');
      assert.ok(tmpFiles[0].startsWith('other.txt.'), 'kept the right temp');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
