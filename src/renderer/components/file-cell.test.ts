import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { DirEntry } from '../../shared/ipc-types';
import { buildFileDragItem } from './file-cell';

function entry(path: string, name: string): DirEntry {
  return {
    path,
    name,
    isDirectory: false,
    isFile: true,
    size: 1,
    modified: '2026-01-01T00:00:00.000Z',
    extension: 'jpg',
  };
}

describe('buildFileDragItem', () => {
  it('reads the current selection when the drag-start factory runs', () => {
    const a = entry('/album/a.jpg', 'a.jpg');
    const b = entry('/album/b.jpg', 'b.jpg');
    const selected = new Set([a.path]);
    const byPath = new Map([
      [a.path, a],
      [b.path, b],
    ]);
    // react-dnd invokes this function only when dragging actually starts.
    const itemAtDragStart = () =>
      buildFileDragItem(a, selected, (path) => byPath.get(path));

    // FileList mutates this Set in place without changing its identity.
    selected.add(b.path);

    assert.deepEqual(itemAtDragStart(), {
      paths: [a.path, b.path],
      names: ['a.jpg', 'b.jpg'],
    });
  });

  it('drags only the target when it is outside the selection', () => {
    const a = entry('/album/a.jpg', 'a.jpg');
    const b = entry('/album/b.jpg', 'b.jpg');
    assert.deepEqual(
      buildFileDragItem(a, new Set([b.path]), () => b),
      { paths: [a.path], names: ['a.jpg'] }
    );
  });

  it('omits selected paths that are no longer resolvable', () => {
    const a = entry('/album/a.jpg', 'a.jpg');
    const stale = entry('/album/stale.jpg', 'stale.jpg');
    assert.deepEqual(
      buildFileDragItem(
        a,
        new Set([a.path, stale.path]),
        (path) => (path === a.path ? a : undefined)
      ),
      { paths: [a.path], names: ['a.jpg'] }
    );
  });
});
