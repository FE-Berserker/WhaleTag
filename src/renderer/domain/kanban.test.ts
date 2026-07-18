import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketEntries,
  tagsAfterMove,
  UNTAGGED_COLUMN,
} from './kanban';
import { QUADRANT_VALUES } from '../../shared/smart-tags';
import type { DirEntry } from '../../shared/ipc-types';

/** Minimal DirEntry factory for the kanban bucketing tests. */
function entry(name: string): DirEntry {
  const dot = name.lastIndexOf('.');
  return {
    name,
    path: `/root/${name}`,
    isFile: true,
    isDirectory: false,
    size: 0,
    modified: '1970-01-01T00:00:00.000Z',
    extension: dot >= 0 ? name.slice(dot + 1).toLowerCase() : '',
  };
}

/** Build the tagsByName map the view passes to bucketEntries. */
function tagMap(pairs: Record<string, string[]>): Map<string, string[]> {
  // H.24 R1: bucketEntries looks tags up by full path; entry() defaults to
  // `/root/${name}`, so prefix each name with `/root/`.
  return new Map(
    Object.entries(pairs).map(([k, v]) => [`/root/${k}`, v])
  );
}

describe('kanban bucketEntries', () => {
  const groupTags = ['todo', 'doing', 'done'];

  it('buckets each file under the first group tag it carries', () => {
    const entries = [entry('a.txt'), entry('b.txt'), entry('c.txt')];
    const tags = tagMap({
      'a.txt': ['doing'],
      'b.txt': ['done', 'work'],
      'c.txt': ['todo'],
    });
    const buckets = bucketEntries(entries, groupTags, tags);
    assert.deepEqual(buckets.get('todo')!.map((e) => e.name), ['c.txt']);
    assert.deepEqual(buckets.get('doing')!.map((e) => e.name), ['a.txt']);
    assert.deepEqual(buckets.get('done')!.map((e) => e.name), ['b.txt']);
    assert.deepEqual(buckets.get(UNTAGGED_COLUMN)!.map((e) => e.name), []);
  });

  it('puts files with no group tag into the untagged column', () => {
    const entries = [entry('x.txt'), entry('y.txt')];
    const tags = tagMap({ 'x.txt': ['work'], 'y.txt': [] });
    const buckets = bucketEntries(entries, groupTags, tags);
    assert.deepEqual(
      buckets.get(UNTAGGED_COLUMN)!.map((e) => e.name),
      ['x.txt', 'y.txt']
    );
  });

  it('uses group order for the first-match (no duplicate cards across columns)', () => {
    // File has both 'doing' and 'todo'; 'todo' comes first in groupTags.
    const entries = [entry('m.txt')];
    const tags = tagMap({ 'm.txt': ['doing', 'todo'] });
    const buckets = bucketEntries(entries, groupTags, tags);
    assert.deepEqual(buckets.get('todo')!.map((e) => e.name), ['m.txt']);
    assert.deepEqual(buckets.get('doing')!.map((e) => e.name), []);
    // Appears exactly once across all columns.
    const total = [...buckets.values()].reduce((n, list) => n + list.length, 0);
    assert.equal(total, 1);
  });

  it('always includes every column key, even when empty (sparse)', () => {
    const buckets = bucketEntries([], groupTags, tagMap({}));
    assert.deepEqual(
      [...buckets.keys()],
      ['todo', 'doing', 'done', UNTAGGED_COLUMN]
    );
    assert.ok([...buckets.values()].every((list) => list.length === 0));
  });
});

describe('kanban tagsAfterMove (mutually-exclusive within group)', () => {
  const groupTags = ['todo', 'doing', 'done'];

  it('replaces the current group tag with the target', () => {
    assert.deepEqual(tagsAfterMove(['todo'], groupTags, 'doing'), ['doing']);
  });

  it('keeps non-group tags untouched', () => {
    assert.deepEqual(
      tagsAfterMove(['work', 'todo', '2026'], groupTags, 'done'),
      ['work', '2026', 'done']
    );
  });

  it('clears the whole group when moved to the untagged column (null target)', () => {
    assert.deepEqual(
      tagsAfterMove(['work', 'doing'], groupTags, null),
      ['work']
    );
  });

  it('drops multiple stale group tags, leaving only the target', () => {
    assert.deepEqual(
      tagsAfterMove(['todo', 'doing'], groupTags, 'done'),
      ['done']
    );
  });

  it('does not duplicate a target tag the file already has', () => {
    assert.deepEqual(tagsAfterMove(['done'], groupTags, 'done'), ['done']);
  });

  it('adds the target to an untagged file', () => {
    assert.deepEqual(tagsAfterMove(['work'], groupTags, 'todo'), ['work', 'todo']);
  });
});

describe('priority matrix (quadrant) reuses kanban helpers', () => {
  it('buckets files into the four quadrant columns + untagged', () => {
    const entries = [
      entry('a.txt'),
      entry('b.txt'),
      entry('c.txt'),
    ];
    const tags = tagMap({
      'a.txt': ['urgent-important'],
      'b.txt': ['noturgent-unimportant', 'work'],
      'c.txt': ['misc'],
    });
    const buckets = bucketEntries(entries, QUADRANT_VALUES, tags);
    assert.deepEqual(buckets.get('urgent-important')!.map((e) => e.name), [
      'a.txt',
    ]);
    assert.deepEqual(
      buckets.get('noturgent-unimportant')!.map((e) => e.name),
      ['b.txt']
    );
    assert.deepEqual(buckets.get(UNTAGGED_COLUMN)!.map((e) => e.name), [
      'c.txt',
    ]);
  });

  it('moving to a quadrant replaces any existing quadrant (mutually exclusive)', () => {
    assert.deepEqual(
      tagsAfterMove(['urgent-important', 'work'], QUADRANT_VALUES, 'noturgent-important'),
      ['work', 'noturgent-important']
    );
  });

  it('moving to the untagged tray clears the quadrant, keeps other tags', () => {
    assert.deepEqual(
      tagsAfterMove(['work', 'urgent-unimportant'], QUADRANT_VALUES, null),
      ['work']
    );
  });
});
