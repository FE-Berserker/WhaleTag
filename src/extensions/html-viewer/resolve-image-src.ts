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
  if (!dirPath) return null;
  const raw = (src ?? '').trim();
  if (!raw) return null;
  // Drop query / fragment: they belong to the URL, not the file path.
  const pathPart = raw.split(/[?#]/, 1)[0];
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
  return encodeWhaleFileUrl(`${base}/${segments.join('/')}`);
}
