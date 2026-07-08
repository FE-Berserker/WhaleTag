import path from 'path';
import { promises as fsp } from 'fs';
import { unzipSync } from 'fflate';
import { isImageFile } from '../shared/whale-meta';

/**
 * Extracts the embedded **cover image bytes** from an ebook file, for the
 * thumbnail pipeline (`thumbnail.ts` hands the result to `encodeImageThumb`).
 *
 * Pure-JS, no native deps beyond `fflate` (a tiny ZIP reader). By format:
 *  - **epub** → ZIP: `META-INF/container.xml` → OPF → cover by precedence
 *    (EPUB3 `properties="cover-image"`, EPUB2 `<meta name="cover">`, guide
 *    reference, then first image). A cover that points at an (X)HTML page is
 *    followed to its first `<img>`/`<image>`.
 *  - **cbz** → ZIP: first image entry by natural-sorted name.
 *  - **fb2** → XML: `<coverpage>` image ref → matching base64 `<binary>`.
 *  - **mobi / azw / azw3** → PalmDB + MOBI/EXTH: EXTH record 201 (cover) or 202
 *    (thumbnail) gives an index relative to the first image record.
 *
 * Throws when no cover can be found or decoded; the caller treats that as a
 * silent fallback to a file-type icon (mirroring Office).
 */
export async function extractEbookCover(srcPath: string): Promise<Buffer> {
  const ext = path.extname(srcPath).slice(1).toLowerCase();
  switch (ext) {
    case 'epub':
      return extractEpubCover(srcPath);
    case 'cbz':
      return extractCbzCover(srcPath);
    case 'fb2':
      return extractFb2Cover(srcPath);
    case 'mobi':
    case 'azw':
    case 'azw3':
      return extractMobiCover(srcPath);
    default:
      throw new Error(`ebook-cover: unsupported extension .${ext}`);
  }
}

// ---------------------------------------------------------------------------
// ZIP helpers (epub, cbz) — fflate's `filter` lets us walk entries without
// inflating, then inflate only the single entry we want.
// ---------------------------------------------------------------------------

/** Lists entry names in a ZIP without decompressing any of them. */
function listZipNames(data: Uint8Array): string[] {
  const names: string[] = [];
  unzipSync(data, {
    filter: (file) => {
      names.push(file.name);
      return false;
    },
  });
  return names;
}

/** Inflates and returns a single ZIP entry (case-insensitive fallback). */
function readZipEntry(data: Uint8Array, name: string): Uint8Array | null {
  let out = unzipSync(data, { filter: (f) => f.name === name });
  if (out[name]) return out[name];
  const lower = name.toLowerCase();
  out = unzipSync(data, { filter: (f) => f.name.toLowerCase() === lower });
  const key = Object.keys(out)[0];
  return key ? out[key] : null;
}

/** UTF-8 view of a byte array (for the small XML entries). */
function textOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}

/** POSIX-style dirname for a ZIP path ('' when at the archive root). */
function zipDirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/**
 * Resolves an href (relative to `base` dir) into a normalized ZIP path,
 * stripping any `#fragment`/`?query` and percent-decoding (e.g. `%20`).
 */
function resolveZipPath(base: string, href: string): string {
  let rel = href.split('#')[0].split('?')[0];
  try {
    rel = decodeURIComponent(rel);
  } catch {
    /* leave as-is if not valid percent-encoding */
  }
  const stack: string[] = [];
  for (const part of (base ? base.split('/') : []).concat(rel.split('/'))) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

/** Natural-order comparator so `page2` sorts before `page10`. */
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function isHtmlPath(p: string): boolean {
  return /\.x?html?$/i.test(p);
}

function isImageHref(href: string, mediaType: string): boolean {
  return /^image\//i.test(mediaType) || isImageFile(href);
}

// ---------------------------------------------------------------------------
// EPUB
// ---------------------------------------------------------------------------

interface OpfItem {
  id: string;
  href: string;
  mediaType: string;
  properties: string;
}

/** Parses an XML start-tag's attributes into a lowercase-keyed map. */
function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"|([\w:-]+)\s*=\s*'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) {
    if (m[1] !== undefined) attrs[m[1].toLowerCase()] = m[2];
    else attrs[m[3].toLowerCase()] = m[4];
  }
  return attrs;
}

/** Extracts the OPF `<manifest>` items (`<itemref>` in the spine is excluded). */
function parseManifestItems(opf: string): OpfItem[] {
  const items: OpfItem[] = [];
  const re = /<item\b([^>]*?)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(opf))) {
    const a = parseAttrs(m[1]);
    if (a.href) {
      items.push({
        id: a.id ?? '',
        href: a.href,
        mediaType: a['media-type'] ?? '',
        properties: a.properties ?? '',
      });
    }
  }
  return items;
}

/** Resolves the cover href declared in an OPF, or null if none is declared. */
function findCoverHref(opf: string): string | null {
  const items = parseManifestItems(opf);

  // 1. EPUB3: manifest item flagged properties="cover-image".
  const coverImage = items.find((i) => /\bcover-image\b/.test(i.properties));
  if (coverImage) return coverImage.href;

  // 2. EPUB2: <meta name="cover" content="ID"/> → manifest item with that id.
  const meta = opf.match(/<meta\b[^>]*\bname\s*=\s*["']cover["'][^>]*>/i);
  if (meta) {
    const id = parseAttrs(meta[0]).content;
    const item = id ? items.find((i) => i.id === id) : undefined;
    if (item) return item.href;
  }

  // 3. <guide> reference type="cover" (usually a cover page, sometimes an image).
  const guide = opf.match(/<reference\b[^>]*\btype\s*=\s*["']cover["'][^>]*>/i);
  if (guide) {
    const href = parseAttrs(guide[0]).href;
    if (href) return href;
  }

  // 4. Fallback: first image in the manifest.
  const firstImage = items.find((i) => isImageHref(i.href, i.mediaType));
  return firstImage ? firstImage.href : null;
}

async function extractEpubCover(srcPath: string): Promise<Buffer> {
  const data = new Uint8Array(await fsp.readFile(srcPath));

  const container = readZipEntry(data, 'META-INF/container.xml');
  if (!container) throw new Error('epub: missing META-INF/container.xml');
  const opfPath = textOf(container).match(
    /<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/i
  )?.[1];
  if (!opfPath) throw new Error('epub: no OPF rootfile');

  const opfBytes = readZipEntry(data, opfPath);
  if (!opfBytes) throw new Error('epub: OPF not found');
  const opf = textOf(opfBytes);
  const opfDir = zipDirname(opfPath);

  const coverHref = findCoverHref(opf);
  if (!coverHref) throw new Error('epub: no cover declared');

  const targetPath = resolveZipPath(opfDir, coverHref);
  let bytes = readZipEntry(data, targetPath);
  if (!bytes) throw new Error('epub: cover entry missing');

  // A cover reference can point at an (X)HTML wrapper page; follow it to the
  // first embedded raster/SVG image.
  if (isHtmlPath(targetPath)) {
    const html = textOf(bytes);
    const inner =
      html.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i)?.[1] ??
      html.match(/<image\b[^>]*?(?:xlink:)?href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!inner) throw new Error('epub: cover page has no image');
    bytes = readZipEntry(data, resolveZipPath(zipDirname(targetPath), inner));
    if (!bytes) throw new Error('epub: cover image missing');
  }

  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// CBZ (comic archive — a ZIP of page images)
// ---------------------------------------------------------------------------

async function extractCbzCover(srcPath: string): Promise<Buffer> {
  const data = new Uint8Array(await fsp.readFile(srcPath));
  const names = listZipNames(data)
    .filter((n) => !n.endsWith('/')) // skip directory entries
    .filter((n) => !n.startsWith('__MACOSX/')) // skip macOS resource forks
    .filter((n) => {
      const base = n.split('/').pop() ?? '';
      return base !== '' && !base.startsWith('.');
    })
    .filter((n) => isImageFile(n));
  if (names.length === 0) throw new Error('cbz: no image pages');

  names.sort(naturalCompare);
  const bytes = readZipEntry(data, names[0]);
  if (!bytes) throw new Error('cbz: first page unreadable');
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// FB2 (FictionBook — XML with base64-embedded images)
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function extractFb2Cover(srcPath: string): Promise<Buffer> {
  // latin1: tag/attr names and the base64 payload are ASCII; this avoids
  // mangling non-UTF-8 (e.g. windows-1251) prose elsewhere in the file.
  const text = (await fsp.readFile(srcPath)).toString('latin1');

  const id = text.match(
    /<coverpage[\s\S]*?<image[^>]*?(?:xlink:)?href\s*=\s*["']#?([^"']+)["']/i
  )?.[1];

  let binary: RegExpMatchArray | null = null;
  if (id) {
    binary = text.match(
      new RegExp(
        `<binary\\b[^>]*\\bid\\s*=\\s*["']${escapeRegExp(id)}["'][^>]*>([\\s\\S]*?)<\\/binary>`,
        'i'
      )
    );
  }
  // Fallback: the first image-typed <binary> in the document.
  if (!binary) {
    binary = text.match(
      /<binary\b[^>]*\bcontent-type\s*=\s*["']image\/[^"']*["'][^>]*>([\s\S]*?)<\/binary>/i
    );
  }
  if (!binary) throw new Error('fb2: no cover binary');

  const buf = Buffer.from(binary[1].replace(/\s+/g, ''), 'base64');
  if (buf.length === 0) throw new Error('fb2: empty cover');
  return buf;
}

// ---------------------------------------------------------------------------
// MOBI / AZW / AZW3 (PalmDB container + MOBI/EXTH headers)
// ---------------------------------------------------------------------------

/** True when `b` starts with a known raster image magic number. */
function looksLikeImage(b: Uint8Array): boolean {
  if (b.length < 4) return false;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true; // JPEG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true; // PNG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true; // GIF
  if (b[0] === 0x42 && b[1] === 0x4d) return true; // BMP
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  )
    return true; // WEBP (RIFF....WEBP)
  return false;
}

const EXTH_COVER = 201; // CoverOffset record
const EXTH_THUMB = 202; // ThumbOffset record

async function extractMobiCover(srcPath: string): Promise<Buffer> {
  const buf = await fsp.readFile(srcPath);
  if (buf.length < 78) throw new Error('mobi: file too small');

  // --- PalmDB record table ---
  const numRecords = buf.readUInt16BE(0x4c);
  if (numRecords < 1) throw new Error('mobi: no records');
  const recordOffset = (n: number): number => buf.readUInt32BE(0x4e + n * 8);

  const rec0Start = recordOffset(0);
  const rec0End = numRecords > 1 ? recordOffset(1) : buf.length;
  const rec0 = buf.subarray(rec0Start, rec0End);
  // Offsets below are relative to record 0 (PalmDOC header is its first 16 bytes,
  // the MOBI header follows at +0x10, matching KindleUnpack).
  if (rec0.length < 0x84 || rec0.toString('latin1', 16, 20) !== 'MOBI') {
    throw new Error('mobi: no MOBI header');
  }
  const mobiHeaderLen = rec0.readUInt32BE(0x14);
  const firstImageIndex = rec0.readUInt32BE(0x6c);
  const exthFlags = rec0.readUInt32BE(0x80);
  if ((exthFlags & 0x40) === 0) throw new Error('mobi: no EXTH header');
  if (
    firstImageIndex === 0 ||
    firstImageIndex === 0xffffffff ||
    firstImageIndex >= numRecords
  ) {
    throw new Error('mobi: no image records');
  }

  // --- EXTH header: scan records for the cover/thumbnail offsets ---
  const exthStart = 0x10 + mobiHeaderLen;
  if (rec0.toString('latin1', exthStart, exthStart + 4) !== 'EXTH') {
    throw new Error('mobi: bad EXTH header');
  }
  const exthCount = rec0.readUInt32BE(exthStart + 8);
  let p = exthStart + 12;
  let coverOffset = -1;
  let thumbOffset = -1;
  for (let i = 0; i < exthCount; i++) {
    if (p + 8 > rec0.length) break;
    const type = rec0.readUInt32BE(p);
    const len = rec0.readUInt32BE(p + 4);
    if (len < 8 || p + len > rec0.length) break;
    if (type === EXTH_COVER && len === 12) coverOffset = rec0.readUInt32BE(p + 8);
    else if (type === EXTH_THUMB && len === 12) thumbOffset = rec0.readUInt32BE(p + 8);
    p += len;
  }

  const valid = (o: number) => o >= 0 && o !== 0xffffffff;
  const imageIndex = valid(coverOffset)
    ? firstImageIndex + coverOffset
    : valid(thumbOffset)
      ? firstImageIndex + thumbOffset
      : -1;
  if (imageIndex < 0 || imageIndex >= numRecords) {
    throw new Error('mobi: no cover record');
  }

  // --- Pull the cover image record's raw bytes ---
  const start = recordOffset(imageIndex);
  const end = imageIndex + 1 < numRecords ? recordOffset(imageIndex + 1) : buf.length;
  // Copy out of the file buffer so we don't pin the whole file in memory.
  const img = new Uint8Array(buf.subarray(start, end));
  if (!looksLikeImage(img)) throw new Error('mobi: cover record is not an image');
  return Buffer.from(img);
}
