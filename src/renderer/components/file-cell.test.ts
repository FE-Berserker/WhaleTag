import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { DirEntry } from '../../shared/ipc-types';
import {
  buildFileDragItem,
  lookupEntry,
  lookupEntryIndex,
  removeDateTagsForDroppedEntries,
  setDateTagForDroppedEntries,
} from './file-cell';

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

describe('setDateTagForDroppedEntries (P1-2 batch date drop)', () => {
  it('calls the batch callback exactly ONCE with every dropped entry', () => {
    const a = entry('/album/a.jpg', 'a.jpg');
    const b = entry('/album/b.jpg', 'b.jpg');
    const batchCalls: Array<{ entries: DirEntry[]; dateKey: string }> = [];
    let legacyCalls = 0;
    setDateTagForDroppedEntries(
      {
        onSetEntryDateTags: (entries, dateKey) =>
          batchCalls.push({ entries, dateKey }),
        onSetEntryDateTag: () => {
          legacyCalls += 1;
        },
      },
      [a, b],
      'today-20260628'
    );
    assert.equal(batchCalls.length, 1, 'drop must produce ONE batch call');
    assert.equal(legacyCalls, 0, 'batch path must not also fire per-entry saves');
    assert.deepEqual(batchCalls[0].entries, [a, b]);
    assert.equal(batchCalls[0].dateKey, 'today-20260628');
  });

  it('falls back to one call per entry for legacy hosts', () => {
    const a = entry('/album/a.jpg', 'a.jpg');
    const b = entry('/album/b.jpg', 'b.jpg');
    const legacy: Array<{ path: string; dateKey: string }> = [];
    setDateTagForDroppedEntries(
      {
        onSetEntryDateTag: (e, dateKey) => legacy.push({ path: e.path, dateKey }),
      },
      [a, b],
      '20260628'
    );
    assert.deepEqual(legacy, [
      { path: a.path, dateKey: '20260628' },
      { path: b.path, dateKey: '20260628' },
    ]);
  });

  it('does nothing for an empty drop', () => {
    let calls = 0;
    setDateTagForDroppedEntries(
      {
        onSetEntryDateTags: () => {
          calls += 1;
        },
        onSetEntryDateTag: () => {
          calls += 1;
        },
      },
      [],
      '20260628'
    );
    assert.equal(calls, 0);
  });
});

describe('removeDateTagsForDroppedEntries (P1-2 batch date clear)', () => {
  it('calls the batch callback exactly ONCE with every dropped entry', () => {
    const a = entry('/album/a.jpg', 'a.jpg');
    const b = entry('/album/b.jpg', 'b.jpg');
    const batchCalls: DirEntry[][] = [];
    let legacyCalls = 0;
    removeDateTagsForDroppedEntries(
      {
        onRemoveEntryDateTags: (entries) => batchCalls.push(entries),
        onRemoveEntryDateTag: () => {
          legacyCalls += 1;
        },
      },
      [a, b]
    );
    assert.equal(batchCalls.length, 1, 'drop must produce ONE batch call');
    assert.equal(legacyCalls, 0);
    assert.deepEqual(batchCalls[0], [a, b]);
  });

  it('falls back to one call per entry for legacy hosts', () => {
    const a = entry('/album/a.jpg', 'a.jpg');
    const b = entry('/album/b.jpg', 'b.jpg');
    const legacy: string[] = [];
    removeDateTagsForDroppedEntries(
      { onRemoveEntryDateTag: (e) => legacy.push(e.path) },
      [a, b]
    );
    assert.deepEqual(legacy, [a.path, b.path]);
  });

  it('does nothing for an empty drop', () => {
    let calls = 0;
    removeDateTagsForDroppedEntries(
      {
        onRemoveEntryDateTags: () => {
          calls += 1;
        },
        onRemoveEntryDateTag: () => {
          calls += 1;
        },
      },
      []
    );
    assert.equal(calls, 0);
  });
});

/**
 * Hosts (FileList) hand every row/grid cell a `Map`-backed `resolveEntry` and
 * `entryIndex`. These helpers are the single call site for both, so the O(1)
 * path is asserted here instead of in every consumer. The `entries` arrays are
 * deliberately empty: a fallback to `find`/`findIndex` would return
 * `undefined` / `-1` and fail.
 */
describe('lookupEntry', () => {
  it('resolves through the host map without scanning `entries`', () => {
    const target = entry('/album/a.jpg', 'a.jpg');
    const data = {
      entries: [] as DirEntry[],
      resolveEntry: (path: string) => (path === target.path ? target : undefined),
    };
    assert.equal(lookupEntry(data, target.path), target);
    assert.equal(lookupEntry(data, '/album/missing.jpg'), undefined);
  });

  it('falls back to a linear scan for hosts that pass no resolveEntry', () => {
    const target = entry('/album/b.jpg', 'b.jpg');
    const data = { entries: [entry('/album/a.jpg', 'a.jpg'), target] };
    assert.equal(lookupEntry(data, target.path), target);
    assert.equal(lookupEntry(data, '/album/missing.jpg'), undefined);
  });
});

describe('lookupEntryIndex', () => {
  it('returns the host-provided index without scanning `entries`', () => {
    const data = {
      entries: [] as DirEntry[],
      entryIndex: (path: string) => (path === '/album/x.jpg' ? 7 : -1),
    };
    assert.equal(lookupEntryIndex(data, '/album/x.jpg'), 7);
    // -1 means "not in this view"; it must be returned as-is, not treated as a
    // missing map entry that triggers a re-scan.
    assert.equal(lookupEntryIndex(data, '/album/y.jpg'), -1);
  });

  it('treats index 0 as a real hit', () => {
    const data = { entries: [] as DirEntry[], entryIndex: () => 0 };
    assert.equal(lookupEntryIndex(data, '/album/first.jpg'), 0);
  });

  it('falls back to findIndex for hosts that pass no entryIndex', () => {
    const data = {
      entries: [
        entry('/album/a.jpg', 'a.jpg'),
        entry('/album/b.jpg', 'b.jpg'),
        entry('/album/c.jpg', 'c.jpg'),
      ],
    };
    assert.equal(lookupEntryIndex(data, '/album/b.jpg'), 1);
    assert.equal(lookupEntryIndex(data, '/album/missing.jpg'), -1);
  });
});
