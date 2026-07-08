import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPendingQuery,
  getDefaultPendingStageIds,
  groupPending,
} from './task-reminder';
import type { IndexEntry } from './ipc-types';
import type { WorkflowStage } from './workflow';

/** Minimal IndexEntry factory for the grouping tests. */
function entry(name: string, tags: string[]): IndexEntry {
  return {
    name,
    path: `sub/${name}`,
    isDir: false,
    size: 0,
    mtime: 0,
    ext: name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '',
    tags,
  };
}

function stage(id: string, value: string, color = '#000000'): WorkflowStage {
  return { id, value, color };
}

describe('getDefaultPendingStageIds', () => {
  it('prefers stages matching the historical default values', () => {
    const stages = [
      stage('s1', 'not-started'),
      stage('s2', 'in-progress'),
      stage('s3', 'completed'),
    ];
    assert.deepEqual(getDefaultPendingStageIds(stages), ['s1', 's2']);
  });

  it('falls back to the first two stages when defaults are absent', () => {
    const stages = [
      stage('s1', 'todo'),
      stage('s2', 'doing'),
      stage('s3', 'done'),
    ];
    assert.deepEqual(getDefaultPendingStageIds(stages), ['s1', 's2']);
  });

  it('uses all stages when fewer than two exist', () => {
    const stages = [stage('s1', 'todo')];
    assert.deepEqual(getDefaultPendingStageIds(stages), ['s1']);
  });

  it('returns an empty array for an empty workflow', () => {
    assert.deepEqual(getDefaultPendingStageIds([]), []);
  });
});

describe('buildPendingQuery', () => {
  it('matches files carrying ANY pending workflow tag', () => {
    const tags = ['not-started', 'in-progress'];
    const q = buildPendingQuery(tags);
    assert.deepEqual(q.tags, tags);
    assert.equal(q.tagMatch, 'any');
    assert.equal(q.type, 'files');
    assert.equal(q.text, ''); // no other constraint
  });
});

describe('groupPending', () => {
  it('groups by the first pending tag each entry carries', () => {
    const tags = ['not-started', 'in-progress'];
    const entries = [
      entry('a.txt', ['in-progress']),
      entry('b.txt', ['not-started', 'work']),
      entry('c.txt', ['in-progress']),
    ];
    const groups = groupPending(entries, tags);
    assert.deepEqual(
      groups.map((g) => g.tag),
      ['not-started', 'in-progress']
    ); // follows tags order, empty groups omitted
    assert.deepEqual(
      groups.find((g) => g.tag === 'in-progress')!.entries.map((e) => e.name),
      ['a.txt', 'c.txt']
    );
    assert.deepEqual(
      groups.find((g) => g.tag === 'not-started')!.entries.map((e) => e.name),
      ['b.txt']
    );
  });

  it('drops entries with no pending tag and omits empty groups', () => {
    const groups = groupPending(
      [entry('x.txt', ['completed']), entry('y.txt', ['in-progress'])],
      ['not-started', 'in-progress']
    );
    assert.equal(groups.length, 1);
    assert.equal(groups[0].tag, 'in-progress');
    assert.deepEqual(groups[0].entries.map((e) => e.name), ['y.txt']);
  });

  it('returns [] when nothing is pending', () => {
    assert.deepEqual(
      groupPending([entry('z.txt', ['done', 'misc'])], ['not-started']),
      []
    );
  });

  it('assigns a multi-pending file to the first tag in order only', () => {
    // Has both pending tags; should appear once, under 'not-started' (order 0).
    const groups = groupPending(
      [entry('m.txt', ['in-progress', 'not-started'])],
      ['not-started', 'in-progress']
    );
    assert.equal(groups.length, 1);
    assert.equal(groups[0].tag, 'not-started');
    assert.equal(groups[0].entries.length, 1);
  });

  it('groups by custom tags when provided', () => {
    const entries = [
      entry('a.txt', ['review']),
      entry('b.txt', ['draft']),
    ];
    const groups = groupPending(entries, ['draft', 'review']);
    assert.deepEqual(groups.map((g) => g.tag), ['draft', 'review']);
    assert.deepEqual(
      groups.find((g) => g.tag === 'draft')!.entries.map((e) => e.name),
      ['b.txt']
    );
    assert.deepEqual(
      groups.find((g) => g.tag === 'review')!.entries.map((e) => e.name),
      ['a.txt']
    );
  });
});
