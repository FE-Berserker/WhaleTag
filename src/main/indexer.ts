import path from 'path';
import { promises as fsp, type Stats } from 'fs';
import { mergeTags } from '../shared/tags';
import type { IndexEntry } from '../shared/ipc-types';
import { readSidecars } from './sidecar';
import { mapWithConcurrency } from './concurrency';

/**
 * Walks a location root into a flat list of IndexEntry (relative paths,
 * portable). The list is ingested into the SQLite index by `index-db.ts` —
 * this module no longer reads or writes wsi.json (plan §6.6 P2 moved the index
 * to SQLite). Tags are always re-read from sidecars on every walk: tagging
 * doesn't change mtime, so a mtime cache on tags would hide newly-applied tags.
 */

/** Directories never indexed (our metadata dir + common heavy build artifacts). */
const IGNORE_DIRS = new Set(['.whale', 'node_modules', '.git']);

/** Relative path with forward slashes (stored portably in the index). */
function toRel(rootPath: string, fullPath: string): string {
  return path.relative(rootPath, fullPath).split(path.sep).join('/');
}

function extOf(name: string): string {
  return name.includes('.')
    ? name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    : '';
}

function makeEntry(
  rootPath: string,
  fullPath: string,
  name: string,
  isDir: boolean,
  mtime: number,
  size: number,
  tags: string[],
  tagsUnreadable = false
): IndexEntry {
  return {
    name,
    path: toRel(rootPath, fullPath),
    isDir,
    size: isDir ? 0 : size,
    mtime,
    ext: isDir ? '' : extOf(name),
    tags,
    ...(tagsUnreadable ? { tagsUnreadable: true } : {}),
  };
}

/** Result of a walk: the entries plus whether every path could be read. */
export interface WalkReport {
  entries: IndexEntry[];
  /**
   * False when at least one directory/file failed with an error other than
   * ENOENT (EPERM/EACCES/EBUSY…). The tree may still be there, so the
   * ingester must not treat missing entries as deletions.
   */
  complete: boolean;
  /** Paths that could not be read/walked (for the warning log). */
  unreadable: string[];
}

/** True for "it really is gone" — any other error may be transient. */
function isVanished(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Recursively walks `rootPath`, returning the entries plus a completeness flag.
 * `complete: false` makes `index-db.ingestFiles` keep the stored rows for
 * paths it did not see, instead of deleting a subtree that was merely
 * unreadable (e.g. a transient EACCES on a network share).
 */
export async function buildIndexReport(
  rootPath: string,
  onProgress?: (scanned: number) => void
): Promise<WalkReport> {
  const entries: IndexEntry[] = [];
  const unreadable: string[] = [];

  async function walk(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch (error) {
      // ENOENT: the directory vanished between listing and recursion — its
      // rows are genuinely stale and the delete pass should drop them.
      // Anything else means the subtree may still exist; keep its rows.
      if (!isVanished(error)) unreadable.push(dir);
      return;
    }
    // Stat with bounded concurrency, then split files / dirs so the directory's
    // sidecars can be read once (wsd.json is a single aggregated file).
    const stats = await mapWithConcurrency(names, 16, async (name) => {
      const full = path.join(dir, name);
      try {
        return { name, full, stat: await fsp.stat(full) };
      } catch (error) {
        if (!isVanished(error)) unreadable.push(full);
        return null;
      }
    });
    const dirs: { name: string; full: string; stat: Stats }[] = [];
    const files: { name: string; full: string; stat: Stats }[] = [];
    for (const s of stats) {
      if (!s) continue;
      if (s.stat.isDirectory()) {
        if (!IGNORE_DIRS.has(s.name)) dirs.push(s);
      } else if (s.stat.isFile()) {
        files.push(s);
      }
    }

    for (const { name, full, stat } of dirs) {
      entries.push(
        makeEntry(rootPath, full, name, true, stat.mtime.getTime(), 0, [])
      );
    }

    if (files.length) {
      let sidecars: Awaited<ReturnType<typeof readSidecars>> = {};
      let tagsUnreadable = false;
      try {
        sidecars = await readSidecars(dir, files.map((f) => f.name));
      } catch (error) {
        // A corrupt/unreadable wsd.json must not abort the whole location scan.
        // Keep the error visible and index this directory without stored tags;
        // write APIs still reject so the damaged metadata is never overwritten.
        // `tagsUnreadable` tells the ingester to keep the tags already stored
        // for these rows — a transient read failure must not erase the tag
        // index (the sidecar itself is still intact on disk).
        tagsUnreadable = true;
        console.warn('[indexer] Sidecar read failed; indexing without stored tags:', dir, error);
      }
      for (const { name, full, stat } of files) {
        const tags = mergeTags(name, sidecars[name]?.tags ?? []);
        entries.push(
          makeEntry(
            rootPath,
            full,
            name,
            false,
            stat.mtime.getTime(),
            stat.size,
            tags,
            tagsUnreadable
          )
        );
      }
    }

    // Recurse into subdirs with bounded concurrency (was a serial
    // `for ... await`), so a wide location (many top-level subdirs) doesn't
    // walk depth-first with zero parallelism. `entries.push` is synchronous,
    // so concurrent walks share it safely — JS async only interleaves at await
    // boundaries, never mid-statement. Insertion order becomes non-deterministic,
    // which is fine: the SQLite index is order-independent and queries re-sort.
    await mapWithConcurrency(dirs, 8, ({ full }) => walk(full));

    // docs/04 §10 progress (scan phase): report after each directory; the
    // worker throttles the actual events.
    onProgress?.(entries.length);
  }

  await walk(rootPath);
  return { entries, complete: unreadable.length === 0, unreadable };
}

/** Recursively walks `rootPath`, returning a flat list of IndexEntry. */
export async function buildIndex(
  rootPath: string,
  onProgress?: (scanned: number) => void
): Promise<IndexEntry[]> {
  return (await buildIndexReport(rootPath, onProgress)).entries;
}
