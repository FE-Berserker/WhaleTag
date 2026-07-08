import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fsp, existsSync } from 'fs';
import { zipSync } from 'fflate';
import sharp from 'sharp';
import { extractEbookCover } from './ebook-cover';
import {
  generateThumbnail,
  loadThumbnail,
  thumbPathFor,
} from './thumbnail';

/** Per-test scratch directory under the OS temp root. */
async function tmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'whale-ebook-'));
}

/** A small solid-color PNG as bytes, to stand in for an embedded cover image. */
async function makeCoverPng(
  rgb: { r: number; g: number; b: number } = { r: 10, g: 200, b: 120 }
): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width: 16, height: 24, channels: 3, background: rgb },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

const u8 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));

describe('extractEbookCover — EPUB', () => {
  it('finds an EPUB3 cover-image (properties="cover-image")', async () => {
    const cover = await makeCoverPng();
    const opf = `<?xml version="1.0"?>
      <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
        <manifest>
          <item id="c" href="cover.png" media-type="image/png" properties="cover-image"/>
          <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml"/>
        </manifest>
      </package>`;
    const epub = zipSync({
      'META-INF/container.xml': u8(
        `<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
      ),
      'OEBPS/content.opf': u8(opf),
      'OEBPS/cover.png': cover,
    });
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'book.epub');
      await fsp.writeFile(src, epub);
      const out = await extractEbookCover(src);
      assert.deepEqual(new Uint8Array(out), new Uint8Array(cover));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('finds an EPUB2 cover via <meta name="cover">', async () => {
    const cover = await makeCoverPng({ r: 200, g: 30, b: 30 });
    const opf = `<?xml version="1.0"?>
      <package xmlns="http://www.idpf.org/2007/opf" version="2.0">
        <metadata><meta name="cover" content="cover-img"/></metadata>
        <manifest>
          <item id="cover-img" href="images/cover.png" media-type="image/png"/>
        </manifest>
      </package>`;
    const epub = zipSync({
      'META-INF/container.xml': u8(
        `<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`
      ),
      'content.opf': u8(opf),
      'images/cover.png': cover,
    });
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'book2.epub');
      await fsp.writeFile(src, epub);
      const out = await extractEbookCover(src);
      assert.deepEqual(new Uint8Array(out), new Uint8Array(cover));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('follows a guide cover page to its embedded <img>', async () => {
    const cover = await makeCoverPng({ r: 20, g: 20, b: 220 });
    const opf = `<?xml version="1.0"?>
      <package xmlns="http://www.idpf.org/2007/opf" version="2.0">
        <manifest>
          <item id="coverpage" href="text/cover.xhtml" media-type="application/xhtml+xml"/>
        </manifest>
        <guide><reference type="cover" title="Cover" href="text/cover.xhtml"/></guide>
      </package>`;
    const epub = zipSync({
      'META-INF/container.xml': u8(
        `<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`
      ),
      'content.opf': u8(opf),
      'text/cover.xhtml': u8(
        `<html><body><img src="../images/c.png" alt="cover"/></body></html>`
      ),
      'images/c.png': cover,
    });
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'guide.epub');
      await fsp.writeFile(src, epub);
      const out = await extractEbookCover(src);
      assert.deepEqual(new Uint8Array(out), new Uint8Array(cover));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects an EPUB with no cover or images', async () => {
    const opf = `<?xml version="1.0"?>
      <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
        <manifest>
          <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml"/>
        </manifest>
      </package>`;
    const epub = zipSync({
      'META-INF/container.xml': u8(
        `<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`
      ),
      'content.opf': u8(opf),
      'nav.xhtml': u8('<html></html>'),
    });
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'nocover.epub');
      await fsp.writeFile(src, epub);
      await assert.rejects(extractEbookCover(src));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('extractEbookCover — CBZ', () => {
  it('returns the first page by natural sort', async () => {
    const first = await makeCoverPng({ r: 1, g: 2, b: 3 });
    const other = await makeCoverPng({ r: 9, g: 9, b: 9 });
    // Insertion order is intentionally out of order; "01" must win over "10".
    const cbz = zipSync({
      '10.png': other,
      '02.png': other,
      '01.png': first,
      'ReadMe.txt': u8('not an image'),
    });
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'comic.cbz');
      await fsp.writeFile(src, cbz);
      const out = await extractEbookCover(src);
      assert.deepEqual(new Uint8Array(out), new Uint8Array(first));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('extractEbookCover — FB2', () => {
  it('decodes the base64 <binary> referenced by <coverpage>', async () => {
    const cover = await makeCoverPng({ r: 100, g: 100, b: 10 });
    const b64 = Buffer.from(cover).toString('base64');
    const fb2 = `<?xml version="1.0" encoding="utf-8"?>
      <FictionBook>
        <description><title-info>
          <coverpage><image l:href="#cover.jpg"/></coverpage>
        </title-info></description>
        <binary id="cover.jpg" content-type="image/jpeg">${b64}</binary>
      </FictionBook>`;
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'book.fb2');
      await fsp.writeFile(src, fb2, 'utf8');
      const out = await extractEbookCover(src);
      assert.deepEqual(new Uint8Array(out), new Uint8Array(cover));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Builds a minimal but spec-valid MOBI: a PalmDB with 3 records — record 0
 * carries the PalmDOC+MOBI+EXTH headers (firstImageIndex=2, EXTH 201
 * coverOffset=0), record 1 is filler, record 2 is the cover image.
 */
function buildMobi(cover: Uint8Array): Buffer {
  const numRecords = 3;
  const mobiHeaderLen = 232;
  const exthStart = 0x10 + mobiHeaderLen; // 248
  const exthLen = 24; // 12 header + one 12-byte record
  const rec0 = Buffer.alloc(exthStart + exthLen); // 272
  rec0.writeUInt16BE(1, 0); // PalmDOC: compression = none(1)
  rec0.write('MOBI', 16, 'latin1');
  rec0.writeUInt32BE(mobiHeaderLen, 0x14);
  rec0.writeUInt32BE(2, 0x6c); // firstImageIndex
  rec0.writeUInt32BE(0x40, 0x80); // EXTH-present flag
  rec0.write('EXTH', exthStart, 'latin1');
  rec0.writeUInt32BE(exthLen, exthStart + 4);
  rec0.writeUInt32BE(1, exthStart + 8); // EXTH record count
  rec0.writeUInt32BE(201, exthStart + 12); // type = CoverOffset
  rec0.writeUInt32BE(12, exthStart + 16); // record length
  rec0.writeUInt32BE(0, exthStart + 20); // coverOffset = 0

  const rec1 = Buffer.from('filler text');
  const records = [rec0, rec1, Buffer.from(cover)];

  const header = Buffer.alloc(78);
  header.write('test', 0, 'latin1');
  header.write('BOOK', 60, 'latin1');
  header.write('MOBI', 64, 'latin1');
  header.writeUInt16BE(numRecords, 0x4c);

  const table = Buffer.alloc(numRecords * 8);
  let offset = 78 + numRecords * 8;
  records.forEach((rec, i) => {
    table.writeUInt32BE(offset, i * 8);
    offset += rec.length;
  });

  return Buffer.concat(
    [header, table, ...records] as unknown as readonly Uint8Array[]
  );
}

describe('extractEbookCover — MOBI', () => {
  it('extracts the cover via EXTH record 201', async () => {
    const cover = await makeCoverPng({ r: 50, g: 60, b: 70 });
    const mobi = buildMobi(cover);
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'book.mobi');
      // Buffer→writeFile TS 5.9 friction, same as atomic-write.ts.
      await fsp.writeFile(src, mobi as never);
      const out = await extractEbookCover(src);
      assert.deepEqual(new Uint8Array(out), new Uint8Array(cover));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('ebook thumbnails (end-to-end)', () => {
  it('generates a .whale/thumbs/<file>.jpg from an epub cover', async () => {
    const cover = await makeCoverPng();
    const epub = zipSync({
      'META-INF/container.xml': u8(
        `<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`
      ),
      'content.opf': u8(
        `<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="c" href="cover.png" media-type="image/png" properties="cover-image"/></manifest></package>`
      ),
      'cover.png': cover,
    });
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'e2e.epub');
      await fsp.writeFile(src, epub);
      await generateThumbnail(src);
      assert.ok(existsSync(thumbPathFor(src)), 'thumb file created');
      const url = await loadThumbnail(src);
      assert.ok(
        url?.startsWith('data:image/jpeg;base64,'),
        'thumb loads as jpeg data URL'
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves no thumbnail for a coverless ebook (no throw)', async () => {
    const epub = zipSync({
      'META-INF/container.xml': u8(
        `<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`
      ),
      'content.opf': u8(
        `<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml"/></manifest></package>`
      ),
      'nav.xhtml': u8('<html></html>'),
    });
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'bare.epub');
      await fsp.writeFile(src, epub);
      await assert.doesNotReject(generateThumbnail(src));
      assert.equal(await loadThumbnail(src), null, 'no thumb created');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
