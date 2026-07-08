/**
 * One-off script: writes a few JPEGs with synthetic EXIF metadata into
 * `Test/exif-sample/` so the P3-7 popup feature can be exercised in the
 * Mapique view without a real camera roll.
 *
 *   node scripts/generate-exif-samples.js
 *
 * The script is idempotent — re-running it overwrites the same files.
 * No CLI args, no env config: the four cases are a fixed demo set.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const piexif = require('piexifjs');

const OUT_DIR = path.join(__dirname, '..', 'Test', 'exif-sample');

// Make a tiny solid-color JPEG buffer.
async function blankJpeg(rgb) {
  return sharp({
    create: { width: 320, height: 240, channels: 3, background: rgb },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

// Insert an EXIF dict into a JPEG buffer and return the new bytes.
function withExif(jpegBuffer, exifObj) {
  const dataUrl = `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`;
  const exifBytes = piexif.dump(exifObj);
  const out = piexif.insert(exifBytes, dataUrl);
  const base64 = out.replace(/^data:image\/jpeg;base64,/, '');
  return Buffer.from(base64, 'base64');
}

async function writeCase(name, rgb, exifObj) {
  const buf = await blankJpeg(rgb);
  const out = exifObj ? withExif(buf, exifObj) : buf;
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, out);
  console.log(`wrote ${file} (${out.length} bytes)`);
}

// Helper: build a GPS IFD from decimal degrees.
function gps(degLat, degLng) {
  function toDms(deg) {
    const abs = Math.abs(deg);
    const d = Math.floor(abs);
    const mFloat = (abs - d) * 60;
    const m = Math.floor(mFloat);
    const s = Math.round((mFloat - m) * 60 * 100);
    return [
      [d, 1],
      [m, 1],
      [s, 100],
    ];
  }
  return {
    [piexif.GPSIFD.GPSLatitudeRef]: degLat >= 0 ? 'N' : 'S',
    [piexif.GPSIFD.GPSLatitude]: toDms(degLat),
    [piexif.GPSIFD.GPSLongitudeRef]: degLng >= 0 ? 'E' : 'W',
    [piexif.GPSIFD.GPSLongitude]: toDms(degLng),
  };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // Case 1: full EXIF (camera + lens + settings + GPS) — Beijing
  await writeCase(
    '01-full-beijing.jpg',
    { r: 70, g: 130, b: 180 },
    {
      '0th': {
        [piexif.ImageIFD.Make]: 'Apple',
        [piexif.ImageIFD.Model]: 'iPhone 15 Pro',
        [piexif.ImageIFD.Software]: 'iOS 17.4',
        [piexif.ImageIFD.DateTime]: '2024:03:15 14:32:10',
      },
      Exif: {
        [piexif.ExifIFD.DateTimeOriginal]: '2024:03:15 14:32:10',
        [piexif.ExifIFD.DateTimeDigitized]: '2024:03:15 14:32:10',
        [piexif.ExifIFD.LensModel]: 'iPhone 15 Pro back triple camera 6.86mm f/1.78',
        [piexif.ExifIFD.LensMake]: 'Apple',
        [piexif.ExifIFD.FocalLength]: [686, 100], // 6.86mm
        [piexif.ExifIFD.ExposureTime]: [1, 250], // 1/250s
        [piexif.ExifIFD.FNumber]: [178, 100], // f/1.78
        [piexif.ExifIFD.ISOSpeedRatings]: 200,
      },
      GPS: gps(39.9087, 116.3975), // Tiananmen
      Interop: {},
      '1st': {},
      thumbnail: null,
    }
  );

  // Case 2: prefix-dedup (Fujifilm — Make appears in Model) — Shanghai
  await writeCase(
    '02-prefix-fujifilm.jpg',
    { r: 200, g: 100, b: 80 },
    {
      '0th': {
        [piexif.ImageIFD.Make]: 'FUJIFILM',
        [piexif.ImageIFD.Model]: 'FUJIFILM X-T5',
        [piexif.ImageIFD.DateTime]: '2024:04:20 09:15:00',
      },
      Exif: {
        [piexif.ExifIFD.DateTimeOriginal]: '2024:04:20 09:15:00',
        [piexif.ExifIFD.LensModel]: 'XF 23mm F1.4 R LM WR',
        [piexif.ExifIFD.FocalLength]: [23, 1],
        [piexif.ExifIFD.ExposureTime]: [1, 125],
        [piexif.ExifIFD.FNumber]: [14, 10], // f/1.4
        [piexif.ExifIFD.ISOSpeedRatings]: 400,
      },
      GPS: gps(31.2304, 121.4737), // People's Square
      Interop: {},
      '1st': {},
      thumbnail: null,
    }
  );

  // Case 3: partial EXIF (date + GPS only, no camera) — Hangzhou
  await writeCase(
    '03-partial-no-camera.jpg',
    { r: 100, g: 150, b: 100 },
    {
      '0th': {
        [piexif.ImageIFD.DateTime]: '2024:05:01 16:45:00',
      },
      Exif: {
        [piexif.ExifIFD.DateTimeOriginal]: '2024:05:01 16:45:00',
      },
      GPS: gps(30.2741, 120.1551), // West Lake
      Interop: {},
      '1st': {},
      thumbnail: null,
    }
  );

  // Case 4: no EXIF at all (raw JPEG) — should show "No EXIF data" placeholder
  await writeCase('04-no-exif.jpg', { r: 200, g: 200, b: 200 }, null);

  console.log(`\nDone. Point a location at: ${OUT_DIR}`);
})();
