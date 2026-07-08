import path from 'path';
import os from 'os';
import fs, { promises as fsp } from 'fs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, gzipSync } from 'fflate';
import {
  listArchive,
  readArchiveEntry,
  extractArchive,
  sevenZipBinary,
  parseSevenZipList,
} from './archive';
import { setAllowedRoots } from './allowed-roots';

async function makeTempDir(prefix: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function writeUstarTar(files: Array<{ name: string; content: Uint8Array }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  for (const file of files) {
    const header = new Uint8Array(512);
    const nameBytes = encoder.encode(file.name);
    header.set(nameBytes.slice(0, 99), 0);
    // mode '100644' octal
    const mode = '0000644 ';
    header.set(encoder.encode(mode), 100);
    header.set(encoder.encode('0001750 '), 108); // uid
    header.set(encoder.encode('0001750 '), 116); // gid
    const sizeStr = file.content.length.toString(8).padStart(11, '0') + ' ';
    header.set(encoder.encode(sizeStr), 124);
    const mtimeStr = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + ' ';
    header.set(encoder.encode(mtimeStr), 136);
    header[156] = 0x30; // regular file
    header.set(encoder.encode('ustar  \0'), 257);
    // chksum placeholder then compute
    header.set(encoder.encode('        '), 148);
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += header[i];
    const chksum = sum.toString(8).padStart(6, '0') + '\0 ';
    header.set(encoder.encode(chksum), 148);
    blocks.push(header);
    const paddedSize = Math.ceil(file.content.length / 512) * 512;
    const block = new Uint8Array(paddedSize);
    block.set(file.content);
    blocks.push(block);
  }
  // Two zero blocks mark end of archive.
  blocks.push(new Uint8Array(512));
  blocks.push(new Uint8Array(512));
  const total = blocks.reduce((acc, b) => acc + b.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of blocks) {
    out.set(b, offset);
    offset += b.length;
  }
  return out;
}

describe('archive decoder', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await makeTempDir('whale-archive-test-');
    setAllowedRoots([tmpDir]);
  });

  after(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  });

  describe('ZIP via fflate', () => {
    it('lists zip entries', async () => {
      const data = zipSync({
        'readme.txt': new TextEncoder().encode('hello'),
        'folder/nested.json': new TextEncoder().encode('{"a":1}'),
      });
      const src = path.join(tmpDir, 'sample.zip');
      await fsp.writeFile(src, data);
      const { entries, truncated } = await listArchive(src);
      assert.equal(truncated, false);
      const paths = entries.map((e) => e.path).sort();
      assert.deepEqual(paths, ['folder/nested.json', 'readme.txt']);
    });

    it('reads a zip entry', async () => {
      const data = zipSync({
        'readme.txt': new TextEncoder().encode('hello world'),
      });
      const src = path.join(tmpDir, 'read.zip');
      await fsp.writeFile(src, data);
      const result = await readArchiveEntry(src, 'readme.txt');
      assert.ok(result);
      assert.equal(result!.size, 11);
      assert.equal(atob(result!.base64), 'hello world');
    });

    it('extracts zip entries safely', async () => {
      const data = zipSync({
        'safe.txt': new TextEncoder().encode('safe'),
        '../evil.txt': new TextEncoder().encode('evil'),
      });
      const src = path.join(tmpDir, 'slip.zip');
      const dest = path.join(tmpDir, 'zip-out');
      await fsp.writeFile(src, data);
      const { written, skipped, errors } = await extractArchive(src, dest);
      assert.equal(written, 1);
      assert.equal(skipped.length, 1);
      assert.equal(errors.length, 0);
      assert.equal(existsSync(path.join(dest, 'safe.txt')), true);
      assert.equal(existsSync(path.join(tmpDir, 'evil.txt')), false);
    });
  });

  describe('TAR via fflate', () => {
    it('lists tar entries', async () => {
      const tar = writeUstarTar([
        { name: 'a.txt', content: new TextEncoder().encode('a') },
        { name: 'dir/b.txt', content: new TextEncoder().encode('b') },
      ]);
      const src = path.join(tmpDir, 'sample.tar');
      await fsp.writeFile(src, tar);
      const { entries } = await listArchive(src);
      const paths = entries.map((e) => e.path).sort();
      assert.deepEqual(paths, ['a.txt', 'dir/b.txt']);
    });

    it('reads a tar entry', async () => {
      const tar = writeUstarTar([
        { name: 'data.bin', content: new Uint8Array([0x00, 0x01, 0x02]) },
      ]);
      const src = path.join(tmpDir, 'read.tar');
      await fsp.writeFile(src, tar);
      const result = await readArchiveEntry(src, 'data.bin');
      assert.ok(result);
      assert.equal(result!.size, 3);
    });

    it('extracts tar entries and skips traversal', async () => {
      const tar = writeUstarTar([
        { name: 'ok.txt', content: new TextEncoder().encode('ok') },
        { name: '../../escape.txt', content: new TextEncoder().encode('escape') },
      ]);
      const src = path.join(tmpDir, 'slip.tar');
      const dest = path.join(tmpDir, 'tar-out');
      await fsp.writeFile(src, tar);
      const { written, skipped } = await extractArchive(src, dest);
      assert.equal(written, 1);
      assert.equal(skipped.length, 1);
      assert.equal(existsSync(path.join(dest, 'ok.txt')), true);
    });
  });

  describe('TGZ via fflate', () => {
    it('lists tgz entries', async () => {
      const tar = writeUstarTar([{ name: 'gzipped.txt', content: new TextEncoder().encode('gz') }]);
      const tgz = gzipSync(tar);
      const src = path.join(tmpDir, 'sample.tgz');
      await fsp.writeFile(src, tgz);
      const { entries } = await listArchive(src);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].path, 'gzipped.txt');
    });
  });

  describe('maxEntries truncation', () => {
    it('truncates when entries exceed maxEntries', async () => {
      const files: Record<string, Uint8Array> = {};
      for (let i = 0; i < 5; i += 1) {
        files[`file${i}.txt`] = new TextEncoder().encode(String(i));
      }
      const data = zipSync(files);
      const src = path.join(tmpDir, 'trunc.zip');
      await fsp.writeFile(src, data);
      const { entries, truncated } = await listArchive(src, { maxEntries: 2 });
      assert.equal(entries.length, 2);
      assert.equal(truncated, true);
    });
  });

  describe('7za list parser', () => {
    it('parses 7za l -slt output', () => {
      const output = `
7-Zip (a) 24.09 : Copyright (c) 1999-2024 Igor Pavlov : 2024-11-29

Scanning the drive for archives:



Listing archive: test.7z

--
Path = test.7z
Type = 7z
Physical Size = 1234
Headers Size = 234
Method = LZMA2:12
Solid = -
Blocks = 1

----------
Path = doc.txt
Size = 100
Packed Size = 50
Modified = 2024-01-01 10:00:00
Attributes = -rw-r--r--
CRC = 1234ABCD
Encrypted = -
Method = LZMA2:12
Block = 0

Path = subdir
Folder = +
Size = 0
Packed Size = 0
Modified = 2024-01-01 10:00:00
Attributes = drwxr-xr-x

Path = subdir/image.png
Size = 200
Packed Size = 80
Modified = 2024-01-01 10:00:00
Attributes = -rw-r--r--
CRC = ABCD1234
`;
      const entries = parseSevenZipList(output, 'test.7z');
      assert.equal(entries.length, 3);
      assert.equal(entries[0].path, 'doc.txt');
      assert.equal(entries[0].size, 100);
      assert.equal(entries[0].compressedSize, 50);
      assert.equal(entries[0].isDir, false);
      assert.equal(entries[1].path, 'subdir');
      assert.equal(entries[1].isDir, true);
      assert.equal(entries[2].path, 'subdir/image.png');
      assert.equal(entries[2].isDir, false);
    });
  });

  describe('7z via 7zip-bin', () => {
    it('lists, reads and extracts a 7z archive', async () => {
      const sevenZip = require('7zip-bin');
      const src = path.join(tmpDir, 'sample.7z');
      const dest = path.join(tmpDir, '7z-out');
      // Create a 7z archive with the bundled 7za binary.
      const fileA = path.join(tmpDir, 'a.txt');
      const fileB = path.join(tmpDir, 'sub', 'b.txt');
      await fsp.mkdir(path.dirname(fileB), { recursive: true });
      await fsp.writeFile(fileA, 'hello 7z');
      await fsp.writeFile(fileB, 'nested');
      const { execFileSync } = require('child_process');
      execFileSync(sevenZip.path7za, ['a', '-y', src, fileA, fileB], { timeout: 30000 });

      const { entries, truncated } = await listArchive(src);
      assert.equal(truncated, false);
      const paths = entries.map((e) => e.path).sort();
      assert.deepEqual(paths, ['a.txt', 'b.txt']);

      const content = await readArchiveEntry(src, 'a.txt');
      assert.ok(content);
      assert.equal(atob(content!.base64), 'hello 7z');

      const { written, skipped, errors } = await extractArchive(src, dest);
      assert.equal(written, 2);
      assert.equal(skipped.length, 0);
      assert.equal(errors.length, 0);
      assert.equal(await fsp.readFile(path.join(dest, 'a.txt'), 'utf8'), 'hello 7z');
      assert.equal(await fsp.readFile(path.join(dest, 'b.txt'), 'utf8'), 'nested');
    });
  });

  describe('sevenZipBinary detection', () => {
    it('returns explicit override first', () => {
      const override = path.join(tmpDir, 'my-7za');
      fs.writeFileSync(override, '#!/bin/sh\n');
      assert.equal(sevenZipBinary(override), override);
    });

    it('returns WHALE_7ZA_PATH when file exists', () => {
      const envPath = path.join(tmpDir, 'env-7za');
      fs.writeFileSync(envPath, '#!/bin/sh\n');
      const original = process.env.WHALE_7ZA_PATH;
      process.env.WHALE_7ZA_PATH = envPath;
      try {
        assert.equal(sevenZipBinary(null), envPath);
      } finally {
        if (original === undefined) delete process.env.WHALE_7ZA_PATH;
        else process.env.WHALE_7ZA_PATH = original;
      }
    });
  });
});

function existsSync(p: string): boolean {
  return fs.existsSync(p);
}
