import path from 'path';
import { existsSync, promises as fsp } from 'fs';
import { META_DIR, TRANSCODES_DIR } from '../shared/whale-meta';

/**
 * Opus transcode cache for audio formats Chromium can't play natively. The
 * `whale-audio://` protocol handler streams the transcode live on first open
 * (ffmpeg → Opus piped straight to `<audio>`, playback starts within ~1s) and
 * tees the output to `<dir>/.whale/transcodes/<basename>.opus` so the next
 * open hits a fresh cache file served with full Range/seek support. Mirrors
 * the thumbnail cache at `<dir>/.whale/thumbs/<basename>.jpg` (same mtime
 * invalidation + rename/move/copy cleanup hooks).
 */

/** `<dir>/.whale/transcodes/<basename>.opus` for a given source audio file. */
export function transcodePathFor(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    META_DIR,
    TRANSCODES_DIR,
    `${path.basename(filePath)}.opus`
  );
}

/**
 * Whether a fresh Opus transcode cache exists for `filePath`. "Fresh" means
 * the cache file's mtime is >= the source's mtime (same invalidation rule as
 * the thumbnail cache). Returns `{ path, fresh }` so the caller can serve the
 * cached file on a hit without re-deriving the path. Never throws — a stat
 * failure (e.g. source gone mid-request) reports `fresh: false` so the
 * protocol handler can surface its own error.
 */
export async function isTranscodeCached(
  filePath: string
): Promise<{ path: string; fresh: boolean }> {
  const target = transcodePathFor(filePath);
  let srcMtime: number;
  try {
    srcMtime = (await fsp.stat(filePath)).mtimeMs;
  } catch {
    return { path: target, fresh: false };
  }
  if (!existsSync(target)) return { path: target, fresh: false };
  try {
    if ((await fsp.stat(target)).mtimeMs >= srcMtime) {
      return { path: target, fresh: true };
    }
  } catch {
    // fall through — treat as stale / miss
  }
  return { path: target, fresh: false };
}

/** Removes a file's transcode cache (used when the file is deleted). No-op if absent. */
export async function removeTranscode(filePath: string): Promise<void> {
  await fsp.rm(transcodePathFor(filePath), { force: true }).catch(() => undefined);
}

/** Moves a file's transcode cache to follow a rename/move. No-op if the file had none. */
export async function moveTranscode(
  oldPath: string,
  newPath: string
): Promise<void> {
  const oldCache = transcodePathFor(oldPath);
  if (!existsSync(oldCache)) return;
  const newCache = transcodePathFor(newPath);
  await fsp.mkdir(path.dirname(newCache), { recursive: true });
  if (existsSync(newCache)) {
    await fsp.rm(newCache, { force: true });
  }
  try {
    await fsp.rename(oldCache, newCache);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    await fsp.copyFile(oldCache, newCache);
    await fsp.rm(oldCache, { force: false });
  }
}

/** Copies a file's transcode cache alongside a file copy. No-op if the source had none. */
export async function copyTranscode(
  sourcePath: string,
  destPath: string
): Promise<void> {
  const srcCache = transcodePathFor(sourcePath);
  if (!existsSync(srcCache)) return;
  const destCache = transcodePathFor(destPath);
  await fsp.mkdir(path.dirname(destCache), { recursive: true });
  await fsp.copyFile(srcCache, destCache);
}
