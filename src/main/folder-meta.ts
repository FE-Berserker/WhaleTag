import path from 'path';
import { promises as fsp } from 'fs';
import {
  META_DIR,
  FOLDER_META_FILE,
  type FolderMeta,
} from '../shared/whale-meta';
import { atomicWriteJson } from './atomic-write';
import { withLock } from './dir-lock';

/**
 * Per-folder metadata store (`.whale/wsm.json`). Holds a single folder's
 * tags/color/description plus its view preferences (perspective, entrySize) —
 * one small JSON file per directory, distinct from the per-file `wsd.json`.
 *
 * Writes are merge-first (read-modify-write): `writeFolderMeta` only overwrites
 * the keys it's given, so setting the perspective never clobbers a folder's
 * tags/description. Data is sacred — partial writes never wipe untouched fields.
 *
 * Concurrency: each directory's wsm.json is mutated under the same per-directory
 * lock (`dir-lock.ts`) the sidecar store uses, so concurrent writes to one
 * folder serialize instead of clobbering each other. Reads are lock-free.
 * Atomicity: temp+rename via `atomic-write.ts`, so a crash mid-write leaves the
 * previous file intact.
 */

/** Path of a directory's folder-metadata file (`<dir>/.whale/wsm.json`). */
function wsmPath(dirPath: string): string {
  return path.join(dirPath, META_DIR, FOLDER_META_FILE);
}

/** True when a FolderMeta carries nothing worth persisting (keep the store sparse). */
function isFolderMetaEmpty(meta: FolderMeta): boolean {
  return (
    (!meta.tags || meta.tags.length === 0) &&
    !meta.color &&
    !meta.description &&
    !meta.perspective &&
    meta.entrySize === undefined
  );
}

/** Reads a directory's wsm.json; returns `{}` if absent or invalid. Lock-free. */
export async function readFolderMeta(dirPath: string): Promise<FolderMeta> {
  try {
    const data = await fsp.readFile(wsmPath(dirPath), 'utf8');
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === 'object') return parsed as FolderMeta;
    return {};
  } catch {
    return {};
  }
}

/**
 * Merges `patch` into a directory's wsm.json (read-modify-write under the dir
 * lock). Only the keys present in `patch` are changed; pass `undefined` for a
 * key to clear it. Creates `.whale/` if needed; removes the file if the merged
 * result is empty so an unconfigured folder leaves no trace.
 */
export async function writeFolderMeta(
  dirPath: string,
  patch: Partial<FolderMeta>
): Promise<void> {
  await withLock(dirPath, async () => {
    const current = await readFolderMeta(dirPath);
    const merged: FolderMeta = { ...current, ...patch };
    // Drop keys explicitly cleared to undefined so they don't linger in JSON.
    (Object.keys(patch) as (keyof FolderMeta)[]).forEach((k) => {
      if (patch[k] === undefined) delete merged[k];
    });
    const target = wsmPath(dirPath);
    if (isFolderMetaEmpty(merged)) {
      await fsp.rm(target, { force: true }).catch(() => undefined);
      return;
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await atomicWriteJson(target, merged);
  });
}
