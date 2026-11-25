/**
 * Shared text decoding: ONE encoding policy for every place the app turns
 * file bytes into a string — the viewer / editor read path
 * (`ipc/fs-read.ts` → `readTextFile`), the MCP `whale_extract_text` tool and
 * the full-text indexer (`fulltext.ts`).
 *
 * Why it exists: until 2026-11 the indexer read every file as raw UTF-8, so a
 * GBK / Shift-JIS / CP1252 document displayed correctly in the viewer (which
 * auto-detected the encoding) but could never be found by full-text search —
 * every non-ASCII byte had already become U+FFFD in the index.
 *
 * Policy, in order:
 *  1. UTF-8 BOM → strip the marker, decode the rest as UTF-8.
 *  2. Bytes that already decode to valid UTF-8 (no U+FFFD) and contain no NUL
 *     are returned as is. This is the overwhelmingly common case and skips
 *     charset detection entirely — the indexer reads thousands of files per
 *     build, and it also stops a short / ambiguous sample from being
 *     "corrected" into a legacy encoding it never was. NUL bytes leave the
 *     fast path because UTF-16 text (BOM-less) decodes to a NUL-riddled yet
 *     U+FFFD-free string and must go through detection.
 *  3. jschardet on a ≤256 KiB sample:
 *       - UTF-8 / ASCII at confidence ≥ 0.8, or any detection below 0.3
 *         → UTF-8 (modern files are overwhelmingly UTF-8; a low-confidence
 *         sample is usually just short or ambiguous);
 *       - otherwise decode with iconv-lite using the detected encoding, and
 *         whichever decoding has FEWER U+FFFD wins — legacy files often hold
 *         a few invalid bytes, and forcing UTF-8 there produces thousands of
 *         replacement characters.
 */
import { promises as fsp } from 'fs';
import { getChardet, getIconv } from './lazy-native';

/** chardet only needs a small byte sample; more is wasted CPU. */
const CHARDET_SAMPLE = 256 * 1024;
const HIGH_CONFIDENCE = 0.8;
const LOW_CONFIDENCE = 0.3;

const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf]);
const BOM_UTF16LE = Buffer.from([0xff, 0xfe]);
const BOM_UTF16BE = Buffer.from([0xfe, 0xff]);

/** Counts U+FFFD without `s.match(/\uFFFD/g)`, which allocates a giant array. */
function countReplacements(s: string): number {
  let count = 0;
  let idx = s.indexOf('\uFFFD');
  while (idx !== -1) {
    count++;
    idx = s.indexOf('\uFFFD', idx + 1);
  }
  return count;
}

/** Decodes file bytes to a string using the encoding policy above. */
export function decodeTextBuffer(buf: Buffer): string {
  // UTF-8 BOM: strip the marker and decode the remainder as UTF-8.
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString('utf8', 3);
  }

  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD') && !utf8.includes('\0')) return utf8;

  // subarray is a zero-copy view, so sampling is cheap.
  const detected = getChardet().detect(
    buf.length > CHARDET_SAMPLE ? buf.subarray(0, CHARDET_SAMPLE) : buf
  );
  const encoding = detected?.encoding?.toLowerCase() ?? 'utf8';
  const confidence = detected?.confidence ?? 0;

  // High-confidence UTF-8 / ASCII -> decode as UTF-8.
  if ((encoding === 'utf-8' || encoding === 'ascii') && confidence >= HIGH_CONFIDENCE) {
    return utf8;
  }

  // Very low confidence usually means the sample is too short or ambiguous;
  // modern files are overwhelmingly UTF-8, so prefer that default.
  if (confidence < LOW_CONFIDENCE) {
    return utf8;
  }

  // Decode with the detected encoding. jschardet may report ASCII for files
  // that are mostly ASCII with a few non-UTF-8 bytes (common for older Chinese
  // Windows text), so keep the detected name as the iconv target unless it is
  // clearly a UTF-8 alias.
  const target = encoding === 'utf-8' || encoding === 'ascii' ? 'utf8' : encoding;
  const decoded = getIconv().decode(buf, target);

  // Pick whichever decoding yields fewer replacement characters.
  const utf8Bad = countReplacements(utf8);
  const decodedBad = countReplacements(decoded);
  return decodedBad <= utf8Bad ? decoded : utf8;
}

/**
 * Byte formats of a text file that an editor cannot see and so cannot put
 * back itself: `decodeTextBuffer` strips the mark, because a text editor would
 * otherwise show (and let the cursor collide with) a stray zero-width
 * character at offset 0.
 */
export type TextByteFormat = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be';

/**
 * Byte format of the text file currently on disk, decided by its BOM alone —
 * the one unambiguous signal. Anything else is reported as plain UTF-8: a
 * legacy-encoded file (GBK, Shift-JIS, …) is read correctly but saved as
 * UTF-8, because the detected charset is a guess and re-encoding into it can
 * lose characters.
 */
export async function readTextByteFormat(filePath: string): Promise<TextByteFormat> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const head = Buffer.alloc(3);
    const { bytesRead } = await handle.read(head, 0, 3, 0);
    if (bytesRead === 3 && head.equals(BOM_UTF8)) return 'utf8-bom';
    if (bytesRead >= 2 && head[0] === 0xff && head[1] === 0xfe) return 'utf16le';
    if (bytesRead >= 2 && head[0] === 0xfe && head[1] === 0xff) return 'utf16be';
    return 'utf8';
  } finally {
    await handle.close();
  }
}

/**
 * Encodes text in the given byte format — the inverse of the BOM handling in
 * `decodeTextBuffer`, so "open → edit → save" returns a file to the format it
 * had instead of silently dropping its BOM or turning UTF-16 into UTF-8.
 */
export function encodeTextAs(text: string, format: TextByteFormat): Buffer {
  switch (format) {
    case 'utf8':
      return Buffer.from(text, 'utf8');
    case 'utf8-bom':
      // An editor that keeps the mark itself must not end up with two.
      return Buffer.concat([
        BOM_UTF8,
        Buffer.from(text.startsWith('\uFEFF') ? text.slice(1) : text, 'utf8'),
      ]);
    case 'utf16le':
      return Buffer.concat([BOM_UTF16LE, Buffer.from(text, 'utf16le')]);
    case 'utf16be': {
      const body = Buffer.from(text, 'utf16le');
      body.swap16();
      return Buffer.concat([BOM_UTF16BE, body]);
    }
  }
}
