import path from 'path';
import { existsSync, promises as fsp } from 'fs';
import { META_DIR, TRANSCODES_DIR } from '../shared/whale-meta';
import { atomicWriteBytes } from './atomic-write';
import { convertOfficeToPdf } from './office-convert';

/**
 * Office→PDF transcode cache for documents Whale's office-viewer opens.
 *
 * The main process converts once (LibreOffice `soffice --convert-to pdf`) and
 * stores the result at `<dir>/.whale/transcodes/<basename>.pdf`, mirroring the
 * audio Opus cache at `<dir>/.whale/transcodes/<basename>.opus`
 * ([src/main/transcode-cache.ts](./transcode-cache.ts)) — same mtime
 * invalidation, atomic write, inflight dedup, and rename/move/copy cleanup
 * hooks. Replay is then instant (cache hit → ~100ms vs ~5s cold soffice
 * start + convert).
 *
 * The PDF lives in `TRANSCODES_DIR` (not a new `office-pdf/` dir) because it's
 * conceptually a transcode — a derived asset produced by an external tool,
 * not a thumbnail (which lives in `THUMBS_DIR` as a 256px JPEG).
 */

const PDF_EXT = '.pdf';

/** `<dir>/.whale/transcodes/<basename>.pdf` for a given source Office file. */
export function officePdfPathFor(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    META_DIR,
    TRANSCODES_DIR,
    `${path.basename(filePath)}${PDF_EXT}`
  );
}

// Concurrent calls for the SAME source share one in-flight soffice run (opening
// a file while the grid is still mounting can fire several requests). Mirrors
// transcode-cache.ts's `inflight` map and thumbnail.ts's same pattern.
const inflight = new Map<string, Promise<Buffer>>();

/**
 * Returns the PDF transcode of `filePath` as a Buffer — from the cache when
 * fresh (source unchanged), otherwise transcoded via LibreOffice and cached.
 * Throws when the source is gone or soffice fails; the caller surfaces the
 * error to office-viewer, which shows it in its status bar.
 *
 * `options.sofficePath` is forwarded to `convertOfficeToPdf` for a one-shot
 * override (e.g. user-configured binary path). It does NOT participate in the
 * cache key — concurrent calls with different `sofficePath` dedup to the first
 * one in flight, matching `loadTranscode` behavior.
 */
export function loadOfficePdf(
  filePath: string,
  options?: { sofficePath?: string | null }
): Promise<Buffer> {
  const existing = inflight.get(filePath);
  if (existing) return existing;
  const run = doLoadOfficePdf(filePath, options).finally(() => {
    inflight.delete(filePath);
  });
  inflight.set(filePath, run);
  return run;
}

async function doLoadOfficePdf(
  filePath: string,
  options?: { sofficePath?: string | null }
): Promise<Buffer> {
  const target = officePdfPathFor(filePath);
  let srcMtime: number;
  try {
    srcMtime = (await fsp.stat(filePath)).mtimeMs;
  } catch {
    throw new Error('source office file is gone');
  }

  // Cache hit: reuse while the source is unchanged (mtime compare, same shape
  // as `transcode-cache.ts:doLoadTranscode` and `thumbnail.ts`).
  if (existsSync(target)) {
    try {
      if ((await fsp.stat(target)).mtimeMs >= srcMtime) {
        return fsp.readFile(target);
      }
    } catch {
      // fall through and regenerate
    }
  }

  const buf = await convertOfficeToPdf(filePath, options);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await atomicWriteBytes(target, buf);
  return buf;
}

/** Removes a file's PDF cache (used when the file is deleted). No-op if absent. */
export async function removeOfficePdf(filePath: string): Promise<void> {
  await fsp.rm(officePdfPathFor(filePath), { force: true }).catch(() => undefined);
}

/** Moves a file's PDF cache to follow a rename/move. No-op if the file had none. */
export async function moveOfficePdf(
  oldPath: string,
  newPath: string
): Promise<void> {
  const oldCache = officePdfPathFor(oldPath);
  if (!existsSync(oldCache)) return;
  const newCache = officePdfPathFor(newPath);
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

/** Copies a file's PDF cache alongside a file copy. No-op if the source had none. */
export async function copyOfficePdf(
  sourcePath: string,
  destPath: string
): Promise<void> {
  const srcCache = officePdfPathFor(sourcePath);
  if (!existsSync(srcCache)) return;
  const destCache = officePdfPathFor(destPath);
  await fsp.mkdir(path.dirname(destCache), { recursive: true });
  await fsp.copyFile(srcCache, destCache);
}