/**
 * html-viewer — document-relative image resolution
 *
 * The host localizes the preview document: it inlines the file's text into the
 * extension's own document and supplies `dirPath` (the HTML file's directory)
 * with `fileContent`. A relative `<img src="./pic.png">` would otherwise be
 * resolved against the extension origin (`whale-extension://html-viewer/`) and
 * 404 — the host streams the real file via `whale-file://` instead.
 *
 * Safety contract: only paths that stay inside `dirPath` are rewritten.
 * Absolute paths, URLs (`http:`, `data:`, `file:`, …), drive letters, UNC paths
 * and any `..` segment that would climb above `dirPath` are left untouched — the
 * preview must not become a way to stream arbitrary local files.
 *
 * Pure helper (no DOM) so it can be tested without an iframe.
 */

import { encodeWhaleFileUrl } from '../../shared/whale-file-url';

/** `scheme:` prefix — caught before the relative-path branch so remote / data
 *  images and `file:` URLs are never converted into `whale-file://`. Note this
 *  also rejects a first segment that merely looks like a scheme. */
const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
/** Windows drive path (`C:\` or `C:/`) — absolute, not document-relative. */
const DRIVE_LETTER_RE = /^[a-zA-Z]:[\\/]/;
/** UNC path (`\\server\share` or `//server/share`) — absolute, not relative. */
const UNC_RE = /^[\\/]{2}/;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // Malformed percent escapes: keep the raw text so the traversal check still
    // sees what the browser would request.
    return value;
  }
}

/**
 * Resolve a document-relative `<img src>` to a `whale-file://` URL under
 * `dirPath`.
 *
 * @returns the encoded URL, or `null` when the reference is absolute, remote,
 *          escapes `dirPath`, has no path component, or `dirPath` is missing.
 */
export function resolveRelativeImageSrc(
  src: string | null | undefined,
  dirPath: string | null | undefined
): string | null {
  const resolved = resolveRelativeRefPath(src, dirPath);
  return resolved === null ? null : encodeWhaleFileUrl(resolved);
}

/**
 * The absolute path behind a document-relative reference (same input rules
 * and traversal rejection as `resolveRelativeImageSrc`), or `null`. Shared by
 * the image rewrite (→ `whale-file://`) and the link rewrite (→ `file://`).
 */
export function resolveRelativeRefPath(
  ref: string | null | undefined,
  dirPath: string | null | undefined
): string | null {
  if (!dirPath) return null;
  const src = (ref ?? '').trim();
  if (!src) return null;
  // Drop query / fragment: they belong to the URL, not the file path.
  const pathPart = src.split(/[?#]/, 1)[0];
  if (!pathPart) return null;
  if (
    HAS_SCHEME_RE.test(pathPart) ||
    DRIVE_LETTER_RE.test(pathPart) ||
    UNC_RE.test(pathPart) ||
    pathPart.startsWith('/') ||
    pathPart.startsWith('\\')
  ) {
    return null;
  }

  // Decode BEFORE normalizing so `%2e%2e/` and `%2f` cannot smuggle a
  // traversal past the segment check below.
  const decoded = safeDecode(pathPart).replace(/\\/g, '/');
  const segments: string[] = [];
  for (const segment of decoded.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) return null;

  const base = dirPath.replace(/[\\/]+$/, '');
  if (!base) return null;
  return `${base}/${segments.join('/')}`;
}

/**
 * Resolve a document-relative `<a href>` to a `file://` URL under `dirPath`, so
 * a link such as `./notes.pdf` reaches the host as a real file reference.
 * Without this the host received the bare relative text, could not turn it
 * into a path, and refused it — the click did nothing. Main converts the URL
 * back to a path and applies the configured-location check before opening.
 *
 * Absolute paths, URLs (`http:`, `mailto:`, …), drive letters, UNC paths and
 * `..` traversal above `dirPath` are returned as `null`: the caller forwards
 * those unchanged (the host opens `http(s)` itself, everything else is
 * checked by main).
 */
export function resolveRelativeHref(
  href: string | null | undefined,
  dirPath: string | null | undefined
): string | null {
  const resolved = resolveRelativeRefPath(href, dirPath);
  if (resolved === null) return null;
  const encodeRest = (rest: string) =>
    rest
      .split('/')
      .map(encodeURIComponent)
      .join('/');
  if (/^[\\/]{2}/.test(resolved)) {
    // UNC location: `\\server\share\doc.pdf` → `file://server/share/doc.pdf`.
    return `file://${encodeRest(resolved.replace(/\\/g, '/').slice(2))}`;
  }
  const forward = resolved.replace(/\\/g, '/');
  const drive = /^[a-zA-Z]:/.exec(forward)?.[0] ?? '';
  // `file:///C:/…` (drive colon stays a colon: it is structural) or
  // `file:///home/…` on POSIX.
  const rest = forward.slice(drive.length).replace(/^\//, '');
  return `file:///${drive}${drive ? '/' : ''}${encodeRest(rest)}`;
}
