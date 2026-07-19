import { parentDir } from '-/services/path-util';

/**
 * Which currently-LOADED tree folders to reload after an fs.watch flush
 * (docs/04 §10). A change alters its PARENT directory's children listing;
 * folders the tree hasn't loaded yet are skipped — they load lazily on
 * expand anyway, so reloading them would be pure waste.
 *
 * `overflow: true` (the watcher's filename buffer overflowed) degrades to
 * "reload every loaded folder" — conservative but correct, and rare.
 */
export function changedParentsToReload(
  changedFullPaths: string[],
  loadedDirs: ReadonlySet<string>,
  overflow: boolean
): string[] {
  if (overflow) return [...loadedDirs];
  const out = new Set<string>();
  for (const p of changedFullPaths) {
    const parent = parentDir(p);
    if (loadedDirs.has(parent)) out.add(parent);
  }
  return [...out];
}
