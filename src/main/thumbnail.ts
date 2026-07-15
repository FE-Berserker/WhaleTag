import path from 'path';
import os from 'os';
import { existsSync, promises as fsp } from 'fs';
import { execFile } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';
import {
  META_DIR,
  THUMBS_DIR,
  FOLDER_THUMB_FILE,
  FOLDER_BACKGROUND_FILE,
  thumbKindOf,
  isThumbnailable,
} from '../shared/whale-meta';
import type { GenerateThumbnailOptions } from '../shared/ipc-types';
import { atomicWriteBytes } from './atomic-write';
import { sofficeSemaphore, thumbnailSemaphore } from './concurrency';
import { extractEbookCover } from './ebook-cover';
import { renderFontToPng } from './font-thumb';
import { getSharp, getCanvas } from './lazy-native';

/**
 * Per-file thumbnails, stored at `<dir>/.whale/thumbs/<basename>.jpg`.
 *
 * Generation runs in the Electron main process. By source kind (`thumbKindOf`):
 *  - **image** → sharp (N-API, no rebuild) resizes/encodes directly.
 *  - **video** → ffmpeg-static extracts one frame to a PNG buffer, then sharp
 *    resizes/encodes it.
 *  - **pdf** → pdfjs-dist renders page 1 to a `@napi-rs/canvas`, then sharp
 *    resizes/encodes it.
 *  - **office** → LibreOffice (`soffice`) headless-converts the document to a
 *    temporary PDF, then reuses the pdf path above. LibreOffice is NOT bundled;
 *    if it is missing or conversion fails, generation aborts silently and the
 *    renderer falls back to a file-type icon.
 *  - **ebook** → `ebook-cover.ts` extracts the embedded cover image bytes
 *    (epub/cbz via fflate; fb2 via XML; mobi/azw3 via PalmDB+EXTH), then sharp
 *    resizes/encodes it. A book with no embedded cover aborts silently (icon).
 *  - **font** → `font-thumb.ts` registers the font with `@napi-rs/canvas`,
 *    draws a sample preview, and encodes it as PNG; sharp then produces the
 *    JPEG thumbnail. Corrupt/unsupported fonts abort silently (icon).
 *
 * Output is always JPEG, max 256px. Cache: a thumbnail is reused while the
 * source is unchanged (`thumb.mtime >= source.mtime`). Cleanup mirrors
 * `sidecar.ts` (remove/move/copy on the matching `.jpg`) — all path-based and
 * format-agnostic, so adding kinds needs no IPC changes.
 */

/** Max thumbnail edge in px. `withoutEnlargement` keeps small sources small. */
const THUMB_SIZE = 256;

/** JPEG quality for the stored thumbnail. */
const THUMB_QUALITY = 80;

const nodeRequire = createRequire(__filename);
const pdfWorkerPath = nodeRequire.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
// pdfjs in the Electron main process loads cmap / font data via fs.readFile, so
// these must be plain filesystem paths with a trailing "/" (forward slash; pdfjs
// validates it and Windows fs accepts forward separators), NOT file:// URLs — a
// file:// URL would ENOENT and silently blank standard fonts / CJK glyphs.
const pdfRootDir = path.join(path.dirname(pdfWorkerPath), '..', '..');
const pdfStandardFontDataUrl = path.join(pdfRootDir, 'standard_fonts') + '/';
// Predefined CMaps for decoding non-embedded CID-keyed CJK fonts.
const pdfCMapUrl = path.join(pdfRootDir, 'cmaps') + '/';

type PdfjsLib = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let _pdfjs: PdfjsLib | undefined;
/** Lazy-load pdfjs on first PDF thumbnail (not at app startup). The pdfjs
 *  module (~1MB+) and worker setup are deferred via nodeRequire (createRequire),
 *  which webpack leaves as a runtime require — bundling the .mjs would
 *  hard-code its import.meta.url and crash the main process at load. */
function getPdfjs(): PdfjsLib {
  if (_pdfjs) return _pdfjs;
  const lib = nodeRequire('pdfjs-dist/legacy/build/pdf.mjs') as PdfjsLib;
  lib.GlobalWorkerOptions.workerSrc = pathToFileURL(pdfWorkerPath).href;
  _pdfjs = lib;
  return lib;
}

/** `<dir>/.whale/thumbs/<basename>.jpg` for a given source file. */
export function thumbPathFor(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    META_DIR,
    THUMBS_DIR,
    `${path.basename(filePath)}.jpg`
  );
}

/**
 * Resolves the ffmpeg binary path. When packaged, the path points inside the
 * asar archive (not executable); electron-builder unpacks it to
 * `app.asar.unpacked`, so swap the segment. null when ffmpeg-static is absent.
 */
export function ffmpegPath(): string | null {
  if (!ffmpegStatic) return null;
  return ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
}

// Memoized PATH-probe result for the bare `soffice` command (spawns a child,
// up to 3s — LibreOffice's bootstrap can be slow on a cold Windows install).
// Cached so office thumbnails / PDF conversions don't re-probe on every call;
// the candidate-path checks below stay per-call (cheap existsSync). The probe
// itself runs via async `execFile` (P1-1 — execFileSync would block the main
// process event loop on cold PATH lookup and freeze every window / IPC).
// `_sofficeInflight` dedupes concurrent probes: the first caller kicks off the
// spawn, subsequent callers await the same Promise.
let _sofficeOnPath: boolean | undefined;
let _sofficeInflight: Promise<boolean> | null = null;

/**
 * Tries to locate the LibreOffice `soffice` binary. Honours an explicit
 * override, then common install locations, then PATH. Returns null when
 * LibreOffice cannot be found.
 */
export async function sofficeBinary(
  override: string | null | undefined
): Promise<string | null> {
  if (override) return override;

  const candidates: string[] = [];
  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'
    );
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/LibreOffice.app/Contents/MacOS/soffice');
  } else {
    candidates.push(
      '/usr/bin/soffice',
      '/usr/lib/libreoffice/program/soffice'
    );
  }

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  // Final fallback: let PATH resolve it. Memoized (see _sofficeOnPath).
  if (_sofficeOnPath === undefined) {
    if (!_sofficeInflight) {
      _sofficeInflight = new Promise<boolean>((resolve) => {
        execFile(
          'soffice',
          ['--version'],
          { timeout: 3000 },
          (err) => {
            _sofficeOnPath = !err;
            _sofficeInflight = null;
            resolve(_sofficeOnPath);
          }
        );
      });
    }
    await _sofficeInflight;
  }
  return _sofficeOnPath ? 'soffice' : null;
}

/** Returns true when a LibreOffice `soffice` binary can be located. */
export async function isSofficeAvailable(): Promise<boolean> {
  return (await sofficeBinary(null)) !== null;
}

/**
 * Standard CLI args for converting an Office document to PDF via `soffice`.
 * Single source of truth shared by `encodeOfficeThumb` (thumbnail.ts) and
 * `convertOfficeToPdf` (office-convert.ts).
 *
 * `--norestore --nologo --nofirststartwizard` suppress LibreOffice's profile
 * restore / splash / first-start wizard, cutting cold-start overhead 30–50%
 * (typical Windows cold start 2–5s). The flags are no-ops when the profile
 * is already in steady state, so they're always safe to include.
 */
export function sofficeConvertArgs(tmpDir: string, srcPath: string): string[] {
  return [
    '--headless',
    '--norestore',
    '--nologo',
    '--nofirststartwizard',
    '--convert-to',
    'pdf',
    '--outdir',
    tmpDir,
    srcPath,
  ];
}

/**
 * Converts an Office document to a temporary PDF via LibreOffice, then reuses
 * `encodePdfThumb` on that PDF. Cleans up the temporary PDF and its directory
 * afterwards. Throws if LibreOffice is missing or conversion fails.
 */
async function encodeOfficeThumb(
  srcPath: string,
  sofficePath?: string | null
): Promise<Buffer> {
  const bin = await sofficeBinary(sofficePath);
  if (!bin) throw new Error('LibreOffice (soffice) not found');

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-office-'));
  const baseName = path.basename(srcPath, path.extname(srcPath));
  const expectedPdf = path.join(tmpDir, `${baseName}.pdf`);

  try {
    // Serialize soffice with the office-viewer path (profile-lock contention —
    // see office-convert.ts). Hold the permit only for the soffice subprocess,
    // not the subsequent pdfjs/sharp thumbnail render.
    await sofficeSemaphore.run(
      () =>
        new Promise<void>((resolve, reject) => {
          const isCmd = process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(bin);
          execFile(
            bin,
            sofficeConvertArgs(tmpDir, srcPath),
            {
              timeout: 120000,
              stdio: ['ignore', 'pipe', 'pipe'] as const,
              shell: isCmd,
            } as import('child_process').ExecFileOptions,
            (err, stdout, stderr) => {
              if (err) {
                reject(
                  new Error(
                    `soffice failed: ${err.message}\n${stderr || stdout || ''}`
                  )
                );
                return;
              }
              resolve();
            }
          );
        })
    );
    if (!existsSync(expectedPdf)) {
      throw new Error('LibreOffice did not produce a PDF');
    }
    return await encodePdfThumb(expectedPdf);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Resizes/encodes an image (path or in-memory buffer) into a JPEG thumbnail
 * buffer. The single place that touches the image backend (sharp).
 */
async function encodeImageThumb(input: string | Buffer): Promise<Buffer> {
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

/**
 * Rasterizes an SVG file into a JPEG thumbnail via sharp's bundled librsvg.
 *
 * Why a dedicated path (instead of falling through to `encodeImageThumb`):
 *  - **Density oversample.** sharp's librsvg default is 72 DPI, which at the
 *    final 256px target produces slightly soft edges. Bumping to 96 DPI
 *    rasterizes ~33% more pixels before downsampling, giving a crisper JPEG
 *    for the same `quality: 80` (verified with `samples/svg/*.svg`).
 *  - **viewBox-only inputs.** An SVG without `width` / `height` (common for
 *    responsive icons and exports from design tools) is still rasterized
 *    correctly — librsvg uses the viewBox as the default size — but only if
 *    you go through sharp, not by reading the file as text.
 *  - **Silent fallback.** Malformed SVGs (`<svg></svg>` with no viewBox →
 *    "bad dimensions"; non-XML garbage → "unsupported image format") throw
 *    from sharp. The caller treats `kind === 'svg'` as a soft failure: any
 *    decode error leaves no thumbnail behind and the renderer falls back to
 *    the type icon. Without this guard, a single bad SVG in a directory
 *    would surface as an IPC error in the UI.
 *
 * `unlimited: false` (sharp's default) keeps the renderer from following
 * remote `<image href="https://...">` references — Whale is local-first.
 */
async function encodeSvgThumb(srcPath: string): Promise<Buffer> {
  return getSharp()(srcPath, { density: 96 })
    .resize({
      width: THUMB_SIZE,
      height: THUMB_SIZE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
    .toBuffer();
}

/**
 * Extracts a single frame from `srcPath` via ffmpeg as a PNG buffer (full res),
 * then hands it to `encodeImageThumb` for uniform sizing/quality. Seeks to ~1s
 * to skip black lead-in; retries at 0s for sub-second clips. Throws if ffmpeg
 * is unavailable or fails to decode.
 */
async function encodeVideoThumb(srcPath: string): Promise<Buffer> {
  const bin = ffmpegPath();
  if (!bin) throw new Error('ffmpeg-static unavailable');

  const grabFrame = (seek: number): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const args = [
        '-ss',
        String(seek),
        '-i',
        srcPath,
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-vcodec',
        'png',
        '-loglevel',
        'error',
        'pipe:1',
      ];
      execFile(
        bin,
        args,
        { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return reject(err);
          const buf = stdout as unknown as Buffer;
          if (!buf || buf.length === 0) {
            return reject(new Error('ffmpeg produced no frame'));
          }
          resolve(buf);
        }
      );
    });

  // Try ~1s in; sub-second clips have no frame there, so fall back to 0.
  let frame: Buffer;
  try {
    frame = await grabFrame(1);
  } catch {
    frame = await grabFrame(0);
  }
  return encodeImageThumb(frame);
}

/**
 * Renders page 1 of `srcPath` via pdfjs-dist into a `@napi-rs/canvas`, then
 * encodes it as a JPEG thumbnail. Throws when the PDF is missing, encrypted,
 * or cannot to render page 1 within the timeout.
 */
async function encodePdfThumb(srcPath: string): Promise<Buffer> {
  const data = new Uint8Array(await fsp.readFile(srcPath));

  const loadingTask = getPdfjs().getDocument({
    data,
    useSystemFonts: true,
    cMapUrl: pdfCMapUrl,
    cMapPacked: true,
    standardFontDataUrl: pdfStandardFontDataUrl,
  });

  let doc: Awaited<typeof loadingTask.promise> | null = null;
  try {
    doc = await loadingTask.promise;
    const page = await doc.getPage(1);
    try {
      // Choose a viewport scale so the larger edge becomes a high-res source
      // for downscaling (quality is better than rendering at thumb size).
      const viewport = page.getViewport({ scale: 1 });
      const scale = THUMB_SIZE / Math.max(viewport.width, viewport.height);
      const scaled = page.getViewport({ scale: Math.max(scale, 1) });
      const canvas = getCanvas().createCanvas(scaled.width, scaled.height);
      const ctx = canvas.getContext('2d');
      await page.render({
        canvas: null,
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport: scaled,
      }).promise;
      const pngBuf = await canvas.encode('png');
      return encodeImageThumb(pngBuf);
    } finally {
      page.cleanup?.();
    }
  } finally {
    loadingTask.destroy?.().catch(() => undefined);
  }
}

/**
 * Extracts an ebook's embedded cover (see `ebook-cover.ts`) and hands the raw
 * image bytes to `encodeImageThumb` for uniform sizing/quality. Throws when the
 * book has no embedded cover or it can't be decoded.
 */
async function encodeEbookThumb(srcPath: string): Promise<Buffer> {
  return encodeImageThumb(await extractEbookCover(srcPath));
}

/**
 * Renders a font preview via `font-thumb.ts` to a PNG buffer, then resizes/
 * encodes it as a JPEG thumbnail. Throws when the font file cannot be
 * registered or rendered (corrupt/unsupported format).
 */
async function encodeFontThumb(srcPath: string): Promise<Buffer> {
  return encodeImageThumb(await renderFontToPng(srcPath));
}

/**
 * Generates (or refreshes) a file's thumbnail. Skips files Whale can't
 * thumbnail and reuses an existing thumbnail when the source hasn't changed
 * (mtime). Silently does nothing if the source is gone; throws on real
 * decode/IO errors so the IPC layer can surface them.
 *
 * Concurrent calls for the SAME source share one in-flight promise: the grid
 * mounts many cells at once and React (StrictMode / fast remounts) can ask
 * twice for the same file, which would otherwise run the backend twice and
 * race on the same output. Deduping collapses those into a single generation.
 */
const inflight = new Map<string, Promise<void>>();

export function generateThumbnail(
  filePath: string,
  options?: GenerateThumbnailOptions
): Promise<void> {
  const existing = inflight.get(filePath);
  if (existing) return existing;
  const run = doGenerateThumbnail(filePath, options).finally(() => {
    inflight.delete(filePath);
  });
  inflight.set(filePath, run);
  return run;
}

async function doGenerateThumbnail(
  filePath: string,
  options?: GenerateThumbnailOptions
): Promise<void> {
  const kind = thumbKindOf(path.basename(filePath));
  if (!kind) return; // nothing Whale can thumbnail

  const target = thumbPathFor(filePath);
  let srcMtime: number;
  try {
    srcMtime = (await fsp.stat(filePath)).mtimeMs;
  } catch {
    return; // source gone — nothing to generate; cleanup handles removal
  }

  // Reuse the existing thumbnail if the source is unchanged.
  if (existsSync(target)) {
    try {
      if ((await fsp.stat(target)).mtimeMs >= srcMtime) return;
    } catch {
      // fall through and regenerate
    }
  }

  // P1-6 (perf audit): bound concurrent thumbnail encodes (sharp / ffmpeg /
  // pdfjs / soffice) across ALL callers — file-thumb IPC AND folder thumbs.
  // The cheap kind/stat/reuse short-circuits above run OUTSIDE the permit so a
  // cache hit never consumes a slot; only the real encoding + write holds one.
  await thumbnailSemaphore.run(async () => {
    let buf: Buffer;
    try {
      buf =
        kind === 'video'
          ? await encodeVideoThumb(filePath)
          : kind === 'pdf'
            ? await encodePdfThumb(filePath)
            : kind === 'office'
              ? await encodeOfficeThumb(filePath, options?.sofficePath)
              : kind === 'ebook'
                ? await encodeEbookThumb(filePath)
                : kind === 'font'
                  ? await encodeFontThumb(filePath)
                  : kind === 'svg'
                    ? await encodeSvgThumb(filePath)
                    : await encodeImageThumb(filePath);
    } catch (e) {
      // Office conversion depends on an external binary that may be missing or
      // misconfigured; ebooks may simply carry no embedded cover; an SVG may have
      // no viewBox / invalid XML / unsupported features librsvg can't parse.
      // Fonts may be corrupt or use an unsupported table/layout. In those cases
      // fail silently so the renderer shows a type icon. Returning from this
      // lambda leaves no thumbnail on disk (run() resolves to undefined).
      if (
        kind === 'office' ||
        kind === 'ebook' ||
        kind === 'svg' ||
        kind === 'font'
      ) {
        return;
      }
      throw e;
    }

    await fsp.mkdir(path.dirname(target), { recursive: true });
    await atomicWriteBytes(target, buf);
  });
}

/**
 * Loads a file's thumbnail as a `data:image/jpeg;base64,...` URL (CSP permits
 * `data:`/`blob:`; `file:` is blocked). Returns null when no thumbnail exists
 * yet — the renderer then asks to generate one. Throws on real IO errors.
 *
 * P2-1: an in-process LRU memo (keyed by filePath, invalidated by the thumb
 * file's mtimeMs) avoids re-reading + re-base64-encoding the same JPEG on
 * every revisit / re-scroll / multi-consumer request (list + tray + kanban
 * all ask for the same thumb). `doGenerateThumbnail` stamps the thumb's mtime
 * to >= the source mtime on (re)generation, so a regenerated thumb changes
 * mtimeMs → automatic cache miss. Bounded so a long session can't leak.
 */
interface ThumbCacheEntry {
  mtimeMs: number;
  dataUrl: string;
}
const thumbCache = new Map<string, ThumbCacheEntry>();
const THUMB_CACHE_MAX = 500;

export async function loadThumbnail(
  filePath: string
): Promise<string | null> {
  const target = thumbPathFor(filePath);
  // `fsp.stat` is both the existence check and the invalidation signal (one
  // syscall, vs the prior sync `existsSync` + later `readFile`).
  let mtimeMs: number;
  try {
    mtimeMs = (await fsp.stat(target)).mtimeMs;
  } catch {
    // Missing (ENOENT) or inaccessible — nothing to return. Drop any stale
    // entry so a later regeneration starts clean.
    thumbCache.delete(filePath);
    return null;
  }
  const cached = thumbCache.get(filePath);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) {
    // LRU refresh: re-insert to move this key to most-recent.
    thumbCache.delete(filePath);
    thumbCache.set(filePath, cached);
    return cached.dataUrl;
  }
  const buf = await fsp.readFile(target);
  const dataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`;
  thumbCache.set(filePath, { mtimeMs, dataUrl });
  // Evict the oldest entry (Map preserves insertion order) over the cap.
  if (thumbCache.size > THUMB_CACHE_MAX) {
    const oldest = thumbCache.keys().next().value;
    if (oldest !== undefined) thumbCache.delete(oldest);
  }
  return dataUrl;
}

/** Removes a file's thumbnail (used when the file is deleted). No-op if absent. */
export async function removeThumbnail(filePath: string): Promise<void> {
  thumbCache.delete(filePath);
  await fsp.rm(thumbPathFor(filePath), { force: true }).catch(() => undefined);
}

/**
 * Moves a file's thumbnail to follow a rename/move. No-op if the file had none.
 * Handles cross-volume (EXDEV) via copy-then-delete, matching ipc.ts' move().
 */
export async function moveThumbnail(
  oldPath: string,
  newPath: string
): Promise<void> {
  const oldThumb = thumbPathFor(oldPath);
  if (!existsSync(oldThumb)) return;
  const newThumb = thumbPathFor(newPath);
  await fsp.mkdir(path.dirname(newThumb), { recursive: true });
  if (existsSync(newThumb)) {
    await fsp.rm(newThumb, { force: true });
  }
  try {
    await fsp.rename(oldThumb, newThumb);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    await fsp.copyFile(oldThumb, newThumb);
    await fsp.rm(oldThumb, { force: false });
  }
}

/** Copies a file's thumbnail alongside a file copy. No-op if the source had none. */
export async function copyThumbnail(
  sourcePath: string,
  destPath: string
): Promise<void> {
  const srcThumb = thumbPathFor(sourcePath);
  if (!existsSync(srcThumb)) return;
  const destThumb = thumbPathFor(destPath);
  await fsp.mkdir(path.dirname(destThumb), { recursive: true });
  await fsp.copyFile(srcThumb, destThumb);
}

/** Path of a directory's thumbnail image (`<dir>/.whale/wst.jpg`). */
export function folderThumbPathFor(dirPath: string): string {
  return path.join(dirPath, META_DIR, FOLDER_THUMB_FILE);
}

/** Path of a directory's background image (`<dir>/.whale/wsb.jpg`). */
export function folderBackgroundPathFor(dirPath: string): string {
  return path.join(dirPath, META_DIR, FOLDER_BACKGROUND_FILE);
}

/**
 * Resizes/crops an image file to a square folder thumbnail (JPEG) and writes it
 * to `wst.jpg`. Used for both manual picks and auto-generation.
 */
async function writeFolderThumbImage(
  sourcePath: string,
  targetPath: string
): Promise<void> {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const buf = await getSharp()(sourcePath)
    .rotate()
    .resize({
      width: THUMB_SIZE,
      height: THUMB_SIZE,
      fit: 'cover',
      withoutEnlargement: true,
    })
    .jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
    .toBuffer();
  await atomicWriteBytes(targetPath, buf);
}

/**
 * Finds the first thumbnailable file in `dirPath` (by sorted name, skipping the
 * `.whale` meta directory). Returns null when the directory contains none.
 */
async function firstThumbnailableFile(dirPath: string): Promise<string | null> {
  let names: string[];
  try {
    names = await fsp.readdir(dirPath);
  } catch {
    return null;
  }
  names.sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    if (name === META_DIR) continue;
    if (!isThumbnailable(name)) continue;
    const fullPath = path.join(dirPath, name);
    try {
      const st = await fsp.stat(fullPath);
      if (st.isFile()) return fullPath;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Auto-generates a folder thumbnail from the first thumbnailable file in the
 * directory. Falls back to clearing any stale thumbnail if no source exists.
 */
export async function generateFolderThumbnail(
  dirPath: string
): Promise<void> {
  const sourcePath = await firstThumbnailableFile(dirPath);
  const targetPath = folderThumbPathFor(dirPath);
  if (!sourcePath) {
    await fsp.rm(targetPath, { force: true }).catch(() => undefined);
    return;
  }
  // Reuse the file's thumbnail if already generated; otherwise create one.
  const fileThumb = thumbPathFor(sourcePath);
  if (!existsSync(fileThumb)) {
    await generateThumbnail(sourcePath);
  }
  if (existsSync(fileThumb)) {
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.copyFile(fileThumb, targetPath);
  }
}

/**
 * Sets a custom image as the folder thumbnail. `sourcePath` may be any image
 * file (or any file that already has a `.whale/thumbs/<name>.jpg`).
 */
export async function setFolderThumbnail(
  dirPath: string,
  sourcePath: string
): Promise<void> {
  const targetPath = folderThumbPathFor(dirPath);
  const fileThumb = thumbPathFor(sourcePath);
  if (!existsSync(fileThumb)) {
    await generateThumbnail(sourcePath);
  }
  if (existsSync(fileThumb)) {
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.copyFile(fileThumb, targetPath);
    return;
  }
  // No generated thumbnail available — try to read the source as an image.
  await writeFolderThumbImage(sourcePath, targetPath);
}

/** Removes a directory's thumbnail image. No-op if absent. */
export async function clearFolderThumbnail(dirPath: string): Promise<void> {
  await fsp.rm(folderThumbPathFor(dirPath), { force: true }).catch(() => undefined);
}

/**
 * Loads a directory's thumbnail as a data URL. If no `wst.jpg` exists yet, this
 * auto-generates one from the first thumbnailable file in the directory.
 * Returns null for an empty/unthumbnailable directory.
 */
export async function loadFolderThumbnail(
  dirPath: string
): Promise<string | null> {
  const targetPath = folderThumbPathFor(dirPath);
  if (!existsSync(targetPath)) {
    await generateFolderThumbnail(dirPath);
  }
  if (!existsSync(targetPath)) return null;

  // Windows may briefly lock the file after generation/copy; retry on EBUSY.
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const buf = await fsp.readFile(targetPath);
      return `data:image/jpeg;base64,${buf.toString('base64')}`;
    } catch (e) {
      lastError = e as Error;
      if ((e as NodeJS.ErrnoException).code !== 'EBUSY') break;
      await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
    }
  }
  throw lastError;
}

/**
 * Sets a custom image as the folder background (`wsb.jpg`). Backgrounds are
 * stored at a higher resolution than thumbnails.
 */
export async function setFolderBackground(
  dirPath: string,
  sourcePath: string
): Promise<void> {
  const targetPath = folderBackgroundPathFor(dirPath);
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const buf = await getSharp()(sourcePath)
    .rotate()
    .resize({
      width: 1024,
      height: 1024,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
    .toBuffer();
  await atomicWriteBytes(targetPath, buf);
}

/** Removes a directory's background image. No-op if absent. */
export async function clearFolderBackground(dirPath: string): Promise<void> {
  await fsp.rm(folderBackgroundPathFor(dirPath), { force: true }).catch(() => undefined);
}

/**
 * Loads a directory's background as a data URL. Does not auto-generate;
 * backgrounds are manual-only.
 */
export async function loadFolderBackground(
  dirPath: string
): Promise<string | null> {
  const targetPath = folderBackgroundPathFor(dirPath);
  if (!existsSync(targetPath)) return null;
  const buf = await fsp.readFile(targetPath);
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}
