/**
 * Locks down the multi-tab viewer's pure helpers (dedup key + LRU eviction).
 * These underpin the "open N files without closing the previous ones" UX: the
 * dedup key decides when opening the same file focuses vs. creates a tab, and
 * `pickLruEvict` decides which tab to drop silently when MAX_TABS is hit.
 *
 * Tested in isolation (no React/redux/ipc) — the helpers live in their own
 * module for exactly this reason.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_TABS,
  findTabForFile,
  makeTabId,
  isTabDirty,
  pickLruEvict,
  sameFile,
  syncLocationReadOnly,
} from './extension-tabs';

describe('extension-tabs', () => {
  describe('makeTabId', () => {
    it('composes filePath + manifestId with a separator', () => {
      assert.equal(makeTabId('/a/b.md', 'text-editor'), '/a/b.md::text-editor');
    });

    it('is stable for the same inputs (dedup key)', () => {
      assert.equal(
        makeTabId('/a/b.md', 'text-editor'),
        makeTabId('/a/b.md', 'text-editor')
      );
    });

    it('distinguishes the same file opened with different extensions', () => {
      assert.notEqual(
        makeTabId('/a/b.md', 'text-editor'),
        makeTabId('/a/b.md', 'html-viewer')
      );
    });

    it('distinguishes different files in the same extension', () => {
      assert.notEqual(
        makeTabId('/a/b.md', 'text-editor'),
        makeTabId('/a/c.md', 'text-editor')
      );
    });
  });

  describe('isTabDirty', () => {
    it('keys dirty state by tab id, keeping two extensions on one path independent', () => {
      const filePath = '/same.md';
      const textTab = makeTabId(filePath, 'text-editor');
      const drawTab = makeTabId(filePath, 'excalidraw-editor');
      const editState = { [textTab]: { dirty: true } };
      assert.equal(isTabDirty(editState, textTab), true);
      assert.equal(isTabDirty(editState, drawTab), false);
      assert.equal(isTabDirty(editState, filePath), false);
    });
  });

  describe('pickLruEvict', () => {
    // Helper: build a newest-first candidate (index 0 = most recent).
    const mk = (id: string, filePath: string, lastAccessed: number) => ({
      id,
      filePath,
      lastAccessed,
    });

    it('returns the oldest (last) non-dirty tab', () => {
      const tabs = [
        mk('new', '/new', 300), // the tab being added
        mk('a', '/a', 200),
        mk('b', '/b', 100), // LRU
      ];
      assert.equal(pickLruEvict(tabs, 'new', new Set()), 'b');
    });

    it('skips the newly-added tab', () => {
      // Even if `new` were the oldest, it must never be evicted.
      const tabs = [mk('a', '/a', 100), mk('new', '/new', 50)];
      assert.equal(pickLruEvict(tabs, 'new', new Set()), 'a');
    });

    it('skips dirty tabs and evicts the oldest clean one', () => {
      const tabs = [
        mk('new', '/new', 400),
        mk('a', '/a', 300),
        mk('b', '/b', 200), // dirty — skip
        mk('c', '/c', 100), // oldest clean → evict
      ];
      assert.equal(pickLruEvict(tabs, 'new', new Set(['b'])), 'c');
    });

    it('protects only the dirty tab when two extensions share one file path', () => {
      const filePath = '/same.md';
      const textId = makeTabId(filePath, 'text-editor');
      const drawId = makeTabId(filePath, 'excalidraw-editor');
      const tabs = [mk(textId, filePath, 20), mk(drawId, filePath, 10)];
      assert.equal(pickLruEvict(tabs, 'new', new Set([drawId])), textId);
    });

    it('returns null when every candidate is dirty', () => {
      const tabs = [
        mk('new', '/new', 300),
        mk('a', '/a', 200),
        mk('b', '/b', 100),
      ];
      assert.equal(pickLruEvict(tabs, 'new', new Set(['a', 'b'])), null);
    });

    it('returns null when there is nothing but the new tab', () => {
      assert.equal(
        pickLruEvict([mk('new', '/new', 1)], 'new', new Set()),
        null
      );
    });

    it('does not mutate the input list', () => {
      const tabs = [
        mk('new', '/new', 300),
        mk('a', '/a', 200),
        mk('b', '/b', 100),
      ];
      const before = tabs.map((t) => ({ ...t }));
      pickLruEvict(tabs, 'new', new Set());
      assert.deepEqual(tabs, before);
    });
  });

  describe('sameFile', () => {
    it('matches watcher paths across separators and casing', () => {
      assert.equal(sameFile('C:\\Root\\Photo.md', 'c:/root/photo.MD'), true);
      assert.equal(sameFile('/root/photo.md', '/root/photo.md/'), true);
    });

    it('does not confuse a sibling or descendant with the file', () => {
      assert.equal(sameFile('/root/photo.md', '/root/photo.md.backup'), false);
      assert.equal(sameFile('/root/photo.md', '/root/photo.md/copy'), false);
    });
  });

  describe('findTabForFile', () => {
    const tabs = [{ filePath: '/root/Photo.md' }, { filePath: '/root/photo.md' }];

    it('prefers exact identity when case-distinct tabs coexist', () => {
      assert.equal(findTabForFile(tabs, '/root/photo.md'), tabs[1]);
      assert.equal(findTabForFile(tabs, '/root/Photo.md'), tabs[0]);
    });

    it('uses normalized watcher identity only when it is unambiguous', () => {
      assert.equal(findTabForFile(tabs, '/ROOT/PHOTO.MD'), undefined);
      assert.equal(findTabForFile([tabs[0]], '/ROOT/PHOTO.MD'), tabs[0]);
    });

    it('does not reload a sibling or descendant path', () => {
      assert.equal(findTabForFile(tabs, '/root/photo.md.backup'), undefined);
      assert.equal(findTabForFile(tabs, '/root/photo.md/copy'), undefined);
    });
  });

  describe('syncLocationReadOnly', () => {
    const tabs = [
      { id: 'a', locationId: 'one', readOnly: false },
      { id: 'b', locationId: 'two', readOnly: false },
      { id: 'c', locationId: 'one', readOnly: true },
    ];

    it('updates only existing tabs from the affected location', () => {
      const next = syncLocationReadOnly(tabs, 'one', true);
      assert.deepEqual(
        next.map((tab) => [tab.id, tab.readOnly]),
        [
          ['a', true],
          ['b', false],
          ['c', true],
        ]
      );
      assert.notEqual(next[0], tabs[0]);
      assert.equal(next[1], tabs[1]);
      assert.equal(next[2], tabs[2]);
      assert.equal(tabs[0].readOnly, false, 'input remains immutable');
    });

    it('can make the matching location writable without touching others', () => {
      const next = syncLocationReadOnly(tabs, 'one', false);
      assert.equal(next[0].readOnly, false);
      assert.equal(next[1].readOnly, false);
      assert.equal(next[2].readOnly, false);
    });

    it('returns the original array when no tab needs changing', () => {
      assert.equal(syncLocationReadOnly(tabs, 'two', false), tabs);
      assert.equal(syncLocationReadOnly(tabs, 'missing', true), tabs);
    });
  });

  describe('MAX_TABS', () => {
    it('is a positive integer cap', () => {
      assert.equal(typeof MAX_TABS, 'number');
      assert.ok(MAX_TABS > 0);
      assert.equal(Math.floor(MAX_TABS), MAX_TABS);
    });
  });
});
