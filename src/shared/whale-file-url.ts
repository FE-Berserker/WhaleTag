/**
 * Encoding / decoding for the `whale-file://` custom protocol.
 *
 * Why this lives here: the renderer (sandbox: true, no `require`) encodes the
 * path into a URL that `<video src=...>` can request, and the main process
 * decodes that same URL back into a filesystem path inside its Range handler.
 * Both ends need to agree on the exact byte sequence, so the logic is kept in
 * one shared module and locked down by `whale-file-url.test.ts`.
 *
 * Format (mirrors WHATWG file URL semantics so it round-trips on every
 * platform):
 *
 *   Windows: `C:\Users\foo\bar.mp4`  -> `whale-file:///C:/Users/foo/bar.mp4`
 *   POSIX:   `/home/foo/bar.mp4`     -> `whale-file:///home/foo/bar.mp4`
 *
 * Three things make this trickier than a single `encodeURIComponent`:
 *   1. Drive letters must keep their `:` separator (`C:` not `C%3A`) so the
 *      URL stays human-readable AND so `new URL(...)` parses it correctly
 *      on Windows (Chromium expects `/C:` after the triple slash).
 *   2. We can't pre-convert to `file://` because `protocol.handle` would then
 *      intercept it before our handler runs.
 *   3. Segments may contain spaces, non-ASCII, `%`, `?`, `#` — all must be
 *      percent-encoded and decoded symmetrically.
 */

/**
 * Encode a platform-native absolute path into a `<scheme>://` URL.
 *
 * Scheme-parameterized core: `whale-file` (stream any file to `<video>` /
 * `<img>` / `<audio>`) and `whale-audio` (live Opus transcode of formats
 * Chromium can't decode). Both share the exact same byte format; only the
 * scheme prefix differs, and the main process dispatches to the right
 * handler by scheme.
 *
 * Returns `null` for relative paths or empty input — the caller should
 * surface that as a precondition error rather than producing a malformed
 * URL that silently 404s on the main side.
 */
function encodeForScheme(filePath: string, scheme: string): string | null {
  if (!filePath) return null;
  // Normalize: Windows uses `\`, POSIX uses `/`. The protocol body uses `/`
  // uniformly — splitting later is easier with one separator.
  let normalized = filePath.replace(/\\/g, '/');
  // Strip Windows long-path prefixes that realpathSync may emit
  // (`\\?\C:\foo` or `\\?\UNC\server\share`). Current callers pass raw
  // `\\server\share` paths, but be defensive so a realpath-normalized form
  // still round-trips: `//?/UNC/s/s` → `//s/s`; `//?/C:/f` → `C:/f`.
  normalized = normalized
    .replace(/^\/\/\?\/unc\//i, '//')
    .replace(/^\/\/\?\//i, '');
  // UNC network share: `\\server\share[\...]` → `//server/share[/...]`.
  // Encode the server as the URL authority (host) per WHATWG `file://` UNC
  // semantics, so Chromium's GURL treats it as a host instead of folding it
  // into the path — the old four-slash `whale-file:////server/...` form was
  // mangled by GURL (server → host, lowercased) and the decoder, reading only
  // pathname, lost the server entirely → 403. MUST run before the POSIX
  // branch: `//server/share` also starts with `/`. A bare `\\server` with no
  // share falls through and is rejected as a relative path.
  // Any `//`-prefixed path is server-based (UNC). A bare `\\server` with no
  // share is not a valid streamable target — reject it here so it doesn't
  // fall through to the POSIX branch and emit the broken four-slash URL form.
  if (normalized.startsWith('//')) {
    const unc = /^\/\/([^/]+)\/(.+)$/.exec(normalized);
    if (!unc) return null;
    const server = unc[1];
    // ASCII-only server guard. Chromium normalizes standard-scheme hosts
    // (lowercase + IDNA/Punycode for non-ASCII, rejects spaces/punct), so a
    // CJK or punct-containing server name would be mangled into a host SMB
    // can't reach. Real SMB/NetBIOS names are ASCII (FE-cat / NAS-01); a
    // non-ASCII server returns null so the caller surfaces
    // 'streaming URL unavailable' instead of a silent bad URL.
    if (!/^[A-Za-z0-9._-]+$/.test(server)) return null;
    const encodedRest = unc[2].split('/').map(encodeURIComponent).join('/');
    // Lowercase the server to match what the URL parser does to the host on
    // decode — makes encode→decode byte-exact (Windows SMB names are
    // case-insensitive, so this is safe).
    return `${scheme}://${server.toLowerCase()}/${encodedRest}`;
  }
  // A relative path (no leading slash, no drive letter) can't be encoded
  // into a `<scheme>://` URL because the result would be ambiguous
  // (e.g. `whale-file://foo` means `foo` is the host, not a path).
  const isWindowsAbs = /^[A-Za-z]:(\/|$)/.test(normalized);
  const isPosixAbs = normalized.startsWith('/');
  if (!isWindowsAbs && !isPosixAbs) return null;

  // On Windows the URL form needs a leading slash so the URL parser sees
  // `whale-file:///C:/...` (three slashes total: `://` then `/C:`).
  // Without this `new URL` would interpret `C:` as the host.
  const withLeadingSlash = isWindowsAbs && !normalized.startsWith('/')
    ? `/${normalized}`
    : normalized;

  const segments = withLeadingSlash.split('/');
  // The first segment is always empty (path starts with `/`); the second
  // is the drive letter on Windows (`C:`) — keep `:` literal there.
  const encoded = segments.map((seg, idx) => {
    const escaped = encodeURIComponent(seg);
    // Restore `:` only on the drive-letter segment. Anywhere else, `:` in
    // a filename would be suspicious — keeping it encoded is safer and
    // round-trips correctly through the decoder anyway.
    if (isWindowsAbs && idx === 1) {
      return escaped.replace(/%3A/gi, ':');
    }
    return escaped;
  });
  return `${scheme}://${encoded.join('/')}`;
}

/**
 * Decode a `<scheme>://` URL back into a platform-native path.
 *
 * Symmetric to `encodeForScheme` — used by the main-process protocol
 * handlers. Returns `null` if the input isn't a `<scheme>://` URL for the
 * requested scheme or the path can't be parsed (caller maps to 404).
 *
 * On Windows the returned path uses `/` separators (forward slashes), which
 * `fs.createReadStream` accepts everywhere — Node normalizes internally.
 */
function decodeForScheme(rawUrl: string, scheme: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${scheme}:`) return null;
  // UNC: a non-empty host is the SMB server name (the encoder put it there
  // per `file://` UNC semantics). Rebuild `//host/share/...` — Node's fs
  // treats `//server/path` as UNC `\\server\path` on Windows. `hostname` is
  // already lowercased by the URL parser, matching the encoder's toLowerCase,
  // so the round-trip is byte-exact for ASCII servers.
  if (url.hostname) {
    const segs = url.pathname.split('/').map(decodeURIComponentSafe);
    return `//${url.hostname}${segs.join('/')}`;
  }
  // `url.pathname` already percent-decodes for us, but per-segment is
  // safer for round-trip (a stray `/` in encoded form would otherwise
  // decode wrong). Decode each segment ourselves.
  const segments = url.pathname.split('/').map(decodeURIComponentSafe);
  // Re-join with `/`. First segment is empty (path starts with `/`).
  let decoded = segments.join('/');
  // On Windows, strip the synthetic leading slash we added in the encoder
  // so the path looks native (`C:/...` not `/C:/...`).
  if (/^\/[A-Za-z]:/.test(decoded)) {
    decoded = decoded.slice(1);
  }
  return decoded;
}

/** Encode an absolute path into a `whale-file://` URL (stream any file). */
export function encodeWhaleFileUrl(filePath: string): string | null {
  return encodeForScheme(filePath, 'whale-file');
}

/** Decode a `whale-file://` URL back into a platform-native path. */
export function decodeWhaleFileUrl(rawUrl: string): string | null {
  return decodeForScheme(rawUrl, 'whale-file');
}

/**
 * Encode an absolute path into a `whale-audio://` URL (live Opus transcode
 * of formats Chromium can't decode: APE / WMA / AIFF / …). Same byte format
 * as `whale-file://` — only the scheme prefix differs, and the main process
 * dispatches to the transcode-streaming handler by scheme.
 */
export function encodeWhaleAudioUrl(filePath: string): string | null {
  return encodeForScheme(filePath, 'whale-audio');
}

/** Decode a `whale-audio://` URL back into a platform-native path. */
export function decodeWhaleAudioUrl(rawUrl: string): string | null {
  return decodeForScheme(rawUrl, 'whale-audio');
}

/** `decodeURIComponent` wrapper that returns the raw string on bad escape. */
function decodeURIComponentSafe(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    // Malformed escape (e.g. `%ZZ`) — return as-is rather than throwing,
    // so a corrupted URL becomes a 404 rather than crashing the handler.
    return seg;
  }
}