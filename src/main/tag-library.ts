import path from 'path';
import { promises as fsp } from 'fs';
import { META_DIR } from '../shared/whale-meta';
import { atomicWriteJson } from './atomic-write';
import { withLock } from './dir-lock';

/**
 * Per-location tag library (`.whale/wtaglib.json`).
 *
 * Each location owns ONE vocabulary: a free-form description per tag, shared
 * by every file in that location. The intent is "the location defines what its
 * tags MEAN", so two locations can give the same tag string very different
 * semantics (e.g. `urgent` means "ship today" in one project and "needs review"
 * in another) without colliding.
 *
 * Storage shape:
 *   {
 *     "version": 1,
 *     "descriptions": { "<tag>": "<description>", ... }
 *   }
 *
 * Sparse: when `descriptions` is empty, the file is removed so an unconfigured
 * location leaves no trace. Writes are merge-first under the per-location lock
 * (so concurrent writes serialize), atomic via `atomicWriteJson` (so a crash
 * mid-write leaves the previous file intact — data is sacred).
 */

/** File name of a location's tag library. */
const TAG_LIBRARY_FILE = 'wtaglib.json';

/** Schema version of `wtaglib.json`. Bump on shape changes. */
const TAG_LIBRARY_VERSION = 1;

interface LocationTagLibrary {
  version: number;
  descriptions: Record<string, string>;
}

/** Path of a location root's tag-library file. */
function wtaglibPath(locationRoot: string): string {
  return path.join(locationRoot, META_DIR, TAG_LIBRARY_FILE);
}

/** True when a tag library carries nothing worth persisting (keep storage sparse). */
function isTagLibraryEmpty(lib: LocationTagLibrary): boolean {
  return Object.keys(lib.descriptions).length === 0;
}

/** Reads a location's `wtaglib.json`; returns `{}` when absent or invalid. */
export async function readTagLibrary(
  locationRoot: string
): Promise<Record<string, string>> {
  try {
    const data = await fsp.readFile(wtaglibPath(locationRoot), 'utf8');
    const parsed = JSON.parse(data);
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.descriptions &&
      typeof parsed.descriptions === 'object'
    ) {
      return parsed.descriptions as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Sets `tag`'s description in a location's `wtaglib.json` (read-modify-write
 * under the location's lock). Empty / whitespace-only descriptions REMOVE the
 * entry — there's no point persisting an empty string. When the resulting
 * library is empty, the file is deleted entirely.
 *
 * `tag` is taken verbatim (no normalization) so callers can persist any tag
 * string the location's files actually carry.
 */
export async function setTagLibraryDescription(
  locationRoot: string,
  tag: string,
  description: string
): Promise<void> {
  await withLock(locationRoot, async () => {
    const current = await readTagLibrary(locationRoot);
    const next: Record<string, string> = { ...current };
    const trimmed = description.trim();
    if (trimmed) next[tag] = trimmed;
    else delete next[tag];
    const target = wtaglibPath(locationRoot);
    if (Object.keys(next).length === 0) {
      await fsp.rm(target, { force: true }).catch(() => undefined);
      return;
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await atomicWriteJson(target, {
      version: TAG_LIBRARY_VERSION,
      descriptions: next,
    });
  });
}

/**
 * Removes a tag's description entry (if any) from a location's `wtaglib.json`.
 * Idempotent — no error when the tag wasn't present. The file is deleted when
 * the last entry is removed.
 */
export async function clearTagLibraryDescription(
  locationRoot: string,
  tag: string
): Promise<void> {
  await withLock(locationRoot, async () => {
    const current = await readTagLibrary(locationRoot);
    if (!(tag in current)) return;
    const next: Record<string, string> = { ...current };
    delete next[tag];
    const target = wtaglibPath(locationRoot);
    if (isTagLibraryEmpty({ version: TAG_LIBRARY_VERSION, descriptions: next })) {
      await fsp.rm(target, { force: true }).catch(() => undefined);
      return;
    }
    await atomicWriteJson(target, {
      version: TAG_LIBRARY_VERSION,
      descriptions: next,
    });
  });
}

/** Internal helper for tests / IPC: returns the absolute file path of a
 *  location's tag library (or null when nothing's there yet). */
export function tagLibraryFilePath(locationRoot: string): string {
  return wtaglibPath(locationRoot);
}