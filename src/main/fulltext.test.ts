import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';
import iconv from 'iconv-lite';

import {
  buildFulltextIndex,
  extractPdfText,
  extractText,
  extractTextDetailed,
  selectRemoved,
  searchFulltext,
} from './fulltext';
import { MAX_PDF_BYTES } from './fulltext-limits';
import * as indexDb from './index-db';

type PdfjsLib = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

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
  indexDb.closeDb(root);
  await fsp.rm(root, { recursive: true, force: true });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(
  condition: () => boolean,
  description: string,
  timeoutMs = 2000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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

  it('indexes legacy-encoded text with the viewer decoder (GBK file becomes searchable)', async () => {
    const root = await tmpRoot();
    try {
      const text = '你好，世界。这是一个 GBK 编码的测试文件，用于验证全文检索。';
      const p = path.join(root, 'gbk-note.txt');
      await fsp.writeFile(p, iconv.encode(text, 'gbk'));
      const size = (await fsp.stat(p)).size;
      // Before the shared decoder the indexer read raw UTF-8 and produced a
      // U+FFFD-only string, so this document could never match a search.
      assert.equal(await extractText(p, 'txt', size), text);
      await indexDb.closeDb(root);
      const { count } = await buildFulltextIndex(root);
      assert.equal(count, 1);
      assert.deepEqual(names(await searchFulltext(root, '全文检索')), ['gbk-note.txt']);
    } finally {
      await cleanup(root);
    }
  });

  it('a capped read that splits a multi-byte character leaves no trailing U+FFFD', async () => {
    const root = await tmpRoot();
    try {
      const text = '中文'.repeat(40);
      const p = await write(root, 'cjk.txt', text);
      const full = Buffer.byteLength(text, 'utf8');
      // Report a size that lands one byte INSIDE the last character.
      const sliced = await extractText(p, 'txt', full - 1);
      assert.equal(sliced, text.slice(0, -1));
      assert.equal(await extractText(p, 'txt', full), text);
    } finally {
      await cleanup(root);
    }
  });
});

describe('fulltext PDF resource bounds', () => {
  it('allows two live pdfjs documents globally and passes plain Uint8Array views', async () => {
    const root = await tmpRoot();
    const files = await Promise.all(
      Array.from({ length: 5 }, (_, i) => write(root, `${i}.pdf`, `%fake-${i}`))
    );
    const inputs: unknown[] = [];
    const tasks: Array<ReturnType<typeof deferred<{ numPages: number }>>> = [];
    let active = 0;
    let maxActive = 0;
    let releaseDocuments = false;
    const emptyDocument = { numPages: 0 };

    // Inject only the pdfjs loader used by this unit; no module-global mock,
    // production IPC, or cached test double leaks into other test files.
    const fakePdfjs = {
      getDocument: (options: { data: unknown }) => {
        inputs.push(options.data);
        active += 1;
        maxActive = Math.max(maxActive, active);
        const task = deferred<{ numPages: number }>();
        if (releaseDocuments) task.resolve(emptyDocument);
        tasks.push(task);
        return {
          promise: task.promise,
          destroy: async () => {
            active -= 1;
          },
        };
      },
    } as unknown as PdfjsLib;

    const pending = files.map((file) => extractPdfText(file, () => fakePdfjs));
    try {
      await waitFor(() => tasks.length >= 2, 'the first two PDF tasks');
      // Give an incorrectly unbounded implementation a chance to start all five.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const startedBeforeRelease = tasks.length;
      releaseDocuments = true;
      for (const task of tasks) task.resolve(emptyDocument);
      const results = await Promise.all(pending);

      assert.equal(startedBeforeRelease, 2);
      assert.equal(tasks.length, 5);
      assert.equal(maxActive, 2);
      assert.equal(active, 0);
      assert.equal(inputs.length, 5);
      assert.ok(inputs.every((input) => input instanceof Uint8Array));
      assert.ok(inputs.every((input) => !(input instanceof Buffer)));
      assert.deepEqual(results, Array.from({ length: 5 }, () => null));
    } finally {
      // Also unblock queued tasks if an assertion fails before the normal release.
      releaseDocuments = true;
      for (const task of tasks) task.resolve(emptyDocument);
      await Promise.allSettled(pending);
      await cleanup(root);
    }
  });

  it('timeout stops the page loop, cleans the current page, and destroys pdfjs', async () => {
    const root = await tmpRoot();
    const firstText = deferred<{ items: Array<{ str: string }> }>();
    const firstTextStarted = deferred<void>();
    let pageRequests = 0;
    let pageCleanups = 0;
    let destroyCalls = 0;

    const fakePdfjs = {
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 3,
          getPage: async () => {
            pageRequests += 1;
            return {
              getTextContent: () => {
                if (pageRequests === 1) {
                  firstTextStarted.resolve(undefined);
                  return firstText.promise;
                }
                return Promise.resolve({ items: [{ str: 'should not be read' }] });
              },
              cleanup: () => {
                pageCleanups += 1;
              },
            };
          },
        }),
        destroy: async () => {
          destroyCalls += 1;
        },
      }),
    } as unknown as PdfjsLib;

    const pdf = await write(root, 'slow.pdf', '%fake-slow');
    let pending: ReturnType<typeof extractPdfText> | undefined;
    try {
      // Avoid coupling this lifecycle test to Electron's mock-timer scheduler;
      // production keeps the 10 s default.
      pending = extractPdfText(pdf, () => fakePdfjs, 25);
      await firstTextStarted.promise;
      const result = await pending;
      firstText.resolve({ items: [{ str: 'late first-page text' }] });
      // Let the in-flight getTextContent continuation observe the settled flag.
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(result, null);
      assert.equal(pageRequests, 1);
      assert.equal(pageCleanups, 1);
      assert.equal(destroyCalls, 1);
    } finally {
      firstTextStarted.resolve(undefined);
      firstText.resolve({ items: [] });
      if (pending) await Promise.allSettled([pending]);
      await cleanup(root);
    }
  });

  it('bounded destroy waits release both permits so a queued PDF can finish', async () => {
    const root = await tmpRoot();
    const files = await Promise.all(
      Array.from({ length: 3 }, (_, i) => write(root, `stuck-${i}.pdf`, '%fake'))
    );
    let started = 0;
    let destroyCalls = 0;
    const fakePdfjs = {
      getDocument: () => {
        started += 1;
        if (started <= 2) {
          return {
            promise: new Promise<never>(() => undefined),
            destroy: () => {
              destroyCalls += 1;
              return new Promise<void>(() => undefined);
            },
          };
        }
        return {
          promise: Promise.resolve({
            numPages: 1,
            getPage: async () => ({
              getTextContent: async () => ({ items: [{ str: 'recovered' }] }),
              cleanup: () => undefined,
            }),
          }),
          destroy: async () => {
            destroyCalls += 1;
          },
        };
      },
    } as unknown as PdfjsLib;

    const pending = files.map((file) => extractPdfText(file, () => fakePdfjs, 20, 20));
    try {
      await waitFor(() => started === 2, 'both global PDF permits to be occupied');
      // Before the bounded destroy wait, these two calls kept both permits
      // forever and the third extraction never reached getDocument.
      await waitFor(() => started === 3, 'the queued PDF after two stuck destroys');
      assert.deepEqual(await Promise.all(pending), [null, null, 'recovered']);
      assert.equal(destroyCalls, 3);
    } finally {
      await cleanup(root);
    }
  });
});

describe('fulltext buildFulltextIndex (SQLite + FTS5)', () => {
  it('marks an empty directory as initialized after a complete build', async () => {
    const root = await tmpRoot();
    try {
      assert.equal(indexDb.hasFulltext(root), false);
      assert.equal((await buildFulltextIndex(root)).count, 0);
      assert.equal(indexDb.hasFulltext(root), true);
    } finally {
      await cleanup(root);
    }
  });

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
  it('bounds extraction globally across nested directory walks and still indexes every file', async () => {
    const root = await tmpRoot();
    const expectedNames: string[] = [];
    const gates: Array<ReturnType<typeof deferred<void>>> = [];
    let started = 0;
    let active = 0;
    let maxActive = 0;
    let releaseFirstBatch = false;

    for (let branch = 0; branch < 4; branch += 1) {
      const dir = path.join(root, `branch-${branch}`);
      await fsp.mkdir(dir);
      for (let leaf = 0; leaf < 4; leaf += 1) {
        const name = `branch-${branch}-leaf-${leaf}.txt`;
        expectedNames.push(name);
        await write(dir, name, 'real build walk');
      }
    }

    // Four child walks can each reach their per-directory width of four. This
    // controlled extractor holds the global first batch until the assertion.
    const pending = buildFulltextIndex(root, undefined, async (fullPath) => {
      started += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (started <= 8) {
          const gate = deferred<void>();
          gates.push(gate);
          if (releaseFirstBatch) gate.resolve(undefined);
          await gate.promise;
        }
        return {
          text: `nestedneedle ${path.basename(fullPath)}`,
          unreadable: false,
        };
      } finally {
        active -= 1;
      }
    });

    try {
      await waitFor(() => gates.length === 8, 'the global first extraction batch');
      // Nested per-directory limiters used to let all sixteen files enter here.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(started, 8);
      assert.equal(maxActive, 8);

      releaseFirstBatch = true;
      for (const gate of gates) gate.resolve(undefined);
      assert.equal((await pending).count, 16);
      assert.equal(started, 16);
      assert.equal(active, 0);
      assert.equal(maxActive, 8);
      assert.deepEqual(
        names(await searchFulltext(root, 'nestedneedle')),
        [...expectedNames].sort()
      );
    } finally {
      releaseFirstBatch = true;
      for (const gate of gates) gate.resolve(undefined);
      await Promise.allSettled([pending]);
      await cleanup(root);
    }
  });

  it('keeps non-PDF extraction moving while PDF work is queued', async () => {
    const root = await tmpRoot();
    const originalReaddir = fsp.readdir;
    const pdfGates: Array<ReturnType<typeof deferred<void>>> = [];
    const pdfsReady = deferred<void>();
    let pdfStarted = 0;
    let textStarted = 0;
    let releasePdfs = false;
    let pending: ReturnType<typeof buildFulltextIndex> | undefined;

    try {
      // Sibling walks give the text task its own per-directory worker while
      // the PDF walk holds every generic permit in the regression scenario.
      (fsp as { readdir: unknown }).readdir = async (dir: string) => {
        const names = await originalReaddir(dir);
        if (path.basename(dir) === 'z-text') await pdfsReady.promise;
        return names.sort();
      };
      const pdfDir = path.join(root, 'a-pdfs');
      const textDir = path.join(root, 'z-text');
      await fsp.mkdir(pdfDir);
      await fsp.mkdir(textDir);
      for (let index = 0; index < 8; index += 1) {
        await write(pdfDir, `${String(index).padStart(3, '0')}-queued.pdf`, 'placeholder');
      }
      await write(textDir, 'text.txt', 'plain text');

      pending = buildFulltextIndex(root, undefined, async (fullPath, ext) => {
        if (ext !== 'pdf') {
          textStarted += 1;
          return { text: 'text needle', unreadable: false };
        }
        pdfStarted += 1;
        const gate = deferred<void>();
        pdfGates.push(gate);
        if (pdfGates.length === 8) pdfsReady.resolve(undefined);
        if (releasePdfs) gate.resolve(undefined);
        await gate.promise;
        return { text: `pdf needle ${path.basename(fullPath)}`, unreadable: false };
      });

      await waitFor(
        () => pdfGates.length === 8 && textStarted === 1,
        'text extraction to bypass the queued PDF work'
      );
      assert.equal(pdfStarted, 8);
      releasePdfs = true;
      for (const gate of pdfGates) gate.resolve(undefined);
      assert.equal((await pending).count, 9);
      assert.equal(pdfStarted, 8);
      assert.equal(textStarted, 1);
    } finally {
      pdfsReady.resolve(undefined);
      releasePdfs = true;
      for (const gate of pdfGates) gate.resolve(undefined);
      if (pending) await Promise.allSettled([pending]);
      (fsp as { readdir: unknown }).readdir = originalReaddir;
      await cleanup(root);
    }
  });
  it('flushes bounded first-build batches and atomically applies changed/deleted rows', async () => {
    const root = await tmpRoot();
    const originalInsert = indexDb.insertFulltext;
    const originalDelete = indexDb.deleteFulltextPaths;
    const insertBatches: string[][] = [];
    const deleteBatches: string[][] = [];
    try {
      (indexDb as { insertFulltext: unknown }).insertFulltext = async (
        rootPath: string,
        records: Parameters<typeof indexDb.insertFulltext>[1]
      ) => {
        insertBatches.push(records.map((record) => record.path));
        return originalInsert(rootPath, records);
      };
      (indexDb as { deleteFulltextPaths: unknown }).deleteFulltextPaths = async (
        rootPath: string,
        paths: string[]
      ) => {
        deleteBatches.push([...paths]);
        return originalDelete(rootPath, paths);
      };

      for (let i = 0; i < 205; i += 1) {
        const content = i === 0 ? 'oldneedle' : i === 1 ? 'obsolete' : `needle ${i}`;
        await write(root, `f${String(i).padStart(3, '0')}.txt`, content);
      }
      assert.equal((await buildFulltextIndex(root)).count, 205);
      assert.deepEqual(insertBatches.map((batch) => batch.length), [100, 100, 5]);
      assert.equal(insertBatches.flat().length, 205);
      assert.deepEqual(deleteBatches, [[]]);

      await write(root, 'f000.txt', 'precious new');
      const future = new Date(Date.now() + 5_000);
      await fsp.utimes(path.join(root, 'f000.txt'), future, future);
      await fsp.rm(path.join(root, 'f001.txt'));
      assert.equal((await buildFulltextIndex(root)).count, 204);

      assert.deepEqual(insertBatches[insertBatches.length - 1], ['f000.txt']);
      assert.deepEqual(deleteBatches[deleteBatches.length - 1], ['f001.txt']);
      assert.deepEqual(await searchFulltext(root, 'oldneedle'), []);
      assert.deepEqual(names(await searchFulltext(root, 'precious')), ['f000.txt']);
      assert.deepEqual(await searchFulltext(root, 'obsolete'), []);
    } finally {
      (indexDb as { insertFulltext: unknown }).insertFulltext = originalInsert;
      (indexDb as { deleteFulltextPaths: unknown }).deleteFulltextPaths = originalDelete;
      await cleanup(root);
    }
  });

  it('failed batch keeps prior rows, defers deletes, and recovers incrementally', async () => {
    const root = await tmpRoot();
    const originalInsert = indexDb.insertFulltext;
    const originalDelete = indexDb.deleteFulltextPaths;
    try {
      await write(root, 'removed.txt', 'obsolete prior row');
      assert.equal((await buildFulltextIndex(root)).count, 1);
      await fsp.rm(path.join(root, 'removed.txt'));
      for (let i = 0; i < 101; i += 1) {
        await write(root, `n${String(i).padStart(3, '0')}.txt`, `committed ${i}`);
      }

      const attemptSizes: number[] = [];
      const deleteCalls: string[][] = [];
      try {
        (indexDb as { insertFulltext: unknown }).insertFulltext = async (
          rootPath: string,
          records: Parameters<typeof indexDb.insertFulltext>[1]
        ) => {
          attemptSizes.push(records.length);
          if (attemptSizes.length === 2) throw new Error('injected fulltext batch failure');
          return originalInsert(rootPath, records);
        };
        (indexDb as { deleteFulltextPaths: unknown }).deleteFulltextPaths = async (
          rootPath: string,
          paths: string[]
        ) => {
          deleteCalls.push([...paths]);
          return originalDelete(rootPath, paths);
        };

        await assert.rejects(buildFulltextIndex(root), /injected fulltext batch failure/);
        assert.deepEqual(attemptSizes, [100, 1]);
        assert.deepEqual(deleteCalls, [], 'a partial/failed build must not delete prior rows');
        assert.deepEqual(names(await searchFulltext(root, 'obsolete')), ['removed.txt']);
        assert.ok(
          (await searchFulltext(root, 'committed')).length > 0,
          'the first committed batch remains valid incremental progress'
        );
      } finally {
        (indexDb as { insertFulltext: unknown }).insertFulltext = originalInsert;
        (indexDb as { deleteFulltextPaths: unknown }).deleteFulltextPaths = originalDelete;
      }

      // The next successful build reuses committed mtime rows, writes the tail,
      // and only then applies the deletion deferred by the failed build.
      assert.equal((await buildFulltextIndex(root)).count, 101);
      assert.deepEqual(await searchFulltext(root, 'obsolete'), []);
      assert.ok((await searchFulltext(root, 'committed')).length > 0);
    } finally {
      (indexDb as { insertFulltext: unknown }).insertFulltext = originalInsert;
      (indexDb as { deleteFulltextPaths: unknown }).deleteFulltextPaths = originalDelete;
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
