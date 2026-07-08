import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';
import {
  ingestFiles,
  queryFiles,
  advancedQuery,
  distinctTags,
  ingestFulltext,
  queryFulltext,
  hasFulltext,
  indexStatus,
  closeDb,
  loadExifProcessed,
  markExifProcessed,
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
      await ingestFulltext(root, [
        { path: 'notes.md', name: 'notes.md', mtime: 1, content: 'the quick brown fox jumps' },
      ]);
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

  it('indexStatus reports count and readiness', async () => {
    const root = await tmpRoot();
    try {
      assert.deepEqual(indexStatus(root), { count: 0, ready: false });
      await setup(root);
      await ingestFiles(root, [
        entry({ path: 'a', name: 'a' }),
        entry({ path: 'b', name: 'b' }),
      ]);
      assert.deepEqual(indexStatus(root), { count: 2, ready: true });
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
});
