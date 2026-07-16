import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';
import { assertWithinAllowedRoot, setAllowedRoots } from './allowed-roots';
import { CASE_INSENSITIVE_FS } from './path-fold';

/** Per-test scratch directory under the OS temp root. */
async function tmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'whale-allowed-roots-'));
}

/**
 * Helper: create a directory symlink, skipping the test on Windows if the
 * process lacks symlink privilege (developer mode / admin).
 */
async function trySymlink(
  target: string,
  linkPath: string
): Promise<boolean> {
  try {
    await fsp.symlink(target, linkPath, 'dir');
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw e;
  }
}

describe('allowed roots guard', () => {
  it('refuses all writes when no roots are configured', () => {
    setAllowedRoots([]);
    assert.throws(
      () => assertWithinAllowedRoot('/some/path'),
      /Refused: no configured locations/
    );
  });

  it('allows paths inside a configured root', async () => {
    const dir = await tmpDir();
    try {
      setAllowedRoots([dir]);
      assert.doesNotThrow(() => assertWithinAllowedRoot(dir));
      assert.doesNotThrow(() => assertWithinAllowedRoot(path.join(dir, 'child.txt')));
      assert.doesNotThrow(() =>
        assertWithinAllowedRoot(path.join(dir, 'nested', 'deep.txt'))
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses paths outside all configured roots', async () => {
    const dir = await tmpDir();
    const other = await tmpDir();
    try {
      setAllowedRoots([dir]);
      assert.throws(
        () => assertWithinAllowedRoot(other),
        /Refused: path is outside/
      );
      assert.throws(
        () => assertWithinAllowedRoot(path.join(other, 'child.txt')),
        /Refused: path is outside/
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.rm(other, { recursive: true, force: true });
    }
  });

  it('honors filesystem case-sensitivity (fold on win/mac, exact on linux)', async () => {
    const dir = await tmpDir();
    try {
      setAllowedRoots([dir]);
      const upper = dir.toUpperCase();
      if (CASE_INSENSITIVE_FS) {
        // Windows/macOS: /TMP/... is the same dir as the registered /tmp/...
        assert.doesNotThrow(() => assertWithinAllowedRoot(upper));
      } else {
        // Linux/ext4: /TMP/... is a DIFFERENT path than registered /tmp/... —
        // folding them together would let a case-colliding sibling slip in.
        assert.throws(() => assertWithinAllowedRoot(upper), /Refused/);
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('replaces previous roots when set again', async () => {
    const dir1 = await tmpDir();
    const dir2 = await tmpDir();
    try {
      setAllowedRoots([dir1]);
      assert.doesNotThrow(() => assertWithinAllowedRoot(dir1));
      assert.throws(() => assertWithinAllowedRoot(dir2));

      setAllowedRoots([dir2]);
      assert.doesNotThrow(() => assertWithinAllowedRoot(dir2));
      assert.throws(() => assertWithinAllowedRoot(dir1));
    } finally {
      await fsp.rm(dir1, { recursive: true, force: true });
      await fsp.rm(dir2, { recursive: true, force: true });
    }
  });

  it('rejects writes through a symlink that escapes the root', async () => {
    const dir = await tmpDir();
    const outside = await tmpDir();
    try {
      const link = path.join(dir, 'escape');
      if (!(await trySymlink(outside, link))) return; // Windows privilege skip

      setAllowedRoots([dir]);
      assert.throws(
        () => assertWithinAllowedRoot(path.join(link, 'file.txt')),
        /Refused: path is outside/
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it('allows writes to a symlink that stays inside the root', async () => {
    const dir = await tmpDir();
    try {
      const realDir = path.join(dir, 'real');
      const link = path.join(dir, 'link');
      await fsp.mkdir(realDir);
      if (!(await trySymlink(realDir, link))) return; // Windows privilege skip

      setAllowedRoots([dir]);
      assert.doesNotThrow(() =>
        assertWithinAllowedRoot(path.join(link, 'file.txt'))
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('allows non-existent targets whose resolved parent is inside the root', async () => {
    const dir = await tmpDir();
    try {
      setAllowedRoots([dir]);
      assert.doesNotThrow(() =>
        assertWithinAllowedRoot(path.join(dir, 'new', 'file.txt'))
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects non-existent targets whose resolved parent escapes the root', async () => {
    const dir = await tmpDir();
    const outside = await tmpDir();
    try {
      const link = path.join(dir, 'escape');
      if (!(await trySymlink(outside, link))) return; // Windows privilege skip

      setAllowedRoots([dir]);
      assert.throws(
        () => assertWithinAllowedRoot(path.join(link, 'new', 'file.txt')),
        /Refused: path is outside/
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });
});
