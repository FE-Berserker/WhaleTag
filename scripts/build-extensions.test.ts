import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  replaceManifestPlaceholder,
  shouldCopyDrawioAsset,
  configureDrawioOfflineViewer,
  configureDrawioPreConfig,
} = require('./build-extensions.js') as {
  replaceManifestPlaceholder: (
    content: string,
    id: string,
    manifest: Record<string, unknown>
  ) => string;
  shouldCopyDrawioAsset: (relativePath: string) => boolean;
  configureDrawioOfflineViewer: (html: string) => string;
  configureDrawioPreConfig: (source: string) => string;
};

describe('extension manifest injection', () => {
  it('replaces the placeholder with the serialized manifest', () => {
    const manifest = { id: 'text-editor', fileTypes: ['txt'] };
    const result = replaceManifestPlaceholder(
      'before /* MANIFEST_INJECTED_BY_BUILD */ {} after',
      'text-editor',
      manifest
    );

    assert.equal(
      result,
      'before {"id":"text-editor","fileTypes":["txt"]} after'
    );
  });

  it('does not expand dollar replacement sequences in manifest values', () => {
    const manifest = {
      id: 'text-editor',
      description: 'literal $& $` $\' $1',
    };
    const result = replaceManifestPlaceholder(
      'before /* MANIFEST_INJECTED_BY_BUILD */ {} after',
      'text-editor',
      manifest
    );

    assert.equal(result, `before ${JSON.stringify(manifest)} after`);
  });

  it('fails closed when the placeholder is missing', () => {
    assert.throws(
      () =>
        replaceManifestPlaceholder('manifest: {}', 'text-editor', {
          id: 'text-editor',
        }),
      /Extension text-editor: manifest placeholder not found/
    );
  });
});

describe('drawio asset copy filter', () => {
  it('drops desktop dependencies, source maps and unused viewer bundles', () => {
    const excluded = [
      'META-INF',
      'META-INF/maven/plugin.xml',
      'electron.js',
      'electronFilesWorker.js',
      'node_modules',
      'node_modules/commander/index.js',
      'js/app.min.js.map',
      'js/viewer.min.js',
      'workbox-9fe249eb.js',
    ];

    for (const relativePath of excluded) {
      assert.equal(shouldCopyDrawioAsset(relativePath), false, relativePath);
    }
    assert.equal(
      shouldCopyDrawioAsset('node_modules\\commander\\index.js'),
      false
    );
  });

  it('keeps every asset on the editor runtime path', () => {
    const retained = [
      'index.html',
      'open.html',
      'js/app.min.js',
      'js/viewer-static.min.js',
      'js/diagramly/DesktopLibrary.js',
      'js/diagramly/ElectronApp.js',
      'math/jax/output/SVG/fonts/TeX/fontdata.js',
      'stencils/basic.xml',
      'templates/basic.xml',
      'service-worker.js',
      'workbox-f163abaa.js',
    ];

    for (const relativePath of retained) {
      assert.equal(shouldCopyDrawioAsset(relativePath), true, relativePath);
    }
  });

  it('pins HTML viewer and lightbox URLs to the packaged offline asset', () => {
    const html = '<html><head><script>window.APP = true;</script></head></html>';
    const configured = configureDrawioOfflineViewer(html);
    assert.ok(configured.includes("new URL('js/viewer-static.min.js', window.location.href).href"));
    assert.ok(configured.includes('window.VIEWER_URL = window.DRAWIO_VIEWER_URL'));
    assert.ok(configured.indexOf('window.DRAWIO_VIEWER_URL') < configured.indexOf('window.APP'));
    assert.equal(configureDrawioOfflineViewer(configured), configured);
  });

  it('overrides the vendor PreConfig resets with local viewer and lightbox URLs', () => {
    const baseAssignment =
      "window.DRAWIO_BASE_URL = new URL('.', window.location.href).href.replace(/\\/$/, '')";
    const lightboxAssignment =
      "window.DRAWIO_LIGHTBOX_URL = new URL('.', window.location.href).href.replace(/\\/$/, '')";
    const source = 'window.DRAWIO_BASE_URL = null;\nwindow.DRAWIO_VIEWER_URL = null;';
    const configured = configureDrawioPreConfig(source);
    assert.ok(configured.includes(baseAssignment));
    assert.ok(configured.includes("window.DRAWIO_VIEWER_URL = new URL('js/viewer-static.min.js', window.location.href).href"));
    assert.ok(configured.includes('window.VIEWER_URL = window.DRAWIO_VIEWER_URL'));
    assert.ok(configured.includes(lightboxAssignment));
    assert.equal(configureDrawioPreConfig(configured), configured);
    const reordered = configureDrawioPreConfig(
      'window.DRAWIO_VIEWER_URL = null;\nwindow.DRAWIO_BASE_URL = null;'
    );
    assert.ok(reordered.includes(baseAssignment));
    assert.ok(reordered.includes(lightboxAssignment));
    assert.throws(() => configureDrawioPreConfig('window.APP = true;'), /expected offline URL resets/);
  });
});

// --- Content-Security-Policy ----------------------------------------------
// The policy lives in src/extensions/shared/csp-policy.json and is synthesized
// into each built index.html. These tests pin the security-relevant parts: a
// future viewer that forgets its entry, or an entry that quietly widens
// script-src, must fail here instead of shipping.

const {
  loadCspPolicy,
  buildCspForExtension,
  buildMetaCspForExtension,
  buildCspManifest,
  CSP_POLICY_FILE,
  CSP_MANIFEST_FILENAME,
  REQUIRED_CSP_DIRECTIVES,
  META_OMITTED_DIRECTIVES,
} = require('./build-extensions.js') as {
  loadCspPolicy: () => CspPolicy;
  buildCspForExtension: (policy: CspPolicy, id: string) => string;
  buildMetaCspForExtension: (policy: CspPolicy, id: string) => string;
  buildCspManifest: (policy: CspPolicy) => CspManifest;
  CSP_POLICY_FILE: string;
  CSP_MANIFEST_FILENAME: string;
  REQUIRED_CSP_DIRECTIVES: string[];
  META_OMITTED_DIRECTIVES: string[];
};

interface CspPolicy {
  placeholder: string;
  header: { appOriginPlaceholder: string; frameAncestors: string[] };
  baseline: Record<string, string[]>;
  extensions: Record<string, Record<string, string[]>>;
}

interface CspManifest {
  version: number;
  generatedAt: string;
  appOriginPlaceholder: string;
  baseline: Record<string, string[]>;
  extensions: Record<string, Record<string, string[]>>;
}

const fs = require('node:fs') as typeof import('node:fs');
const path = require('node:path') as typeof import('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const EXTENSIONS_SRC_DIR = path.join(REPO_ROOT, 'src', 'extensions');

function discoverExtensionIds(): string[] {
  return fs
    .readdirSync(EXTENSIONS_SRC_DIR, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        fs.existsSync(
          path.join(EXTENSIONS_SRC_DIR, entry.name, 'manifest.json')
        )
    )
    .map((entry) => entry.name)
    .sort();
}

function directiveTokens(csp: string, directive: string): string[] {
  for (const part of csp.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [name, ...tokens] = trimmed.split(/\s+/);
    if (name === directive) return tokens;
  }
  return [];
}

describe('extension CSP policy', () => {
  const policy = loadCspPolicy();
  const ids = discoverExtensionIds();

  it('reads the shared policy file', () => {
    assert.ok(fs.existsSync(CSP_POLICY_FILE), CSP_POLICY_FILE);
    assert.ok(policy.placeholder.length > 0);
    assert.ok(ids.length >= 8, `expected the built-in viewers, got ${ids.join(', ')}`);
  });

  it('locks down object/base/frame sinks in the shared baseline', () => {
    for (const directive of REQUIRED_CSP_DIRECTIVES) {
      assert.deepEqual(policy.baseline[directive], ["'none'"], directive);
    }
    // No baseline policy may grant eval or inline script to every viewer.
    assert.equal(policy.baseline['script-src'].includes("'unsafe-eval'"), false);
    assert.equal(policy.baseline['script-src'].includes("'unsafe-inline'"), false);
  });

  it('keeps the header policy anchored on a substituted app origin', () => {
    const { appOriginPlaceholder, frameAncestors } = policy.header;
    assert.equal(appOriginPlaceholder, '__APP_ORIGIN__');
    assert.deepEqual(frameAncestors, ["'self'", appOriginPlaceholder]);
  });

  it('whitelists only the two internal protocols for images', () => {
    const imgSrc = policy.baseline['img-src'];
    assert.ok(imgSrc.includes('whale-extension://*'), 'missing whale-extension');
    assert.ok(imgSrc.includes('whale-file:'), 'missing whale-file');
    assert.equal(imgSrc.some((token) => token === 'http:' || token === 'https:'), false);
  });

  it('has an entry for every extension and no unknown entries', () => {
    for (const id of ids) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(policy.extensions, id),
        `no CSP entry for extension ${id}`
      );
    }
    for (const id of Object.keys(policy.extensions)) {
      assert.ok(ids.includes(id), `CSP entry for unknown extension ${id}`);
    }
  });

  it('synthesizes every policy with the baseline protections intact', () => {
    for (const id of ids) {
      const csp = buildCspForExtension(policy, id);
      for (const directive of REQUIRED_CSP_DIRECTIVES) {
        assert.deepEqual(directiveTokens(csp, directive), ["'none'"], `${id}:${directive}`);
      }
      assert.deepEqual(directiveTokens(csp, 'default-src'), ["'self'"], id);
      assert.ok(directiveTokens(csp, 'img-src').includes('whale-file:'), id);
      // Stable serialization: no duplicate tokens inside a directive.
      for (const part of csp.split(';')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const tokens = trimmed.split(/\s+/);
        assert.equal(new Set(tokens).size, tokens.length, `${id}: ${trimmed}`);
      }
    }
  });

  it('strips meta-ignored directives from the injected meta policy', () => {
    // `frame-ancestors` is ignored in meta-delivered policies; leaving it in
    // makes Chromium log an error on every extension load. The response header
    // (see the manifest describe below) is the only place it belongs.
    assert.deepEqual(META_OMITTED_DIRECTIVES, ['frame-ancestors']);
    const requiredMeta = REQUIRED_CSP_DIRECTIVES.filter(
      (directive) => !META_OMITTED_DIRECTIVES.includes(directive)
    );
    for (const id of ids) {
      const meta = buildMetaCspForExtension(policy, id);
      assert.equal(meta.includes('frame-ancestors'), false, `${id}:frame-ancestors`);
      for (const directive of requiredMeta) {
        assert.deepEqual(directiveTokens(meta, directive), ["'none'"], `${id}:${directive}`);
      }
      assert.deepEqual(directiveTokens(meta, 'default-src'), ["'self'"], id);
      assert.ok(directiveTokens(meta, 'img-src').includes('whale-file:'), id);
      // Nothing else got dropped along the way.
      for (const directive of Object.keys(policy.baseline)) {
        if (META_OMITTED_DIRECTIVES.includes(directive)) continue;
        assert.ok(directiveTokens(meta, directive).length > 0, `${id}:${directive}`);
      }
    }
  });

  it('keeps eval / remote privileges on the extensions that need them', () => {
    for (const id of ids) {
      const csp = buildCspForExtension(policy, id);
      const scriptTokens = directiveTokens(csp, 'script-src');
      const imgTokens = directiveTokens(csp, 'img-src');
      const allowsEval = scriptTokens.includes("'unsafe-eval'");
      const allowsWasmEval = scriptTokens.includes("'wasm-unsafe-eval'");
      // draw.io ships a legacy Monaco-ish bundle; heic decodes wasm.
      assert.equal(allowsEval, id === 'drawio-editor' || id === 'heic-viewer', `${id}:unsafe-eval`);
      assert.equal(allowsWasmEval, id === 'heic-viewer', `${id}:wasm-unsafe-eval`);
      // html-viewer renders remote <img>; everything else stays local.
      const allowsRemoteImages = imgTokens.includes('https:') && imgTokens.includes('http:');
      assert.equal(allowsRemoteImages, id === 'html-viewer', `${id}:remote-images`);
    }
  });

  it('keeps every source template on the placeholder instead of a hardcoded policy', () => {
    for (const id of ids) {
      const htmlPath = path.join(EXTENSIONS_SRC_DIR, id, 'index.html');
      const html = fs.readFileSync(htmlPath, 'utf8');
      assert.ok(
        html.includes(`content="${policy.placeholder}"`),
        `${id}/index.html must use content="${policy.placeholder}"`
      );
      for (const directive of [
        'default-src',
        'script-src',
        'object-src',
        'frame-ancestors',
      ]) {
        assert.equal(
          html.includes(directive),
          false,
          `${id}/index.html still hardcodes ${directive}`
        );
      }
    }
  });
});

// The protocol handler cannot use the meta policy for `frame-ancestors`
// (Chromium drops that directive from meta-delivered policies), so the build
// also emits `dist/extensions/csp-policy.generated.json` and main.ts serves it
// as a response header. These tests pin the generated contract: it must carry
// the same baseline protections, must allow the app shell to frame the
// document, and must leave runtime substitution to the main process.
describe('extension CSP header manifest', () => {
  const policy = loadCspPolicy();
  const ids = discoverExtensionIds();
  const manifest = buildCspManifest(policy);

  it('is generated from the same policy file', () => {
    assert.equal(manifest.version, 1);
    assert.equal(manifest.appOriginPlaceholder, policy.header.appOriginPlaceholder);
    assert.equal(typeof manifest.generatedAt, 'string');
  });

  it('covers every extension and nothing else', () => {
    assert.deepEqual(Object.keys(manifest.extensions).sort(), ids.slice().sort());
  });

  it('allows the app shell to frame the document', () => {
    const expected = ["'self'", policy.header.appOriginPlaceholder];
    assert.deepEqual(manifest.baseline['frame-ancestors'], expected);
    for (const [id, directives] of Object.entries(manifest.extensions)) {
      assert.deepEqual(directives['frame-ancestors'], expected, id);
    }
    // The meta tag must NOT carry it: Chromium logs a console error for every
    // meta-delivered frame-ancestors (the real-window smoke asserts no console
    // errors), and the header is the only channel that enforces it anyway.
    assert.equal(
      buildMetaCspForExtension(policy, 'json-viewer').includes('frame-ancestors'),
      false
    );
  });

  it('keeps the baseline protections in every header policy', () => {
    for (const [id, directives] of Object.entries(manifest.extensions)) {
      for (const directive of REQUIRED_CSP_DIRECTIVES) {
        // `frame-ancestors` is the one directive the header intentionally
        // changes: the app shell must be allowed to frame the document.
        if (directive === 'frame-ancestors') continue;
        assert.deepEqual(directives[directive], ["'none'"], `${id}:${directive}`);
      }
      assert.deepEqual(
        directives['frame-ancestors'],
        ["'self'", policy.header.appOriginPlaceholder],
        `${id}:frame-ancestors`
      );
      assert.deepEqual(directives['default-src'], ["'self'"], id);
      assert.ok(directives['img-src'].includes('whale-file:'), id);
      for (const [directive, tokens] of Object.entries(directives)) {
        assert.equal(new Set(tokens).size, tokens.length, `${id}:${directive}`);
      }
    }
  });

  it('keeps eval privileges on the extensions that need them, and nowhere else', () => {
    for (const id of ids) {
      const scriptTokens = manifest.extensions[id]['script-src'];
      assert.equal(
        scriptTokens.includes("'unsafe-eval'"),
        id === 'drawio-editor' || id === 'heic-viewer',
        `${id}:unsafe-eval`
      );
      assert.equal(
        scriptTokens.includes("'unsafe-inline'"),
        id === 'drawio-editor',
        `${id}:unsafe-inline`
      );
    }
  });

  it('leaves the runtime placeholder for the main process instead of a literal origin', () => {
    const serialized = JSON.stringify(manifest);
    assert.equal(serialized.includes(policy.placeholder), false);
    assert.equal(serialized.includes('"file:"'), false);
    assert.equal(serialized.includes('http://localhost'), false);
  });

  it('uses the artifact name the main process reads and validates its shape', () => {
    assert.equal(CSP_MANIFEST_FILENAME, 'csp-policy.generated.json');
    const mainModule = require('../src/main/extension-csp') as {
      CSP_MANIFEST_FILENAME: string;
      parseCspManifest: (raw: unknown) => unknown;
    };
    assert.equal(CSP_MANIFEST_FILENAME, mainModule.CSP_MANIFEST_FILENAME);
    assert.ok(
      mainModule.parseCspManifest(manifest),
      'the main process validator must accept the generated manifest'
    );
  });
});
