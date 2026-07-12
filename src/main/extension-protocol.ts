/**
 * Pure resolver for the `whale-extension://` custom protocol.
 *
 * Lives in its own file (no Electron side effects on import) so it can
 * be unit-tested under `node:test` without spinning up an Electron
 * runtime — see `extension-protocol.test.ts`.
 *
 * Why this exists:
 * The `whale-extension://<extId>/<relPath>` URL is what the renderer
 * uses to load extension iframes (md-editor, text-editor, drawio, …)
 * and their sub-resources. The previous implementation used the
 * deprecated `protocol.registerFileProtocol` callback API. That API
 * silently fails in Electron 32+ when the scheme is registered as a
 * privileged custom scheme (`standard: true, secure: true` — see
 * `registerSchemesAsPrivileged` in `main.ts`), so the iframe body
 * never executes, the host's `ready` handshake never fires, and both
 * panes stay blank. The migrated `protocol.handle` flow (in
 * `main.ts > registerExtensionProtocol`) uses this resolver.
 */
import path from 'path';
import * as fsp from 'fs/promises';

/**
 * Case-insensitive, separator-aware "is `child` inside `root`?" used by both
 * traversal guards. Exported for unit tests.
 *
 * On Windows, `realpath` (GetFinalPathNameByHandle) canonicalizes the prefix
 * of an asar path — prepending `\\?\` and possibly changing drive-letter case
 * — so a plain case-sensitive `startsWith` on mixed forms false-rejects every
 * packaged asset. Lowercasing both sides and matching on `root + path.sep`
 * (mirrors `assertWithinAllowedRoot` in allowed-roots.ts) is the robust check.
 */
export function isWithinRoot(child: string, root: string): boolean {
  const c = child.toLowerCase();
  const r = root.toLowerCase();
  return c === r || c.startsWith(r + path.sep);
}

/**
 * Resolve a `whale-extension://<extId>/<relPath>` URL to either the
 * file bytes + MIME type, or a structured error with the right HTTP
 * status.
 *
 * `extensionsRoot` is the absolute path to the `extensions/` directory
 * the URLs are resolved against. Production passes
 * `<__dirname>/../extensions` (the packaged dist tree); tests pass an
 * `os.tmpdir()`-based isolated fixture so the suite never touches the
 * real source tree.
 *
 * Security: `extId` and `relPath` are both resolved against
 * `extensionsRoot/<extId>/` and the final absolute path is verified to
 * sit inside that root before reading. This blocks `..` traversal,
 * absolute-path injection, and URL-encoded `..` variants.
 */
export async function resolveExtensionRequest(
  requestUrl: string,
  extensionsRoot: string
): Promise<
  | { ok: true; buf: Buffer; mime: string }
  | { ok: false; status: number; msg: string }
> {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { ok: false, status: 400, msg: 'Malformed whale-extension URL' };
  }
  const extId = url.hostname;
  if (!extId || extId === '..' || extId.includes('/') || extId.includes('\\')) {
    return { ok: false, status: 400, msg: 'Invalid extension id' };
  }
  const relPath = url.pathname.replace(/^\//, '');
  const extRoot = path.resolve(extensionsRoot, extId);
  const fullPath = path.resolve(extRoot, relPath);
  // First-line guard: after URL-parser `..` normalization, the
  // string-level resolved path MUST stay inside extRoot. (URL
  // normalization already collapses `..`, so this catches the rare
  // hand-crafted URL or symlink-path that bypasses the parser.) Case-
  // insensitive via `isWithinRoot`; the realpath guard below is the
  // authority on canonical form.
  if (!isWithinRoot(fullPath, extRoot)) {
    return { ok: false, status: 403, msg: 'Path traversal blocked' };
  }
  // Second-line guard: also check the *real* path (after resolving
  // symlinks). A symlink living inside extRoot that points outside would
  // pass the string-level check above. Mirrors `assertWithinAllowedRoot`
  // (allowed-roots.ts), which realpaths + lowercases BOTH sides.
  //
  // Realpath-ing `extRoot` too is the load-bearing fix on Windows packaged
  // builds: Node's realpath (GetFinalPathNameByHandle) canonicalizes the
  // real-FS prefix of an asar path — prepending `\\?\` and possibly changing
  // drive-letter case — so a realpath'd file path never string-matches the
  // plain `extRoot`. Without realpath-ing + lowercasing `extRoot` as well,
  // EVERY packaged (asar) asset request false-fires this 403 (dev passes
  // because its real-FS paths realpath to the same string they started as).
  let realFullPath: string;
  try {
    realFullPath = await fsp.realpath(fullPath);
  } catch (err) {
    // If realpath fails (e.g. file doesn't exist), fall through to
    // readFile, which will surface the real ENOENT.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return { ok: false, status: 404, msg: 'Not found' };
    }
    if (code === 'EISDIR') {
      return { ok: false, status: 404, msg: 'Not a file' };
    }
    return {
      ok: false,
      status: 500,
      msg: `whale-extension realpath failed: ${(err as Error).message}`,
    };
  }
  let realExtRoot = extRoot;
  try {
    realExtRoot = await fsp.realpath(extRoot);
  } catch {
    // extRoot not real-pathable (shouldn't happen — it's the ext dir);
    // fall back to the string form. The first-line guard still governs.
  }
  if (!isWithinRoot(realFullPath, realExtRoot)) {
    return { ok: false, status: 403, msg: 'Path traversal blocked' };
  }
  let buf: Buffer;
  try {
    buf = await fsp.readFile(realFullPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return { ok: false, status: 404, msg: 'Not found' };
    }
    if (code === 'EISDIR') {
      return { ok: false, status: 404, msg: 'Not a file' };
    }
    return {
      ok: false,
      status: 500,
      msg: `whale-extension read failed: ${(err as Error).message}`,
    };
  }
  return { ok: true, buf, mime: mimeForPath(fullPath) };
}

/**
 * MIME type lookup for the `whale-extension://` protocol. The map
 * covers web text types (HTML / CSS / JS / JSON / source maps / plain
 * text) and the media types that the sibling `whale-file://` protocol
 * also handles (images, videos). Default fallback is
 * `application/octet-stream` (kept safe for binary streams).
 *
 * The web text types are essential for the extension protocol:
 * without the right Content-Type, Chromium refuses to execute
 * `bundle.js` or render `index.html` in the iframe, and the whole
 * extension load chain falls over silently.
 */
export function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const map: Record<string, string> = {
    // Web text types — added when the `whale-extension://` protocol
    // migrated to `protocol.handle`. Extensions ship their own
    // index.html, CSS, JS, JSON registry, etc. through this protocol,
    // so a wrong Content-Type (e.g. `application/octet-stream` for
    // HTML) makes Chromium refuse to execute the script or render the
    // document. Safe for `whale-file://` too — `<video>` / `<img>`
    // never request `.html` / `.js` / `.css`.
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    map: 'application/json; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
    wasm: 'application/wasm',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    avif: 'image/avif',
    tiff: 'image/tiff',
    tif: 'image/tiff',
    ico: 'image/x-icon',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    webm: 'video/webm',
    ogv: 'video/ogg',
    m4v: 'video/mp4',
    mkv: 'video/x-matroska',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    '3gp': 'video/3gpp',
    wmv: 'video/x-ms-wmv',
    flv: 'video/x-flv',
  };
  return map[ext] ?? 'application/octet-stream';
}
