/**
 * Relative-path helpers for extension file links — drawio `<UserObject link>`
 * and excalidraw `element.link`. Diagrams store their file links RELATIVE to
 * the diagram's own directory, so a folder can be moved / copied / sent to
 * someone else without breaking every link. At load time the editor resolves
 * the relative link back to an absolute path (drawio: a `file://` URL;
 * excalidraw: a bare path) so runtime behaviour is byte-for-byte identical to
 * the old absolute-link world — see docs/20.
 *
 * Pure path math — no DOM, no fs, no browser globals — so it is testable under
 * `node:test` in isolation. Each editor owns a thin glue layer:
 *   - drawio converts path <-> `file://` URL in `drop-xml.ts` and rewrites the
 *     `link` attribute via DOMParser.
 *   - excalidraw walks the element JSON in `excalidraw-links.ts`.
 *
 * Conventions:
 *  - Relative output is always forward-slash with a `./` prefix
 *    (`./sub/foo.png`), regardless of host OS, so a diagram authored on
 *    Windows opens correctly on macOS/Linux.
 *  - A link is converted to relative ONLY when its target lives INSIDE the
 *    diagram's directory. Targets that would need `..` stay absolute — a
 *    `../` link breaks the moment the folder is moved, which defeats the whole
 *    point (docs/20 §11).
 *  - Windows drive-letter and UNC paths compare case-INSENSITIVELY for the
 *    "is the target under the base dir" check (Win/macOS default filesystems
 *    are case-insensitive — same lesson as the md-render P0-2 fix). POSIX
 *    paths compare case-sensitively (Linux). On a mismatch `toRelative`
 *    returns null and the link stays absolute, which is safe everywhere.
 */

const DRIVE_RE = /^([a-zA-Z]:)[\\/]/; // C:\  C:/
const UNC_RE = /^[\\/][\\/]/; // \\host\share  //host/share
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i; // any `scheme:` prefix (http:, mailto:, file:, …)

/** Normalize backslashes to forward slashes. Does NOT touch casing. */
function toFwd(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Windows drive-letter or UNC path → lives on a case-insensitive filesystem. */
function isCaseInsensitive(p: string): boolean {
  return DRIVE_RE.test(p) || UNC_RE.test(p);
}

/** The comparable root of an absolute path: drive root (`c:/`), POSIX root
 *  (`/`), or UNC share root (`//host/share`). Used to reject cross-root
 *  relatives (e.g. `D:\…` relative to `C:\…`) up front. Lowercased so drive
 *  letters and UNC hosts compare case-insensitively. */
function rootOf(p: string): string {
  const d = DRIVE_RE.exec(p);
  if (d) return d[1].toLowerCase() + ':/';
  if (UNC_RE.test(p)) {
    const seg = p.replace(/^[\\/][\\/]+/, '').split(/[\\/]/);
    return `//${(seg[0] || '').toLowerCase()}/${(seg[1] || '').toLowerCase()}`;
  }
  return '/';
}

/** Drop the root (drive / POSIX slash / UNC `//host/share`) and split the rest
 *  into segments, filtering empties (from `//`, a trailing `/`, or a root-only
 *  path like `//host/share` whose remainder is empty). */
function splitSegs(p: string): string[] {
  let s = p;
  const d = DRIVE_RE.exec(s);
  if (d) {
    s = s.slice(d[0].length); // drop `C:\` / `C:/`
  } else if (UNC_RE.test(s)) {
    const parts = s.replace(/^[\\/][\\/]+/, '').split(/[\\/]/);
    s = parts.slice(2).join('/'); // drop `host/share`
  } else if (s.startsWith('/')) {
    s = s.slice(1);
  }
  return s.split('/').filter((seg) => seg.length > 0);
}

/** Looks like an absolute filesystem path (drive letter / POSIX root / UNC).
 *  A bare relative segment like `sub/foo.png` or `./x` returns false. */
export function isAbsoluteishPath(p: string): boolean {
  const s = p.trim();
  if (!s) return false;
  return DRIVE_RE.test(s) || s.startsWith('/') || UNC_RE.test(s);
}

/** Has a `scheme:` prefix that is NOT `file:` (http, https, ftp, mailto, tel…).
 *  Such links are external and must never be rewritten — only our own `file:`
 *  URLs and bare paths are candidates for relativization.
 *
 *  A Windows drive letter (`C:`) is NOT a scheme — guard against it first or
 *  `C:\abs` would be misread as scheme `c`. */
export function isExternalUrl(p: string): boolean {
  const s = p.trim();
  if (DRIVE_RE.test(s)) return false;
  const m = SCHEME_RE.exec(s);
  if (!m) return false;
  const scheme = m[0].slice(0, -1).toLowerCase(); // drop trailing ':'
  return scheme !== 'file';
}

/** Absolute → relative (forward-slash, `./` prefix). Returns `null` when
 *  `target` is not inside `baseDir` (different root, or would require `..`),
 *  in which case the caller leaves the link absolute. */
export function toRelative(target: string, baseDir: string): string | null {
  const t = toFwd(target).replace(/\/+$/, '');
  const b = toFwd(baseDir).replace(/\/+$/, '');
  if (!t || !b) return null;
  if (rootOf(t) !== rootOf(b)) return null;

  const ci = isCaseInsensitive(t);
  const eq = (x: string, y: string): boolean =>
    ci ? x.toLowerCase() === y.toLowerCase() : x === y;

  const tSeg = splitSegs(t);
  const bSeg = splitSegs(b);

  // Every base segment must match a target segment (case-aware). If a base
  // segment diverges, the target is a sibling / cousin, not a descendant →
  // would need `..` → keep absolute.
  let i = 0;
  for (; i < Math.min(tSeg.length, bSeg.length); i += 1) {
    if (!eq(tSeg[i], bSeg[i])) return null;
  }
  if (i < bSeg.length) return null;

  const rest = tSeg.slice(i).filter((s) => s.length > 0);
  return './' + rest.join('/');
}

/** Relative → absolute. `./` / bare relative links are resolved against
 *  `baseDir` (forward-slash). An already-absolute path is returned normalized.
 *  An external URL (http/…) is returned unchanged. `..` segments are left
 *  literal — concatenated onto the base, the OS resolves them at open time
 *  (we never emit `..`, and an authored `../x` still opens correctly). */
export function resolveRelative(relOrAbs: string, baseDir: string): string {
  const v = relOrAbs.trim();
  if (isExternalUrl(v)) return relOrAbs;
  if (isAbsoluteishPath(v)) return toFwd(v);
  const b = toFwd(baseDir).replace(/\/+$/, '');
  // Strip any number of leading `./` (a single `./` is what toRelative emits,
  // but be lenient with hand-authored links).
  let rel = v;
  while (rel.startsWith('./')) rel = rel.slice(2);
  if (!rel) return b;
  return b + '/' + rel;
}

/** Directory of `p` (forward-slash, no trailing slash except for a bare root).
 *  Cross-platform: `C:/a/b.drawio` → `C:/a`, `C:/x.drawio` → `C:/`,
 *  `/a/b` → `/a`, `/x` → `/`, bare `x` → `.`. */
export function dirname(p: string): string {
  const f = toFwd(p).replace(/\/+$/, '');
  if (!f) return '.';
  const idx = f.lastIndexOf('/');
  if (idx < 0) return '.';
  const head = f.slice(0, idx);
  if (head === '') return f.startsWith('/') ? '/' : '.';
  // `C:/x.drawio` → head is `C:` (drive letter, no slash) → normalize to `C:/`.
  if (DRIVE_RE.test(f) && !head.includes('/')) return head + '/';
  return head;
}

/** Inverse of `toFileUrl` (drop-xml.ts): `file:///C:/foo%20bar/baz.pdf` →
 *  `C:/foo bar/baz.pdf`, `file:///Users/me/x` → `/Users/me/x`. Forward-slash.
 *  Only the 3-slash form our own `toFileUrl` produces is supported; an
 *  authority form (`file://host/…`) is not produced by Whale. Returns the
 *  input unchanged if it isn't a `file:` URL. */
export function fileUrlToPath(url: string): string {
  const trimmed = url.trim();
  const lower = trimmed.toLowerCase();
  let s: string;
  if (lower.startsWith('file://')) s = trimmed.slice(7);
  else if (lower.startsWith('file:')) s = trimmed.slice(5);
  else return url;
  s = s.replace(/^\/+/, '');
  const segments = s.split('/').map((seg) => {
    try {
      return decodeURIComponent(seg);
    } catch {
      return seg;
    }
  });
  const path = segments.join('/');
  // toFileUrl folds POSIX's leading slash into the URL's third slash and keeps
  // the Windows drive letter. Reverse that so the result is absolute again.
  if (DRIVE_RE.test(path)) return path;
  return '/' + path;
}
