import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { DirEntry } from '../../shared/ipc-types';
import type { SidecarMeta } from '../../shared/whale-meta';
import {
  MAX_RECURSIVE_ENTRIES,
  aggregateRecursiveEntries,
} from './recursive-entries';

/** Build a DirEntry fixture without spelling out every field each time. */
function file(path: string, name: string, extra: Partial<DirEntry> = {}): DirEntry {
  return {
    path,
    name,
    isFile: true,
    isDirectory: false,
    size: 0,
    modified: '',
    extension: '',
    ...extra,
  };
}
function dir(path: string, name: string, extra: Partial<DirEntry> = {}): DirEntry {
  return {
    path,
    name,
    isFile: false,
    isDirectory: true,
    size: 0,
    modified: '',
    extension: '',
    ...extra,
  };
}

describe('shared recursive-entries aggregateRecursiveEntries', () => {
  it('keeps both files and directories in entries (regression: Mapique tray)', () => {
    // Mirrors the layout the user observed: a folder contains a file plus a
    // subdirectory. Before the fix, the hook filtered by `isFile` and the
    // subdirectory vanished from the MapiqueView tray at depth > 1.
    const root = '/loc';
    const sub = `${root}/sub`;
    const visible: DirEntry[] = [
      file(`${root}/photo.jpg`, 'photo.jpg'),
      file(`${sub}/note.txt`, 'note.txt'),
      dir(sub, 'sub'),
      dir(root, 'loc'),
    ];

    const { entries } = aggregateRecursiveEntries(visible, new Map());

    assert.deepEqual(
      entries.map((e) => e.path),
      [`${root}/photo.jpg`, `${sub}/note.txt`, sub, root],
      'directories must not be dropped from the recursive scan'
    );
    assert.equal(
      entries.some((e) => e.isDirectory && e.name === 'sub'),
      true,
      'the subdirectory entry must survive the aggregation'
    );
  });

  it('merges file-name tags with sidecar tags for files', () => {
    // `[work]` lives in the filename; `urgent` lives in the sidecar.
    const visible = [file('/loc/draft[task].md', 'draft[task].md')];
    const sidecar: SidecarMeta = { tags: ['urgent'] };
    const sidecarsByEntry = new Map<string, SidecarMeta | undefined>([
      ['/loc/draft[task].md', sidecar],
    ]);

    const { tagsByName } = aggregateRecursiveEntries(visible, sidecarsByEntry);

    const merged = tagsByName.get('/loc/draft[task].md') ?? [];
    assert.deepEqual(merged.sort(), ['task', 'urgent']);
  });

  it('keys projections by full path so same-named files stay independent (H.24 R1)', () => {
    // Two `notes.md` in different subdirs must each keep their own tags.
    const a = file('/a/notes.md', 'notes.md');
    const b = file('/b/notes.md', 'notes.md');
    const sidecarsByEntry = new Map<string, SidecarMeta | undefined>([
      [a.path, { tags: ['alpha'] }],
      [b.path, { tags: ['beta'] }],
    ]);

    const { tagsByName } = aggregateRecursiveEntries([a, b], sidecarsByEntry);

    assert.deepEqual(tagsByName.get('/a/notes.md'), ['alpha']);
    assert.deepEqual(tagsByName.get('/b/notes.md'), ['beta']);
  });

  it('reads GPS from the geo: tag (single source of truth)', () => {
    const fileA = file('/loc/a.jpg', 'a.jpg');
    const fileB = file('/loc/b.jpg', 'b.jpg');
    const fileC = file('/loc/c.jpg', 'c.jpg');

    const sidecarsByEntry = new Map<string, SidecarMeta | undefined>([
      [fileA.path, { tags: ['geo:12.340000,56.780000'] }],
      [fileB.path, { tags: ['geo:1.5,2.5'] }],
      [fileC.path, undefined],
    ]);

    const { geoByName } = aggregateRecursiveEntries(
      [fileA, fileB, fileC],
      sidecarsByEntry
    );

    assert.deepEqual(geoByName.get('/loc/a.jpg'), { lat: 12.34, lng: 56.78 });
    assert.deepEqual(geoByName.get('/loc/b.jpg'), { lat: 1.5, lng: 2.5 });
    assert.equal(geoByName.get('/loc/c.jpg'), null);
  });

  it('drops entries with no tags from tagsByName (no spurious empty maps)', () => {
    const visible = [
      file('/loc/empty.txt', 'empty.txt'),
      file('/loc/tagged.md', 'tagged.md'),
    ];
    const sidecarsByEntry = new Map<string, SidecarMeta | undefined>([
      ['/loc/tagged.md', { tags: ['starred'] }],
    ]);

    const { tagsByName } = aggregateRecursiveEntries(visible, sidecarsByEntry);

    assert.equal(tagsByName.has('/loc/empty.txt'), false);
    assert.deepEqual(tagsByName.get('/loc/tagged.md'), ['starred']);
  });

  it('returns a defensive copy of entries (mutating the result does not affect the input)', () => {
    const original = [file('/loc/a.txt', 'a.txt'), dir('/loc/sub', 'sub')];
    const { entries } = aggregateRecursiveEntries(original, new Map());

    entries.pop();
    assert.equal(original.length, 2, 'source array must remain intact');
  });

  it('exports MAX_RECURSIVE_ENTRIES as a sane finite cap (H.24 R7)', () => {
    assert.equal(
      typeof MAX_RECURSIVE_ENTRIES,
      'number',
      'MAX_RECURSIVE_ENTRIES must be a number'
    );
    assert.ok(
      MAX_RECURSIVE_ENTRIES > 0 && Number.isFinite(MAX_RECURSIVE_ENTRIES),
      `unexpected cap ${MAX_RECURSIVE_ENTRIES}`
    );
  });
});
