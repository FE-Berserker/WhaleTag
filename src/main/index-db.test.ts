import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';
import {
  ingestFiles,
  filesPrior,
  queryFiles,
  advancedQuery,
  advancedQueryReadOnly,
  distinctTags,
  distinctTagsReadOnly,
  insertFulltext,
  deleteFulltextPaths,
  fulltextPrior,
  queryFulltext,
  hasFulltext,
  markFulltextInitialized,
  indexStatus,
  closeDb,
  loadExifProcessed,
  markExifProcessed,
  markExifProcessedMany,
  clearExifProcessed,
} from './index-db';
import type { IndexEntry } from '../shared/ipc-types';
import type { SearchQuery } from '../shared/search-query';

async function tmpRoot(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'whale-idx-'));
}

/** Creates `.whale/` so getDb can open `<root>/.whale/index.db` there. */
async function setup(root: string): Promise<void> {
  await fsp.mkdir(path.join(root, '.whale'), { recursive: true });
}

function entry(over: Partial<IndexEntry> & { path: string }): IndexEntry {
  return {
    name: over.name ?? path.basename(over.path),
    isDir: false,
    size: 0,
    mtime: 0,
    ext: '',
    tags: [],
    ...over,
  };
}

function emptyQ(): SearchQuery {
  return {
    text: '',
    tags: [],
    tagMatch: 'all',
    excludeTags: [],
    type: 'any',
    extensions: [],
    sizeMinBytes: null,
    sizeMaxBytes: null,
    modifiedAfter: null,
    modifiedBefore: null,
  };
}

describe('index-db (SQLite + FTS5 trigram)', () => {
  it('ingests and fuzzy-queries by filename substring', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      await ingestFiles(root, [
        entry({ path: 'a/report-final.pdf', name: 'report-final.pdf', ext: 'pdf' }),
        entry({ path: 'b/photo.jpg', name: 'photo.jpg', ext: 'jpg' }),
      ]);
      const hits = queryFiles(root, 'report');
      assert.equal(hits.length, 1);
      assert.equal(hits[0].name, 'report-final.pdf');
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('scopes filename, advanced and both fulltext matchers to a directory subtree', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      const rows = [
        entry({ path: 'project', name: 'project', isDir: true, tags: ['needle', 'xy'] }),
        entry({ path: 'project/inside.md', tags: ['needle', 'xy'] }),
        entry({ path: 'project/nested/deep.md', tags: ['needle', 'xy'] }),
        entry({ path: 'project-old/outside.md', tags: ['needle', 'xy'] }),
        entry({ path: 'other/inside.md', tags: ['needle', 'xy'] }),
      ];
      await ingestFiles(root, rows);
      await insertFulltext(
        root,
        rows.filter((row) => !row.isDir).map((row, index) => ({
          path: row.path,
          name: row.name,
          mtime: index,
          content: 'shared needle 目标关键词',
        }))
      );

      assert.deepEqual(
        queryFiles(root, 'needle', 'project').map((hit) => hit.path).sort(),
        ['project', 'project/inside.md', 'project/nested/deep.md']
      );
      // The short-query LIKE branch and Windows-style separators use the same scope.
      assert.deepEqual(
        queryFiles(root, 'x', 'project\\nested\\').map((hit) => hit.path),
        ['project/nested/deep.md']
      );
      assert.deepEqual(
        advancedQuery(root, emptyQ(), 'project').map((hit) => hit.path).sort(),
        ['project', 'project/inside.md', 'project/nested/deep.md'],
        'the directory row itself is included, but project-old and other are not'
      );
      assert.deepEqual(
        advancedQuery(root, { ...emptyQ(), text: 'needle' }, 'project/nested').map((hit) => hit.path),
        ['project/nested/deep.md']
      );
      assert.deepEqual(
        queryFulltext(root, 'needle', 'project').map((hit) => hit.name).sort(),
        ['deep.md', 'inside.md']
      );
      assert.deepEqual(
        queryFulltext(root, '目标关键词', 'project/nested').map((hit) => hit.name),
        ['deep.md'],
        'the CJK substring fallback is scoped too'
      );
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects absolute paths and traversal in pathPrefix even for short-circuit queries', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      for (const prefix of ['/absolute', 'C:\\absolute', '../outside', 'a/./b', 'a/../b', 'a\0b']) {
        assert.throws(() => queryFiles(root, 'needle', prefix), /pathPrefix/);
        assert.throws(() => queryFiles(root, ' ', prefix), /pathPrefix/);
        assert.throws(() => queryFulltext(root, 'x', prefix), /pathPrefix/);
        assert.throws(() => advancedQuery(root, emptyQ(), prefix), /pathPrefix/);
      }
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('applies pathPrefix before filename, advanced and fulltext result limits', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      const outside = Array.from({ length: 301 }, (_, index) =>
        entry({
          path: `outside/${String(index).padStart(3, '0')}-needle.md`,
          tags: ['needle'],
        })
      );
      await ingestFiles(root, [
        ...outside,
        entry({ path: 'target/zz-needle-target-with-a-deliberately-much-longer-name.md', tags: ['needle'] }),
      ]);
      assert.equal(
        queryFiles(root, 'needle').some((hit) => hit.path === 'target/zz-needle-target-with-a-deliberately-much-longer-name.md'),
        false,
        'the unscoped fixture must exhaust the filename limit before reaching the target'
      );
      assert.equal(
        advancedQuery(root, { ...emptyQ(), text: 'needle' }).some(
          (hit) => hit.path === 'target/zz-needle-target-with-a-deliberately-much-longer-name.md'
        ),
        false,
        'the unscoped fixture must exhaust the advanced limit before reaching the target'
      );
      assert.deepEqual(
        queryFiles(root, 'needle', 'target').map((hit) => hit.path),
        ['target/zz-needle-target-with-a-deliberately-much-longer-name.md']
      );
      assert.deepEqual(
        advancedQuery(root, { ...emptyQ(), text: 'needle' }, 'target').map((hit) => hit.path),
        ['target/zz-needle-target-with-a-deliberately-much-longer-name.md']
      );

      const textRows = (prefix: string, count: number, content: string) =>
        Array.from({ length: count }, (_, index) => ({
          path: `${prefix}/${String(index).padStart(3, '0')}.md`,
          name: `${index}.md`,
          mtime: index,
          content,
        }));
      await insertFulltext(root, [
        ...textRows('ranked-outside', 101, 'shared needle'),
        { path: 'target/ranked-target-with-a-deliberately-much-longer-name.md', name: 'ranked-target-with-a-deliberately-much-longer-name.md', mtime: 1, content: 'shared needle' },
        ...textRows('cjk-outside', 101, '包含目标关键词'),
        { path: 'target/cjk.md', name: 'cjk.md', mtime: 1, content: '包含目标关键词' },
      ]);
      assert.equal(
        queryFulltext(root, 'needle').some((hit) => hit.name === 'ranked-target-with-a-deliberately-much-longer-name.md'),
        false,
        'the unscoped fixture must exhaust the ranked fulltext limit before reaching the target'
      );
      assert.equal(
        queryFulltext(root, '目标关键词').some((hit) => hit.name === 'cjk.md'),
        false,
        'the unscoped fixture must exhaust the CJK fulltext limit before reaching the target'
      );
      assert.deepEqual(
        queryFulltext(root, 'needle', 'target').map((hit) => hit.name),
        ['ranked-target-with-a-deliberately-much-longer-name.md']
      );
      assert.deepEqual(
        queryFulltext(root, '目标关键词', 'target').map((hit) => hit.name),
        ['cjk.md']
      );
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
  it('drops entries for deleted files on re-ingest', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      await ingestFiles(root, [
        entry({ path: 'keep.txt', name: 'keep.txt' }),
        entry({ path: 'gone.txt', name: 'gone.txt' }),
      ]);
      await ingestFiles(root, [entry({ path: 'keep.txt', name: 'keep.txt' })]);
      assert.equal(queryFiles(root, 'gone').length, 0);
      assert.equal(queryFiles(root, 'keep').length, 1);
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the stored tags when the walk could not read the sidecar (docs/04 §7)', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      await ingestFiles(root, [
        entry({ path: 'a/note.txt', name: 'note.txt', tags: ['keep-me', 'other'] }),
      ]);
      assert.equal(queryFiles(root, 'keep-me').length, 1);

      // The next walk hit a sidecar read failure: only filename-derived tags.
      await ingestFiles(root, [
        entry({ path: 'a/note.txt', name: 'note.txt', tags: [], tagsUnreadable: true }),
      ]);
      assert.equal(queryFiles(root, 'keep-me').length, 1, 'stored tags survive');
      assert.match(filesPrior(root).get('a/note.txt') ?? '', /keep-me/);

      // A successful read is authoritative again: clearing tags clears them.
      await ingestFiles(root, [entry({ path: 'a/note.txt', name: 'note.txt', tags: [] })]);
      assert.equal(queryFiles(root, 'keep-me').length, 0);
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('closeDb drops the cached handle; double-close is a no-op and the next query reopens (docs/04 §10)', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      await ingestFiles(root, [entry({ path: 'x.txt', name: 'x.txt' })]);
      assert.equal(queryFiles(root, 'x.txt').length, 1);
      closeDb(root);
      closeDb(root); // already closed — no-op, must not throw
      // The handle cache is cold again, but the on-disk db persists: the
      // next query lazily reopens and still sees the ingested rows.
      assert.equal(queryFiles(root, 'x.txt').length, 1);
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('ingestFiles reports monotonic progress across delete + upsert batches (docs/04 §10)', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      // Seed a row that the second run deletes (not walked anymore).
      await ingestFiles(root, [entry({ path: 'gone.txt', name: 'gone.txt' })]);
      const calls: Array<[number, number]> = [];
      await ingestFiles(
        root,
        [entry({ path: 'keep.txt', name: 'keep.txt' })],
        (done, total) => calls.push([done, total])
      );
      // total = removed(1: gone.txt) + changed(1: keep.txt) = 2.
      assert.ok(calls.length >= 1);
      assert.deepEqual(calls[calls.length - 1], [2, 2]);
      for (const [, total] of calls) assert.equal(total, 2);
      for (let i = 1; i < calls.length; i++) {
        assert.ok(calls[i][0] >= calls[i - 1][0], 'monotonic');
      }
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps stored rows for a subtree the walk could not read (incomplete ingest)', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      await ingestFiles(root, [
        entry({ path: 'seen.txt', name: 'seen.txt' }),
        entry({ path: 'locked/inside.txt', name: 'inside.txt' }),
      ]);
      assert.equal(indexStatus(root).count, 2);

      // The second walk hit EACCES on `locked/`, so that subtree is missing
      // from `entries` — the ingester must not treat it as a deletion.
      await ingestFiles(
        root,
        [entry({ path: 'seen.txt', name: 'seen.txt' })],
        undefined,
        { complete: false }
      );

      assert.equal(
        queryFiles(root, 'inside').length,
        1,
        'rows under an unreadable subtree survive'
      );
      assert.equal(indexStatus(root).count, 2, 'cached count matches the table');
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('deletes rows outside the unreadable subtree while keeping that subtree (partial ingest)', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      await ingestFiles(root, [
        entry({ path: 'keep.txt', name: 'keep.txt' }),
        entry({ path: 'locked/inside.txt', name: 'inside.txt' }),
        entry({ path: 'gone.txt', name: 'gone.txt' }),
      ]);

      // Walk hit EACCES on `locked/` only: the walker reports it as an
      // ABSOLUTE path while the index stores root-relative ones.
      await ingestFiles(
        root,
        [entry({ path: 'keep.txt', name: 'keep.txt' })],
        undefined,
        { complete: false, unreadable: [path.join(root, 'locked')] }
      );

      assert.equal(
        queryFiles(root, 'inside').length,
        1,
        'rows under the unreadable subtree survive'
      );
      assert.equal(
        queryFiles(root, 'gone').length,
        0,
        'an unreadable sibling directory no longer freezes the delete pass'
      );
      assert.equal(indexStatus(root).count, 2, 'cached count matches the table');
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('escapes LIKE wildcards on the short-term (<3 chars) query path', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      await ingestFiles(root, [
        entry({ path: 'plain.txt', name: 'plain.txt' }),
        entry({ path: 'a%b.txt', name: 'a%b.txt' }),
        entry({ path: 'a_b.txt', name: 'a_b.txt' }),
      ]);
      // Without escapeLike, `%`/`_` were wildcards and matched every row.
      assert.deepEqual(
        queryFiles(root, '%').map((e) => e.name),
        ['a%b.txt']
      );
      assert.deepEqual(
        queryFiles(root, '_').map((e) => e.name),
        ['a_b.txt']
      );
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('ingestFiles is incremental: unchanged rows skipped, tag-only changes re-indexed (P0-1)', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      await ingestFiles(root, [
        entry({ path: 'a.txt', name: 'a.txt', mtime: 100, size: 10, tags: ['x'] }),
        entry({ path: 'b.txt', name: 'b.txt', mtime: 200, size: 20, tags: ['y'] }),
      ]);

      // filesPrior exposes the signature used to decide skips: `${mtime}|${size}|${tags}`.
      const prior = filesPrior(root);
      assert.equal(prior.size, 2);
      assert.equal(prior.get('a.txt'), '100|10|x');
      assert.equal(prior.get('b.txt'), '200|20|y');

      // Re-ingest IDENTICAL entries — a no-op re-index. Rows must stay queryable
      // (FTS intact); this is the regression guard for the incremental skip.
      await ingestFiles(root, [
        entry({ path: 'a.txt', name: 'a.txt', mtime: 100, size: 10, tags: ['x'] }),
        entry({ path: 'b.txt', name: 'b.txt', mtime: 200, size: 20, tags: ['y'] }),
      ]);
      assert.equal(queryFiles(root, 'a.txt').length, 1);
      assert.equal(queryFiles(root, 'b.txt').length, 1);
      assert.equal(distinctTags(root).length, 2);

      // b's TAGS change with NO mtime bump (a sidecar edit). tags is in the
      // signature, so b must be re-upserted and the new tag become searchable —
      // the key correctness reason tags can't be left out of the signature.
      await ingestFiles(root, [
        entry({ path: 'a.txt', name: 'a.txt', mtime: 100, size: 10, tags: ['x'] }),
        entry({ path: 'b.txt', name: 'b.txt', mtime: 200, size: 20, tags: ['y', 'z'] }),
      ]);
      assert.equal(
        advancedQuery(root, { ...emptyQ(), tags: ['z'] }).length,
        1
      );
      assert.deepEqual(distinctTags(root).sort(), ['x', 'y', 'z']);
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('advancedQuery filters by extension / size / tags', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      await ingestFiles(root, [
        entry({ path: 'a.pdf', name: 'a.pdf', ext: 'pdf', size: 500, tags: ['work'] }),
        entry({ path: 'b.jpg', name: 'b.jpg', ext: 'jpg', size: 5000, tags: ['photo'] }),
        entry({ path: 'c.pdf', name: 'c.pdf', ext: 'pdf', size: 50, tags: ['draft'] }),
      ]);
      assert.equal(advancedQuery(root, { ...emptyQ(), extensions: ['pdf'] }).length, 2);
      const big = advancedQuery(root, { ...emptyQ(), sizeMinBytes: 1000 });
      assert.equal(big.length, 1);
      assert.equal(big[0].name, 'b.jpg');
      const work = advancedQuery(root, { ...emptyQ(), tags: ['work'] });
      assert.equal(work.length, 1);
      assert.deepEqual(work[0].tags, ['work']);
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('advancedQuery accepts 1–2 char text (LIKE fallback with ESCAPE)', async () => {
    // Regression: the <3-char branch used the SQL text `ESCAPE "\"`; better-sqlite3
    // is built with SQLITE_DQS=0, so the double-quoted token is an identifier and
    // EVERY short advanced search threw "no such column".
    const root = await tmpRoot();
    try {
      await setup(root);
      await ingestFiles(root, [
        entry({ path: 'a.pdf', name: 'a.pdf', ext: 'pdf', size: 500 }),
        entry({ path: 'ab.jpg', name: 'ab.jpg', ext: 'jpg', size: 5000 }),
        entry({ path: 'ba.txt', name: 'ba.txt', ext: 'txt', size: 5 }),
        entry({ path: '10_percent.md', name: '10_percent.md', ext: 'md', size: 5 }),
      ]);

      const one = advancedQuery(root, { ...emptyQ(), text: 'b' }).map((e) => e.name).sort();
      assert.deepEqual(one, ['ab.jpg', 'ba.txt']);
      assert.deepEqual(
        advancedQuery(root, { ...emptyQ(), text: ' 1 ' }).map((e) => e.name),
        ['10_percent.md'],
        'text is trimmed before the length check'
      );

      const two = advancedQuery(root, { ...emptyQ(), text: 'ab' }).map((e) => e.name);
      assert.deepEqual(two, ['ab.jpg']);

      // LIKE wildcards inside the text are literal (escapeLike), and so is the
      // ESCAPE character itself.
      assert.deepEqual(
        advancedQuery(root, { ...emptyQ(), text: '_' }).map((e) => e.name),
        ['10_percent.md']
      );

      // The short branch composes with the structured filters.
      assert.deepEqual(
        advancedQuery(root, { ...emptyQ(), text: 'b', extensions: ['jpg'] }).map((e) => e.name),
        ['ab.jpg']
      );
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('distinctTags returns the unique tag set, sorted', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      await ingestFiles(root, [
        entry({ path: 'a', name: 'a', tags: ['y', 'x'] }),
        entry({ path: 'b', name: 'b', tags: ['y', 'z'] }),
      ]);
      assert.deepEqual(distinctTags(root), ['x', 'y', 'z']);
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('ingests and queries fulltext with a snippet', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      await insertFulltext(root, [
        { path: 'notes.md', name: 'notes.md', mtime: 1, content: 'the quick brown fox jumps' },
      ]);
      markFulltextInitialized(root);
      assert.ok(hasFulltext(root));
      const hits = queryFulltext(root, 'quick brown');
      assert.equal(hits.length, 1);
      assert.equal(hits[0].name, 'notes.md');
      assert.ok(hits[0].snippet.includes('quick'));
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('fulltext: CJK queries match inside a run (unicode61 cannot split CJK)', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      // unicode61 treats each contiguous CJK run as ONE token, so a phrase
      // query for a part of a run could never match. The substring fallback
      // answers it and builds the same <mark> snippet markup as snippet().
      await insertFulltext(root, [
        {
          path: 'cn.md',
          name: 'cn.md',
          mtime: 1,
          content: '你好，世界。这是一个 GBK 编码的测试文件，用于验证全文检索。',
        },
        { path: 'en.md', name: 'en.md', mtime: 2, content: 'nothing to see here' },
      ]);
      const q = (text: string) => queryFulltext(root, text);
      const hit = q('全文检索');
      assert.equal(hit.length, 1);
      assert.equal(hit[0].name, 'cn.md');
      assert.ok(hit[0].snippet.includes('<mark>全文检索</mark>'), hit[0].snippet);
      assert.equal(q('测试文件').length, 1);
      // A whole run: found by the MATCH branch, still reported exactly once
      // even though the substring scan finds it too.
      assert.equal(q('用于验证全文检索').length, 1);
      assert.equal(q('GBK').length, 1);
      // Mixed script (spaces break unicode61 tokens, CJK runs do not).
      assert.equal(q('GBK 编码的测试').length, 1);
      assert.equal(q('看不见').length, 0);
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('fulltext: a 2-character CJK query is a whole word, 1 character is refused', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      await insertFulltext(root, [
        { path: 'a.md', name: 'a.md', mtime: 1, content: '设计模式与代码重构' },
      ]);
      assert.equal(queryFulltext(root, '设计').length, 1);
      assert.equal(queryFulltext(root, '代码重构').length, 1);
      assert.equal(queryFulltext(root, '模').length, 0);
      // Latin queries keep the 3-character minimum.
      assert.equal(queryFulltext(root, 'de').length, 0);
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('fulltext: the CJK fallback is case-insensitive for ASCII and escapes LIKE wildcards', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      await insertFulltext(root, [
        { path: 'a.md', name: 'a.md', mtime: 1, content: '设计 Design 模式 Patterns 中文版' },
        { path: 'b.md', name: 'b.md', mtime: 2, content: 'axb 中文' },
      ]);
      const hit = queryFulltext(root, 'design 模式');
      assert.equal(hit.length, 1);
      assert.ok(hit[0].snippet.includes('<mark>Design 模式</mark>'), hit[0].snippet);
      // `_` and `%` are literal characters of the query, never wildcards.
      assert.equal(queryFulltext(root, 'a_b 中文').length, 0);
      assert.equal(queryFulltext(root, 'axb 中文').length, 1);
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('fulltext: the fallback snippet is a window around the match, not the whole document', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      const filler = '填充'.repeat(100); // 200 chars before the match
      await insertFulltext(root, [
        {
          path: 'long.md',
          name: 'long.md',
          mtime: 1,
          content: `${filler}目标关键词\n\n${'尾巴'.repeat(100)}`,
        },
      ]);
      const [hit] = queryFulltext(root, '目标关键词');
      assert.ok(hit, 'expected a hit');
      assert.ok(hit.snippet.startsWith('…'), hit.snippet);
      assert.ok(hit.snippet.endsWith('…'), hit.snippet);
      assert.ok(hit.snippet.includes('<mark>目标关键词</mark>'), hit.snippet);
      assert.ok(!hit.snippet.includes('\n'), 'whitespace is collapsed');
      assert.ok(hit.snippet.length < 200, hit.snippet);
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('markFulltextInitialized marks an empty index as built', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      // Built, but there is nothing textual in it — this used to look exactly
      // like "never built", so the watcher stopped rebuilding it for good.
      markFulltextInitialized(root);
      assert.equal(hasFulltext(root), true);
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('hasFulltext reports false for a root with no index', async () => {
    const root = await tmpRoot();
    try {
      assert.equal(hasFulltext(root), false);
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('incremental fulltext: insert / delete-by-path / prior-mtime-only (unchanged rows survive)', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      // Seed three rows through the production incremental path.
      await insertFulltext(root, [
        { path: 'a.md', name: 'a.md', mtime: 10, content: 'alpha bravo' },
        { path: 'b.md', name: 'b.md', mtime: 20, content: 'bravo charlie' },
        { path: 'c.md', name: 'c.md', mtime: 30, content: 'charlie delta' },
      ]);

      // fulltextPrior returns mtime ONLY (no document bodies in memory).
      const prior = fulltextPrior(root);
      assert.equal(prior.size, 3);
      assert.equal(prior.get('b.md'), 20);
      assert.equal(typeof prior.get('a.md'), 'number');

      // insertFulltext adds WITHOUT wiping existing rows.
      await insertFulltext(root, [
        { path: 'd.md', name: 'd.md', mtime: 40, content: 'delta echo' },
      ]);
      assert.equal(queryFulltext(root, 'bravo').length, 2); // a.md + b.md still there

      // deleteFulltextPaths removes only the named paths (missing is a no-op).
      await deleteFulltextPaths(root, ['b.md', 'missing.md']);
      assert.equal(queryFulltext(root, 'bravo').length, 1); // only a.md
      assert.equal(queryFulltext(root, 'charlie').length, 1); // c.md survived
      assert.equal(fulltextPrior(root).get('b.md'), undefined);
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('insertFulltext replaces rather than duplicates a path (FTS5 has no unique constraint)', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      const rec = { path: 'dup.md', name: 'dup.md', mtime: 1, content: 'one two' };
      await insertFulltext(root, [rec]);
      // The same path arriving again (a re-run that skipped its delete step)
      // must not leave two rows behind; both would match queries.
      await insertFulltext(root, [{ ...rec, mtime: 2, content: 'three four' }]);
      assert.equal(queryFulltext(root, 'three').length, 1);
      assert.equal(queryFulltext(root, 'one').length, 0);
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('indexStatus reports count and readiness', async () => {
    const root = await tmpRoot();
    try {
      assert.deepEqual(indexStatus(root), { count: 0, ready: false, exists: false });
      await setup(root);
      await ingestFiles(root, [
        entry({ path: 'a', name: 'a' }),
        entry({ path: 'b', name: 'b' }),
      ]);
      assert.deepEqual(indexStatus(root), { count: 2, ready: true, exists: true });
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('indexStatus.exists survives an emptied index (incremental watcher gate)', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      await ingestFiles(root, [entry({ path: 'a', name: 'a' })]);
      assert.equal(indexStatus(root).ready, true);
      // Every file deleted: the index still EXISTS for this root. Gating the
      // watcher on `ready` used to read as "never built", so files added after
      // this point were never indexed again.
      await ingestFiles(root, []);
      assert.deepEqual(indexStatus(root), { count: 0, ready: false, exists: true });
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('indexStatus count tracks adds + deletes across re-ingests (P2-2 meta counter)', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      await ingestFiles(root, [
        entry({ path: 'a', name: 'a' }),
        entry({ path: 'b', name: 'b' }),
        entry({ path: 'c', name: 'c' }),
      ]);
      assert.equal(indexStatus(root).count, 3);

      // Re-ingest with one removed and one added (net unchanged). The meta
      // counter is rewritten to seen.size every ingest, so it must stay exact
      // — a naive delta or a stale count would drift here.
      await ingestFiles(root, [
        entry({ path: 'a', name: 'a' }),
        entry({ path: 'c', name: 'c' }),
        entry({ path: 'd', name: 'd' }),
      ]);
      assert.equal(indexStatus(root).count, 3);

      // Shrink to a single entry.
      await ingestFiles(root, [entry({ path: 'a', name: 'a' })]);
      assert.equal(indexStatus(root).count, 1);
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  // --- P3-4: EXIF extraction cache ------------------------------------

  it('loadExifProcessed returns [] when the db does not exist yet', async () => {
    const root = await tmpRoot();
    try {
      assert.deepEqual(loadExifProcessed(root), []);
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('markExifProcessed upserts and loadExifProcessed reads back', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      markExifProcessed(root, {
        path: '/abs/img1.jpg',
        status: 'ok',
        lat: 39.9,
        lng: 116.4,
        triedAt: 1,
      });
      markExifProcessed(root, {
        path: '/abs/img2.jpg',
        status: 'none',
        lat: null,
        lng: null,
        triedAt: 2,
      });
      const got = loadExifProcessed(root);
      assert.equal(got.length, 2);
      const byPath = Object.fromEntries(got.map((r) => [r.path, r]));
      assert.equal(byPath['/abs/img1.jpg'].status, 'ok');
      assert.equal(byPath['/abs/img1.jpg'].lat, 39.9);
      assert.equal(byPath['/abs/img1.jpg'].lng, 116.4);
      assert.equal(byPath['/abs/img1.jpg'].triedAt, 1);
      assert.equal(byPath['/abs/img2.jpg'].status, 'none');
      assert.equal(byPath['/abs/img2.jpg'].lat, null);
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('markExifProcessedMany upserts many rows in one batch (and is a no-op when empty)', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      markExifProcessedMany(root, [
        { path: '/abs/a.jpg', status: 'ok', lat: 1, lng: 2, triedAt: 100 },
        { path: '/abs/b.jpg', status: 'none', lat: null, lng: null, triedAt: 101 },
        { path: '/abs/c.jpg', status: 'ok', lat: 3, lng: 4, triedAt: 102 },
      ]);
      let got = loadExifProcessed(root);
      assert.equal(got.length, 3);

      // Upsert within a batch overwrites in place (same ON CONFLICT path).
      markExifProcessedMany(root, [
        { path: '/abs/a.jpg', status: 'none', lat: null, lng: null, triedAt: 200 },
      ]);
      got = loadExifProcessed(root);
      assert.equal(got.length, 3);
      const a = got.find((r) => r.path === '/abs/a.jpg');
      assert.equal(a?.status, 'none');
      assert.equal(a?.triedAt, 200);

      // Empty input is a no-op.
      markExifProcessedMany(root, []);
      assert.equal(loadExifProcessed(root).length, 3);
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('markExifProcessed overwrites prior record on conflict', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      markExifProcessed(root, {
        path: '/abs/p.jpg',
        status: 'none',
        lat: null,
        lng: null,
        triedAt: 100,
      });
      // Re-mark the same path with a real result (e.g. sidecar was deleted
      // and the user re-ran extraction — cache should pick up the new GPS).
      markExifProcessed(root, {
        path: '/abs/p.jpg',
        status: 'ok',
        lat: 1.23,
        lng: 4.56,
        triedAt: 200,
      });
      const got = loadExifProcessed(root);
      assert.equal(got.length, 1);
      assert.equal(got[0].status, 'ok');
      assert.equal(got[0].lat, 1.23);
      assert.equal(got[0].triedAt, 200);
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('clearExifProcessed wipes the table and is a no-op when empty', async () => {
    const root = await tmpRoot();
    try {
      await setup(root);
      clearExifProcessed(root);
      assert.deepEqual(loadExifProcessed(root), []);
      markExifProcessed(root, {
        path: '/abs/x.jpg',
        status: 'ok',
        lat: 0,
        lng: 0,
        triedAt: 1,
      });
      clearExifProcessed(root);
      assert.deepEqual(loadExifProcessed(root), []);
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('EXIF cache is independent across roots', async () => {
    const rootA = await tmpRoot();
    const rootB = await tmpRoot();
    try {
      await setup(rootA);
      await setup(rootB);
      markExifProcessed(rootA, {
        path: '/abs/shared.jpg',
        status: 'ok',
        lat: 1,
        lng: 2,
        triedAt: 1,
      });
      markExifProcessed(rootB, {
        path: '/abs/shared.jpg',
        status: 'none',
        lat: null,
        lng: null,
        triedAt: 1,
      });
      const a = loadExifProcessed(rootA);
      const b = loadExifProcessed(rootB);
      assert.equal(a[0].status, 'ok');
      assert.equal(b[0].status, 'none');
    } finally {
      closeDb(rootA);
      closeDb(rootB);
      await fsp.rm(rootA, { recursive: true, force: true });
      await fsp.rm(rootB, { recursive: true, force: true });
    }
  });

  it('LAN readonly queries report a missing index without creating metadata', async () => {
    const root = await tmpRoot();
    try {
      assert.equal(advancedQueryReadOnly(root, emptyQ()), null);
      assert.equal(distinctTagsReadOnly(root), null);
      await assert.rejects(fsp.stat(path.join(root, '.whale')), { code: 'ENOENT' });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('LAN readonly queries reuse existing rows without changing the database', async () => {
    const root = await tmpRoot();
    const dbFile = path.join(root, '.whale', 'index.db');
    try {
      await setup(root);
      await ingestFiles(root, [
        entry({ path: 'a.txt', name: 'a.txt', tags: ['alpha', 'shared'] }),
        entry({ path: 'b.txt', name: 'b.txt', tags: ['beta', 'shared'] }),
      ]);
      closeDb(root);
      const before = await fsp.readFile(dbFile);
      const namesBefore = await fsp.readdir(path.dirname(dbFile));
      const hits = advancedQueryReadOnly(root, { ...emptyQ(), tags: ['alpha'] });
      assert.deepEqual(hits?.map((item) => item.path), ['a.txt']);
      assert.deepEqual(distinctTagsReadOnly(root), ['alpha', 'beta', 'shared']);
      assert.deepEqual(await fsp.readFile(dbFile), before);
      // Readonly SQLite connections may materialize transient WAL shared-memory
      // files while reading a WAL-mode database; they never create a new index.
      const namesAfter = (await fsp.readdir(path.dirname(dbFile))).filter(
        (name) => name !== 'index.db-shm' && name !== 'index.db-wal'
      );
      assert.deepEqual(namesAfter, namesBefore);
    } finally {
      closeDb(root);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
