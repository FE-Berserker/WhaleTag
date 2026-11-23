import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { DirEntry } from '../../shared/ipc-types';
import { buildTreeRows, visibleTreeChildren } from './directory-tree-rows';

function dir(path: string): DirEntry {
  return {
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    isDirectory: true,
    isFile: false,
    size: 0,
    extension: '',
    modified: '2026-01-01T00:00:00.000Z',
  } as DirEntry;
}

function file(path: string): DirEntry {
  return {
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    isDirectory: false,
    isFile: true,
    size: 1,
    extension: 'txt',
    modified: '2026-01-01T00:00:00.000Z',
  } as DirEntry;
}

const base = {
  rootName: 'root',
  rootPath: '/root',
  showFiles: true,
};

describe('buildTreeRows', () => {
  it('emits only the root when it is collapsed', () => {
    const rows = buildTreeRows({
      ...base,
      expanded: new Set<string>(),
      childrenByPath: new Map([['/root', [dir('/root/sub')]]]),
      childrenError: new Map(),
    });
    assert.deepEqual(rows, [
      { kind: 'folder', name: 'root', path: '/root', depth: 0 },
    ]);
  });

  it('flattens expanded folders with folders before the files cached under them', () => {
    const rows = buildTreeRows({
      ...base,
      expanded: new Set(['/root', '/root/sub']),
      childrenByPath: new Map([
        ['/root', [dir('/root/sub'), file('/root/a.txt')]],
        ['/root/sub', []],
      ]),
      childrenError: new Map(),
    });
    assert.deepEqual(
      rows.map((r) => [r.kind, r.depth]),
      [
        ['folder', 0],
        ['folder', 1],
        ['file', 1],
      ]
    );
  });

  it('emits an error row under a folder whose children failed and nothing is cached', () => {
    // The shape the old code never produced: a failed load used to be cached
    // as an empty child list, so the folder just looked empty.
    const rows = buildTreeRows({
      ...base,
      expanded: new Set(['/root']),
      childrenByPath: new Map(),
      childrenError: new Map([['/root', 'EACCES: permission denied']]),
    });
    assert.deepEqual(rows, [
      { kind: 'folder', name: 'root', path: '/root', depth: 0 },
      {
        kind: 'error',
        path: '/root',
        message: 'EACCES: permission denied',
        depth: 1,
      },
    ]);
  });

  it('keeps cached children and appends the error row when a reload failed', () => {
    const rows = buildTreeRows({
      ...base,
      expanded: new Set(['/root']),
      childrenByPath: new Map([['/root', [file('/root/a.txt')]]]),
      childrenError: new Map([['/root', 'disk unplugged']]),
    });
    assert.deepEqual(
      rows.map((r) => r.kind),
      ['folder', 'file', 'error']
    );
  });

  it('hides files when showFiles is false but keeps folders, errors and depth', () => {
    const rows = buildTreeRows({
      ...base,
      showFiles: false,
      expanded: new Set(['/root', '/root/sub']),
      childrenByPath: new Map([
        ['/root', [dir('/root/sub'), file('/root/a.txt')]],
        ['/root/sub', [file('/root/sub/b.txt')]],
      ]),
      childrenError: new Map([['/root/sub', 'locked']]),
    });
    assert.deepEqual(
      rows.map((r) => [r.kind, r.depth]),
      [
        ['folder', 0],
        ['folder', 1],
        ['error', 2],
      ]
    );
  });

  it('filters hidden entries at row-build time, not at cache time', () => {
    // P2-3: `childrenByPath` stores the raw listing now, so the SAME cache has to
    // render two different trees depending on the settings toggle. Before the
    // fix the loader pre-filtered, and flipping the toggle re-listed every
    // expanded folder (resetting the tree).
    const childrenByPath = new Map([
      ['/root', [dir('/root/.git'), file('/root/.hidden.txt'), file('/root/a.txt')]],
    ]);
    const rowsFor = (showHiddenFiles: boolean) =>
      buildTreeRows({
        ...base,
        showHiddenFiles,
        expanded: new Set(['/root']),
        childrenByPath,
        childrenError: new Map(),
      }).map((r) => (r.kind === 'file' ? r.entry.path : r.path));

    assert.deepEqual(rowsFor(false), ['/root', '/root/a.txt']);
    assert.deepEqual(rowsFor(true), [
      '/root',
      '/root/.git',
      '/root/.hidden.txt',
      '/root/a.txt',
    ]);
  });
});

describe('visibleTreeChildren', () => {
  const kids = [
    dir('/root/sub'),
    dir('/root/.git'),
    file('/root/a.txt'),
    file('/root/.hidden.txt'),
  ];

  it('drops dot-prefixed names unless hidden files are shown', () => {
    assert.deepEqual(
      visibleTreeChildren(kids, { showFiles: true }).map((k) => k.name),
      ['sub', 'a.txt']
    );
    assert.deepEqual(
      visibleTreeChildren(kids, { showFiles: true, showHiddenFiles: true }).map(
        (k) => k.name
      ),
      ['sub', '.git', 'a.txt', '.hidden.txt']
    );
  });

  it('drops files entirely when showFiles is false, but keeps every folder', () => {
    assert.deepEqual(
      visibleTreeChildren(kids, { showFiles: false }).map((k) => k.name),
      ['sub']
    );
    assert.deepEqual(
      visibleTreeChildren(kids, { showFiles: false, showHiddenFiles: true }).map(
        (k) => k.name
      ),
      ['sub', '.git']
    );
  });

  it('returns a new array so callers cannot alias the cache', () => {
    const visible = visibleTreeChildren(kids, { showFiles: true, showHiddenFiles: true });
    assert.notEqual(visible, kids);
  });

  it('keeps an empty listing empty (no invented rows)', () => {
    assert.deepEqual(visibleTreeChildren([], { showFiles: true }), []);
  });
});
