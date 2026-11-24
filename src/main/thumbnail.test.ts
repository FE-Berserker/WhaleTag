import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fsp, existsSync } from 'fs';
import { PDFDocument, rgb } from 'pdf-lib';
import sharp from 'sharp';
import ffmpegStatic from 'ffmpeg-static';
import {
  generateThumbnail,
  loadThumbnail,
  removeThumbnail,
  moveThumbnail,
  copyThumbnail,
  thumbPathFor,
  setFolderBackground,
  folderBackgroundPathFor,
  loadFolderBackground,
} from './thumbnail';
import { THUMBS_DIR } from '../shared/whale-meta';

/** Per-test scratch directory under the OS temp root. */
async function tmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'whale-thumb-'));
}

/** Writes a small solid-color PNG so generateThumbnail has a real image to read. */
async function makePng(filePath: string): Promise<void> {
  await sharp({
    create: {
      width: 24,
      height: 24,
      channels: 3,
      background: { r: 0, g: 128, b: 255 },
    },
  })
    .png()
    .toFile(filePath);
}

/**
 * Writes a tiny video using ffmpeg's testsrc. Falls back to sharp PNG when
 * ffmpeg-static is unavailable, which still lets the non-video tests run.
 */
async function makeVideo(filePath: string): Promise<boolean> {
  // Bind to a local const first: TS does not narrow the default import binding
  // inside the Promise executor below, so `ffmpegStatic` would stay string|null.
  const ffmpegPath = ffmpegStatic;
  if (!ffmpegPath) return false;
  const { execFile } = await import('child_process');
  await new Promise<void>((resolve, reject) => {
    execFile(
      ffmpegPath,
      [
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=2:size=64x64:rate=1',
        '-pix_fmt',
        'yuv420p',
        filePath,
      ],
      (err: Error | null) => (err ? reject(err) : resolve())
    );
  });
  return true;
}

/**
 * Writes a tiny PDF using pdf-lib so generateThumbnail has a real PDF to read.
 */
async function makePdf(filePath: string): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([100, 100]);
  page.drawText('Whale', { x: 10, y: 50, size: 20, color: rgb(0, 0.5, 1) });
  await fsp.writeFile(filePath, await doc.save());
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

type ReadFileAsBuffer = (
  file: string | Buffer | URL,
  options?: BufferEncoding | null
) => Promise<Buffer>;

function readAsBuffer(
  read: typeof fsp.readFile,
  file: string | Buffer | URL,
  options?: BufferEncoding | null
): Promise<Buffer> {
  return (read as unknown as ReadFileAsBuffer)(file, options);
}

describe('image thumbnails (.whale/thumbs/<file>.jpg)', () => {
  it('generates a thumbnail and loads it as a data URL', async () => {
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'a.png');
      await makePng(src);
      await generateThumbnail(src);
      assert.ok(existsSync(thumbPathFor(src)), 'thumb file created');
      assert.ok(
        thumbPathFor(src).includes(`${path.sep}${THUMBS_DIR}${path.sep}`),
        'stored under thumbs/'
      );
      const url = await loadThumbnail(src);
      assert.ok(
        url?.startsWith('data:image/jpeg;base64,'),
        'load returns a jpeg data URL'
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('dedupes concurrent generation of the same file (no rename race)', async () => {
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'a.png');
      await makePng(src);
      // Fire many concurrent generations for the SAME not-yet-thumbnailed file.
      // Before the in-flight dedupe + unique temp names, these collided on one
      // `${target}.${pid}.tmp` and the loser's rename hit ENOENT.
      await Promise.all(
        Array.from({ length: 12 }, () => generateThumbnail(src))
      );
      assert.ok(existsSync(thumbPathFor(src)), 'thumb file created');
      // No stray temp files left behind in the thumbs dir.
      const thumbsDir = path.dirname(thumbPathFor(src));
      const leftovers = (await fsp.readdir(thumbsDir)).filter((n) =>
        n.endsWith('.tmp')
      );
      assert.deepEqual(leftovers, [], 'no leftover .tmp files');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('skips non-image files (no thumbnail written)', async () => {
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'notes.txt');
      await fsp.writeFile(src, 'hello', 'utf8');
      await generateThumbnail(src);
      assert.ok(!existsSync(thumbPathFor(src)), 'no thumb for non-image');
      assert.equal(await loadThumbnail(src), null);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null when no thumbnail exists yet', async () => {
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'absent.png');
      assert.equal(await loadThumbnail(src), null);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('reuses an existing thumbnail when the source is unchanged (mtime)', async () => {
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'a.png');
      await makePng(src);
      // Pin the source mtime in the past so the thumb (written "now") is newer.
      const old = new Date('2020-01-01T00:00:00Z');
      await fsp.utimes(src, old, old);
      await generateThumbnail(src);
      const mtimeAfterFirst = (await fsp.stat(thumbPathFor(src))).mtimeMs;
      // Second generate should short-circuit (thumb.mtime >= src.mtime) and NOT
      // rewrite the file — so its mtime stays identical.
      await generateThumbnail(src);
      const mtimeAfterSecond = (await fsp.stat(thumbPathFor(src))).mtimeMs;
      assert.equal(mtimeAfterFirst, mtimeAfterSecond, 'thumb not rewritten');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('removes a thumbnail', async () => {
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'a.png');
      await makePng(src);
      await generateThumbnail(src);
      await removeThumbnail(src);
      assert.equal(await loadThumbnail(src), null);
      assert.ok(!existsSync(thumbPathFor(src)));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('moves a thumbnail across directories', async () => {
    const srcDir = await tmpDir();
    const dstDir = await tmpDir();
    try {
      const src = path.join(srcDir, 'a.png');
      const dst = path.join(dstDir, 'a.png');
      await makePng(src);
      await generateThumbnail(src);
      await moveThumbnail(src, dst);
      assert.ok(
        (await loadThumbnail(dst))?.startsWith('data:image/jpeg'),
        'thumb moved to destination'
      );
      assert.equal(await loadThumbnail(src), null, 'source thumb gone');
    } finally {
      await fsp.rm(srcDir, { recursive: true, force: true });
      await fsp.rm(dstDir, { recursive: true, force: true });
    }
  });

  it('copies a thumbnail without removing the source', async () => {
    const srcDir = await tmpDir();
    const dstDir = await tmpDir();
    try {
      const src = path.join(srcDir, 'a.png');
      const dst = path.join(dstDir, 'b.png');
      await makePng(src);
      await generateThumbnail(src);
      await copyThumbnail(src, dst);
      assert.ok(
        (await loadThumbnail(src))?.startsWith('data:image/jpeg'),
        'source thumb kept'
      );
      assert.ok(
        (await loadThumbnail(dst))?.startsWith('data:image/jpeg'),
        'destination has a copy'
      );
    } finally {
      await fsp.rm(srcDir, { recursive: true, force: true });
      await fsp.rm(dstDir, { recursive: true, force: true });
    }
  });
});

describe('Font thumbnails (.whale/thumbs/<file>.jpg)', () => {
  it('generates a thumbnail for a TrueType font (.ttf)', async () => {
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'calligraphic.ttf');
      await fsp.copyFile('samples/fonts/calligraphic.ttf', src);
      await generateThumbnail(src);
      assert.ok(existsSync(thumbPathFor(src)), 'ttf thumb file created');
      const url = await loadThumbnail(src);
      assert.ok(
        url?.startsWith('data:image/jpeg;base64,'),
        'ttf thumb loads as jpeg data URL'
      );
      const thumb = await fsp.readFile(thumbPathFor(src));
      assert.ok(thumb.length > 500, 'ttf thumb buffer non-trivial in size');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('generates a thumbnail for a WOFF2 font', async () => {
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'calligraphic.woff2');
      await fsp.copyFile('samples/fonts/calligraphic.woff2', src);
      await generateThumbnail(src);
      assert.ok(existsSync(thumbPathFor(src)), 'woff2 thumb file created');
      const url = await loadThumbnail(src);
      assert.ok(
        url?.startsWith('data:image/jpeg;base64,'),
        'woff2 thumb loads as jpeg data URL'
      );
      const thumb = await fsp.readFile(thumbPathFor(src));
      assert.ok(thumb.length > 500, 'woff2 thumb buffer non-trivial in size');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back silently for a corrupt / unsupported font file', async () => {
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'bogus.ttf');
      await fsp.writeFile(src, 'this is not a font', 'utf8');
      await assert.doesNotReject(
        generateThumbnail(src),
        'corrupt font does not throw'
      );
      assert.equal(
        await loadThumbnail(src),
        null,
        'no thumb written for corrupt font'
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Folder thumbnails (.whale/wst.jpg)', () => {
  it('auto-generates a folder thumbnail from the first thumbnailable file', async () => {
    const dir = await tmpDir();
    try {
      const img = path.join(dir, 'a.png');
      await makePng(img);
      await fsp.writeFile(path.join(dir, 'notes.txt'), 'hello', 'utf8');
      const { loadFolderThumbnail, generateFolderThumbnail, folderThumbPathFor } =
        await import('./thumbnail');
      await generateFolderThumbnail(dir);
      assert.ok(
        existsSync(folderThumbPathFor(dir)),
        'wst.jpg created from first image'
      );
      const url = await loadFolderThumbnail(dir);
      assert.ok(
        url?.startsWith('data:image/jpeg;base64,'),
        'folder thumb loads as jpeg data URL'
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('coalesces same-folder loads into one copy and one read', async (t) => {
    const dir = await tmpDir();
    try {
      const img = path.join(dir, 'a.png');
      await makePng(img);
      // Seed the source thumbnail so the test isolates folder copy + read work.
      await generateThumbnail(img);
      const { loadFolderThumbnail, folderThumbPathFor } = await import('./thumbnail');
      const target = folderThumbPathFor(dir);
      const originalCopy = fsp.copyFile;
      const originalRead = fsp.readFile;
      let copies = 0;
      let reads = 0;
      t.mock.method(
        fsp,
        'copyFile',
        async (
          source: string | Buffer | URL,
          destination: string | Buffer | URL,
          mode?: number
        ) => {
          if (path.resolve(String(destination)) === target) copies += 1;
          await originalCopy(source, destination, mode);
        }
      );
      const read: ReadFileAsBuffer = async (file, options) => {
        if (path.resolve(String(file)) === target) reads += 1;
        return readAsBuffer(originalRead, file, options);
      };
      t.mock.method(fsp, 'readFile', read);

      const pending = Array.from({ length: 8 }, () => loadFolderThumbnail(dir));
      const results = await Promise.all(pending);

      assert.equal(copies, 1, 'only the first caller generates/copies the thumbnail');
      assert.equal(reads, 1, 'all concurrent callers share the same read');
      assert.ok(results[0]?.startsWith('data:image/jpeg;base64,'));
      assert.ok(results.every((result) => result === results[0]));

      // Settlement clears only the in-flight entry; this is not a data cache.
      assert.equal(await loadFolderThumbnail(dir), results[0]);
      assert.equal(copies, 1);
      assert.equal(reads, 2);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('clears a folder thumbnail', async () => {
    const dir = await tmpDir();
    try {
      const img = path.join(dir, 'a.png');
      await makePng(img);
      const {
        generateFolderThumbnail,
        clearFolderThumbnail,
        folderThumbPathFor,
      } = await import('./thumbnail');
      await generateFolderThumbnail(dir);
      assert.ok(existsSync(folderThumbPathFor(dir)));
      await clearFolderThumbnail(dir);
      assert.ok(!existsSync(folderThumbPathFor(dir)), 'wst.jpg removed');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('sets a custom folder thumbnail from an image file', async () => {
    const dir = await tmpDir();
    try {
      const srcDir = await tmpDir();
      try {
        const srcImg = path.join(srcDir, 'custom.png');
        await makePng(srcImg);
        const { setFolderThumbnail, loadFolderThumbnail, folderThumbPathFor } =
          await import('./thumbnail');
        await setFolderThumbnail(dir, srcImg);
        assert.ok(
          !existsSync(thumbPathFor(srcImg)),
          'manual folder picks never write a source-side thumbnail'
        );
        assert.ok(
          existsSync(folderThumbPathFor(dir)),
          'wst.jpg created from custom image'
        );
        const url = await loadFolderThumbnail(dir);
        assert.ok(url?.startsWith('data:image/jpeg;base64,'));
      } finally {
        await fsp.rm(srcDir, { recursive: true, force: true });
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('sets a custom folder thumbnail from a PDF without writing beside the source', async () => {
    const dir = await tmpDir();
    const srcDir = await tmpDir();
    try {
      const src = path.join(srcDir, 'cover.pdf');
      await makePdf(src);
      const { setFolderThumbnail, loadFolderThumbnail, folderThumbPathFor } =
        await import('./thumbnail');
      await setFolderThumbnail(dir, src);
      assert.ok(!existsSync(thumbPathFor(src)), 'PDF source directory stays untouched');
      assert.ok(existsSync(folderThumbPathFor(dir)), 'PDF cover uses the worker encoder');
      assert.ok((await loadFolderThumbnail(dir))?.startsWith('data:image/jpeg;base64,'));
    } finally {
      await fsp.rm(srcDir, { recursive: true, force: true });
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('re-encodes a stale cached source without modifying the source cache', async () => {
    const dir = await tmpDir();
    const srcDir = await tmpDir();
    try {
      const src = path.join(srcDir, 'cover.png');
      await makePng(src);
      await generateThumbnail(src);
      const cachedPath = thumbPathFor(src);
      const oldCache = await fsp.readFile(cachedPath);
      await sharp({
        create: {
          width: 24,
          height: 24,
          channels: 3,
          background: { r: 255, g: 0, b: 0 },
        },
      })
        .png()
        .toFile(src);
      const old = new Date('2000-01-01T00:00:00Z');
      await fsp.utimes(cachedPath, old, old);

      const { setFolderThumbnail, folderThumbPathFor } = await import('./thumbnail');
      await setFolderThumbnail(dir, src);
      const target = await fsp.readFile(folderThumbPathFor(dir));
      assert.notDeepEqual(target, oldCache, 'stale source thumb is not copied');
      assert.deepEqual(await fsp.readFile(cachedPath), oldCache, 'source cache stays untouched');
    } finally {
      await fsp.rm(srcDir, { recursive: true, force: true });
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Folder backgrounds (.whale/wsb.jpg)', () => {
  it('coalesces same-folder background reads without caching the result', async (t) => {
    const dir = await tmpDir();
    const target = folderBackgroundPathFor(dir);
    const contents = 'folder background';
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, contents, 'utf8');
    const originalRead = fsp.readFile;
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read: ReadFileAsBuffer = async (file, options) => {
      if (path.resolve(String(file)) === target) {
        reads += 1;
        await gate;
      }
      return readAsBuffer(originalRead, file, options);
    };
    t.mock.method(fsp, 'readFile', read);
    const pending = Array.from({ length: 6 }, () => loadFolderBackground(dir));
    try {
      await waitFor(() => reads === 1, 'the shared background read');
      assert.equal(reads, 1, 'concurrent callers start only one underlying read');
      release();
      const expected = `data:image/jpeg;base64,${Buffer.from(contents).toString('base64')}`;
      const results = await Promise.all(pending);
      assert.deepEqual(results, Array.from({ length: 6 }, () => expected));

      // A later call must read again rather than reuse a persistent data URL.
      assert.equal(await loadFolderBackground(dir), expected);
      assert.equal(reads, 2);
    } finally {
      release();
      await Promise.allSettled(pending);
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps in-flight background loads isolated by directory', async (t) => {
    const root = await tmpDir();
    const dirA = path.join(root, 'a');
    const dirB = path.join(root, 'b');
    const targetA = folderBackgroundPathFor(dirA);
    const targetB = folderBackgroundPathFor(dirB);
    await fsp.mkdir(path.dirname(targetA), { recursive: true });
    await fsp.mkdir(path.dirname(targetB), { recursive: true });
    await fsp.writeFile(targetA, 'background A');
    await fsp.writeFile(targetB, 'background B');
    const originalRead = fsp.readFile;
    const reads: string[] = [];
    const releases = new Map<string, () => void>();
    const read: ReadFileAsBuffer = async (file, options) => {
      const resolved = path.resolve(String(file));
      if (resolved === targetA || resolved === targetB) {
        reads.push(resolved);
        await new Promise<void>((resolve) => releases.set(resolved, resolve));
      }
      return readAsBuffer(originalRead, file, options);
    };
    t.mock.method(fsp, 'readFile', read);
    const pending = [loadFolderBackground(dirA), loadFolderBackground(dirB)];
    try {
      await waitFor(() => reads.length === 2, 'both directories to read independently');
      assert.deepEqual(reads.sort(), [targetA, targetB].sort());
      for (const release of releases.values()) release();
      assert.deepEqual(await Promise.all(pending), [
        `data:image/jpeg;base64,${Buffer.from('background A').toString('base64')}`,
        `data:image/jpeg;base64,${Buffer.from('background B').toString('base64')}`,
      ]);
    } finally {
      for (const release of releases.values()) release();
      await Promise.allSettled(pending);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('propagates a shared background read failure and permits a retry', async (t) => {
    const dir = await tmpDir();
    const target = folderBackgroundPathFor(dir);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, 'recovered background');
    const originalRead = fsp.readFile;
    let attempts = 0;
    const read: ReadFileAsBuffer = async (file, options) => {
      if (path.resolve(String(file)) === target) {
        attempts += 1;
        if (attempts === 1) throw new Error('transient background read failure');
      }
      return readAsBuffer(originalRead, file, options);
    };
    t.mock.method(fsp, 'readFile', read);
    try {
      const pending = [loadFolderBackground(dir), loadFolderBackground(dir)];
      const rejected = await Promise.allSettled(pending);
      assert.equal(attempts, 1, 'the failed read is shared');
      for (const result of rejected) {
        assert.equal(result.status, 'rejected');
        if (result.status === 'rejected') {
          assert.match(String(result.reason), /transient background read failure/);
        }
      }

      const url = await loadFolderBackground(dir);
      assert.equal(attempts, 2, 'failure is evicted and the next call retries');
      assert.equal(
        url,
        `data:image/jpeg;base64,${Buffer.from('recovered background').toString('base64')}`
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('bounds sharp background encodes to the shared four-permit limit', async () => {
    const root = await tmpDir();
    let started = 0;
    let active = 0;
    let maxActive = 0;
    let allowCompletion = false;
    const releases: Array<() => void> = [];
    const releaseAll = () => {
      for (const release of releases.splice(0)) release();
    };
    const fakeSharp = (() => {
      const pipeline = {
        rotate: () => pipeline,
        resize: () => pipeline,
        jpeg: () => pipeline,
        toBuffer: () => {
          started += 1;
          active += 1;
          maxActive = Math.max(maxActive, active);
          if (allowCompletion) {
            active -= 1;
            return Promise.resolve(Buffer.from('background'));
          }
          return new Promise<Buffer>((resolve) => {
            releases.push(() => {
              active -= 1;
              resolve(Buffer.from('background'));
            });
          });
        },
      };
      return pipeline;
    }) as unknown as typeof sharp;

    const targets: string[] = [];
    const pending = Array.from({ length: 10 }, (_, i) => {
      const dir = path.join(root, `folder-${i}`);
      targets.push(folderBackgroundPathFor(dir));
      return setFolderBackground(dir, path.join(root, `source-${i}.png`), () => fakeSharp);
    });
    try {
      await waitFor(() => started === 4, 'the first four background encodes');
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(started, 4, 'no encode starts without a global permit');

      allowCompletion = true;
      releaseAll();
      await Promise.all(pending);
      assert.equal(started, 10);
      assert.equal(maxActive, 4);
      assert.equal(active, 0);
      assert.ok(targets.every((target) => existsSync(target)));
    } finally {
      allowCompletion = true;
      releaseAll();
      await Promise.allSettled(pending);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('releases a permit after an encode error so a queued encode can run', async () => {
    const root = await tmpDir();
    let started = 0;
    let active = 0;
    const releases: Array<() => void> = [];
    const releaseAll = () => {
      for (const release of releases.splice(0)) release();
    };
    const fakeSharp = ((sourcePath: string) => {
      const shouldFail = path.basename(sourcePath) === 'source-0.png';
      const pipeline = {
        rotate: () => pipeline,
        resize: () => pipeline,
        jpeg: () => pipeline,
        toBuffer: () => {
          const id = ++started;
          active += 1;
          if (shouldFail) {
            active -= 1;
            return Promise.reject(new Error('intentional background encode failure'));
          }
          if (id <= 4) {
            return new Promise<Buffer>((resolve) => {
              releases.push(() => {
                active -= 1;
                resolve(Buffer.from('background'));
              });
            });
          }
          active -= 1;
          return Promise.resolve(Buffer.from('recovered'));
        },
      };
      return pipeline;
    }) as unknown as typeof sharp;

    const pending = Array.from({ length: 4 }, (_, i) =>
      setFolderBackground(
        path.join(root, `folder-${i}`),
        path.join(root, `source-${i}.png`),
        () => fakeSharp
      )
    );
    const firstRejected = pending[0].then(
      () => assert.fail('the first background encode should reject'),
      (error: unknown) => {
        assert.match(String(error), /intentional background encode failure/);
      }
    );
    let fifth: Promise<void> | undefined;
    try {
      await waitFor(() => started === 4, 'all four permits to be occupied');
      await firstRejected;
      fifth = setFolderBackground(
        path.join(root, 'folder-4'),
        path.join(root, 'source-4.png'),
        () => fakeSharp
      );
      // The other three encodes remain blocked. Only the failed operation's
      // released permit can let this fifth call reach sharp.
      await waitFor(() => started === 5, 'a queued encode after the failure');
      assert.equal(active, 3);
      releaseAll();
      await Promise.all([...pending.slice(1), fifth]);
      assert.ok(existsSync(folderBackgroundPathFor(path.join(root, 'folder-4'))));
    } finally {
      releaseAll();
      await Promise.allSettled(pending);
      if (started === 5 && fifth) await Promise.allSettled([fifth]);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe('PDF thumbnails (.whale/thumbs/<file>.jpg)', () => {
  it('generates a first-page thumbnail for a PDF and loads it', async () => {
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'doc.pdf');
      await makePdf(src);
      await generateThumbnail(src);
      assert.ok(existsSync(thumbPathFor(src)), 'pdf thumb file created');
      const url = await loadThumbnail(src);
      assert.ok(
        url?.startsWith('data:image/jpeg;base64,'),
        'pdf thumb loads as jpeg data URL'
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Writes a minimal SVG with explicit `width` / `height` (the "happy path" —
 * most exported SVGs from design tools carry both). The shape is just a
 * filled circle so a JPEG output is non-empty even at thumb size.
 */
async function makeSvg(filePath: string): Promise<void> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120">
  <rect width="120" height="120" fill="#1d4e89"/>
  <circle cx="60" cy="60" r="44" fill="#ffd166" stroke="#0b1f3a" stroke-width="4"/>
</svg>`;
  await fsp.writeFile(filePath, svg, 'utf8');
}

describe('SVG thumbnails (.whale/thumbs/<file>.jpg)', () => {
  it('rasterizes an SVG with explicit width/height and loads the JPEG', async () => {
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'icon.svg');
      await makeSvg(src);
      await generateThumbnail(src);
      assert.ok(existsSync(thumbPathFor(src)), 'svg thumb file created');
      const url = await loadThumbnail(src);
      assert.ok(
        url?.startsWith('data:image/jpeg;base64,'),
        'svg thumb loads as jpeg data URL'
      );
      // The thumbnail is real image bytes, not an empty stub.
      const thumb = await fsp.readFile(thumbPathFor(src));
      assert.ok(thumb.length > 500, 'thumb buffer non-trivial in size');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('handles viewBox-only SVGs without explicit width/height', async () => {
    // Common case for icons and exports from design tools: only a viewBox,
    // no width/height. librsvg uses the viewBox as the default rasterization
    // size. The fixed sample `samples/svg/viewbox-only.svg` covers this — copy
    // it into the scratch dir so the test is self-contained.
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'viewbox-only.svg');
      await fsp.copyFile('samples/svg/viewbox-only.svg', src);
      await generateThumbnail(src);
      assert.ok(
        existsSync(thumbPathFor(src)),
        'viewBox-only svg produces a thumb'
      );
      const url = await loadThumbnail(src);
      assert.ok(
        url?.startsWith('data:image/jpeg;base64,'),
        'viewBox-only thumb loads as jpeg data URL'
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('rasterizes a rich real-world SVG (gradients + paths + text)', async () => {
    // `samples/svg/whale-test.svg` exercises gradient defs, polylines, paths,
    // and text rendering. If librsvg chokes on any of those, this fails.
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'whale-test.svg');
      await fsp.copyFile('samples/svg/whale-test.svg', src);
      await generateThumbnail(src);
      const url = await loadThumbnail(src);
      assert.ok(
        url?.startsWith('data:image/jpeg;base64,'),
        'complex svg thumb loads as jpeg data URL'
      );
      const thumb = await fsp.readFile(thumbPathFor(src));
      assert.ok(thumb.length > 2000, 'complex svg thumb is non-trivial');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back silently for malformed / empty SVGs', async () => {
    // Malformed SVGs must not surface as IPC errors — `kind === 'svg'` is in
    // the silent-fallback list in `doGenerateThumbnail`, so generateThumbnail
    // resolves cleanly and leaves no thumbnail behind.
    const dir = await tmpDir();
    try {
      // Pure garbage — sharp throws "unsupported image format".
      const garbage = path.join(dir, 'garbage.svg');
      await fsp.writeFile(garbage, '<<not really svg at all>>', 'utf8');
      await assert.doesNotReject(
        generateThumbnail(garbage),
        'malformed svg does not throw'
      );
      assert.equal(
        await loadThumbnail(garbage),
        null,
        'no thumb written for malformed svg'
      );

      // Empty <svg></svg> — sharp throws "bad dimensions" because there is
      // no viewBox to infer size from.
      const empty = path.join(dir, 'empty.svg');
      await fsp.writeFile(empty, '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');
      await assert.doesNotReject(
        generateThumbnail(empty),
        'dimensionless svg does not throw'
      );
      assert.equal(
        await loadThumbnail(empty),
        null,
        'no thumb written for dimensionless svg'
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('does not follow external <image href> URLs (local-first)', async () => {
    // sharp's librsvg does NOT follow remote image refs by default — we
    // don't enable `unlimited: true` anywhere. An SVG that references a
    // remote image should still rasterize (the embedded `<image>` is just
    // skipped or fails the rasterization) but must not trigger any network
    // fetch. We can't observe "no network" from here, so we only assert
    // that the call resolves without throwing — either librsvg substitutes
    // a missing image (silent success) or it errors (which falls into the
    // kind-svg silent-fallback path).
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'external-ref.svg');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="60" height="60">
  <image xlink:href="https://example.invalid/missing.png" width="60" height="60"/>
</svg>`;
      await fsp.writeFile(src, svg, 'utf8');
      await assert.doesNotReject(
        generateThumbnail(src),
        'external-ref svg does not throw to the caller'
      );
      // Whether a thumb is written depends on librsvg behavior for missing
      // images; either outcome is acceptable as long as we don't throw.
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});


describe('video thumbnails (.whale/thumbs/<file>.jpg)', () => {
  it('generates a first-frame thumbnail for a video and loads it', async () => {
    if (!ffmpegStatic) return;
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'clip.mp4');
      assert.ok(await makeVideo(src), 'ffmpeg available');
      await generateThumbnail(src);
      assert.ok(existsSync(thumbPathFor(src)), 'video thumb file created');
      const url = await loadThumbnail(src);
      assert.ok(
        url?.startsWith('data:image/jpeg;base64,'),
        'video thumb loads as jpeg data URL'
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('dedupes concurrent generation of the same video', async () => {
    if (!ffmpegStatic) return;
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'clip.mp4');
      assert.ok(await makeVideo(src), 'ffmpeg available');
      await Promise.all(
        Array.from({ length: 6 }, () => generateThumbnail(src))
      );
      assert.ok(existsSync(thumbPathFor(src)), 'video thumb file created');
      const thumbsDir = path.dirname(thumbPathFor(src));
      const leftovers = (await fsp.readdir(thumbsDir)).filter((n) =>
        n.endsWith('.tmp')
      );
      assert.deepEqual(leftovers, [], 'no leftover .tmp files');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
