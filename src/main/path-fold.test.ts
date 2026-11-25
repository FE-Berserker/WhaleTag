import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import {
  canonicalPathKey,
  foldPath,
  isCaseInsensitivePlatform,
  isSameOrDescendantPath,
  CASE_INSENSITIVE_FS,
} from './path-fold';

describe('isCaseInsensitivePlatform', () => {
  it('folds case on Windows and macOS only', () => {
    assert.equal(isCaseInsensitivePlatform('win32'), true);
    assert.equal(isCaseInsensitivePlatform('darwin'), true);
  });

  it('keeps exact comparison on case-sensitive platforms and unknown ones', () => {
    assert.equal(isCaseInsensitivePlatform('linux'), false);
    assert.equal(isCaseInsensitivePlatform('freebsd'), false);
    assert.equal(isCaseInsensitivePlatform(undefined), false);
  });
});

describe('foldPath', () => {
  it('lowercases when caseInsensitive is true', () => {
    assert.equal(foldPath('/Foo/Bar/File.TXT', true), '/foo/bar/file.txt');
  });

  it('returns the path unchanged when caseInsensitive is false', () => {
    assert.equal(foldPath('/Foo/Bar/File.TXT', false), '/Foo/Bar/File.TXT');
  });

  it('default follows the platform FS semantics', () => {
    // Windows/macOS fold; Linux/other are exact. Either way it must agree with
    // the exported constant — the security guards rely on this single source.
    const p = '/MiXeD/Path';
    if (CASE_INSENSITIVE_FS) {
      assert.equal(foldPath(p), p.toLowerCase());
    } else {
      assert.equal(foldPath(p), p);
    }
  });
});

describe('isSameOrDescendantPath', () => {
  it('matches case-insensitively on win32/darwin (caseInsensitive=true)', () => {
    assert.equal(isSameOrDescendantPath('C:/Data', 'C:/Data', true), true);
    assert.equal(isSameOrDescendantPath('C:/Data', 'C:/Data/sub/a.jpg', true), true);
    assert.equal(isSameOrDescendantPath('C:/Data', 'c:/data/SUB', true), true);
    assert.equal(
      isSameOrDescendantPath('C:\\Data\\Sub', 'C:/Data/Sub/child', true),
      true
    );
  });

  it('does not match a case-colliding sibling on linux (caseInsensitive=false)', () => {
    assert.equal(isSameOrDescendantPath('/Data', '/Data', false), true);
    assert.equal(isSameOrDescendantPath('/Data', '/Data/notes/a.txt', false), true);
    assert.equal(isSameOrDescendantPath('/Data', '/data/notes/a.txt', false), false);
    assert.equal(isSameOrDescendantPath('/Data', '/Data2/notes', false), false);
  });

  it('is segment-boundary aware (a name prefix is not a descendant)', () => {
    assert.equal(isSameOrDescendantPath('C:/Data', 'C:/database/x', true), false);
    assert.equal(isSameOrDescendantPath('/data', '/database/x', false), false);
  });

  it('normalizes trailing slashes and both separator styles', () => {
    assert.equal(isSameOrDescendantPath('C:/Data/', 'C:/Data//', true), true);
    assert.equal(isSameOrDescendantPath('/Data/', '/Data/sub/', false), true);
    assert.equal(isSameOrDescendantPath('C:\\Data\\', 'C:/Data/sub', true), true);
  });

  it('treats the filesystem root as an ancestor of every absolute path', () => {
    assert.equal(isSameOrDescendantPath('/', '/Data/notes', false), true);
    assert.equal(isSameOrDescendantPath('/', '/', false), true);
    assert.equal(isSameOrDescendantPath('/', 'Data', false), false);
  });

  it('defaults to the platform case policy', () => {
    if (CASE_INSENSITIVE_FS) {
      assert.equal(isSameOrDescendantPath('C:/Data', 'c:/data/sub'), true);
    } else {
      assert.equal(isSameOrDescendantPath('/Data', '/data/sub'), false);
      assert.equal(isSameOrDescendantPath('/Data', '/Data/sub'), true);
    }
  });
});

describe('canonicalPathKey', () => {
  it('gives every spelling of one directory the same key', async (t) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-canonical-'));
    try {
      const dir = path.join(root, 'Mixed', 'Dir');
      await fsp.mkdir(dir, { recursive: true });
      const alias = path.join(root, 'alias');
      try {
        await fsp.symlink(dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        t.skip(`directory links cannot be created here: ${(error as Error).message}`);
        return;
      }
      const key = canonicalPathKey(dir);
      assert.equal(key, canonicalPathKey(path.join(dir, 'child', '..')), '`..` alias');
      assert.equal(
        key,
        canonicalPathKey(dir.split(path.sep).join('/')),
        'separator alias'
      );
      assert.equal(key, canonicalPathKey(alias), 'symlink / junction alias');
      assert.notEqual(key, canonicalPathKey(root), 'different directories keep their own keys');
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('keys a not-yet-existing target by its real parent', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-canonical-'));
    try {
      const dir = path.join(root, 'real');
      await fsp.mkdir(dir);
      const alias = path.join(root, 'alias');
      await fsp.symlink(dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const direct = canonicalPathKey(path.join(dir, 'wsd.json'));
      assert.equal(
        direct,
        canonicalPathKey(path.join(alias, 'wsd.json')),
        'the target does not exist yet, so the parent decides'
      );
      await fsp.writeFile(path.join(dir, 'wsd.json'), '{}');
      assert.equal(direct, canonicalPathKey(path.join(alias, 'wsd.json')), 'unchanged once it exists');
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('never throws and stays absolute for anything it cannot resolve', () => {
    const nowhere = path.join(os.tmpdir(), 'whale-nowhere', 'x', 'y.json');
    assert.equal(canonicalPathKey(nowhere), foldPath(path.resolve(nowhere)));
    assert.ok(path.isAbsolute(canonicalPathKey('relative/entry.txt')));
  });
});
