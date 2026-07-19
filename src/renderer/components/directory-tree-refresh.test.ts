import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { changedParentsToReload } from './directory-tree-refresh';

describe('changedParentsToReload', () => {
  const loaded = new Set(['C:/Data', 'C:/Data/a', 'C:/Data/a/b']);

  it('reloads the parent of a changed file when that parent is loaded', () => {
    assert.deepEqual(
      changedParentsToReload(['C:/Data/a/new.txt'], loaded, false),
      ['C:/Data/a']
    );
  });

  it('skips parents the tree has not loaded (lazy-load on expand)', () => {
    assert.deepEqual(
      changedParentsToReload(['C:/Data/unloaded/x.txt'], loaded, false),
      []
    );
  });

  it('dedupes multiple changes under the same parent', () => {
    assert.deepEqual(
      changedParentsToReload(
        ['C:/Data/a/1.txt', 'C:/Data/a/2.txt', 'C:/Data/a/b/3.txt'],
        loaded,
        false
      ).sort(),
      ['C:/Data/a', 'C:/Data/a/b']
    );
  });

  it('a change directly under the root reloads the root', () => {
    assert.deepEqual(
      changedParentsToReload(['C:/Data/newdir'], loaded, false),
      ['C:/Data']
    );
  });

  it('overflow (watch buffer overrun) reloads every loaded folder', () => {
    assert.deepEqual(
      changedParentsToReload([], loaded, true).sort(),
      ['C:/Data', 'C:/Data/a', 'C:/Data/a/b']
    );
  });

  it('empty input + no overflow → nothing to reload', () => {
    assert.deepEqual(changedParentsToReload([], loaded, false), []);
  });

  it('is separator/case tolerant via parentDir normalization', () => {
    const loadedWin = new Set(['c:\\data\\a']);
    assert.deepEqual(
      changedParentsToReload(['c:\\data\\a\\x.txt'], loadedWin, false),
      ['c:\\data\\a']
    );
  });
});
