import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fsp, existsSync } from 'fs';
import { readFolderMeta, writeFolderMeta } from './folder-meta';
import { META_DIR, FOLDER_META_FILE } from '../shared/whale-meta';

/** Per-test scratch directory under the OS temp root. */
async function tmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'whale-foldermeta-'));
}

const wsm = (dir: string) => path.join(dir, META_DIR, FOLDER_META_FILE);

describe('folder metadata store (wsm.json)', () => {
  it('returns {} when no wsm.json exists', async () => {
    const dir = await tmpDir();
    try {
      assert.deepEqual(await readFolderMeta(dir), {});
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('writes a patch and reads it back', async () => {
    const dir = await tmpDir();
    try {
      await writeFolderMeta(dir, { perspective: 'grid', entrySize: 200 });
      const meta = await readFolderMeta(dir);
      assert.equal(meta.perspective, 'grid');
      assert.equal(meta.entrySize, 200);
      assert.ok(existsSync(wsm(dir)), 'wsm.json created');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('merges patches without clobbering untouched keys', async () => {
    const dir = await tmpDir();
    try {
      await writeFolderMeta(dir, {
        tags: ['project'],
        color: '#abc',
        description: 'desc',
      });
      // A later view-only patch must not wipe tags/color/description.
      await writeFolderMeta(dir, { perspective: 'grid' });
      const meta = await readFolderMeta(dir);
      assert.deepEqual(meta.tags, ['project']);
      assert.equal(meta.color, '#abc');
      assert.equal(meta.description, 'desc');
      assert.equal(meta.perspective, 'grid');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('clears a key when patched with undefined', async () => {
    const dir = await tmpDir();
    try {
      await writeFolderMeta(dir, { perspective: 'grid', tags: ['keep'] });
      await writeFolderMeta(dir, { perspective: undefined });
      const meta = await readFolderMeta(dir);
      assert.equal(meta.perspective, undefined);
      assert.deepEqual(meta.tags, ['keep']);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('removes wsm.json once the merged result is empty', async () => {
    const dir = await tmpDir();
    try {
      await writeFolderMeta(dir, { perspective: 'grid' });
      assert.ok(existsSync(wsm(dir)), 'created');
      await writeFolderMeta(dir, { perspective: undefined });
      assert.ok(!existsSync(wsm(dir)), 'deleted when empty');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent writes to the same directory (no lost updates)', async () => {
    const dir = await tmpDir();
    try {
      // Fire many independent patches at once; each sets a distinct entrySize
      // but the last-write semantics aren't what we assert — we assert that the
      // read-modify-write never drops the perspective key set up front.
      await writeFolderMeta(dir, { perspective: 'list' });
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          writeFolderMeta(dir, { entrySize: 100 + i })
        )
      );
      const meta = await readFolderMeta(dir);
      assert.equal(meta.perspective, 'list', 'perspective survived concurrent writes');
      assert.ok(
        typeof meta.entrySize === 'number' && meta.entrySize >= 100,
        'an entrySize landed'
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
