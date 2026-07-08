import path from 'path';
import { existsSync, promises as fsp } from 'fs';
import { META_DIR, TRANSCODES_DIR } from '../shared/whale-meta';
import { atomicWriteBytes } from './atomic-write';
import { convertAudioToOpus } from './audio-convert';

/**
 * Opus transcode cache for audio formats Chromium can't play natively. The
 * main process transcodes once (ffmpeg → Opus) and stores the result at
 * `<dir>/.whale/transcodes/<basename>.opus`, mirroring the thumbnail cache at
 * `<dir>/.whale/thumbs/<basename>.jpg` (same mtime-invalidation, atomic write,
 * inflight dedup, and rename/move/copy cleanup hooks). Replay is then instant.
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

// Concurrent calls for the SAME source share one in-flight ffmpeg run (opening
// a file while the grid is still mounting can fire several requests). Mirrors
// thumbnail.ts's `inflight` map.
const inflight = new Map<string, Promise<Buffer>>();

/**
 * Returns the Opus transcode of `filePath` as a Buffer — from the cache when
 * fresh (source unchanged), otherwise transcoded via ffmpeg and cached.
 * Throws when the source is gone or ffmpeg fails; the caller surfaces the
 * error to media-player, which falls back to the system app.
 */
export function loadTranscode(filePath: string): Promise<Buffer> {
  const existing = inflight.get(filePath);
  if (existing) return existing;
  const run = doLoadTranscode(filePath).finally(() => {
    inflight.delete(filePath);
  });
  inflight.set(filePath, run);
  return run;
}

async function doLoadTranscode(filePath: string): Promise<Buffer> {
  const target = transcodePathFor(filePath);
  let srcMtime: number;
  try {
    srcMtime = (await fsp.stat(filePath)).mtimeMs;
  } catch {
    throw new Error('source audio file is gone');
  }

  // Cache hit: reuse while the source is unchanged (mtime compare, like
  // doGenerateThumbnail).
  if (existsSync(target)) {
    try {
      if ((await fsp.stat(target)).mtimeMs >= srcMtime) {
        return fsp.readFile(target);
      }
    } catch {
      // fall through and regenerate
    }
  }

  const buf = await convertAudioToOpus(filePath);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await atomicWriteBytes(target, buf);
  return buf;
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
