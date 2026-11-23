/**
 * Per-extension CSP **response headers** for the `whale-extension://` protocol.
 *
 * A meta-delivered policy cannot enforce `frame-ancestors` (Chromium drops it),
 * so `main.ts > registerExtensionProtocol` adds the policy from
 * `dist/extensions/csp-policy.generated.json` to every HTML response. These
 * tests pin the loader/validator, the app-ancestor substitution and the
 * fail-closed fallbacks without booting Electron.
 *
 * Run via `npm test` (electron --test under node:test).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import * as fs from 'fs';
import {
  APP_ORIGIN_PLACEHOLDER,
  CSP_MANIFEST_FILENAME,
  appFrameAncestorSource,
  buildExtensionCspHeader,
  loadCspManifest,
  parseCspManifest,
} from './extension-csp';

const REQUIRED_DIRECTIVES = [
  'default-src',
  'object-src',
  'base-uri',
  'frame-ancestors',
] as const;

const PROD_ANCESTOR = 'file:';
const DEV_ANCESTOR = 'http://localhost:4002';

function baseDirectives(): Record<string, string[]> {
  return {
    'default-src': ["'self'"],
    'script-src': ["'self'", 'whale-extension://*'],
    'style-src': ["'self'", "'unsafe-inline'", 'whale-extension://*'],
    'img-src': ["'self'", 'data:', 'blob:', 'whale-extension://*', 'whale-file:'],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'frame-ancestors': ["'self'", APP_ORIGIN_PLACEHOLDER],
  };
}

function drawioDirectives(): Record<string, string[]> {
  return {
    ...baseDirectives(),
    'script-src': [
      "'self'",
      'whale-extension://*',
      "'unsafe-inline'",
      "'unsafe-eval'",
    ],
  };
}

function manifestFixture(): Record<string, unknown> {
  return {
    version: 1,
    generatedAt: '2026-11-23T00:00:00.000Z',
    appOriginPlaceholder: APP_ORIGIN_PLACEHOLDER,
    baseline: baseDirectives(),
    extensions: {
      'drawio-editor': drawioDirectives(),
      'json-viewer': baseDirectives(),
    },
  };
}

/** Split a serialized policy into directive → tokens. */
function directiveTokens(csp: string, directive: string): string[] {
  for (const part of csp.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [name, ...tokens] = trimmed.split(/\s+/);
    if (name === directive) return tokens;
  }
  return [];
}

function assertNoDuplicateTokens(csp: string): void {
  for (const part of csp.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    assert.equal(new Set(tokens).size, tokens.length, `duplicate token: ${trimmed}`);
  }
}

describe('extension CSP manifest parsing', () => {
  it('accepts the shape the build script emits', () => {
    const manifest = parseCspManifest(manifestFixture());
    assert.ok(manifest, 'expected the generated shape to validate');
    assert.equal(manifest?.version, 1);
    assert.equal(manifest?.appOriginPlaceholder, APP_ORIGIN_PLACEHOLDER);
    assert.ok(manifest?.extensions['drawio-editor']);
  });

  it('rejects values that are not an object', () => {
    for (const raw of [null, undefined, 'csp', 42, []]) {
      assert.equal(parseCspManifest(raw), null, JSON.stringify(raw));
    }
  });

  it('rejects an unknown manifest version', () => {
    const fixture = manifestFixture();
    fixture.version = 2;
    assert.equal(parseCspManifest(fixture), null);
  });

  it('rejects a missing placeholder', () => {
    const fixture = manifestFixture();
    delete fixture.appOriginPlaceholder;
    assert.equal(parseCspManifest(fixture), null);
  });

  it('rejects a baseline that lost a required directive', () => {
    for (const directive of REQUIRED_DIRECTIVES) {
      const fixture = manifestFixture();
      delete (fixture.baseline as Record<string, unknown>)[directive];
      assert.equal(parseCspManifest(fixture), null, directive);
    }
  });

  it('rejects frame-ancestors without the app-origin placeholder', () => {
    const fixture = manifestFixture();
    (fixture.baseline as Record<string, unknown>)['frame-ancestors'] = ["'self'"];
    assert.equal(parseCspManifest(fixture), null);
  });

  it('rejects an extension entry that lost a required directive', () => {
    for (const directive of REQUIRED_DIRECTIVES) {
      const fixture = manifestFixture();
      delete (
        (fixture.extensions as Record<string, Record<string, unknown>>)['json-viewer']
      )[directive];
      assert.equal(parseCspManifest(fixture), null, directive);
    }
  });

  it('rejects non-string and blank tokens', () => {
    const withNonString = manifestFixture();
    (withNonString.baseline as Record<string, unknown>)['default-src'] = [1];
    assert.equal(parseCspManifest(withNonString), null);

    const withBlank = manifestFixture();
    (withBlank.baseline as Record<string, unknown>)['default-src'] = ['  '];
    assert.equal(parseCspManifest(withBlank), null);
  });
});

describe('extension CSP header synthesis', () => {
  const manifest = parseCspManifest(manifestFixture());

  it('uses the per-extension policy and allows the app ancestor', () => {
    const { csp, known } = buildExtensionCspHeader(
      manifest,
      'drawio-editor',
      PROD_ANCESTOR
    );
    assert.equal(known, true);
    assert.deepEqual(directiveTokens(csp, 'frame-ancestors'), [
      "'self'",
      PROD_ANCESTOR,
    ]);
    assert.ok(directiveTokens(csp, 'script-src').includes("'unsafe-eval'"));
    assert.deepEqual(directiveTokens(csp, 'object-src'), ["'none'"]);
    assert.deepEqual(directiveTokens(csp, 'base-uri'), ["'none'"]);
    assert.equal(csp.includes(APP_ORIGIN_PLACEHOLDER), false);
    assert.ok(csp.endsWith(';'));
    assertNoDuplicateTokens(csp);
  });

  it('does not leak another extension privileges', () => {
    const { csp } = buildExtensionCspHeader(manifest, 'json-viewer', PROD_ANCESTOR);
    assert.equal(directiveTokens(csp, 'script-src').includes("'unsafe-eval'"), false);
    assert.equal(directiveTokens(csp, 'script-src').includes("'unsafe-inline'"), false);
  });

  it('substitutes the dev-server origin in development', () => {
    const { csp } = buildExtensionCspHeader(manifest, 'json-viewer', DEV_ANCESTOR);
    assert.deepEqual(directiveTokens(csp, 'frame-ancestors'), [
      "'self'",
      DEV_ANCESTOR,
    ]);
    // The production ancestor source must not linger (note: `file:` also
    // appears inside the unrelated `whale-file:` image token, so check the
    // framing directive itself).
    assert.equal(
      directiveTokens(csp, 'frame-ancestors').includes(PROD_ANCESTOR),
      false
    );
  });

  it('fails closed for an unknown extension id', () => {
    const { csp, known } = buildExtensionCspHeader(
      manifest,
      'not-installed',
      PROD_ANCESTOR
    );
    assert.equal(known, false);
    assert.deepEqual(directiveTokens(csp, 'frame-ancestors'), [
      "'self'",
      PROD_ANCESTOR,
    ]);
    assert.ok(directiveTokens(csp, 'img-src').includes('whale-file:'));
    assert.equal(directiveTokens(csp, 'script-src').includes("'unsafe-eval'"), false);
  });

  it('fails closed to the built-in baseline when the manifest is missing', () => {
    const { csp, known } = buildExtensionCspHeader(null, 'drawio-editor', PROD_ANCESTOR);
    assert.equal(known, false);
    for (const directive of REQUIRED_DIRECTIVES) {
      assert.ok(
        directiveTokens(csp, directive).length > 0,
        `fallback missing ${directive}`
      );
    }
    assert.deepEqual(directiveTokens(csp, 'frame-ancestors'), [
      "'self'",
      PROD_ANCESTOR,
    ]);
    assert.equal(csp.includes(APP_ORIGIN_PLACEHOLDER), false);
    assertNoDuplicateTokens(csp);
  });

  it('maps the app shell to a scheme source in production only', () => {
    assert.equal(appFrameAncestorSource(false, DEV_ANCESTOR), PROD_ANCESTOR);
    assert.equal(appFrameAncestorSource(true, DEV_ANCESTOR), DEV_ANCESTOR);
  });
});

describe('extension CSP manifest loading', () => {
  let dir: string;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-ext-csp-'));
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads a valid generated manifest', () => {
    const file = path.join(dir, CSP_MANIFEST_FILENAME);
    fs.writeFileSync(file, JSON.stringify(manifestFixture()), 'utf8');
    const manifest = loadCspManifest(file);
    assert.ok(manifest);
    assert.equal(manifest?.version, 1);
  });

  it('returns null for a missing file', () => {
    assert.equal(loadCspManifest(path.join(dir, 'nope.json')), null);
  });

  it('returns null for malformed JSON', () => {
    const file = path.join(dir, 'broken.json');
    fs.writeFileSync(file, '{"version": 1,', 'utf8');
    assert.equal(loadCspManifest(file), null);
  });

  it('returns null for structurally invalid JSON', () => {
    const file = path.join(dir, 'invalid.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1 }), 'utf8');
    assert.equal(loadCspManifest(file), null);
  });

  it('keeps the manifest filename in sync with the build artifact name', () => {
    // scripts/build-extensions.js pins the same literal; drift here would make
    // the protocol handler fall back to the baseline for every extension.
    assert.equal(CSP_MANIFEST_FILENAME, 'csp-policy.generated.json');
  });
});
