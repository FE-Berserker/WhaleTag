/**
 * Renderer-side path helpers. The renderer runs in a `web` webpack target with
 * no Node `path` module, so we implement the few operations we need here,
 * tolerant of both separators (Windows `\` and POSIX `/`).
 */

/** Returns the final segment of a path. */
export function basename(p: string): string {
  if (!p) return '';
  const norm = p.replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** Joins `base` and `child`, preserving the separator already used in `base`. */
export function joinPath(base: string, child: string): string {
  if (!base) return child;
  if (!child) return base;

  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  const trimmedBase = base.endsWith(sep) ? base.slice(0, -1) : base;
  // Normalize child separators to match the base — e.g. joining a relative
  // index path (always '/') onto a Windows root (uses '\').
  const normalizedChild = child.replace(/[\\/]/g, sep);
  const trimmedChild = normalizedChild.startsWith(sep)
    ? normalizedChild.slice(1)
    : normalizedChild;

  return `${trimmedBase}${sep}${trimmedChild}`;
}

/** Splits an absolute path into breadcrumb segments (without the OS separator),
 * keeping a leading drive marker (e.g. "C:") or root for Windows/POSIX roots.
 */
export function pathSegments(p: string): string[] {
  if (!p) return [];
  const norm = p.replace(/\\/g, '/');
  return norm.split('/').filter(Boolean);
}

/** Returns the parent directory of `p`, preserving its separator style. */
export function parentDir(p: string): string {
  if (!p) return '';
  const sep = p.includes('\\') && !p.includes('/') ? '\\' : '/';
  const norm = p.replace(/\\/g, '/');
  const trimmed = norm.endsWith('/') ? norm.slice(0, -1) : norm;
  const idx = trimmed.lastIndexOf('/');
  if (idx < 0) return '';
  let parentNorm = trimmed.slice(0, idx);
  if (parentNorm === '') parentNorm = '/';
  else if (parentNorm.length === 2 && parentNorm[1] === ':') parentNorm += '/';
  if (sep === '\\') return parentNorm.replace(/\//g, '\\');
  return parentNorm;
}

/** Returns true if `candidate` is the same as or inside `ancestor`. */
export function isSameOrDescendant(ancestor: string, candidate: string): boolean {
  // Normalise case as well as separators. This is a UI helper (the real
  // security boundary lives in the main process), but on Windows/macOS-style
  // case-insensitive filesystems it prevents false negatives when comparing
  // paths that differ only in casing.
  const normAncestor = ancestor
    .replace(/\\/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();
  const normCandidate = candidate
    .replace(/\\/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();
  return (
    normCandidate === normAncestor ||
    normCandidate.startsWith(normAncestor + '/')
  );
}
