import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { DirEntry } from '../../shared/ipc-types';
import { buildTreeRows } from './directory-tree-rows';

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
});
