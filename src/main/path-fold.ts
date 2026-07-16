/**
 * Filesystem-aware path case-folding for the security boundary checks
 * (`allowed-roots` write confinement + `extension-protocol` traversal guard).
 *
 * Whether case matters depends on the FILESYSTEM, not the strings:
 *  - **Windows & macOS** (default APFS/HFS+, case-INSENSITIVE): `/Photos` and
 *    `/photos` are the same directory, so folding both sides to lowercase is
 *    the *correct* equality. (Windows `realpath` also rewrites drive-letter
 *    case + the `\\?\` prefix, which folding normalizes — see
 *    `extension-protocol.ts`.)
 *  - **Linux** (ext4/xfs/btrfs, case-SENSITIVE): `/Photos` and `/photos` are
 *    *different* directories. Folding here makes the guard **too permissive** —
 *    a path under a case-colliding sibling (`/photos`) would match a registered
 *    `/Photos` and slip inside the write-confinement boundary.
 *
 * So fold on case-insensitive platforms and compare exactly on case-sensitive
 * ones. This is a platform check (not per-FS runtime probing): it matches the
 * overwhelmingly common filesystem for each OS and preserves the existing
 * Windows/macOS semantics exactly.
 */
export const CASE_INSENSITIVE_FS =
  process.platform === 'win32' || process.platform === 'darwin';

/**
 * Lowercase on Windows/macOS, identity on Linux/other. The `caseInsensitive`
 * param is a test seam so both branches can be exercised off-platform.
 */
export function foldPath(
  p: string,
  caseInsensitive: boolean = CASE_INSENSITIVE_FS
): string {
  return caseInsensitive ? p.toLowerCase() : p;
}
