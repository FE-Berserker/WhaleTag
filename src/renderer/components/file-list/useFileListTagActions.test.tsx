/**
 * Co-located tests for the sidecar-writing handlers `FileList` delegates to
 * (P2 FileList split). The hook owns no state: every handler reads the
 * current tags / description from the context maps, computes the next tag
 * set and persists it through `save` / `saveMany`. These tests pin that
 * contract — the read-only gate, the geo and date-tag rewrite rules, the
 * kanban column move, and how a failed write surfaces. Uses the
 * `useStableBag.test.tsx` Probe pattern (no `renderHook` needed).
 */
import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, cleanup, render } from '@testing-library/react';

import type { DirEntry } from '../../../shared/ipc-types';
import type { SidecarMeta } from '../../../shared/whale-meta';
import {
  useFileListTagActions,
  type FileListTagActions,
  type UseFileListTagActionsOptions,
} from './useFileListTagActions';

let cleanupDom: (() => void) | undefined;

before(() => {
  cleanupDom = globalJsdom();
});
afterEach(() => cleanup());
after(() => cleanupDom?.());

function entry(name: string): DirEntry {
  return {
    name,
    path: `/root/${name}`,
    isFile: true,
    isDirectory: false,
    size: 0,
    modified: '1970-01-01T00:00:00.000Z',
    extension: 'txt',
  };
}

const A = entry('a.txt');
const B = entry('b.txt');

/** Kanban column tags of one mutually-exclusive group. */
const GROUP = ['todo', 'doing', 'done'];
/** Local noon, so the resolved day key is the same in every time zone. */
const NOW = new Date(2026, 6, 4, 12, 0, 0);

type Saved = { entry: DirEntry; meta: SidecarMeta };

interface Harness {
  options: UseFileListTagActionsOptions;
  saved: Saved[];
  savedMany: Saved[][];
  notices: string[];
}

function harness(
  overrides: Partial<UseFileListTagActionsOptions> = {}
): Harness {
  const saved: Saved[] = [];
  const savedMany: Saved[][] = [];
  const notices: string[] = [];
  const options: UseFileListTagActionsOptions = {
    currentLocation: { isReadOnly: false },
    tagsByName: new Map(),
    descByName: new Map(),
    // Deterministic stand-in for the app's normalizer: de-duplicate + sort.
    normalize: (tags) => [...new Set(tags)].sort(),
    save: async (entry, meta) => {
      saved.push({ entry, meta });
    },
    saveMany: async (updates) => {
      savedMany.push(updates);
    },
    showNotice: (msg) => {
      notices.push(msg);
    },
    now: NOW,
    ...overrides,
  };
  return { options, saved, savedMany, notices };
}

function tagsOf(name: string, tags: string[]): [string, string[]] {
  return [`/root/${name}`, tags];
}

function mount(h: Harness): () => FileListTagActions {
  function Probe({
    options,
    seen,
  }: {
    options: UseFileListTagActionsOptions;
    seen: { current: FileListTagActions | null };
  }) {
    seen.current = useFileListTagActions(options);
    return null;
  }
  const seen = { current: null as FileListTagActions | null };
  render(<Probe options={h.options} seen={seen} />);
  return () => {
    if (!seen.current) throw new Error('hook not rendered');
    return seen.current;
  };
}

/** Lets the handlers' fire-and-forget promises run to completion. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function sortedTags(saved: Saved): string[] {
  return [...(saved.meta.tags ?? [])].sort();
}

describe('useFileListTagActions', () => {
  describe('read-only locations', () => {
    it('turns every handler into a no-op', () => {
      const h = harness({
        currentLocation: { isReadOnly: true },
        tagsByName: new Map([
          tagsOf('a.txt', ['doing', 'x', '20260701']),
          tagsOf('b.txt', ['20260701']),
        ]),
      });
      const actions = mount(h);
      actions().handleMoveToColumn([A, B], 'done', GROUP);
      actions().handleGpsFound(A, 31.2, 121.5);
      actions().handleSetGeo(A, 31.2, 121.5);
      actions().handleClearGeo(A);
      actions().handleAddTag(A, 'urgent');
      actions().handleRemoveTag(A, 'x');
      actions().handleSetEntryDateTag(A, '20260704');
      actions().handleRemoveEntryDateTag(A);
      actions().handleSetEntryDateTags([A, B], '20260704');
      actions().handleRemoveEntryDateTags([A, B]);
      assert.deepEqual(h.saved, []);
      assert.deepEqual(h.savedMany, []);
      assert.deepEqual(h.notices, []);
    });
  });

  describe('handleGpsFound', () => {
    it('stores the EXIF coordinate as the only geo tag and keeps the description', () => {
      const h = harness({
        tagsByName: new Map([
          tagsOf('a.txt', ['geo:1.000000,2.000000', 'draft']),
        ]),
        descByName: new Map([['/root/a.txt', 'notes']]),
      });

      mount(h)().handleGpsFound(A, 31.2, 121.5);

      assert.deepEqual(h.saved, [
        {
          entry: A,
          meta: { tags: ['draft', 'geo:31.200000,121.500000'], description: 'notes' },
        },
      ]);
    });

    it('skips the write when the coordinate is already tagged', () => {
      const h = harness({
        tagsByName: new Map([tagsOf('a.txt', ['geo:31.200000,121.500000'])]),
      });

      mount(h)().handleGpsFound(A, 31.2, 121.5);

      assert.deepEqual(h.saved, []);
    });

    it('surfaces a failed save as a notice', async () => {
      const h = harness({
        save: async () => {
          throw new Error('disk full');
        },
      });

      mount(h)().handleGpsFound(A, 31.2, 121.5);
      await settle();

      assert.deepEqual(h.notices, ['disk full']);
    });
  });

  describe('handleSetGeo / handleClearGeo', () => {
    it('replaces a stale coordinate', () => {
      const h = harness({
        tagsByName: new Map([
          tagsOf('a.txt', ['geo:1.000000,2.000000', 'draft']),
        ]),
      });

      mount(h)().handleSetGeo(A, 5, 6);

      assert.deepEqual(h.saved, [
        { entry: A, meta: { tags: ['draft', 'geo:5.000000,6.000000'] } },
      ]);
    });

    it('clears only the geo tags', () => {
      const h = harness({
        tagsByName: new Map([
          tagsOf('a.txt', ['geo:1.000000,2.000000', 'draft']),
        ]),
      });

      mount(h)().handleClearGeo(A);

      assert.deepEqual(h.saved, [{ entry: A, meta: { tags: ['draft'] } }]);
    });
  });

  describe('handleAddTag', () => {
    it('resolves template input to its stored form', () => {
      const h = harness({
        tagsByName: new Map([tagsOf('a.txt', ['draft'])]),
      });
      const actions = mount(h);

      actions().handleAddTag(A, 'today');
      actions().handleAddTag(A, 'month-202606');

      assert.deepEqual(h.saved.map((s) => s.meta.tags), [
        ['20260704', 'draft'],
        ['202606', 'draft'],
      ]);
    });

    it('ignores a tag the entry already carries', () => {
      const h = harness({
        tagsByName: new Map([tagsOf('a.txt', ['draft'])]),
      });

      mount(h)().handleAddTag(A, 'draft');

      assert.deepEqual(h.saved, []);
    });
  });

  describe('handleRemoveTag', () => {
    it('removes the tag and keeps the rest', () => {
      const h = harness({
        tagsByName: new Map([tagsOf('a.txt', ['draft', 'urgent'])]),
      });

      mount(h)().handleRemoveTag(A, 'urgent');

      assert.deepEqual(h.saved, [{ entry: A, meta: { tags: ['draft'] } }]);
    });

    it('writes nothing when the tag is absent', () => {
      const h = harness({
        tagsByName: new Map([tagsOf('a.txt', ['draft'])]),
      });

      mount(h)().handleRemoveTag(A, 'urgent');

      assert.deepEqual(h.saved, []);
    });
  });

  describe('handleSetEntryDateTag / handleRemoveEntryDateTag', () => {
    it('swaps the prior date tag and keeps every other tag', () => {
      const h = harness({
        tagsByName: new Map([tagsOf('a.txt', ['draft', '20260701'])]),
        descByName: new Map([['/root/a.txt', 'notes']]),
      });

      mount(h)().handleSetEntryDateTag(A, '20260704');

      assert.equal(h.saved.length, 1);
      assert.deepEqual(sortedTags(h.saved[0]), ['20260704', 'draft']);
      assert.equal(h.saved[0].meta.description, 'notes');
    });

    it('strips every date tag', () => {
      const h = harness({
        tagsByName: new Map([tagsOf('a.txt', ['20260701', 'draft'])]),
      });

      mount(h)().handleRemoveEntryDateTag(A);

      assert.deepEqual(h.saved, [{ entry: A, meta: { tags: ['draft'] } }]);
    });

    it('writes nothing when there is no date tag', () => {
      const h = harness({
        tagsByName: new Map([tagsOf('a.txt', ['draft'])]),
      });

      mount(h)().handleRemoveEntryDateTag(A);

      assert.deepEqual(h.saved, []);
    });
  });

  describe('handleMoveToColumn', () => {
    it('moves only the cards whose column tag changes', () => {
      const h = harness({
        tagsByName: new Map([
          tagsOf('a.txt', ['doing', 'x']),
          tagsOf('b.txt', ['done']),
        ]),
        descByName: new Map([['/root/a.txt', 'notes']]),
      });

      mount(h)().handleMoveToColumn([A, B], 'done', GROUP);

      assert.equal(h.savedMany.length, 1);
      assert.deepEqual(h.savedMany[0], [
        { entry: A, meta: { tags: ['done', 'x'], description: 'notes' } },
      ]);
    });

    it('clears the group when the target is the untagged column', () => {
      const h = harness({
        tagsByName: new Map([tagsOf('a.txt', ['doing', 'x'])]),
      });

      mount(h)().handleMoveToColumn([A], null, GROUP);

      assert.deepEqual(h.savedMany, [[{ entry: A, meta: { tags: ['x'] } }]]);
    });
  });

  describe('handleSetEntryDateTags / handleRemoveEntryDateTags', () => {
    it('writes a multi-entry drop with one batch', () => {
      const h = harness({
        tagsByName: new Map([
          tagsOf('a.txt', ['draft', '20260701']),
          tagsOf('b.txt', []),
        ]),
      });

      mount(h)().handleSetEntryDateTags([A, B], '20260704');

      assert.deepEqual(h.saved, []);
      assert.equal(h.savedMany.length, 1);
      assert.deepEqual(
        h.savedMany[0].map((s) => [s.entry.name, sortedTags(s)]),
        [
          ['a.txt', ['20260704', 'draft']],
          ['b.txt', ['20260704']],
        ]
      );
    });

    it('keeps the single-entry write for one target', () => {
      const h = harness({
        tagsByName: new Map([tagsOf('a.txt', ['draft'])]),
      });

      mount(h)().handleSetEntryDateTags([A], '20260704');

      assert.equal(h.saved.length, 1);
      assert.deepEqual(sortedTags(h.saved[0]), ['20260704', 'draft']);
      assert.deepEqual(h.savedMany, []);
    });

    it('skips entries without a date tag and writes nothing for an all-clean drop', () => {
      const h = harness({
        tagsByName: new Map([
          tagsOf('a.txt', ['draft', '20260701']),
          tagsOf('b.txt', ['draft']),
        ]),
      });
      const actions = mount(h);

      actions().handleRemoveEntryDateTags([A, B]);

      assert.deepEqual(h.savedMany, [
        [{ entry: A, meta: { tags: ['draft'] } }],
      ]);
    });

    it('writes nothing for an all-clean drop', () => {
      const h = harness({
        tagsByName: new Map([tagsOf('a.txt', ['draft']), tagsOf('b.txt', [])]),
      });

      mount(h)().handleRemoveEntryDateTags([A, B]);

      assert.deepEqual(h.saved, []);
      assert.deepEqual(h.savedMany, []);
    });

    it('surfaces a failed batch as a notice', async () => {
      const h = harness({
        tagsByName: new Map([tagsOf('a.txt', ['draft'])]),
        saveMany: async () => {
          throw new Error('disk full');
        },
      });

      mount(h)().handleSetEntryDateTags([A, B], '20260704');
      await settle();

      assert.deepEqual(h.notices, ['disk full']);
    });
  });
});
