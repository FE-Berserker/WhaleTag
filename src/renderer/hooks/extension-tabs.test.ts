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

import { MAX_TABS, makeTabId, pickLruEvict } from './extension-tabs';

describe('extension-tabs', () => {
  describe('makeTabId', () => {
    it('composes filePath + manifestId with a separator', () => {
      assert.equal(makeTabId('/a/b.md', 'md-editor'), '/a/b.md::md-editor');
    });

    it('is stable for the same inputs (dedup key)', () => {
      assert.equal(
        makeTabId('/a/b.md', 'md-editor'),
        makeTabId('/a/b.md', 'md-editor')
      );
    });

    it('distinguishes the same file opened with different extensions', () => {
      assert.notEqual(
        makeTabId('/a/b.md', 'md-editor'),
        makeTabId('/a/b.md', 'md-viewer')
      );
    });

    it('distinguishes different files in the same extension', () => {
      assert.notEqual(
        makeTabId('/a/b.md', 'md-editor'),
        makeTabId('/a/c.md', 'md-editor')
      );
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
      assert.equal(pickLruEvict(tabs, 'new', new Set(['/b'])), 'c');
    });

    it('returns null when every candidate is dirty', () => {
      const tabs = [
        mk('new', '/new', 300),
        mk('a', '/a', 200),
        mk('b', '/b', 100),
      ];
      assert.equal(pickLruEvict(tabs, 'new', new Set(['/a', '/b'])), null);
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

  describe('MAX_TABS', () => {
    it('is a positive integer cap', () => {
      assert.equal(typeof MAX_TABS, 'number');
      assert.ok(MAX_TABS > 0);
      assert.equal(Math.floor(MAX_TABS), MAX_TABS);
    });
  });
});
