import path from 'path';
import { existsSync, promises as fsp } from 'fs';
import { execFile } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import {
  META_DIR,
  THUMBS_DIR,
  FOLDER_THUMB_FILE,
  FOLDER_BACKGROUND_FILE,
  thumbKindOf,
  isThumbnailable,
  type ThumbKind,
} from '../shared/whale-meta';
import { atomicWriteBytes } from './atomic-write';
import { thumbnailSemaphore } from './concurrency';
import { getSharp } from './lazy-native';
import { encodeImageThumb, THUMB_SIZE, THUMB_QUALITY } from './thumb-encode';
import { thumbRequest } from './thumb-worker-host';

/**
 * Per-file thumbnails, stored at `<dir>/.whale/thumbs/<basename>.jpg`.
 *
 * Generation is split across processes by backend. By source kind
 * (`thumbKindOf`):
 *  - **image** → sharp (N-API, libuv thread pool) resizes/encodes directly.
 *  - **video** → ffmpeg-static extracts one frame to a PNG buffer, then sharp
 *    resizes/encodes it.
 *  - **pdf** → pdfjs-dist renders page 1 to a `@napi-rs/canvas`, then sharp
 *    resizes/encodes it — pure-JS CPU, so it runs in the `whale-thumb`
 *    utilityProcess (`thumb-worker.ts`, see docs/06 §8).
 *  - **font** → `font-thumb.ts` registers the font with `@napi-rs/canvas`,
 *    draws a sample preview, and encodes it as PNG — inside the
 *    utilityProcess; sharp then produces the JPEG thumbnail there.
 *    Corrupt/unsupported fonts abort silently (icon).
 *
 * Output is always JPEG, max 256px. Cache: a thumbnail is reused while the
 * source is unchanged (`thumb.mtime >= source.mtime`). Cleanup mirrors
 * `sidecar.ts` (remove/move/copy on the matching `.jpg`) — all path-based and
 * format-agnostic, so adding kinds needs no IPC changes.
 */

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
        {
          encoding: 'buffer',
          maxBuffer: 64 * 1024 * 1024,
          // A stalled decoder (unreachable SMB share, a device file that never
          // yields a frame) used to hold one of the four encode permits
          // forever; four of those froze the whole thumbnail pipeline. Kill the
          // process instead and report a normal failure so the caller falls
          // back to the generic icon.
          timeout: 10_000,
          killSignal: 'SIGKILL',
        },
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

/** Encode any supported source to the common JPEG thumbnail format, without
 * choosing a cache location or writing to the source directory. */
async function encodeThumbnailBuffer(
  srcPath: string,
  kind: ThumbKind
): Promise<Buffer> {
  if (kind === 'video') return encodeVideoThumb(srcPath);
  if (kind === 'pdf') return thumbRequest('thumb:pdf', { srcPath });
  if (kind === 'font') return thumbRequest('thumb:font', { srcPath });
  if (kind === 'svg') return encodeSvgThumb(srcPath);
  return encodeImageThumb(srcPath);
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

export function generateThumbnail(filePath: string): Promise<void> {
  const existing = inflight.get(filePath);
  if (existing) return existing;
  const run = doGenerateThumbnail(filePath).finally(() => {
    inflight.delete(filePath);
  });
  inflight.set(filePath, run);
  return run;
}

/**
 * Source identity of the last successful generation per file. The on-disk
 * heuristic below (thumb mtime >= source mtime) cannot see a source that was
 * replaced with an OLDER timestamp — `cp -p`, `rsync -t`, or unzipping an
 * archive keeps the original mtime, so a different file with the same name
 * would keep the previous thumbnail forever. Remembering {mtimeMs,size} from
 * the actual generation lets us verify both dimensions in-session; on a cold
 * start we fall back to the mtime heuristic (cheap, and the worst case is one
 * stale thumbnail until the file changes again).
 */
const generatedFrom = new Map<string, { mtimeMs: number; size: number }>();
const GENERATED_FROM_MAX = 5000;

async function doGenerateThumbnail(filePath: string): Promise<void> {
  const kind = thumbKindOf(path.basename(filePath));
  if (!kind) return; // nothing Whale can thumbnail

  const target = thumbPathFor(filePath);
  let srcMtime: number;
  let srcSize: number;
  try {
    const srcStat = await fsp.stat(filePath);
    srcMtime = srcStat.mtimeMs;
    srcSize = srcStat.size;
  } catch {
    return; // source gone — nothing to generate; cleanup handles removal
  }

  // Reuse the existing thumbnail if the source is unchanged.
  const remembered = generatedFrom.get(filePath);
  const unchanged =
    remembered !== undefined &&
    remembered.mtimeMs === srcMtime &&
    remembered.size === srcSize;
  if (existsSync(target)) {
    if (unchanged) return;
    if (remembered === undefined) {
      try {
        if ((await fsp.stat(target)).mtimeMs >= srcMtime) return;
      } catch {
        // fall through and regenerate
      }
    }
  }

  // P1-6 (perf audit): bound concurrent thumbnail encodes (sharp / ffmpeg /
  // pdfjs) across ALL callers — file-thumb IPC AND folder thumbs.
  // The cheap kind/stat/reuse short-circuits above run OUTSIDE the permit so a
  // cache hit never consumes a slot; only the real encoding + write holds one.
  await thumbnailSemaphore.run(async () => {
    let buf: Buffer;
    try {
      buf = await encodeThumbnailBuffer(filePath, kind);
    } catch (e) {
      // An SVG may have no viewBox / invalid XML / unsupported features
      // librsvg can't parse. Fonts may be corrupt or use an unsupported
      // table/layout. In those cases fail silently so the renderer shows a
      // type icon. Returning from this lambda leaves no thumbnail on disk
      // (run() resolves to undefined).
      if (kind === 'svg' || kind === 'font') {
        return;
      }
      throw e;
    }

    await fsp.mkdir(path.dirname(target), { recursive: true });
    await atomicWriteBytes(target, buf);
    generatedFrom.set(filePath, { mtimeMs: srcMtime, size: srcSize });
    if (generatedFrom.size > GENERATED_FROM_MAX) {
      const oldest = generatedFrom.keys().next().value;
      if (oldest !== undefined) generatedFrom.delete(oldest);
    }
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
 * Encodes a manually picked supported source straight into the folder's own
 * metadata. The source may be outside every location (native file picker);
 * never call generateThumbnail(sourcePath) here, because that would create
 * `.whale/` next to the source. Reuses every file-thumbnail backend and the
 * shared semaphore.
 */
async function writeFolderThumbImage(
  sourcePath: string,
  targetPath: string
): Promise<void> {
  const kind = thumbKindOf(path.basename(sourcePath));
  if (!kind) throw new Error('Unsupported folder thumbnail source');
  const buf = await thumbnailSemaphore.run(() =>
    encodeThumbnailBuffer(sourcePath, kind)
  );
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await atomicWriteBytes(targetPath, buf);
}

/**
 * How many files (by sorted name) one folder-thumbnail generation tries
 * before it gives up: one damaged file must not condemn the whole folder.
 */
const FOLDER_SOURCE_CANDIDATES = 8;
/**
 * How long a folder whose every candidate failed is left alone, so repeated
 * renders do not re-run the failing encodes (a video can spend 10 s in ffmpeg
 * before it fails). Time-based on purpose: a finishing download does not
 * change the directory's mtime, a later retry must still pick it up.
 */
const FOLDER_FAIL_TTL_MS = 30_000;
const FOLDER_FAIL_MEMO_MAX = 1000;
/** dirPath → time of the last generation whose every candidate failed. */
const folderGenerateFailures = new Map<string, number>();

/**
 * Finds up to `limit` thumbnailable files in `dirPath` (by sorted name,
 * skipping the `.whale` meta directory). Returns [] when there are none.
 */
async function firstThumbnailableFiles(
  dirPath: string,
  limit: number
): Promise<string[]> {
  let names: string[];
  try {
    names = await fsp.readdir(dirPath);
  } catch {
    return [];
  }
  names.sort((a, b) => a.localeCompare(b));
  const found: string[] = [];
  for (const name of names) {
    if (name === META_DIR) continue;
    if (!isThumbnailable(name)) continue;
    const fullPath = path.join(dirPath, name);
    try {
      const st = await fsp.stat(fullPath);
      if (st.isFile()) {
        found.push(fullPath);
        if (found.length === limit) break;
      }
    } catch {
      continue;
    }
  }
  return found;
}

/**
 * Auto-generates a folder thumbnail from the first thumbnailable file in the
 * directory that actually encodes. Falls back to clearing any stale thumbnail
 * if no source exists.
 */
export async function generateFolderThumbnail(
  dirPath: string
): Promise<void> {
  const failedAt = folderGenerateFailures.get(dirPath);
  if (failedAt !== undefined && Date.now() - failedAt < FOLDER_FAIL_TTL_MS) {
    return;
  }
  const sourcePaths = await firstThumbnailableFiles(
    dirPath,
    FOLDER_SOURCE_CANDIDATES
  );
  const targetPath = folderThumbPathFor(dirPath);
  if (sourcePaths.length === 0) {
    await fsp.rm(targetPath, { force: true }).catch(() => undefined);
    return;
  }
  // One attempt on the alphabetically first file used to throw out of here
  // for a corrupt or truncated file: the folder never got a thumbnail and
  // every re-render re-ran the failing encode. Try the candidates in order.
  for (const sourcePath of sourcePaths) {
    try {
      // Reuse the file's thumbnail if already generated; otherwise create one.
      const fileThumb = thumbPathFor(sourcePath);
      if (!existsSync(fileThumb)) {
        await generateThumbnail(sourcePath);
      }
      if (!existsSync(fileThumb)) continue;
      await fsp.mkdir(path.dirname(targetPath), { recursive: true });
      await fsp.copyFile(fileThumb, targetPath);
      folderGenerateFailures.delete(dirPath);
      return;
    } catch (error) {
      console.warn(
        `[thumbnail] folder thumbnail: skipping ${sourcePath}`,
        error
      );
    }
  }
  if (folderGenerateFailures.size >= FOLDER_FAIL_MEMO_MAX) {
    folderGenerateFailures.clear();
  }
  folderGenerateFailures.set(dirPath, Date.now());
}

/**
 * Sets a custom image as the folder thumbnail. `sourcePath` may be any image
 * the user picked; only the destination folder's `.whale/wst.jpg` is written.
 */
export async function setFolderThumbnail(
  dirPath: string,
  sourcePath: string
): Promise<void> {
  const targetPath = folderThumbPathFor(dirPath);
  const fileThumb = thumbPathFor(sourcePath);
  if (existsSync(fileThumb)) {
    try {
      const [sourceStat, cacheStat] = await Promise.all([
        fsp.stat(sourcePath),
        fsp.stat(fileThumb),
      ]);
      if (cacheStat.mtimeMs >= sourceStat.mtimeMs) {
        await fsp.mkdir(path.dirname(targetPath), { recursive: true });
        await fsp.copyFile(fileThumb, targetPath);
        return;
      }
    } catch {
      // A stale/unreadable cache is not a reason to write back to the source;
      // fall through and encode directly into the destination instead.
    }
  }
  // No fresh reusable thumbnail: encode directly into the destination, never
  // into the source directory (Desktop, a USB drive, or another root).
  await writeFolderThumbImage(sourcePath, targetPath);
}

/** Removes a directory's thumbnail image. No-op if absent. */
export async function clearFolderThumbnail(dirPath: string): Promise<void> {
  // An explicit clear is a fresh start: a memoised failure must not keep the
  // folder blank for the rest of the TTL.
  folderGenerateFailures.delete(dirPath);
  await fsp.rm(folderThumbPathFor(dirPath), { force: true }).catch(() => undefined);
}

/**
 * Coalesce only active loads of the same folder asset. The target path is the
 * key so a folder's thumbnail and background never share each other's result.
 * No result is retained after settlement: later calls always observe the file
 * again, and a failed load can be retried immediately.
 */
const folderLoadInflight = new Map<string, Promise<string | null>>();

function coalesceFolderLoad(
  targetPath: string,
  load: () => Promise<string | null>
): Promise<string | null> {
  const existing = folderLoadInflight.get(targetPath);
  if (existing) return existing;
  const run = load().finally(() => {
    folderLoadInflight.delete(targetPath);
  });
  folderLoadInflight.set(targetPath, run);
  return run;
}

/**
 * Loads a directory's thumbnail as a data URL. If no `wst.jpg` exists yet, this
 * auto-generates one from the first thumbnailable file in the directory.
 * Returns null for an empty/unthumbnailable directory.
 */
export function loadFolderThumbnail(dirPath: string): Promise<string | null> {
  const targetPath = folderThumbPathFor(dirPath);
  return coalesceFolderLoad(targetPath, async () => {
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
  });
}

/**
 * Sets a custom image as the folder background (`wsb.jpg`). Backgrounds are
 * stored at a higher resolution than thumbnails.
 */
export async function setFolderBackground(
  dirPath: string,
  sourcePath: string,
  loadSharp: () => ReturnType<typeof getSharp> = getSharp
): Promise<void> {
  const targetPath = folderBackgroundPathFor(dirPath);
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const buf = await thumbnailSemaphore.run(() =>
    loadSharp()(sourcePath)
      .rotate()
      .resize({
        width: 1024,
        height: 1024,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
      .toBuffer()
  );
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
export function loadFolderBackground(dirPath: string): Promise<string | null> {
  const targetPath = folderBackgroundPathFor(dirPath);
  return coalesceFolderLoad(targetPath, async () => {
    if (!existsSync(targetPath)) return null;
    const buf = await fsp.readFile(targetPath);
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  });
}
