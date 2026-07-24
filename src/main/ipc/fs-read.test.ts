import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';

import { readFileRange } from './fs-read';

describe('readFileRange', () => {
  let dir: string;
  let file: string;
  const CONTENT = new Uint8Array([...'0123456789abcdef'].map((c) => c.charCodeAt(0))); // 16 bytes

  before(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-rfr-'));
    file = path.join(dir, 'a.bin');
    await fsp.writeFile(file, CONTENT);
  });

  after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('reads an exact middle slice', async () => {
    const buf = await readFileRange(file, 4, 6);
    assert.deepEqual([...buf], [...Buffer.from('456789')]);
  });

  it('truncates a slice that runs past EOF', async () => {
    const buf = await readFileRange(file, 10, 100);
    assert.deepEqual([...buf], [...Buffer.from('abcdef')]);
  });

  it('clamps an offset beyond EOF to an empty buffer', async () => {
    const buf = await readFileRange(file, 1000, 10);
    assert.equal(buf.length, 0);
  });

  it('treats a negative offset as 0', async () => {
    const buf = await readFileRange(file, -5, 3);
    assert.deepEqual([...buf], [...Buffer.from('012')]);
  });

  it('reads the whole file when length covers it', async () => {
    const buf = await readFileRange(file, 0, 16);
    assert.deepEqual([...buf], [...CONTENT]);
  });

  it('returns an empty buffer for an empty file', async () => {
    const empty = path.join(dir, 'empty.bin');
    await fsp.writeFile(empty, '');
    const buf = await readFileRange(empty, 0, 64);
    assert.equal(buf.length, 0);
  });
});
