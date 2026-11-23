import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { DirEntry } from '../../shared/ipc-types';
import {
  affectedTreePathsAfterBatch,
  composeBatchNotice,
  moveValidationError,
  removeDateTagsFromEntries,
  runBatchWithRefresh,
  saveTagToEntries,
  selectionAfterBatch,
  setDateTagForEntries,
  summarizeBatchErrors,
  tagMetaSaveManyFailure,
} from './useListCommands';
import { refreshAfterIOAction } from './IOActionsContextProvider';

function entry(path: string): DirEntry {
  return {
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    isDirectory: false,
    isFile: true,
    size: 1,
    modified: '2026-01-01T00:00:00.000Z',
    extension: 'jpg',
  };
}

describe('moveValidationError', () => {
  it('reports invalid sources as item errors while valid mixed sources move', async () => {
    const validationMessage =
      'Cannot move a folder into itself or its descendant.';
    const target = {
      ...entry('/folder/child'),
      isDirectory: true,
      isFile: false,
    };
    const self = {
      ...entry('/folder/child'),
      isDirectory: true,
      isFile: false,
    };
    const parent = {
      ...entry('/folder'),
      isDirectory: true,
      isFile: false,
    };
    const valid = entry('/other.jpg');
    const moved: string[] = [];
    const outcome = await runBatchWithRefresh(
      [self, parent, valid],
      async (source) => {
        const validationError = moveValidationError(
          source,
          target.path,
          validationMessage
        );
        if (validationError) throw new Error(validationError);
        moved.push(source.path);
      },
      async () => {},
      (source) => source.name,
      'Refresh'
    );

    assert.deepEqual(moved, [valid.path]);
    assert.deepEqual(outcome.succeeded, [valid]);
    assert.deepEqual(outcome.errors, [
      `child: ${validationMessage}`,
      `folder: ${validationMessage}`,
    ]);
    assert.deepEqual(
      [
        ...selectionAfterBatch(
          new Set([self.path, parent.path, valid.path]),
          outcome.succeeded
        ),
      ],
      [self.path, parent.path]
    );
    assert.equal(moveValidationError(valid, target.path, validationMessage), null);
  });
});

describe('runBatchWithRefresh', () => {
  it('attempts every item and refreshes exactly once after real outcomes', async () => {
    const items = [entry('/a.jpg'), entry('/b.jpg'), entry('/c.jpg')];
    const calls: string[] = [];
    let refreshReceived: readonly DirEntry[] = [];
    const outcome = await runBatchWithRefresh(
      items,
      async (item) => {
        calls.push(item.name);
        if (item.name === 'b.jpg') throw new Error('disk full');
      },
      async (succeeded) => {
        calls.push('refresh');
        refreshReceived = succeeded;
      },
      (item) => item.name,
      'Refresh'
    );

    assert.deepEqual(calls, ['a.jpg', 'b.jpg', 'c.jpg', 'refresh']);
    assert.deepEqual(outcome.succeeded, [items[0], items[2]]);
    assert.deepEqual(refreshReceived, [items[0], items[2]]);
    assert.deepEqual(outcome.errors, ['b.jpg: disk full']);
  });

  it('retains every item and refresh error instead of throwing or hiding them', async () => {
    const items = [entry('/a.jpg'), entry('/b.jpg')];
    const attempted: string[] = [];
    const outcome = await runBatchWithRefresh(
      items,
      async (item) => {
        attempted.push(item.path);
        throw new Error(`cannot move ${item.name}`);
      },
      async () => {
        throw new Error('listing unavailable');
      },
      (item) => item.name,
      'Actualiser'
    );

    assert.deepEqual(attempted, items.map((item) => item.path));
    assert.deepEqual(outcome.succeeded, []);
    assert.deepEqual(outcome.errors, [
      'a.jpg: cannot move a.jpg',
      'b.jpg: cannot move b.jpg',
      'Actualiser: listing unavailable',
    ]);
  });
});

describe('summarizeBatchErrors', () => {
  it('shows only three failures, summarizes the rest, and logs the full array', () => {
    const errors = [
      'a.jpg: denied',
      'b.jpg: denied',
      'c.jpg: denied',
      'd.jpg: denied',
      'Refresh: listing unavailable',
    ];
    const logs: unknown[][] = [];
    const message = summarizeBatchErrors(
      errors,
      (count) => `and ${count} more`,
      (...args) => logs.push(args)
    );

    assert.equal(
      message,
      'a.jpg: denied; b.jpg: denied; c.jpg: denied; and 2 more'
    );
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], '[files] Batch operation errors:');
    assert.equal(logs[0][1], errors);
    assert.deepEqual(logs[0][1], errors);
  });
});

describe('composeBatchNotice', () => {
  const translations = {
    andMore: (count: number) => `and ${count} more`,
    operationFailed: (message: string) => `Operation failed: ${message}`,
    partialFailure: (success: string, failure: string) =>
      `${success} / ${failure}`,
  };

  it('keeps the full-success text and severity without logging', () => {
    const logs: unknown[][] = [];
    const notice = composeBatchNotice(
      2,
      'Moved 2 items',
      [],
      translations,
      'success',
      (...args) => logs.push(args)
    );

    assert.deepEqual(notice, {
      message: 'Moved 2 items',
      severity: 'success',
    });
    assert.equal(logs.length, 0);
  });

  it('uses one partial-failure template, caps visible errors, and logs all', () => {
    const errors = [
      'a.jpg: denied',
      'b.jpg: denied',
      'c.jpg: denied',
      'd.jpg: denied',
      'Refresh: listing unavailable',
    ];
    const logs: unknown[][] = [];
    const notice = composeBatchNotice(
      2,
      'Deleted 2 items',
      errors,
      translations,
      'success',
      (...args) => logs.push(args)
    );

    assert.deepEqual(notice, {
      message:
        'Deleted 2 items / Operation failed: a.jpg: denied; b.jpg: denied; c.jpg: denied; and 2 more',
      severity: 'warning',
    });
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], '[files] Batch operation errors:');
    assert.equal(logs[0][1], errors);
  });

  it('omits success text and uses error severity when every item failed', () => {
    const logs: unknown[][] = [];
    const notice = composeBatchNotice(
      0,
      'Deleted 0 items',
      ['a.jpg: denied'],
      translations,
      'success',
      (...args) => logs.push(args)
    );

    assert.deepEqual(notice, {
      message: 'Operation failed: a.jpg: denied',
      severity: 'error',
    });
    assert.equal(logs.length, 1);
  });
});

describe('batch tree refresh reconciliation', () => {
  it('deduplicates only successful source parents and the move destination', async () => {
    const a = entry('/left/a.jpg');
    const failed = entry('/failed/b.jpg');
    const c = entry('/left/c.jpg');
    const d = entry('/right/d.jpg');
    const treeRefreshes: string[] = [];
    let listingRefreshes = 0;

    const outcome = await runBatchWithRefresh(
      [a, failed, c, d],
      async (item) => {
        if (item === failed) throw new Error('denied');
      },
      async (succeeded) => {
        for (const path of affectedTreePathsAfterBatch(succeeded, '/dest')) {
          treeRefreshes.push(path);
        }
        listingRefreshes += 1;
      },
      (item) => item.name,
      'Refresh'
    );

    assert.deepEqual(outcome.succeeded, [a, c, d]);
    assert.deepEqual(treeRefreshes, ['/left', '/dest', '/right']);
    assert.equal(treeRefreshes.includes('/failed'), false);
    assert.equal(listingRefreshes, 1);
    assert.deepEqual(affectedTreePathsAfterBatch(outcome.succeeded), [
      '/left',
      '/right',
    ]);
    assert.deepEqual(affectedTreePathsAfterBatch([], '/dest'), []);
  });
});

describe('refreshAfterIOAction', () => {
  it('preserves single-item defaults and independently suppresses batch refreshes', async () => {
    const calls: string[] = [];
    const run = (options?: {
      refresh?: boolean;
      treeRefresh?: boolean;
    }) =>
      refreshAfterIOAction(
        async () => {
          calls.push('listing');
        },
        () => {
          calls.push('tree');
        },
        options
      );

    await run();
    assert.deepEqual(calls, ['tree', 'listing']);
    calls.length = 0;

    await run({ refresh: false });
    assert.deepEqual(calls, ['tree']);
    calls.length = 0;

    await run({ treeRefresh: false });
    assert.deepEqual(calls, ['listing']);
    calls.length = 0;

    await run({ refresh: false, treeRefresh: false });
    assert.deepEqual(calls, []);
  });
});

describe('selectionAfterBatch', () => {
  const a = entry('/a.jpg');
  const b = entry('/b.jpg');
  const c = entry('/c.jpg');

  it('clears only successful paths and retains failed/unrelated paths', () => {
    const previous = new Set([a.path, b.path, c.path]);
    assert.deepEqual(
      [...selectionAfterBatch(previous, [a])],
      [b.path, c.path]
    );
    assert.deepEqual([...previous], [a.path, b.path, c.path]);
  });

  it('keeps the original Set identity when every operation failed', () => {
    const previous = new Set([a.path, b.path]);
    assert.equal(selectionAfterBatch(previous, []), previous);
    assert.equal(selectionAfterBatch(previous, [c]), previous);
  });
});

describe('saveTagToEntries', () => {
  it('uses one saveMany for a multi-target drop and reports actual updates', async () => {
    const a = entry('/a.jpg');
    const b = entry('/b.jpg');
    const c = entry('/c.jpg');
    let saveCalls = 0;
    const manyCalls: unknown[] = [];
    const count = await saveTagToEntries([a, b, c], 'new', {
      save: async () => {
        saveCalls += 1;
      },
      saveMany: async (updates) => {
        manyCalls.push(updates);
      },
      tagsByName: new Map([
        [a.path, ['keep']],
        [b.path, ['new']],
      ]),
      descByName: new Map([[a.path, 'caption']]),
      normalize: (tags) => [...new Set(tags)].sort(),
    });

    assert.equal(count, 2);
    assert.equal(saveCalls, 0);
    assert.equal(manyCalls.length, 1);
    assert.deepEqual(manyCalls[0], [
      {
        entry: a,
        meta: { tags: ['keep', 'new'], description: 'caption' },
      },
      { entry: c, meta: { tags: ['new'] } },
    ]);
  });

  it('keeps the single-target save API and propagates write failures', async () => {
    const a = entry('/a.jpg');
    let saveManyCalls = 0;
    await assert.rejects(
      saveTagToEntries([a], 'new', {
        save: async () => {
          throw new Error('sidecar read-only');
        },
        saveMany: async () => {
          saveManyCalls += 1;
        },
        tagsByName: new Map(),
        descByName: new Map(),
        normalize: (tags) => tags,
      }),
      /sidecar read-only/
    );
    assert.equal(saveManyCalls, 0);
  });

  it('preserves partial saveMany details for the composed tag notice', async () => {
    const a = entry('/a.jpg');
    const b = entry('/b.jpg');
    const failure = Object.assign(new Error('partial tag save'), {
      updatedCount: 1,
      errors: ['b.jpg: sidecar read-only', 'c.jpg: disk full'],
    });
    await assert.rejects(
      saveTagToEntries([a, b], 'new', {
        save: async () => {},
        saveMany: async () => {
          throw failure;
        },
        tagsByName: new Map(),
        descByName: new Map(),
        normalize: (tags) => tags,
      }),
      (error: unknown) => {
        assert.equal(error, failure);
        return true;
      }
    );

    const details = tagMetaSaveManyFailure(failure);
    assert.ok(details);
    const logs: unknown[][] = [];
    const notice = composeBatchNotice(
      details.updatedCount,
      `Applied ${details.updatedCount} tag`,
      details.errors,
      {
        andMore: (count) => `and ${count} more`,
        operationFailed: (message) => `Operation failed: ${message}`,
        partialFailure: (success, failureText) =>
          `${success} / ${failureText}`,
      },
      'success',
      (...args) => logs.push(args)
    );
    assert.deepEqual(notice, {
      message:
        'Applied 1 tag / Operation failed: b.jpg: sidecar read-only; c.jpg: disk full',
      severity: 'warning',
    });
    assert.equal(logs[0][1], details.errors);
    assert.equal(tagMetaSaveManyFailure(new Error('ordinary failure')), null);
  });
});

describe('setDateTagForEntries (P1-2 batch date drop)', () => {
  it('writes a multi-target date drop with ONE saveMany and swaps date tags', async () => {
    const a = entry('/a.jpg');
    const b = entry('/b.jpg');
    const c = entry('/c.jpg');
    let saveCalls = 0;
    const manyCalls: unknown[][] = [];
    const count = await setDateTagForEntries([a, b, c], '20260202', {
      save: async () => {
        saveCalls += 1;
      },
      saveMany: async (updates) => {
        manyCalls.push(updates);
      },
      tagsByName: new Map([
        [a.path, ['keep', '20260101']],
        [b.path, ['idea']],
      ]),
      descByName: new Map([[a.path, 'caption']]),
      normalize: (tags) => tags,
    });

    assert.equal(count, 3);
    assert.equal(saveCalls, 0, 'multi-target drops must not fall back to N saves');
    assert.equal(manyCalls.length, 1, 'exactly one saveMany round-trip');
    assert.deepEqual(manyCalls[0], [
      {
        entry: a,
        meta: { tags: ['keep', '20260202'], description: 'caption' },
      },
      { entry: b, meta: { tags: ['idea', '20260202'] } },
      { entry: c, meta: { tags: ['20260202'] } },
    ]);
  });

  it('keeps the plain save API for a single-target drop', async () => {
    const a = entry('/a.jpg');
    let saveCalls = 0;
    let saveManyCalls = 0;
    const count = await setDateTagForEntries([a], '20260202', {
      save: async () => {
        saveCalls += 1;
      },
      saveMany: async () => {
        saveManyCalls += 1;
      },
      tagsByName: new Map([[a.path, ['keep', '20260101']]]),
      descByName: new Map(),
      normalize: (tags) => tags,
    });
    assert.equal(count, 1);
    assert.equal(saveCalls, 1);
    assert.equal(saveManyCalls, 0);
  });

  it('writes nothing for an empty drop', async () => {
    let calls = 0;
    const count = await setDateTagForEntries([], '20260202', {
      save: async () => {
        calls += 1;
      },
      saveMany: async () => {
        calls += 1;
      },
      tagsByName: new Map(),
      descByName: new Map(),
      normalize: (tags) => tags,
    });
    assert.equal(count, 0);
    assert.equal(calls, 0);
  });
});

describe('removeDateTagsFromEntries (P1-2 batch date clear)', () => {
  it('strips date tags from every target in ONE saveMany, skipping clean entries', async () => {
    const a = entry('/a.jpg');
    const b = entry('/b.jpg');
    const c = entry('/c.jpg');
    let saveCalls = 0;
    const manyCalls: unknown[][] = [];
    const count = await removeDateTagsFromEntries([a, b, c], {
      save: async () => {
        saveCalls += 1;
      },
      saveMany: async (updates) => {
        manyCalls.push(updates);
      },
      tagsByName: new Map([
        [a.path, ['keep', '20260101']],
        [b.path, ['no-date']],
        [c.path, ['20260101-20260103', 'idea']],
      ]),
      descByName: new Map([[c.path, 'caption']]),
      normalize: (tags) => tags,
    });

    assert.equal(count, 2);
    assert.equal(saveCalls, 0);
    assert.equal(manyCalls.length, 1);
    assert.deepEqual(manyCalls[0], [
      { entry: a, meta: { tags: ['keep'] } },
      { entry: c, meta: { tags: ['idea'], description: 'caption' } },
    ]);
  });

  it('uses one save for a single dated target', async () => {
    const a = entry('/a.jpg');
    let saveCalls = 0;
    let saveManyCalls = 0;
    const count = await removeDateTagsFromEntries([a], {
      save: async () => {
        saveCalls += 1;
      },
      saveMany: async () => {
        saveManyCalls += 1;
      },
      tagsByName: new Map([[a.path, ['keep', '20260101']]]),
      descByName: new Map(),
      normalize: (tags) => tags,
    });
    assert.equal(count, 1);
    assert.equal(saveCalls, 1);
    assert.equal(saveManyCalls, 0);
  });

  it('skips the write when no target carries a date tag', async () => {
    const a = entry('/a.jpg');
    const b = entry('/b.jpg');
    let calls = 0;
    const count = await removeDateTagsFromEntries([a, b], {
      save: async () => {
        calls += 1;
      },
      saveMany: async () => {
        calls += 1;
      },
      tagsByName: new Map([
        [a.path, ['plain']],
        [b.path, []],
      ]),
      descByName: new Map(),
      normalize: (tags) => tags,
    });
    assert.equal(count, 0);
    assert.equal(calls, 0);
  });
});
