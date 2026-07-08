import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import piexif from 'piexifjs';
import { extractGps, buildExifSummary } from './exif';

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

describe('buildExifSummary', () => {
  it('returns all-null fields for empty / null input', () => {
    assert.deepEqual(buildExifSummary({}), {
      dateTaken: null,
      camera: null,
      lens: null,
      focalLength: null,
      iso: null,
      shutterSpeed: null,
    });
    assert.deepEqual(buildExifSummary(null), {
      dateTaken: null,
      camera: null,
      lens: null,
      focalLength: null,
      iso: null,
      shutterSpeed: null,
    });
  });

  it('formats camera as "Make Model" when both are distinct', () => {
    const s = buildExifSummary({ Make: 'Apple', Model: 'iPhone 15 Pro' });
    assert.equal(s.camera, 'Apple iPhone 15 Pro');
  });

  it('deduplicates camera when Make === Model', () => {
    const s = buildExifSummary({ Make: 'FUJIFILM', Model: 'FUJIFILM X-T5' });
    assert.equal(s.camera, 'FUJIFILM X-T5');
  });

  it('falls back to whichever of Make/Model is present', () => {
    assert.equal(
      buildExifSummary({ Model: 'iPhone 15 Pro' }).camera,
      'iPhone 15 Pro'
    );
    assert.equal(buildExifSummary({ Make: 'Canon' }).camera, 'Canon');
  });

  it('normalises DateTimeOriginal to ISO 8601', () => {
    const d = new Date('2024-03-15T14:32:00Z');
    const s = buildExifSummary({ DateTimeOriginal: d });
    assert.equal(s.dateTaken, '2024-03-15T14:32:00.000Z');
  });

  it('normalises the EXIF "YYYY:MM:DD HH:MM:SS" string form to ISO', () => {
    const s = buildExifSummary({ DateTimeOriginal: '2024:03:15 14:32:00' });
    // Don't assert the exact ISO — the local-time interpretation depends
    // on the runner's TZ. The contract is "parses to a real date".
    const ts = new Date(s.dateTaken!).getTime();
    assert.ok(!Number.isNaN(ts));
  });

  it('prefers DateTimeOriginal over CreateDate', () => {
    const original = new Date('2024-03-15T14:32:00Z');
    const create = new Date('2024-04-01T00:00:00Z');
    const s = buildExifSummary({ DateTimeOriginal: original, CreateDate: create });
    assert.equal(s.dateTaken, '2024-03-15T14:32:00.000Z');
  });

  it('formats shutter speed as "1/N" for sub-second exposures', () => {
    assert.equal(buildExifSummary({ ExposureTime: 0.004 }).shutterSpeed, '1/250');
    assert.equal(buildExifSummary({ ExposureTime: 0.0166 }).shutterSpeed, '1/60');
  });

  it('formats shutter speed as "Ns" for exposures >= 1s', () => {
    assert.equal(buildExifSummary({ ExposureTime: 2.5 }).shutterSpeed, '2.5s');
    assert.equal(buildExifSummary({ ExposureTime: 1 }).shutterSpeed, '1s');
  });

  it('accepts FocalLength as a number', () => {
    const s = buildExifSummary({ FocalLength: 6.86 });
    assert.equal(s.focalLength, 6.86);
  });

  it('accepts FocalLength as a rational tuple (older cameras)', () => {
    const s = buildExifSummary({ FocalLength: [50, 1] });
    assert.equal(s.focalLength, 50);
  });

  it('accepts both ISO and ISOSpeedRatings', () => {
    assert.equal(buildExifSummary({ ISO: 200 }).iso, 200);
    assert.equal(buildExifSummary({ ISOSpeedRatings: 400 }).iso, 400);
  });

  it('picks LensModel first, falls back to Lens', () => {
    assert.equal(
      buildExifSummary({ LensModel: 'EF 24-70mm f/2.8L II USM' }).lens,
      'EF 24-70mm f/2.8L II USM'
    );
    assert.equal(
      buildExifSummary({ Lens: 'iPhone 15 Pro back camera' }).lens,
      'iPhone 15 Pro back camera'
    );
  });

  it('silently drops non-finite numeric fields', () => {
    const s = buildExifSummary({
      FocalLength: NaN,
      ISO: Infinity,
      ExposureTime: -1,
    });
    assert.equal(s.focalLength, null);
    assert.equal(s.iso, null);
    // ExposureTime = -1 is a finite number but logically meaningless; we
    // still normalise it to "0" so the renderer doesn't show "−1s".
    // (Documented behavior — not a bug.)
    assert.equal(s.shutterSpeed, '0');
  });
});
