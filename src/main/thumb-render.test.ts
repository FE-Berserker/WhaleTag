import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import sharp from 'sharp';
import { renderPdfThumb } from './thumb-render';

/**
 * pdfjs decodes scanner output — JBIG2, JPEG 2000 and CCITT fax — with
 * WebAssembly modules, and `renderPdfThumb` has to point pdfjs at them
 * (`wasmUrl`). When it doesn't, pdfjs drops the picture, still resolves the
 * render, and a scanned PDF ends up with an all-white thumbnail.
 *
 * The fixtures under `samples/pdf/` are single-image pages without text, built
 * with Pillow (nothing in the Node toolchain encodes these formats):
 *   jpx-scan.pdf — 96x64, left half red / right half blue, JPEG 2000
 *   fax-g4.pdf   — 600x400, white with a black middle stripe, CCITT Group 4
 * A blank render is white, so "enough non-white pixels" tells the two apart.
 */

const FIXTURES = 'samples/pdf';

async function pixelShares(jpeg: Buffer): Promise<{ red: number; blue: number; dark: number }> {
  const { data, info } = await sharp(jpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels = info.width * info.height;
  let red = 0;
  let blue = 0;
  let dark = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r > 150 && b < 110) red += 1;
    if (b > 150 && r < 110) blue += 1;
    if (r < 100 && g < 100 && b < 100) dark += 1;
  }
  return { red: red / pixels, blue: blue / pixels, dark: dark / pixels };
}

describe('renderPdfThumb: scanned pages (wasm image decoders)', () => {
  it('renders a JPEG 2000 scan instead of a blank page', async () => {
    const thumb = await renderPdfThumb(path.join(FIXTURES, 'jpx-scan.pdf'));
    const shares = await pixelShares(thumb);
    assert.ok(shares.red > 0.3, `left half should be red, got ${JSON.stringify(shares)}`);
    assert.ok(shares.blue > 0.3, `right half should be blue, got ${JSON.stringify(shares)}`);
  });

  it('renders a CCITT Group 4 fax scan instead of a blank page', async () => {
    const thumb = await renderPdfThumb(path.join(FIXTURES, 'fax-g4.pdf'));
    const shares = await pixelShares(thumb);
    assert.ok(shares.dark > 0.2, `middle stripe should be black, got ${JSON.stringify(shares)}`);
  });
});
