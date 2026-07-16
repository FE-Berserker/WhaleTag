import path from 'path';
import { realpathSync } from 'fs';
import { foldPath } from './path-fold';

/**
 * Roots the renderer has registered as configured locations. Destructive /
 * in-place writes (delete, create, mkdir, rename) are confined to these —
 * defense-in-depth so a compromised renderer can't touch files outside any
 * location. Move/copy DESTINATIONS are exempt (a user may move files into a
 * folder that isn't a location), but their sources are still checked.
 *
 * Security default: when no roots are registered, all destructive writes are
 * refused. The previous "first run allows everything" behavior made it possible
 * for a compromised renderer to call `fs:setAllowedRoots([])` and disable the
 * guard entirely.
 */
const allowedRoots = new Set<string>();

/**
 * Resolve `target` through symlinks for the security check.
 *
 * The path itself may not exist yet (e.g. a new file inside the location), so
 * we `realpathSync` what exists and append the unresolved tail. This prevents
 * symlink escapes: if a directory inside a location is a symlink pointing
 * outside, any write targeting a path below it resolves to the outside path
 * and is rejected.
 */
function resolveGuardPath(target: string): string {
  try {
    return realpathSync(target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      const parent = path.dirname(target);
      // Reached the filesystem root without finding an existing ancestor.
      if (parent === target) throw e;
      return path.join(resolveGuardPath(parent), path.basename(target));
    }
    throw e;
  }
}

/**
 * Throws if `target` is not inside one of the configured location roots.
 * Refuses every write when no roots are configured (no "empty means allow"
 * bypass). Symlinks are resolved before the check to prevent escapes.
 */
export function assertWithinAllowedRoot(target: string): void {
  if (allowedRoots.size === 0) {
    throw new Error(`Refused: no configured locations, cannot write ${target}`);
  }
  // foldPath: case-fold on case-insensitive FS (win/mac), exact on Linux —
  // see path-fold.ts. Folding on ext4 would let /photos slip under /Photos.
  const norm = foldPath(resolveGuardPath(target));
  for (const root of allowedRoots) {
    if (norm === root || norm.startsWith(root + path.sep)) return;
  }
  throw new Error(
    `Refused: path is outside any configured location (${target})`
  );
}

/** Replace the configured location roots with a new list. */
export function setAllowedRoots(roots: string[]): void {
  allowedRoots.clear();
  for (const r of roots ?? []) {
    try {
      allowedRoots.add(foldPath(realpathSync(r)));
    } catch {
      // Fall back to resolved path if the location is temporarily unreachable.
      allowedRoots.add(foldPath(path.resolve(r)));
    }
  }
}

/** Returns a snapshot of the currently configured location roots. */
export function getAllowedRoots(): string[] {
  return Array.from(allowedRoots);
}
