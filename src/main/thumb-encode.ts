import { getSharp } from './lazy-native';

/**
 * Shared JPEG thumbnail encoder + sizing constants. Lives in its own module
 * so both the main-process paths in `thumbnail.ts` (image / svg / video /
 * folder art) and the worker-side renders in `thumb-render.ts` (pdf / ebook
 * / font) use one encode policy without `thumb-render.ts` importing the
 * main-process orchestration (or vice versa).
 */

/** Max thumbnail edge in px. `withoutEnlargement` keeps small sources small. */
export const THUMB_SIZE = 256;

/** JPEG quality for the stored thumbnail. */
export const THUMB_QUALITY = 80;

/**
 * Resizes/encodes an image (path or in-memory buffer) into a JPEG thumbnail
 * buffer. The single place that touches the image backend (sharp).
 */
export async function encodeImageThumb(input: string | Buffer): Promise<Buffer> {
  return getSharp()(input)
    .rotate() // honor EXIF orientation (no-op for buffers without EXIF)
    .resize({
      width: THUMB_SIZE,
      height: THUMB_SIZE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
    .toBuffer();
}
