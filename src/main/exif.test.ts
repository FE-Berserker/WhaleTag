import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import piexif from 'piexifjs';
import { extractGps } from './exif';

describe('extractGps', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'whale-exif-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null for a non-image file', async () => {
    const txtPath = join(tmpDir, 'notes.txt');
    writeFileSync(txtPath, 'hello world');
    const result = await extractGps(txtPath);
    assert.equal(result, null);
  });

  it('returns null for an image without GPS', async () => {
    const imgPath = join(tmpDir, 'no-gps.jpg');
    await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } })
      .jpeg()
      .toFile(imgPath);
    const result = await extractGps(imgPath);
    assert.equal(result, null);
  });

  it('extracts GPS coordinates from a JPEG with EXIF GPS', async () => {
    const imgPath = join(tmpDir, 'gps.jpg');
    // Paris, approximate coordinates: 48.8566 N, 2.3522 E
    const buffer = await sharp({
      create: { width: 1, height: 1, channels: 3, background: 'blue' },
    })
      .jpeg()
      .toBuffer();
    const base64 = `data:image/jpeg;base64,${buffer.toString('base64')}`;

    const exifObj = {
      '0th': {},
      Exif: {},
      GPS: {
        [piexif.GPSIFD.GPSLatitudeRef]: 'N',
        [piexif.GPSIFD.GPSLatitude]: [
          [48, 1],
          [51, 1],
          [2436, 100],
        ],
        [piexif.GPSIFD.GPSLongitudeRef]: 'E',
        [piexif.GPSIFD.GPSLongitude]: [
          [2, 1],
          [21, 1],
          [1080, 100],
        ],
      },
      Interop: {},
      '1st': {},
      thumbnail: null,
    };
    const exifBytes = piexif.dump(exifObj);
    const withExif = piexif.insert(exifBytes, base64);
    const data = withExif.replace(/^data:image\/jpeg;base64,/, '');
    writeFileSync(imgPath, Buffer.from(data, 'base64') as Uint8Array);

    const result = await extractGps(imgPath);
    assert.notEqual(result, null);
    assert.ok(Math.abs(result!.lat - 48.8566) < 0.01);
    assert.ok(Math.abs(result!.lng - 2.3522) < 0.01);
  });
});
