import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_MOUNTED_TABS,
  selectMountedTabIds,
  type MountableTab,
} from './tab-mount-policy';

function tab(id: string, lastAccessed: number): MountableTab {
  return { id, lastAccessed };
}

const none = new Set<string>();

describe('selectMountedTabIds', () => {
  it('mounts nothing when no tab is open', () => {
    assert.deepEqual(selectMountedTabIds([], null, none), new Set());
  });

  it('always mounts the active tab, even at maxMounted = 0', () => {
    const tabs = [tab('a', 1), tab('b', 2)];
    assert.deepEqual(selectMountedTabIds(tabs, 'b', none, 0), new Set(['b']));
  });

  it('defaults to MAX_MOUNTED_TABS slots', () => {
    const tabs = Array.from({ length: 8 }, (_, i) => tab(`t${i}`, i));
    const mounted = selectMountedTabIds(tabs, 't0', none);
    assert.equal(mounted.size, MAX_MOUNTED_TABS);
  });

  it('fills the remaining slots with the most recently used clean tabs', () => {
    const tabs = [tab('active', 10), tab('old', 1), tab('newer', 9), tab('newest', 12)];
    // active is mounted first; the two freshest others fill 4-1 = 3 slots.
    assert.deepEqual(
      selectMountedTabIds(tabs, 'active', none, 3),
      new Set(['active', 'newest', 'newer'])
    );
  });

  it('keeps every dirty tab mounted past the limit', () => {
    const tabs = [
      tab('active', 10),
      tab('dirty-1', 5),
      tab('dirty-2', 4),
      tab('clean-new', 9),
      tab('clean-old', 1),
    ];
    const mounted = selectMountedTabIds(
      tabs,
      'active',
      new Set(['dirty-1', 'dirty-2']),
      2
    );
    assert.deepEqual(
      mounted,
      new Set(['active', 'dirty-1', 'dirty-2'])
    );
  });

  it('stops adding clean tabs once the dirty tabs overflow the limit', () => {
    const tabs = [tab('active', 10), tab('d1', 9), tab('d2', 8), tab('clean', 7)];
    assert.deepEqual(
      selectMountedTabIds(tabs, 'active', new Set(['d1', 'd2']), 3),
      new Set(['active', 'd1', 'd2'])
    );
  });

  it('ignores pinned ids that are not open any more', () => {
    const tabs = [tab('a', 1)];
    assert.deepEqual(
      selectMountedTabIds(tabs, 'a', new Set(['ghost']), 4),
      new Set(['a'])
    );
  });

  it('does not mutate the caller tab list while sorting', () => {
    const tabs = [tab('old', 1), tab('new', 3), tab('mid', 2)];
    const snapshot = tabs.map((entry) => entry.id);
    selectMountedTabIds(tabs, null, none, 2);
    assert.deepEqual(
      tabs.map((entry) => entry.id),
      snapshot
    );
  });

  it('is deterministic for equal lastAccessed values', () => {
    // Tabs are stored newest-first, so a tie resolves to the earliest entry.
    const tabs = [tab('first', 5), tab('second', 5), tab('third', 5)];
    assert.deepEqual(
      selectMountedTabIds(tabs, null, none, 2),
      new Set(['first', 'second'])
    );
  });
});
