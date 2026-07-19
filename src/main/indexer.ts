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
  tags: string[]
): IndexEntry {
  return {
    name,
    path: toRel(rootPath, fullPath),
    isDir,
    size: isDir ? 0 : size,
    mtime,
    ext: isDir ? '' : extOf(name),
    tags,
  };
}

/** Recursively walks `rootPath`, returning a flat list of IndexEntry. */
export async function buildIndex(
  rootPath: string,
  onProgress?: (scanned: number) => void
): Promise<IndexEntry[]> {
  const entries: IndexEntry[] = [];

  async function walk(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return; // unreadable subdir — skip silently
    }
    // Stat with bounded concurrency, then split files / dirs so the directory's
    // sidecars can be read once (wsd.json is a single aggregated file).
    const stats = await mapWithConcurrency(names, 16, async (name) => {
      const full = path.join(dir, name);
      try {
        return { name, full, stat: await fsp.stat(full) };
      } catch {
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
      const sidecars = await readSidecars(dir, files.map((f) => f.name));
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
            tags
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
  return entries;
}
