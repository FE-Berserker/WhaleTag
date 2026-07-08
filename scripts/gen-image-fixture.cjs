/**
 * Stress fixture for the Gallery "no IPC storm" checklist
 * (docs/12-frontend-checklist.md:84). Lays down N small valid PNGs in one flat
 * directory so the Gallery view has thousands of thumbnailable entries to
 * fast-scroll through.
 *
 * Output: Test/压测图库/img-000001.png … (hue varies by index so cells look
 * distinct — easier to eyeball skeleton→img swaps and flicker).
 *
 * Run:  node scripts/gen-image-fixture.cjs        # default 1000
 *       node scripts/gen-image-fixture.cjs 10000   # full 万图 stress
 *
 * Pure Node (zlib + a 10-line CRC32) — no native deps — so it runs anywhere
 * the project does. Safe to re-run (overwrites).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const COUNT = Math.max(1, parseInt(process.argv[2] || '1000', 10));
const W = 128;
const H = 128;
const root = path.join(__dirname, '..', 'Test', '压测图库');
fs.mkdirSync(root, { recursive: true });

// --- minimal PNG encoder (RGB / 8-bit / no interlace) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function hslToRgb(h, s, l) {
  // h∈[0,360), s/l∈[0,1] → [r,g,b]∈[0,255]
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (h % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function buildPng(i) {
  // Hue via golden angle so adjacent files look maximally distinct.
  const [r, g, b] = hslToRgb(i * 137.508, 0.62, 0.55);
  // Two horizontal bands (top = hue, bottom = darker shade) so the image isn't
  // a flat solid color — sharp actually has content to resize.
  const top = Buffer.from([r, g, b]);
  const bot = Buffer.from([Math.round(r * 0.6), Math.round(g * 0.6), Math.round(b * 0.6)]);
  const rowBytes = 1 + W * 3;
  const raw = Buffer.alloc(rowBytes * H);
  let o = 0;
  for (let y = 0; y < H; y++) {
    raw[o++] = 0; // filter: none
    const px = y < H / 2 ? top : bot;
    for (let x = 0; x < W; x++) {
      raw[o++] = px[0]; raw[o++] = px[1]; raw[o++] = px[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let bytes = 0;
const t0 = Date.now();
for (let i = 1; i <= COUNT; i++) {
  const buf = buildPng(i);
  fs.writeFileSync(path.join(root, `img-${String(i).padStart(6, '0')}.png`), buf);
  bytes += buf.length;
  if (i % 1000 === 0 || i === COUNT) console.log(`  ${i}/${COUNT}`);
}
console.log(
  `Done: ${COUNT} PNGs, ${(bytes / 1024 / 1024).toFixed(2)} MiB, ` +
    `${((Date.now() - t0) / 1000).toFixed(1)}s → ${path.relative(process.cwd(), root) || root}`
);
