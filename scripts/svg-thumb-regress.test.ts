// Focused regression test for the SVG thumbnail pipeline — extracted from
// thumbnail.test.ts so it can be run independently during development.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { generateThumbnail, loadThumbnail, thumbPathFor } from '../src/main/thumbnail';

async function tmpDir() { return fsp.mkdtemp(path.join(os.tmpdir(), 'whale-svg-')); }

async function makeSvg(p: string) {
  await fsp.writeFile(p, `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#1d4e89"/><circle cx="60" cy="60" r="44" fill="#ffd166"/></svg>`, 'utf8');
}

describe('SVG thumbnail regression', () => {
  it('basic SVG → JPEG thumb', async () => {
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'a.svg');
      await makeSvg(src);
      await generateThumbnail(src);
      assert.ok(existsSync(thumbPathFor(src)));
      const url = await loadThumbnail(src);
      assert.ok(url?.startsWith('data:image/jpeg;base64,'));
    } finally { await fsp.rm(dir, { recursive: true, force: true }); }
  });
  it('viewBox-only SVG (Test/svg/viewbox-only.svg) → JPEG thumb', async () => {
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'vb.svg');
      await fsp.copyFile('Test/svg/viewbox-only.svg', src);
      await generateThumbnail(src);
      assert.ok(existsSync(thumbPathFor(src)));
    } finally { await fsp.rm(dir, { recursive: true, force: true }); }
  });
  it('real-world SVG (Test/svg/whale-test.svg) → JPEG thumb', async () => {
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'whale.svg');
      await fsp.copyFile('Test/svg/whale-test.svg', src);
      await generateThumbnail(src);
      const url = await loadThumbnail(src);
      assert.ok(url?.startsWith('data:image/jpeg;base64,'));
    } finally { await fsp.rm(dir, { recursive: true, force: true }); }
  });
  it('malformed SVG → silent fallback (no thumb, no throw)', async () => {
    const dir = await tmpDir();
    try {
      const bad = path.join(dir, 'bad.svg');
      await fsp.writeFile(bad, '<<garbage>>', 'utf8');
      await assert.doesNotReject(generateThumbnail(bad));
      assert.equal(await loadThumbnail(bad), null);
      const empty = path.join(dir, 'empty.svg');
      await fsp.writeFile(empty, '<svg></svg>', 'utf8');
      await assert.doesNotReject(generateThumbnail(empty));
      assert.equal(await loadThumbnail(empty), null);
    } finally { await fsp.rm(dir, { recursive: true, force: true }); }
  });
  it('external <image href> → does not throw (no remote fetch)', async () => {
    const dir = await tmpDir();
    try {
      const src = path.join(dir, 'ext.svg');
      await fsp.writeFile(src, `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="60" height="60"><image xlink:href="https://example.invalid/x.png" width="60" height="60"/></svg>`, 'utf8');
      await assert.doesNotReject(generateThumbnail(src));
    } finally { await fsp.rm(dir, { recursive: true, force: true }); }
  });
});
