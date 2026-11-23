import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import type { FulltextHit } from '../../shared/ipc-types';

const require_ = createRequire(__filename);
const savedCache = new Map<string, NodeJS.Module | undefined>();

let searchAllFulltext!: typeof import('./fulltext-search').searchAllFulltext;
let impl: (root: string, query: string) => Promise<FulltextHit[]> = async () => [];
let calls: Array<{ root: string; query: string }> = [];

function injectMock(moduleName: string, exports: unknown): void {
  const modulePath = require_.resolve(moduleName);
  if (!savedCache.has(modulePath)) {
    savedCache.set(modulePath, require_.cache[modulePath]);
  }
  const existing = require_.cache[modulePath];
  require_.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
    children: existing?.children ?? [],
    paths: existing?.paths ?? [],
  } as NodeJS.Module;
}

function hit(path: string): FulltextHit {
  return { path, name: path.split('/').pop() ?? path, snippet: `…${path}…` };
}

before(() => {
  injectMock('-/services/ipc-api', {
    ipcApi: {
      searchFulltext: (root: string, query: string) => {
        calls.push({ root, query });
        return impl(root, query);
      },
    },
  });
  ({ searchAllFulltext } = require_('./fulltext-search') as typeof import('./fulltext-search'));
});

afterEach(() => {
  impl = async () => [];
  calls = [];
});

after(() => {
  for (const [modulePath, original] of savedCache) {
    if (original) require_.cache[modulePath] = original;
    else delete require_.cache[modulePath];
  }
  delete require_.cache[require_.resolve('./fulltext-search')];
});

describe('searchAllFulltext', () => {
  it('returns nothing for an empty query or no roots without calling IPC', async () => {
    const emptyQuery = await searchAllFulltext(['/a'], '   ');
    assert.deepEqual(emptyQuery, { hits: [], failedRoots: [] });
    const noRoots = await searchAllFulltext([], 'note');
    assert.deepEqual(noRoots, { hits: [], failedRoots: [] });
    assert.equal(calls.length, 0);
  });

  it('merges the roots and de-duplicates hits by path', async () => {
    impl = async (root) =>
      root === '/a' ? [hit('/x/one.md'), hit('/x/shared.md')] : [hit('/x/shared.md'), hit('/x/two.md')];

    const result = await searchAllFulltext(['/a', '/b'], ' note ');
    assert.deepEqual(calls, [
      { root: '/a', query: 'note' },
      { root: '/b', query: 'note' },
    ]);
    assert.deepEqual(
      result.hits.map((item) => item.path),
      ['/x/one.md', '/x/shared.md', '/x/two.md']
    );
    assert.deepEqual(result.failedRoots, []);
  });

  it('reports failed roots instead of silently dropping their results', async () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      impl = async (root) => {
        if (root === '/broken') throw new Error('EIO: index unavailable');
        return [hit('/ok/one.md')];
      };

      const result = await searchAllFulltext(['/broken', '/ok'], 'note');
      assert.deepEqual(
        result.hits.map((item) => item.path),
        ['/ok/one.md'],
        'healthy roots still contribute'
      );
      assert.deepEqual(result.failedRoots, ['/broken']);
      assert.ok(
        warnings.some(
          (args) =>
            String(args[0]).includes('root search failed') &&
            String(args[1]) === '/broken'
        ),
        'a failed root must be logged'
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  it('caps the merged result at 100 hits', async () => {
    impl = async (root) =>
      Array.from({ length: 60 }, (_, index) => hit(`/${root.slice(1)}/${index}.md`));

    const result = await searchAllFulltext(['/a', '/b'], 'note');
    assert.equal(result.hits.length, 100);
  });
});
