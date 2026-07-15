/**
 * Font-file thumbnail renderer.
 *
 * Uses `@napi-rs/canvas` to register a local font file, draw a sample preview
 * ("Aa" + pangram + digits) onto a canvas, and return a PNG buffer. The PNG is
 * then fed into the shared `encodeImageThumb` pipeline in `thumbnail.ts` to
 * produce the standard 256px JPEG.
 *
 * The font is registered under a unique alias per call so concurrent
 * generations do not collide on the global font registry; it is removed in a
 * `finally` block to avoid leaking registrations.
 */

import type { SKRSContext2D } from '@napi-rs/canvas';
import { getCanvas } from './lazy-native';
import { randomBytes } from 'crypto';

const PREVIEW_SIZE = 512;
const PAD = 32;
const SAMPLE_BG = '#ffffff';
const SAMPLE_FG = '#1e1e1e';

/**
 * Renders a font preview to a PNG buffer.
 *
 * @throws When the font cannot be registered (unsupported format, corrupt file,
 *         etc.). The caller in `thumbnail.ts` treats this as a silent fallback.
 */
export async function renderFontToPng(srcPath: string): Promise<Buffer> {
  const alias = `WhaleFont-${randomBytes(4).toString('hex')}`;
  const key = getCanvas().GlobalFonts.registerFromPath(srcPath, alias);
  if (!key) {
    throw new Error(`Font registration failed: ${srcPath}`);
  }

  try {
    const canvas = getCanvas().createCanvas(PREVIEW_SIZE, PREVIEW_SIZE);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = SAMPLE_BG;
    ctx.fillRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
    ctx.fillStyle = SAMPLE_FG;
    ctx.textBaseline = 'top';

    // Large "Aa" centered near the top.
    ctx.font = `120px "${alias}"`;
    const textAa = 'Aa';
    const mAa = ctx.measureText(textAa);
    ctx.fillText(textAa, (PREVIEW_SIZE - mAa.width) / 2, PAD);

    // Pangram line below, ellipsized if it does not fit.
    ctx.font = `36px "${alias}"`;
    const pangram = 'The quick brown fox jumps over the lazy dog.';
    const available = PREVIEW_SIZE - PAD * 2;
    const display = fitText(ctx, pangram, available);
    ctx.fillText(
      display,
      (PREVIEW_SIZE - ctx.measureText(display).width) / 2,
      PAD + 150
    );

    // Digits at the bottom.
    ctx.font = `32px "${alias}"`;
    const digits = '0123456789';
    const mDigits = ctx.measureText(digits);
    ctx.fillText(digits, (PREVIEW_SIZE - mDigits.width) / 2, PREVIEW_SIZE - PAD - 32);

    return canvas.encode('png');
  } finally {
    getCanvas().GlobalFonts.remove(key);
  }
}

/** Trims `text` so it fits into `maxWidth`, appending "…" if truncated. */
function fitText(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return `${text.slice(0, lo)}…`;
}
