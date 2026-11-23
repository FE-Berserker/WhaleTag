/**
 * Per-extension Content-Security-Policy **response headers** for the
 * `whale-extension://` protocol.
 *
 * Why this exists:
 * A `<meta http-equiv="Content-Security-Policy">` cannot deliver every
 * directive — the HTML spec requires `frame-ancestors` (and `sandbox`) to be
 * discarded from meta-delivered policies. The eight extension documents ship a
 * meta CSP for the directives that do work there, but the framing restriction
 * only becomes real when it arrives as a response header.
 *
 * `scripts/build-extensions.js` writes
 * `dist/extensions/csp-policy.generated.json` from the single source of truth
 * `src/extensions/shared/csp-policy.json` (already merged per extension, with
 * `__APP_ORIGIN__` left for runtime substitution), so the meta policy and the
 * header policy cannot drift apart. `registerExtensionProtocol` in `main.ts`
 * loads it once and adds the result to every HTML response from the protocol.
 *
 * Fail closed: a missing/corrupt manifest, or an extension folder that the
 * manifest does not know, still gets the baseline policy (never "no CSP"); the
 * caller logs a warning instead of silently serving an unprotected document.
 *
 * Empirically verified against a `file://` parent (Electron 42 / Chromium):
 * the production app shell is a `file:` document, which only matches the
 * scheme source `file:`; `file://` is not a valid host-source (ignored) and
 * `*` never matches non-network schemes. In development the ancestor is the
 * webpack dev-server origin.
 */
import * as fs from 'fs';

/** Name of the build artifact next to the built extension folders. Kept in
 *  sync with `CSP_MANIFEST_FILENAME` in scripts/build-extensions.js (asserted by
 *  the CSP policy test so the two cannot silently diverge). */
export const CSP_MANIFEST_FILENAME = 'csp-policy.generated.json';

/** Token replaced with the app-shell ancestor source at runtime. */
export const APP_ORIGIN_PLACEHOLDER = '__APP_ORIGIN__';

/** Directives that must exist in every header policy. Losing one would be a
 *  security regression, so an incomplete manifest is rejected (fail closed). */
const REQUIRED_HEADER_DIRECTIVES = [
  'default-src',
  'object-src',
  'base-uri',
  'frame-ancestors',
] as const;

export type CspDirectiveMap = Readonly<Record<string, readonly string[]>>;

export interface ExtensionCspManifest {
  version: 1;
  appOriginPlaceholder: string;
  /** Policy for extensions the manifest has no entry for. */
  baseline: CspDirectiveMap;
  /** Pre-merged policy per extension id. */
  extensions: Readonly<Record<string, CspDirectiveMap>>;
}

export interface ExtensionCspHeader {
  /** Serialized `Content-Security-Policy` header value. */
  csp: string;
  /** `false` when `extensionId` was unknown and the baseline was used. */
  known: boolean;
}

function isTokenList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((token) => typeof token === 'string' && token.trim() !== '')
  );
}

function isDirectiveMap(value: unknown): value is Record<string, readonly string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(isTokenList);
}

/**
 * Validate the generated manifest. Returns `null` (rather than throwing) so the
 * protocol handler can fall back to the baseline; malformed policy data must
 * never escape as an unprotected document.
 */
export function parseCspManifest(raw: unknown): ExtensionCspManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  if (candidate.version !== 1) return null;
  if (
    typeof candidate.appOriginPlaceholder !== 'string' ||
    candidate.appOriginPlaceholder.trim() === ''
  ) {
    return null;
  }
  if (!isDirectiveMap(candidate.baseline)) return null;
  const baseline = candidate.baseline as Record<string, readonly string[]>;
  for (const directive of REQUIRED_HEADER_DIRECTIVES) {
    if (!isTokenList(baseline[directive])) return null;
  }
  if (!baseline['frame-ancestors'].includes(candidate.appOriginPlaceholder)) {
    return null;
  }
  if (!candidate.extensions || typeof candidate.extensions !== 'object') {
    return null;
  }
  const extensions = candidate.extensions as Record<string, unknown>;
  for (const [extensionId, policy] of Object.entries(extensions)) {
    if (!isDirectiveMap(policy)) return null;
    // Every extension policy must keep the baseline protections as well; a
    // build that drops one is a regression we refuse to serve.
    for (const directive of REQUIRED_HEADER_DIRECTIVES) {
      if (!isTokenList((policy as Record<string, readonly string[]>)[directive])) {
        return null;
      }
    }
    if (extensionId.trim() === '') return null;
  }
  return {
    version: 1,
    appOriginPlaceholder: candidate.appOriginPlaceholder,
    baseline,
    extensions: extensions as Readonly<Record<string, CspDirectiveMap>>,
  };
}

/** Read + validate the manifest. Any I/O or parse failure yields `null`. */
export function loadCspManifest(manifestPath: string): ExtensionCspManifest | null {
  try {
    return parseCspManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * The app shell's origin as a `frame-ancestors` source expression.
 *
 * Production loads the renderer from `file:` (a scheme source matches the file
 * ancestor; `file://` would be an invalid host-source and ignored). Development
 * matches the webpack dev-server origin, mirroring `isApplicationOrigin`.
 */
export function appFrameAncestorSource(
  development: boolean,
  devServerUrl: string
): string {
  return development ? devServerUrl : 'file:';
}

/** Baseline used when the generated manifest is missing or corrupt. Mirrors
 *  `src/extensions/shared/csp-policy.json` so a broken build still serves a
 *  locked-down policy. */
const FALLBACK_BASELINE: Record<string, readonly string[]> = {
  'default-src': ["'self'"],
  'script-src': ["'self'", 'whale-extension://*'],
  'style-src': ["'self'", "'unsafe-inline'", 'whale-extension://*'],
  'img-src': ["'self'", 'data:', 'blob:', 'whale-extension://*', 'whale-file:'],
  'font-src': ["'self'", 'blob:'],
  'connect-src': ["'self'", 'whale-extension:'],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'frame-ancestors': ["'self'", APP_ORIGIN_PLACEHOLDER],
};

function serializeDirectives(map: CspDirectiveMap, appOrigin: string): string {
  const parts: string[] = [];
  for (const [directive, tokens] of Object.entries(map)) {
    const seen = new Set<string>();
    const resolved: string[] = [];
    for (const token of tokens) {
      const value = token === APP_ORIGIN_PLACEHOLDER ? appOrigin : token;
      if (seen.has(value)) continue;
      seen.add(value);
      resolved.push(value);
    }
    if (resolved.length === 0) continue;
    parts.push(`${directive} ${resolved.join(' ')}`);
  }
  return `${parts.join('; ')};`;
}

/**
 * Build the response-header value for one extension document.
 *
 * `appOrigin` is the app-shell ancestor source (see
 * `appFrameAncestorSource`). Unknown extension ids and a missing manifest both
 * fall back to the baseline policy with `known: false`, so the caller can warn
 * once per id without ever serving an un-protected document.
 */
export function buildExtensionCspHeader(
  manifest: ExtensionCspManifest | null,
  extensionId: string,
  appOrigin: string
): ExtensionCspHeader {
  const known = Boolean(manifest?.extensions[extensionId]);
  const directives =
    (known ? manifest?.extensions[extensionId] : undefined) ??
    manifest?.baseline ??
    FALLBACK_BASELINE;
  return { csp: serializeDirectives(directives, appOrigin), known };
}
