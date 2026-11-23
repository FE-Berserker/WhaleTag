/**
 * Platform-parameterised path case-folding, shared by the main process
 * (`src/main/path-fold.ts` wraps it with the process platform) and mirrored by
 * the renderer (`src/renderer/services/path-util.ts`, which detects the
 * platform from `process.platform` when present and `navigator.userAgent`
 * otherwise).
 *
 * Whether case matters is a FILESYSTEM property, not a string property:
 *  - **Windows & macOS** (default NTFS/APFS/HFS+, case-INSENSITIVE): `/Photos`
 *    and `/photos` are the same directory, so folding both sides to lowercase
 *    is the *correct* equality.
 *  - **Linux** (ext4/xfs/btrfs, case-SENSITIVE): `/Photos` and `/photos` are
 *    *different* directories. Folding there makes a containment guard **too
 *    permissive** — a path under a case-colliding sibling (`/photos`) would
 *    match a registered `/Photos` and slip inside the write-confinement
 *    boundary.
 *
 * Kept free of `process`/`path` so it is importable from any context: the
 * caller decides the platform policy and passes it in (that parameter is also
 * the test seam that exercises both branches off-platform).
 */

/** True when `platform`'s default filesystem is case-insensitive. */
export function isCaseInsensitivePlatform(
  platform: string | undefined
): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/** Lowercase on case-insensitive filesystems, identity otherwise. */
export function foldPath(p: string, caseInsensitive: boolean): string {
  return caseInsensitive ? p.toLowerCase() : p;
}

/**
 * Normalizes both slash styles to `/` and drops trailing separators. A bare
 * root must stay a root instead of collapsing to `''` (POSIX `/`) or `C:`
 * (Windows `C:/`), so the segment-boundary check below stays meaningful.
 */
function normalizeSeparators(p: string): string {
  const slashed = p.replace(/\\/g, '/');
  const stripped = slashed.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

/**
 * True when `candidate` equals `ancestor` or sits beneath it (either slash
 * style, segment-boundary aware). Case is folded per `caseInsensitive` (see
 * module docs), so a case-colliding sibling is NOT a descendant on a
 * case-sensitive filesystem.
 */
export function isSameOrDescendantPath(
  ancestor: string,
  candidate: string,
  caseInsensitive: boolean
): boolean {
  const fold = (p: string): string => {
    const normalized = normalizeSeparators(p);
    return caseInsensitive ? normalized.toLowerCase() : normalized;
  };
  const a = fold(ancestor);
  const c = fold(candidate);
  // The filesystem root has no trailing separator to append, so match on a
  // leading `/` instead.
  if (a === '/') return c === '/' || c.startsWith('/');
  return c === a || c.startsWith(`${a}/`);
}
