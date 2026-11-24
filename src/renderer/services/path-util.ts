/**
 * Renderer-side path helpers. The renderer runs in a `web` webpack target with
 * no Node `path` module, so we implement the few operations we need here,
 * tolerant of both separators (Windows `\` and POSIX `/`).
 *
 * Case policy and the containment check come from `src/shared/path-fold.ts`
 * — the same module the main process wraps — so both sides cannot drift.
 */
import {
  isCaseInsensitivePlatform,
  isSameOrDescendantPath,
} from '../../shared/path-fold';

export { isCaseInsensitivePlatform };

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

/**
 * Best-effort platform of the renderer, for filesystem-case policy only.
 *
 * The renderer bundle targets `web` (no Node `process`), so we cannot rely on
 * `process.platform` being present. Two sources, in order:
 *  1. `globalThis.process.platform` — present under Electron's renderer via
 *     preload/node integration in dev, and under `node:test` (the whole test
 *     suite runs inside Electron `--test`, where it is a real Node process).
 *  2. `navigator.userAgent` — same sniffing approach as MenuNoTransition.tsx.
 *
 * Returns `undefined` when neither source is usable; callers then assume a
 * case-sensitive filesystem (the conservative choice: it only risks a false
 * negative on a case-insensitive disk, never a false positive).
 */
function resolveRendererPlatform(): string | undefined {
  const nodeProcess = (
    globalThis as { process?: { platform?: unknown } }
  ).process;
  if (nodeProcess && typeof nodeProcess.platform === 'string') {
    return nodeProcess.platform;
  }
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent ?? '';
    if (/Windows NT/i.test(ua)) return 'win32';
    if (/Macintosh|Mac OS X/i.test(ua)) return 'darwin';
    if (/Linux|X11/i.test(ua)) return 'linux';
  }
  return undefined;
}

/**
 * Renderer mirror of the main process `CASE_INSENSITIVE_FS` (src/main/path-fold.ts):
 * Windows/macOS fold case, Linux does not. Keeping the two in sync matters —
 * an always-lowercase comparison here would accept `/home/u/Photos` for a root
 * of `/home/u/photos` on Linux, disagreeing with the main process guard.
 */
export const CASE_INSENSITIVE_FS = isCaseInsensitivePlatform(
  resolveRendererPlatform()
);

/**
 * Returns true if `candidate` is the same as or inside `ancestor`.
 *
 * This is a UI helper (the real security boundary lives in the main
 * process). It delegates to the shared implementation, so the renderer and
 * the main process agree on every edge — separator styles, repeated trailing
 * separators, a bare root — and not only on the common case. Case is folded
 * only on case-insensitive filesystems so the verdict matches the main
 * process; `caseInsensitive` is an explicit seam for tests.
 */
export function isSameOrDescendant(
  ancestor: string,
  candidate: string,
  caseInsensitive: boolean = CASE_INSENSITIVE_FS
): boolean {
  return isSameOrDescendantPath(ancestor, candidate, caseInsensitive);
}
