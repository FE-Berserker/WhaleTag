import path from 'path';
import { promises as fsp } from 'fs';
import { ipcMain } from 'electron';
import { DirEntry } from '../../shared/ipc-types';
import { mapWithConcurrency } from '../concurrency';
import { decodeTextBuffer } from '../text-decode';
import { loadRecursiveScan } from '../recursive-cache';
import { assertWithinAllowedRoot } from '../allowed-roots';

/**
 * Read-side `fs:*` handlers: directory listing (flat + recursive) and text /
 * binary file reads. Every path-taking handler here is confined to the
 * configured location roots. Split out of the old god-registrar
 * `ipc.ts` (docs/01 §12) — behavior is otherwise unchanged.
 */

/** Names of entries that are never useful to show in a file browser. */
const HIDDEN = new Set(['.DS_Store', 'Thumbs.db', 'ehthumbs.db']);

function entryFromName(dirPath: string, name: string): DirEntry {
  const fullPath = path.join(dirPath, name);
  return {
    name,
    path: fullPath,
    isDirectory: false,
    isFile: true,
    size: 0,
    modified: '',
    extension: name.includes('.')
      ? name.slice(name.lastIndexOf('.') + 1).toLowerCase()
      : '',
  };
}

/**
 * Stats one directory entry (falling back to lstat for broken symlinks).
 * Returns null when the entry can't be read at all, so the caller can skip it.
 */
async function buildEntry(dirPath: string, name: string): Promise<DirEntry | null> {
  const entry = entryFromName(dirPath, name);
  try {
    const stat = await fsp.stat(entry.path);
    entry.isDirectory = stat.isDirectory();
    entry.isFile = stat.isFile();
    entry.size = stat.isFile() ? stat.size : 0;
    entry.modified = stat.mtime.toISOString();
    if (entry.isDirectory) entry.extension = '';
  } catch {
    // Broken symlink / unreadable entry: fall back to lstat, skip if still bad.
    try {
      const lstat = await fsp.lstat(entry.path);
      entry.isDirectory = lstat.isDirectory();
      entry.isFile = lstat.isFile();
    } catch {
      return null;
    }
  }
  return entry;
}

/** Resolves metadata for every direct child of `dirPath`. */
export async function listDirectory(dirPath: string): Promise<DirEntry[]> {
  const names = (await fsp.readdir(dirPath)).filter((n) => !HIDDEN.has(n));
  // Stat entries with bounded concurrency — a 10k-file directory would
  // otherwise fan out 10k simultaneous stat syscalls.
  const entries = await mapWithConcurrency(names, 16, (name) =>
    buildEntry(dirPath, name)
  );
  const results = entries.filter((e): e is DirEntry => e !== null);

  // Folders first, then files, both alphabetical (case-insensitive).
  results.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return results;
}

/**
 * Hard cap on the number of entries a single recursive scan returns. Mirrors
 * `MAX_RECURSIVE_ENTRIES` in `src/shared/recursive-entries.ts` — kept local
 * here because importing the shared module would pull renderer-only deps
 * (`extractTags` via `-/services/tags`) into the main bundle. When a scan
 * overflows, the renderer surfaces `<ErrorBanner>` (i18n
 * `recursiveEntriesTruncated`). Plan §H.24 R7: the cap is enforced on the
 * main side so a pathological tree (e.g. a 5-deep `node_modules`) can never
 * push a 100k-entry IPC payload that freezes the renderer.
 */
const MAX_RECURSIVE_ENTRIES = 10000;

/**
 * Recursively lists entries under `dirPath` up to `remainingDepth` levels deep.
 * The metadata folder `.whale` is excluded. Returns a flat list of DirEntry
 * objects with absolute paths, suitable for building a visualization tree.
 */
async function listDirectoryRecursive(
  dirPath: string,
  remainingDepth: number,
  // Remaining entry budget for this subtree; the top-level caller uses the
  // full cap and each recursion spends what it collected so a runaway branch
  // is bounded by the original limit, not by per-call limits.
  cap = MAX_RECURSIVE_ENTRIES
): Promise<DirEntry[]> {
  const direct = (await listDirectory(dirPath)).filter(
    (e) => e.name !== '.whale'
  );
  if (direct.length >= cap) return direct.slice(0, cap);
  const all: DirEntry[] = [...direct];
  if (remainingDepth <= 1) return all;

  const dirs = direct.filter((e) => e.isDirectory);
  const nested = await mapWithConcurrency(dirs, 16, (d) =>
    listDirectoryRecursive(d.path, remainingDepth - 1, cap - all.length)
  );
  for (const children of nested) {
    all.push(...children);
    if (all.length >= cap) return all.slice(0, cap);
  }
  return all;
}

/**
 * Reads a text file and returns it as UTF-8, auto-detecting non-UTF-8 encodings.
 * Shares `decodeTextBuffer` with the full-text indexer so a document is decoded
 * the same way for display and for search (`src/main/text-decode.ts`).
 */
export async function readTextFile(filePath: string): Promise<string> {
  return decodeTextBuffer(await fsp.readFile(filePath));
}

export function registerFsReadHandlers(): void {
  // Listing is a read too, and `listDirectoryRecursive` even writes its scan
  // cache into `<dir>/.whale/index-recursive/` — so both are confined exactly
  // like file reads (docs/13 §10). Before 2026-11 they were bare `readdir`
  // calls, which let a compromised renderer enumerate any directory on disk.
  ipcMain.handle('fs:listDirectory', (_event, dirPath: string) => {
    assertWithinAllowedRoot(dirPath);
    return listDirectory(dirPath);
  });

  ipcMain.handle(
    'fs:listDirectoryRecursive',
    (_event, dirPath: string, options?: { maxDepth?: number }) => {
      assertWithinAllowedRoot(dirPath);
      return loadRecursiveScan(dirPath, options?.maxDepth ?? 3, listDirectoryRecursive);
    }
  );

  ipcMain.handle('fs:readTextFile', (_event, filePath: string) => {
    assertWithinAllowedRoot(filePath);
    return readTextFile(filePath);
  });

  // Read-side confinement (docs/13 §13): reads, like writes, are confined to
  // configured locations.
  ipcMain.handle('fs:readFile', (_event, filePath: string) => {
    assertWithinAllowedRoot(filePath);
    return fsp.readFile(filePath);
  });

  // Encode in Main so binary embeds cross IPC as one string rather than a
  // large numeric byte array that the renderer must convert one byte at a time.
  ipcMain.handle('fs:readFileBase64', async (_event, filePath: string) => {
    assertWithinAllowedRoot(filePath);
    const buf = await fsp.readFile(filePath);
    return buf.toString('base64');
  });

  // `fs:pathExists` used to live here: an unconfined `existsSync` that no
  // renderer code ever called. Removed in 2026-11 rather than confined —
  // dead IPC surface is attack surface.
}
