import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';
import {
  assertNotLocationRoot,
  assertWithinAllowedRoot,
  assertWritable,
  isConfiguredRoot,
  isReadOnlyPath,
  setAllowedRoots,
  setReadOnlyRoots,
} from './allowed-roots';
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

  it('allows descendants when the configured root is a filesystem root', () => {
    const root = path.parse(process.cwd()).root;
    try {
      setAllowedRoots([root]);
      assert.doesNotThrow(() =>
        assertWithinAllowedRoot(path.join(root, 'whale-root-guard', 'child.txt'))
      );
    } finally {
      setAllowedRoots([]);
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

describe('isConfiguredRoot', () => {
  it('is false when no roots are configured (refuse-all default)', () => {
    setAllowedRoots([]);
    assert.equal(isConfiguredRoot('/some/path'), false);
  });

  it('matches the root itself but not entries inside it', async () => {
    const dir = await tmpDir();
    try {
      setAllowedRoots([dir]);
      assert.equal(isConfiguredRoot(dir), true);
      assert.equal(isConfiguredRoot(path.join(dir, 'file.txt')), false);
      assert.equal(isConfiguredRoot(path.join(dir, 'nested', 'deep.txt')), false);
    } finally {
      setAllowedRoots([]);
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('normalizes trailing separators and relative segments', async () => {
    const dir = await tmpDir();
    try {
      setAllowedRoots([dir]);
      assert.equal(isConfiguredRoot(`${dir}${path.sep}`), true);
      assert.equal(isConfiguredRoot(path.join(dir, '.', '')), true);
    } finally {
      setAllowedRoots([]);
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a path outside every root as not a root', async () => {
    const dir = await tmpDir();
    const other = await tmpDir();
    try {
      setAllowedRoots([dir]);
      assert.equal(isConfiguredRoot(other), false);
    } finally {
      setAllowedRoots([]);
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.rm(other, { recursive: true, force: true });
    }
  });
});

describe('assertNotLocationRoot', () => {
  it('refuses the configured root itself', async () => {
    const dir = await tmpDir();
    try {
      setAllowedRoots([dir]);
      assert.throws(() => assertNotLocationRoot(dir), /configured location root/);
      // Trailing separator / `./` spellings must be caught too — the guard is
      // what stops delete/move/copy of a whole workspace, and the renderer
      // builds these paths by joining user-visible segments.
      assert.throws(
        () => assertNotLocationRoot(`${dir}${path.sep}`),
        /configured location root/
      );
    } finally {
      setAllowedRoots([]);
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('allows entries inside a root', async () => {
    const dir = await tmpDir();
    try {
      setAllowedRoots([dir]);
      assert.doesNotThrow(() => assertNotLocationRoot(path.join(dir, 'file.txt')));
      assert.doesNotThrow(() =>
        assertNotLocationRoot(path.join(dir, 'nested', 'deep.txt'))
      );
    } finally {
      setAllowedRoots([]);
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('allows everything when no roots are configured (the within-root check rejects)', async () => {
    setAllowedRoots([]);
    // No locations configured is a "nothing is inside" state: this guard only
    // answers the root question, and assertWithinAllowedRoot is what refuses.
    assert.doesNotThrow(() => assertNotLocationRoot('/anywhere/file.txt'));
  });
});

describe('read-only locations', () => {
  it('refuses writes inside a read-only root, including the root itself', async () => {
    const locked = await tmpDir();
    const writable = await tmpDir();
    try {
      setAllowedRoots([locked, writable]);
      setReadOnlyRoots([locked]);
      assert.equal(isReadOnlyPath(locked), true);
      assert.equal(isReadOnlyPath(path.join(locked, 'file.txt')), true);
      assert.equal(isReadOnlyPath(path.join(writable, 'file.txt')), false);
      assert.throws(
        () => assertWritable(path.join(locked, 'file.txt')),
        /read-only/
      );
      assert.throws(() => assertWritable(locked), /read-only/);
      assert.throws(
        () => assertWritable(path.join(locked, 'nested', 'deep.txt')),
        /read-only/
      );
      assert.doesNotThrow(() => assertWritable(path.join(writable, 'file.txt')));
    } finally {
      setAllowedRoots([]);
      setReadOnlyRoots([]);
      await fsp.rm(locked, { recursive: true, force: true });
      await fsp.rm(writable, { recursive: true, force: true });
    }
  });

  it('refuses a path under a read-only location even when another root contains it', async () => {
    const outer = await tmpDir();
    const inner = path.join(outer, 'locked');
    try {
      await fsp.mkdir(inner);
      // A read-only location nested inside a writable one: the containment
      // check must refuse, not pick the first matching root.
      setAllowedRoots([outer, inner]);
      setReadOnlyRoots([inner]);
      assert.throws(
        () => assertWritable(path.join(inner, 'file.txt')),
        /read-only/
      );
      assert.doesNotThrow(() => assertWritable(path.join(outer, 'other.txt')));
    } finally {
      setAllowedRoots([]);
      setReadOnlyRoots([]);
      await fsp.rm(outer, { recursive: true, force: true });
    }
  });

  it('allows writes once the location is no longer read-only', async () => {
    const dir = await tmpDir();
    try {
      setAllowedRoots([dir]);
      setReadOnlyRoots([dir]);
      assert.throws(() => assertWritable(path.join(dir, 'a.txt')), /read-only/);
      setReadOnlyRoots([]);
      assert.doesNotThrow(() => assertWritable(path.join(dir, 'a.txt')));
    } finally {
      setAllowedRoots([]);
      setReadOnlyRoots([]);
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
