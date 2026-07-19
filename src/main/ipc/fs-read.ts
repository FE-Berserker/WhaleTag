import path from 'path';
import { existsSync, promises as fsp } from 'fs';
import { ipcMain } from 'electron';
import { DirEntry } from '../../shared/ipc-types';
import { mapWithConcurrency } from '../concurrency';
import { getChardet, getIconv } from '../lazy-native';
import { loadRecursiveScan } from '../recursive-cache';
import { assertWithinAllowedRoot } from '../allowed-roots';

/**
 * Read-side `fs:*` handlers: directory listing (flat + recursive), text /
 * binary file reads, existence probe. Split out of the old god-registrar
 * `ipc.ts` (docs/01 §12) — behavior is verbatim; only the module boundary
 * is new.
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
async function listDirectory(dirPath: string): Promise<DirEntry[]> {
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

/** Reads a text file and returns it as UTF-8, auto-detecting non-UTF-8 encodings. */
async function readTextFile(filePath: string): Promise<string> {
  const buf = await fsp.readFile(filePath);

  // UTF-8 BOM: strip the marker and decode the remainder as UTF-8.
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString('utf8', 3);
  }

  const utf8 = buf.toString('utf8');
  // chardet only needs a small byte sample to identify an encoding; running
  // it over a multi-MB buffer is wasted main-thread CPU. subarray is a
  // zero-copy view, so this is cheap.
  const CHARDET_SAMPLE = 256 * 1024;
  const detected = getChardet().detect(
    buf.length > CHARDET_SAMPLE ? buf.subarray(0, CHARDET_SAMPLE) : buf
  );
  const encoding = detected?.encoding?.toLowerCase() ?? 'utf8';
  const confidence = detected?.confidence ?? 0;

  // High-confidence UTF-8 / ASCII -> decode as UTF-8.
  if ((encoding === 'utf-8' || encoding === 'ascii') && confidence >= 0.8) {
    return utf8;
  }

  // Very low confidence usually means the sample is too short or ambiguous;
  // modern files are overwhelmingly UTF-8, so prefer that default.
  if (confidence < 0.3) {
    return utf8;
  }

  // Decode with the detected encoding. jschardet may report ASCII for files
  // that are mostly ASCII with a few non-UTF-8 bytes (common for older Chinese
  // Windows text), so keep the detected name as the iconv target unless it is
  // clearly a UTF-8 alias.
  const target = encoding === 'utf-8' || encoding === 'ascii' ? 'utf8' : encoding;
  const decoded = getIconv().decode(buf, target);

  // A legacy-encoded file may contain a handful of invalid bytes (e.g. a
  // corrupted download or mixed-encoding ebook). Forcing UTF-8 in that case
  // produces *millions* of replacement characters, so we pick whichever
  // decoding yields fewer replacements.
  // Count U+FFFD WITHOUT `s.match(/�/g)` — that builds a giant array
  // (millions of entries) when a legacy/mixed-encoding file has many invalid
  // bytes. indexOf walks the string with no allocation.
  const countReplacements = (s: string): number => {
    let count = 0;
    let idx = s.indexOf('�');
    while (idx !== -1) {
      count++;
      idx = s.indexOf('�', idx + 1);
    }
    return count;
  };
  const utf8Bad = countReplacements(utf8);
  const decodedBad = countReplacements(decoded);

  return decodedBad <= utf8Bad ? decoded : utf8;
}

export function registerFsReadHandlers(): void {
  ipcMain.handle('fs:listDirectory', (_event, dirPath: string) =>
    listDirectory(dirPath)
  );

  ipcMain.handle(
    'fs:listDirectoryRecursive',
    (_event, dirPath: string, options?: { maxDepth?: number }) =>
      loadRecursiveScan(dirPath, options?.maxDepth ?? 3, listDirectoryRecursive)
  );

  ipcMain.handle('fs:readTextFile', (_event, filePath: string) => {
    assertWithinAllowedRoot(filePath);
    return readTextFile(filePath);
  });

  // Read-side confinement (docs/13 §13): reads, like writes, are confined to
  // configured locations — an extension's `requestFileBytes` funnels here.
  ipcMain.handle('fs:readFile', (_event, filePath: string) => {
    assertWithinAllowedRoot(filePath);
    return fsp.readFile(filePath);
  });

  ipcMain.handle('fs:pathExists', (_event, targetPath: string) =>
    existsSync(targetPath)
  );
}
