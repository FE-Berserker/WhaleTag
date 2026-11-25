import path from 'path';
import { realpathSync } from 'fs';
import { foldPath, isSameOrDescendantPath } from './path-fold';

/**
 * Roots the renderer has registered as configured locations. Destructive /
 * in-place writes (delete, create, mkdir, rename) are confined to these —
 * defense-in-depth so a compromised renderer can't touch files outside any
 * location. Move/copy DESTINATIONS are exempt (a user may move files into a
 * folder that isn't a location), but their sources are still checked.
 *
 * Since 2026-07-18 the same assert also gates the sensitive read/exec
 * channels (`fs:readFile`, `fs:readTextFile`, `fs:openNative`) — reading or
 * OS-launching a path outside every configured location is refused as well
 * (docs/13 §13).
 *
 * Security default: when no roots are registered, all destructive writes are
 * refused. The previous "first run allows everything" behavior made it possible
 * for a compromised renderer to call `fs:setAllowedRoots([])` and disable the
 * guard entirely.
 */
const allowedRoots = new Set<string>();
let rawAllowedRoots: string[] = [];

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
 * Pure string check: is `target` lexically under (or equal to) one of the
 * configured roots — in the raw renderer-pushed form OR in the symlink-resolved
 * form (`allowedRoots`)? Never touches the filesystem.
 *
 * SECURITY: `resolveGuardPath` runs `realpathSync` on whatever path it is
 * handed, i.e. the main process TOUCHED the target before anything was
 * compared against the roots. A compromised renderer — or any MCP client, in
 * read-only mode, without a single approval — could hand it
 * `\\attacker.example\s\x`: on Windows the SMB session is opened and
 * authenticated with the logged-on user's credentials (NetNTLMv2 hash
 * disclosure), the `\\host@port\s\` form can route through the WebDAV
 * redirector (when that service runs) to an arbitrary host:port, and the
 * distinct error text / latency is an intranet oracle. This gate refuses such
 * a path before any syscall; for paths that ARE under a root the realpath
 * comparison afterwards still catches symlink escapes.
 *
 * `path.resolve` only normalises the string (absolute, `..` collapsed,
 * separators unified) — no filesystem access. Case follows the platform policy
 * (`isSameOrDescendantPath`), so `c:\data\x` under root `C:\Data` passes on
 * Windows/macOS and is refused on Linux exactly like the realpath stage.
 */
function isLexicallyInsideRoots(
  target: string,
  extraRoots?: ReadonlySet<string>
): boolean {
  let resolved: string;
  try {
    resolved = path.resolve(target);
  } catch {
    // Non-string / malformed payload: nothing may be touched for it.
    return false;
  }
  for (const root of rawAllowedRoots) {
    if (isSameOrDescendantPath(root, resolved)) return true;
  }
  for (const root of allowedRoots) {
    if (isSameOrDescendantPath(root, resolved)) return true;
  }
  for (const root of extraRoots ?? []) {
    if (isSameOrDescendantPath(root, resolved)) return true;
  }
  return false;
}

/**
 * Filesystem-free half of {@link assertWithinAllowedRoot}: throws the same
 * "Refused" errors when `target` is not even lexically under a configured
 * root, WITHOUT resolving symlinks. Call it first on paths that would
 * otherwise be stat'ed / opened before the full guard runs (the
 * `whale-file://` protocol handler, shell reveal) so an attacker-chosen path
 * is rejected before anything on disk — or on the network — is touched.
 */
export function assertLexicallyWithinAllowedRoot(target: string): void {
  if (allowedRoots.size === 0) {
    throw new Error(`Refused: no configured locations, cannot write ${target}`);
  }
  if (!isLexicallyInsideRoots(target)) {
    throw new Error(
      `Refused: path is outside any configured location (${target})`
    );
  }
}

/**
 * Throws if `target` is not inside one of the configured location roots.
 * Refuses every write when no roots are configured (no "empty means allow"
 * bypass). Symlinks are resolved before the check to prevent escapes.
 *
 * Two stages: a lexical gate that never touches the filesystem (see
 * `isLexicallyInsideRoots` — keeps attacker-supplied UNC paths from ever
 * reaching `realpathSync`), then the realpath comparison for symlink escapes.
 */
export function assertWithinAllowedRoot(target: string): void {
  assertLexicallyWithinAllowedRoot(target);
  // foldPath: case-fold on case-insensitive FS (win/mac), exact on Linux —
  // see path-fold.ts. Folding on ext4 would let /photos slip under /Photos.
  const norm = foldPath(resolveGuardPath(target));
  for (const root of allowedRoots) {
    const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (norm === root || norm.startsWith(rootPrefix)) return;
  }
  throw new Error(
    `Refused: path is outside any configured location (${target})`
  );
}

/**
 * True when `target` resolves to one of the configured location roots itself
 * (not merely inside one). Callers use it to refuse whole-workspace actions —
 * a root is a container the user opened, not an entry to delete/move/tag.
 */
export function isConfiguredRoot(target: string): boolean {
  if (allowedRoots.size === 0) return false;
  if (!isLexicallyInsideRoots(target)) return false;
  let norm: string;
  try {
    norm = foldPath(resolveGuardPath(target));
  } catch {
    norm = foldPath(path.resolve(target));
  }
  return allowedRoots.has(norm);
}

/**
 * Throws when `target` is one of the configured location roots itself.
 *
 * A root is a container the user opened, not an entry inside it: deleting,
 * moving or renaming it is a whole-workspace action the renderer never offers,
 * and some writes aimed at it land OUTSIDE the boundary (a file sidecar lives
 * in `dirname(target)/.whale/`). The MCP tools already refused roots; the IPC
 * entry points did not, so a compromised renderer could reach the same
 * operations. Hoisted here so both surfaces share one check.
 */
export function assertNotLocationRoot(target: string): void {
  if (isConfiguredRoot(target)) {
    throw new Error(
      'Refused: target is a configured location root, not an entry inside one'
    );
  }
}

/**
 * Read-only subset of the configured locations.
 *
 * "Read only" used to be a renderer-only convention: every write path
 * (delete/move/tag/revision/sidecar) still accepted a path inside such a
 * location, so a compromised or buggy renderer — or an external MCP client —
 * could modify a location the user explicitly marked as protected. The
 * renderer now pushes the read-only subset alongside the roots, and every
 * write entry point refuses paths inside it. Kept folded like allowedRoots so
 * `C:\Foo` / `c:\foo` cannot slip through.
 */
const readOnlyRoots = new Set<string>();

/**
 * Replace the read-only subset. Roots are folded the same way as
 * `setAllowedRoots`; callers pass only locations that are ALSO configured
 * roots (the IPC handler filters against the accepted set).
 */
export function setReadOnlyRoots(roots: string[]): void {
  readOnlyRoots.clear();
  for (const r of roots ?? []) {
    try {
      readOnlyRoots.add(foldPath(realpathSync(r)));
    } catch {
      readOnlyRoots.add(foldPath(path.resolve(r)));
    }
  }
}

/**
 * True when `target` sits inside (or is) a read-only location. A path that
 * cannot be resolved still folds by `path.resolve`, mirroring the guard above.
 */
export function isReadOnlyPath(target: string): boolean {
  if (readOnlyRoots.size === 0) return false;
  // Outside every root lexically → cannot be inside a read-only one either;
  // refuse without touching the filesystem (see isLexicallyInsideRoots).
  if (!isLexicallyInsideRoots(target, readOnlyRoots)) return false;
  let norm: string;
  try {
    norm = foldPath(resolveGuardPath(target));
  } catch {
    norm = foldPath(path.resolve(target));
  }
  for (const root of readOnlyRoots) {
    const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (norm === root || norm.startsWith(rootPrefix)) return true;
  }
  return false;
}

/**
 * Throws when the location containing `target` is read-only.
 *
 * Written as a separate assert (not folded into `assertWithinAllowedRoot`) so
 * the message tells the user which rule they hit — the renderer surfaces the
 * IPC error text verbatim for MCP/e.g. extension saves.
 */
export function assertWritable(target: string): void {
  if (isReadOnlyPath(target)) {
    throw new Error(
      `Refused: the location containing this path is read-only (${target})`
    );
  }
}

/** Replace the configured location roots with a new list. */
export function setAllowedRoots(roots: string[]): void {
  rawAllowedRoots = [...(roots ?? [])];
  allowedRoots.clear();
  for (const r of roots ?? []) {
    try {
      allowedRoots.add(foldPath(realpathSync(r)));
    } catch {
      // Fall back to resolved path if the location is temporarily unreachable.
      allowedRoots.add(foldPath(path.resolve(r)));
    }
  }
  for (const l of rootsListeners) {
    try {
      l(roots ?? []);
    } catch {
      // A broken listener must never break the root sync.
    }
  }
}

/** Returns a snapshot of the currently configured location roots. */
export function getAllowedRoots(): string[] {
  return Array.from(allowedRoots);
}

/** Display-correct paths from the latest renderer push, including for late subscribers. */
export function getRawAllowedRoots(): string[] {
  return [...rawAllowedRoots];
}

type RootsListener = (rawRoots: string[]) => void;
const rootsListeners = new Set<RootsListener>();

/**
 * Subscribe to raw (un-folded) root pushes — e.g. the MCP server surfaces the
 * configured locations to external AI clients and needs display-correct
 * paths, not the case-folded guard strings. Returns an unsubscribe.
 */
export function onAllowedRootsChanged(listener: RootsListener): () => void {
  rootsListeners.add(listener);
  return () => {
    rootsListeners.delete(listener);
  };
}
