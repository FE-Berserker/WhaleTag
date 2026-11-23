import path from 'path';
import { promises as fsp } from 'fs';
import { META_DIR } from '../shared/whale-meta';
import { atomicWriteJson } from './atomic-write';
import { withLock } from './dir-lock';
import { readJsonForMerge } from './merge-read';

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

/** True when a value is a wtaglib.json document safe to merge into. */
function isTagLibraryShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const descriptions = (value as { descriptions?: unknown }).descriptions;
  return (
    typeof descriptions === 'object' &&
    descriptions !== null &&
    !Array.isArray(descriptions)
  );
}

/**
 * Keep the location sparse: remove the library file when it carries nothing.
 * If removal fails (Windows EBUSY/EPERM from another open handle, read-only
 * media), persist an explicit empty document instead — leaving the stale file
 * in place would resurrect every description the user just cleared on the next
 * read, which is worse than one harmless empty file.
 */
async function removeOrEmptyLibrary(
  target: string,
  emptyDoc: () => LocationTagLibrary
): Promise<void> {
  try {
    await fsp.rm(target, { force: true });
  } catch (error) {
    console.warn(
      '[tag-library] could not remove empty wtaglib.json; writing an empty document instead:',
      error
    );
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await atomicWriteJson(target, emptyDoc());
  }
}

/**
 * Merge-safe read for the setters: an unreadable/corrupt wtaglib.json is
 * quarantined rather than read as "no descriptions" (see merge-read.ts).
 */
async function readDescriptionsForMerge(
  locationRoot: string
): Promise<Record<string, string>> {
  const parsed = await readJsonForMerge(
    wtaglibPath(locationRoot),
    isTagLibraryShape
  );
  return parsed
    ? { ...(parsed as LocationTagLibrary).descriptions }
    : {};
}

/**
 * Reads a location's `wtaglib.json` for display.
 *
 * A MISSING file legitimately means "no descriptions yet" → `{}`. Anything
 * else — an unreadable file, malformed JSON, or a document whose shape is not
 * a tag library — is THROWN with the path instead of being reported as "no
 * descriptions": a corrupt library silently read as empty makes every
 * description look deleted, and one edit would then quarantine/overwrite the
 * user's whole vocabulary (docs/02 §9 "损坏 ≠ 空").
 */
export async function readTagLibrary(
  locationRoot: string
): Promise<Record<string, string>> {
  const target = wtaglibPath(locationRoot);
  let data: string;
  try {
    data = await fsp.readFile(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(
      `Failed to read the tag library at ${target}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    throw new Error(
      `Malformed tag library at ${target}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!isTagLibraryShape(parsed)) {
    throw new Error(
      `Malformed tag library at ${target}: expected an object with a "descriptions" object`
    );
  }
  // Return a copy: callers treat the result as display state and must never
  // be able to mutate the parsed document through it.
  return { ...(parsed as LocationTagLibrary).descriptions };
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
    const current = await readDescriptionsForMerge(locationRoot);
    const next: Record<string, string> = { ...current };
    const trimmed = description.trim();
    if (trimmed) next[tag] = trimmed;
    else delete next[tag];
    const target = wtaglibPath(locationRoot);
    if (Object.keys(next).length === 0) {
      await removeOrEmptyLibrary(target, () => ({
        version: TAG_LIBRARY_VERSION,
        descriptions: {},
      }));
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
    const current = await readDescriptionsForMerge(locationRoot);
    if (!(tag in current)) return;
    const next: Record<string, string> = { ...current };
    delete next[tag];
    const target = wtaglibPath(locationRoot);
    if (isTagLibraryEmpty({ version: TAG_LIBRARY_VERSION, descriptions: next })) {
      await removeOrEmptyLibrary(target, () => ({
        version: TAG_LIBRARY_VERSION,
        descriptions: {},
      }));
      return;
    }
    await atomicWriteJson(target, {
      version: TAG_LIBRARY_VERSION,
      descriptions: next,
    });
  });
}
