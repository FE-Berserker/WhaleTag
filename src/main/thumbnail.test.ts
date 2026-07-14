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
  isSofficeAvailable,
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
  if (!ffmpegStatic) return false;
  const { execFile } = await import('child_process');
  await new Promise<void>((resolve, reject) => {
    execFile(
      ffmpegStatic,
      [
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=2:size=64x64:rate=1',
        '-pix_fmt',
        'yuv420p',
        filePath,
      ],
      (err) => (err ? reject(err) : resolve())
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

describe('Office thumbnails (.whale/thumbs/<file>.jpg)', () => {
  it('silently skips Office files when LibreOffice is unavailable', async () => {
    if (await isSofficeAvailable()) {
      // This machine has LibreOffice installed, so the "unavailable" scenario
      // cannot be exercised here. The conversion path is covered by manual/dev
      // testing; this test guards the fallback path on machines without it.
      return;
    }
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'report.docx');
      // Not a real Office file — soffice conversion will fail (or soffice is
      // simply not installed). generateThumbnail must not throw; it should just
      // leave no thumbnail behind so the UI falls back to a file-type icon.
      await fsp.writeFile(src, 'fake docx content', 'utf8');
      await assert.doesNotReject(generateThumbnail(src));
      assert.equal(await loadThumbnail(src), null, 'no thumb created');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Font thumbnails (.whale/thumbs/<file>.jpg)', () => {
  it('generates a thumbnail for a TrueType font (.ttf)', async () => {
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'calligraphic.ttf');
      await fsp.copyFile('Test/fonts/calligraphic.ttf', src);
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
      await fsp.copyFile('Test/fonts/calligraphic.woff2', src);
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
    // size. The fixed sample `Test/svg/viewbox-only.svg` covers this — copy
    // it into the scratch dir so the test is self-contained.
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'viewbox-only.svg');
      await fsp.copyFile('Test/svg/viewbox-only.svg', src);
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
    // `Test/svg/whale-test.svg` exercises gradient defs, polylines, paths,
    // and text rendering. If librsvg chokes on any of those, this fails.
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'whale-test.svg');
      await fsp.copyFile('Test/svg/whale-test.svg', src);
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
