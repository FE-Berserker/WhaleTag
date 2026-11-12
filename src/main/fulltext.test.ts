import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';

import {
  buildFulltextIndex,
  extractText,
  extractTextDetailed,
  selectRemoved,
  searchFulltext,
  MAX_PDF_BYTES,
} from './fulltext';
import { closeDb } from './index-db';

async function tmpRoot(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'whale-ft-'));
}

async function write(root: string, name: string, content: string): Promise<string> {
  const p = path.join(root, name);
  await fsp.writeFile(p, content, 'utf8');
  return p;
}

function names(hits: { name: string }[]): string[] {
  return hits.map((h) => h.name).sort();
}

/** Close the SQLite handle before deleting — Windows keeps the file locked. */
async function cleanup(root: string): Promise<void> {
  closeDb(root);
  await fsp.rm(root, { recursive: true, force: true });
}

describe('fulltext extractText', () => {
  it('collapses whitespace, strips html tags and decodes entity placeholders', async () => {
    const root = await tmpRoot();
    try {
      const txt = await write(root, 'note.txt', 'hello   world\n');
      const html = await write(
        root,
        'page.html',
        '<html><body><p>hello&nbsp;world</p></body></html>'
      );
      assert.equal(await extractText(txt, 'txt', (await fsp.stat(txt)).size), 'hello world');
      assert.equal(
        await extractText(html, 'html', (await fsp.stat(html)).size),
        'hello world'
      );
    } finally {
      await cleanup(root);
    }
  });

  it('refuses a PDF above the cap without reading it', async () => {
    const root = await tmpRoot();
    try {
      // One byte on disk: the guard must fire on the reported size, before any
      // readFile — that is what keeps a multi-GB PDF from OOM-ing the worker.
      const pdf = await write(root, 'big.pdf', 'x');
      assert.equal(await extractText(pdf, 'pdf', MAX_PDF_BYTES + 1), null);
      const detailed = await extractTextDetailed(pdf, 'pdf', MAX_PDF_BYTES + 1);
      assert.deepEqual(detailed, { text: null, unreadable: true });
    } finally {
      await cleanup(root);
    }
  });

  it('reports a missing PDF as unreadable instead of throwing', async () => {
    const root = await tmpRoot();
    try {
      const gone = path.join(root, 'gone.pdf');
      assert.deepEqual(await extractTextDetailed(gone, 'pdf', 10), {
        text: null,
        unreadable: true,
      });
    } finally {
      await cleanup(root);
    }
  });

  it('separates empty files (indexable-as-nothing) from read failures', async () => {
    const root = await tmpRoot();
    try {
      const empty = await write(root, 'empty.txt', '   \n  ');
      assert.deepEqual(await extractTextDetailed(empty, 'txt', 8), {
        text: null,
        unreadable: false,
      });
      const gone = path.join(root, 'gone.txt');
      assert.deepEqual(await extractTextDetailed(gone, 'txt', 8), {
        text: null,
        unreadable: true,
      });
    } finally {
      await cleanup(root);
    }
  });
});

describe('fulltext buildFulltextIndex (SQLite + FTS5)', () => {
  it('indexes supported text files, strips html, and skips unsupported extensions', async () => {
    const root = await tmpRoot();
    try {
      await write(root, 'a.txt', 'needle alpha');
      await write(root, 'b.html', '<p>needle beta</p>');
      await write(root, 'c.bin', 'needle gamma');
      const { count } = await buildFulltextIndex(root);
      assert.equal(count, 2);
      assert.deepEqual(names(await searchFulltext(root, 'needle')), ['a.txt', 'b.html']);
    } finally {
      await cleanup(root);
    }
  });

  it('re-extracts changed files and drops deleted ones', async () => {
    const root = await tmpRoot();
    try {
      await write(root, 'a.txt', 'needle old');
      const b = await write(root, 'b.txt', 'haystack stays');
      assert.equal((await buildFulltextIndex(root)).count, 2);

      await write(root, 'a.txt', 'precious new');
      // Force a distinct mtime even on coarse filesystems.
      const future = new Date(Date.now() + 5_000);
      await fsp.utimes(path.join(root, 'a.txt'), future, future);
      await fsp.rm(b);

      const { count } = await buildFulltextIndex(root);
      assert.equal(count, 1);
      assert.deepEqual(await searchFulltext(root, 'old'), []);
      assert.deepEqual(names(await searchFulltext(root, 'precious')), ['a.txt']);
    } finally {
      await cleanup(root);
    }
  });

  it('keeps unchanged rows on a no-op rebuild', async () => {
    const root = await tmpRoot();
    try {
      await write(root, 'a.txt', 'needle alpha');
      const first = await buildFulltextIndex(root);
      const second = await buildFulltextIndex(root);
      assert.equal(second.count, first.count);
      assert.deepEqual(names(await searchFulltext(root, 'needle')), ['a.txt']);
    } finally {
      await cleanup(root);
    }
  });
});

describe('fulltext selectRemoved', () => {
  it('keeps unseen paths covered by a skipped path', () => {
    const removed = selectRemoved(['a/x', 'a/y', 'ab/z', 'b/w'], new Set(['a/x']), ['a/y']);
    assert.deepEqual(removed.sort(), ['ab/z', 'b/w']);
  });

  it('keeps every row when the root itself could not be read', () => {
    assert.deepEqual(selectRemoved(['a/x', 'b/y'], new Set(), ['']), []);
  });

  it('matches skipped prefixes on path boundaries only', () => {
    assert.deepEqual(selectRemoved(['a/bc/d'], new Set(), ['a/b']), ['a/bc/d']);
    assert.deepEqual(selectRemoved(['a/b/c'], new Set(), ['a/b']), []);
  });
});
