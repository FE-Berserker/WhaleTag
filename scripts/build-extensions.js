#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC_EXTENSIONS = path.join(ROOT, 'src', 'extensions');
const DIST_EXTENSIONS = path.join(
  ROOT,
  'release',
  'app',
  'dist',
  'extensions'
);
const SHARED_API_SOURCE = path.join(SRC_EXTENSIONS, 'shared', 'extension-api.js');
const SHARED_API_DEST_DIR = path.join(DIST_EXTENSIONS, 'shared');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function cleanDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
}

function validateManifest(manifest, id) {
  const required = ['id', 'name', 'type', 'color', 'fileTypes', 'entryPoint'];
  for (const key of required) {
    if (manifest[key] === undefined) {
      throw new Error(`Extension ${id}: missing ${key} in manifest.json`);
    }
  }
  if (manifest.id !== id) {
    throw new Error(
      `Extension ${id}: manifest id "${manifest.id}" does not match directory name`
    );
  }
  if (!['viewer', 'editor'].includes(manifest.type)) {
    throw new Error(`Extension ${id}: invalid type "${manifest.type}"`);
  }
  if (!Array.isArray(manifest.fileTypes) || manifest.fileTypes.length === 0) {
    throw new Error(`Extension ${id}: fileTypes must be a non-empty array`);
  }
}

function discoverExtensions() {
  if (!fs.existsSync(SRC_EXTENSIONS)) return [];

  return fs
    .readdirSync(SRC_EXTENSIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'shared')
    .map((d) => d.name)
    .sort()
    .map((id) => {
      const manifestPath = path.join(SRC_EXTENSIONS, id, 'manifest.json');
      if (!fs.existsSync(manifestPath)) return null;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      validateManifest(manifest, id);
      return { id, manifest };
    })
    .filter(Boolean);
}

function copyExtensionStaticFiles(id) {
  const srcDir = path.join(SRC_EXTENSIONS, id);
  const destDir = path.join(DIST_EXTENSIONS, id);
  ensureDir(destDir);

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    if (entry.name === 'manifest.json') continue; // in registry
    if (/\.tsx?$/.test(entry.name)) continue; // bundled by webpack
    if (entry.isDirectory()) continue;

    const destPath = path.join(destDir, entry.name);
    fs.copyFileSync(srcPath, destPath);
  }
}

const MANIFEST_PLACEHOLDER = '/* MANIFEST_INJECTED_BY_BUILD */ {}';

// --- Content-Security-Policy ----------------------------------------------
// The eight extension viewers share one CSP baseline (object-src / base-uri /
// frame-ancestors locked down, images whitelisted for the two internal
// protocols). Keeping the policy in one JSON file means a new viewer cannot
// ship with a silently divergent policy, and an audit reads one file instead of
// eight inline meta tags. The source `<id>/index.html` keeps only the
// placeholder; the real policy is synthesized here at build time.
const CSP_POLICY_FILE = path.join(SRC_EXTENSIONS, 'shared', 'csp-policy.json');
/** Per-extension header policies for the `whale-extension://` protocol handler.
 *  A meta-delivered policy cannot enforce `frame-ancestors`, so the protocol
 *  serves `dist/extensions/csp-policy.generated.json` as a real response header
 *  (see src/main/extension-csp.ts). The file is generated from the very same
 *  policy JSON, so meta and header can never drift apart. */
const CSP_MANIFEST_FILENAME = 'csp-policy.generated.json';
/** Directives that must be present in every policy; losing one is a
 *  security regression, so the build fails instead of shipping it. */
const REQUIRED_CSP_DIRECTIVES = ['object-src', 'base-uri', 'frame-ancestors'];

/** Directives a `<meta http-equiv>` policy cannot enforce. Chromium logs
 *  `The Content Security Policy directive 'frame-ancestors' is ignored when
 *  delivered via a <meta> element.` on every load, so the meta tag carries the
 *  rest of the policy and this one is delivered only by the response header
 *  (`csp-policy.generated.json`, see src/main/extension-csp.ts). Keeping it in
 *  the meta too would just be console noise in the real-window smoke run. */
const META_OMITTED_DIRECTIVES = ['frame-ancestors'];

function assertCspTokenList(where, directive, tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    throw new Error(`CSP policy: ${where} directive "${directive}" must be a non-empty array`);
  }
  for (const token of tokens) {
    if (typeof token !== 'string' || token.trim() === '') {
      throw new Error(`CSP policy: ${where} directive "${directive}" has a non-string token`);
    }
  }
}

function loadCspPolicy() {
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(CSP_POLICY_FILE, 'utf8'));
  } catch (error) {
    throw new Error(
      `CSP policy: cannot read ${CSP_POLICY_FILE}: ${error instanceof Error ? error.message : error}`
    );
  }
  if (!policy || typeof policy !== 'object' || typeof policy.placeholder !== 'string') {
    throw new Error('CSP policy: missing the `placeholder` string');
  }
  if (!policy.baseline || typeof policy.baseline !== 'object') {
    throw new Error('CSP policy: missing the `baseline` object');
  }
  for (const [directive, tokens] of Object.entries(policy.baseline)) {
    assertCspTokenList('baseline', directive, tokens);
  }
  for (const directive of REQUIRED_CSP_DIRECTIVES) {
    if (!Array.isArray(policy.baseline[directive])) {
      throw new Error(
        `CSP policy: baseline is missing the required directive "${directive}"`
      );
    }
  }
  if (!policy.extensions || typeof policy.extensions !== 'object') {
    throw new Error('CSP policy: missing the `extensions` object');
  }
  for (const [id, extra] of Object.entries(policy.extensions)) {
    if (!extra || typeof extra !== 'object') {
      throw new Error(`CSP policy: extension "${id}" entry must be an object`);
    }
    for (const [directive, tokens] of Object.entries(extra)) {
      assertCspTokenList(id, directive, tokens);
    }
  }
  // Header counterpart. It must name the placeholder it replaces, otherwise the
  // protocol handler would emit a literal `__APP_ORIGIN__` source (ignored by
  // Chromium) and every extension iframe would be blocked.
  if (!policy.header || typeof policy.header !== 'object') {
    throw new Error('CSP policy: missing the `header` object');
  }
  const { appOriginPlaceholder, frameAncestors } = policy.header;
  if (
    typeof appOriginPlaceholder !== 'string' ||
    !/^__[A-Z0-9_]+__$/.test(appOriginPlaceholder)
  ) {
    throw new Error(
      'CSP policy: header.appOriginPlaceholder must look like "__APP_ORIGIN__"'
    );
  }
  assertCspTokenList('header', 'frame-ancestors', frameAncestors);
  if (!frameAncestors.includes(appOriginPlaceholder)) {
    throw new Error(
      'CSP policy: header.frameAncestors must contain header.appOriginPlaceholder'
    );
  }
  return policy;
}

/** Merge baseline + extension extras. Extras only ever append tokens, so a
 *  per-extension entry can never drop a baseline protection. */
function mergeCspDirectives(baseline, extra) {
  const merged = new Map();
  for (const [directive, tokens] of Object.entries(baseline)) {
    merged.set(directive, [...tokens]);
  }
  for (const [directive, tokens] of Object.entries(extra || {})) {
    merged.set(directive, [...(merged.get(directive) || []), ...tokens]);
  }
  return merged;
}

/** Serialize the policy for one extension into a `Content-Security-Policy`
 *  attribute value (stable directive order, duplicate tokens removed). */
function buildCspForExtension(policy, id) {
  const extra = policy.extensions[id];
  if (!extra) {
    throw new Error(`CSP policy: no entry for extension "${id}"`);
  }
  const directives = [];
  for (const [directive, tokens] of mergeCspDirectives(policy.baseline, extra)) {
    const deduped = [...new Set(tokens)];
    if (deduped.length === 0) continue;
    directives.push(`${directive} ${deduped.join(' ')}`);
  }
  return `${directives.join('; ')};`;
}

/** Meta-tag serializer: same policy minus `META_OMITTED_DIRECTIVES`. Used for
 *  the built `index.html`; the omitted directives are delivered by the protocol
 *  response header instead (`buildCspManifest`). */
function buildMetaCspForExtension(policy, id) {
  const extra = policy.extensions[id];
  if (!extra) {
    throw new Error(`CSP policy: no entry for extension "${id}"`);
  }
  const directives = [];
  for (const [directive, tokens] of mergeCspDirectives(policy.baseline, extra)) {
    if (META_OMITTED_DIRECTIVES.includes(directive)) continue;
    const deduped = [...new Set(tokens)];
    if (deduped.length === 0) continue;
    directives.push(`${directive} ${deduped.join(' ')}`);
  }
  return `${directives.join('; ')};`;
}

/** Header counterpart of `buildCspForExtension`. Same directives, but
 *  `frame-ancestors` is replaced by the `header.frameAncestors` list so the app
 *  shell that embeds the iframe is allowed (meta-delivered frame-ancestors is
 *  dropped by Chromium, so this list can only live in the response header). */
function buildHeaderDirectiveMap(policy, extra) {
  const merged = mergeCspDirectives(policy.baseline, extra || {});
  merged.set('frame-ancestors', [...policy.header.frameAncestors]);
  return merged;
}

/** Turn a merged directive map into the plain JSON object the protocol handler
 *  reads: directive → de-duplicated token list. */
function directiveMapToObject(merged) {
  const out = {};
  for (const [directive, tokens] of merged) {
    const deduped = [...new Set(tokens)];
    if (deduped.length === 0) continue;
    out[directive] = deduped;
  }
  return out;
}

/** Build the artifact consumed by `src/main/extension-csp.ts`: every built-in
 *  extension's header policy, pre-merged (the main process never re-implements
 *  the merge rules), with the app-origin placeholder left for runtime
 *  substitution. */
function buildCspManifest(policy) {
  const extensions = {};
  for (const [id, extra] of Object.entries(policy.extensions)) {
    extensions[id] = directiveMapToObject(buildHeaderDirectiveMap(policy, extra));
  }
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    appOriginPlaceholder: policy.header.appOriginPlaceholder,
    baseline: directiveMapToObject(buildHeaderDirectiveMap(policy, {})),
    extensions,
  };
}

/** Write the generated header manifest next to the built extension folders.
 *  `cleanDir` runs before the build, so a failed build never leaves a stale
 *  manifest behind for the main process to trust. */
function writeCspManifest(policy) {
  const manifest = buildCspManifest(policy);
  fs.writeFileSync(
    path.join(DIST_EXTENSIONS, CSP_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );
  return manifest;
}

function injectCspIntoHtml(id, policy) {
  const htmlPath = path.join(DIST_EXTENSIONS, id, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    throw new Error(`CSP: ${id}/index.html was not produced by webpack`);
  }
  const content = fs.readFileSync(htmlPath, 'utf8');
  const placeholder = policy.placeholder;
  if (!content.includes(placeholder)) {
    throw new Error(
      `Extension ${id}: CSP placeholder "${placeholder}" not found in index.html` +
        ' (the template must use content="__WHALE_CSP__")'
    );
  }
  fs.writeFileSync(
    htmlPath,
    content.replace(placeholder, () => buildMetaCspForExtension(policy, id)),
    'utf8'
  );
}

function replaceManifestPlaceholder(content, id, manifest) {
  if (!content.includes(MANIFEST_PLACEHOLDER)) {
    throw new Error(`Extension ${id}: manifest placeholder not found`);
  }
  return content.replace(MANIFEST_PLACEHOLDER, () => JSON.stringify(manifest));
}

function injectManifestIntoApi(id, manifest) {
  const apiPath = path.join(DIST_EXTENSIONS, id, 'extension-api.js');
  if (!fs.existsSync(apiPath)) return;

  const content = fs.readFileSync(apiPath, 'utf8');
  fs.writeFileSync(
    apiPath,
    replaceManifestPlaceholder(content, id, manifest),
    'utf8'
  );
}

function fixHtmlAssetPaths(id) {
  const htmlPath = path.join(DIST_EXTENSIONS, id, 'index.html');
  if (!fs.existsSync(htmlPath)) return;

  let content = fs.readFileSync(htmlPath, 'utf8');
  // Webpack injected paths like `text-editor/bundle.js` or `../text-editor/bundle.js`;
  // the assets actually live next to the HTML, so normalize to `./bundle.js` etc.
  const bundlePattern = new RegExp(`(src=["'])(?:\\.\\./)?${id}/bundle\\.js(["'])`, 'g');
  const cssPattern = new RegExp(`(href=["'])(?:\\.\\./)?${id}/styles\\.css(["'])`, 'g');
  content = content.replace(bundlePattern, '$1./bundle.js$2');
  content = content.replace(cssPattern, '$1./styles.css$2');
  fs.writeFileSync(htmlPath, content, 'utf8');
}

/**
 * Keep the drawio webapp runtime, not the unused drawio-desktop distribution.
 * These exclusions are based on the loaded index.html/app.min.js references:
 * open.html stays because OPEN_FORM/OpenDialog still references it.
 * The copied index pins both lazy viewer URLs to viewer-static.min.js below;
 * viewer.min.js is the separate standalone viewer. The active service worker imports
 * workbox-f163abaa; workbox-9fe249eb is an orphaned older bundle.
 */
function shouldCopyDrawioAsset(relativePath) {
  const rel = relativePath.replace(/\\/g, '/');
  if (rel === 'META-INF' || rel.startsWith('META-INF/')) return false;
  if (rel === 'electron.js' || rel === 'electronFilesWorker.js') return false;
  if (rel === 'node_modules' || rel.startsWith('node_modules/')) return false;
  if (rel.endsWith('.map')) return false;
  if (rel === 'js/viewer.min.js' || rel === 'workbox-9fe249eb.js') return false;
  return true;
}

const DRAWIO_OFFLINE_VIEWER_MARKER = '<!-- whale-offline-viewer -->';

/** Pin both lazy HTML-viewer paths to the packaged asset instead of the CDN. */
function configureDrawioOfflineViewer(html) {
  if (html.includes(DRAWIO_OFFLINE_VIEWER_MARKER)) return html;
  if (!html.includes('<head>')) {
    throw new Error('drawio-editor: <head> not found in drawio-assets/index.html');
  }
  const config = `${DRAWIO_OFFLINE_VIEWER_MARKER}\n<script>\n` +
    "window.DRAWIO_VIEWER_URL = new URL('js/viewer-static.min.js', window.location.href).href;\n" +
    'window.VIEWER_URL = window.DRAWIO_VIEWER_URL;\n' +
    '</script>';
  return html.replace('<head>', () => `<head>\n${config}`);
}

const DRAWIO_OFFLINE_PRECONFIG_MARKER = '/* whale-offline-preconfig */';

/** PreConfig runs after index.html and resets the viewer globals to null. */
function configureDrawioPreConfig(source) {
  if (source.includes(DRAWIO_OFFLINE_PRECONFIG_MARKER)) return source;
  const baseNeedle = 'window.DRAWIO_BASE_URL = null;';
  const viewerNeedle = 'window.DRAWIO_VIEWER_URL = null;';
  if (!source.includes(baseNeedle) || !source.includes(viewerNeedle)) {
    throw new Error('drawio-editor: expected offline URL resets not found in js/PreConfig.js');
  }
  return source
    .replace(
      baseNeedle,
      () => `${DRAWIO_OFFLINE_PRECONFIG_MARKER}\n` +
        "window.DRAWIO_BASE_URL = new URL('.', window.location.href).href.replace(/\\/$/, '');"
    )
    .replace(
      viewerNeedle,
      () => "window.DRAWIO_VIEWER_URL = new URL('js/viewer-static.min.js', window.location.href).href;\n" +
        'window.VIEWER_URL = window.DRAWIO_VIEWER_URL;\n' +
        "window.DRAWIO_LIGHTBOX_URL = new URL('.', window.location.href).href.replace(/\\/$/, '');"
    );
}

/**
 * Copies runtime assets pulled from node_modules. Excalidraw registers every
 * font in dist/prod/fonts as a FontFace under window.EXCALIDRAW_ASSET_PATH and
 * loads the unicode-range subsets its canvas text needs through url() — the
 * handwritten (incl. Chinese Xiaolai) fonts render from these bundled copies
 * (verified in the packaged build, 2026-11-25). Only fetch() is unavailable on
 * the extension scheme, which affects the font inlining of SVG export alone.
 */
function copyExtensionRuntimeAssets(id) {
  if (id === 'excalidraw-editor') {
    const destDir = path.join(DIST_EXTENSIONS, id);
    if (!fs.existsSync(destDir)) return;
    const fontsSrc = path.join(
      ROOT,
      'node_modules',
      '@excalidraw',
      'excalidraw',
      'dist',
      'prod',
      'fonts'
    );
    if (fs.existsSync(fontsSrc)) {
      fs.cpSync(fontsSrc, path.join(destDir, 'fonts'), { recursive: true });
    } else {
      console.warn(`excalidraw-editor: fonts not found at ${fontsSrc}`);
    }
    return;
  }

  if (id === 'drawio-editor') {
    const destDir = path.join(DIST_EXTENSIONS, id);
    if (!fs.existsSync(destDir)) return;
    const drawioSrc = path.join(ROOT, 'node_modules', 'drawio-offline');
    if (!fs.existsSync(drawioSrc)) {
      console.warn(
        `drawio-editor: drawio-offline not found at ${drawioSrc}. ` +
          'Run "npm install drawio-offline --save-dev" to enable the Draw.io editor.'
      );
      return;
    }
    const assetsDest = path.join(destDir, 'drawio-assets');
    console.log('drawio-editor: copying draw.io assets (this may take a moment)...');
    fs.cpSync(drawioSrc, assetsDest, {
      recursive: true,
      filter: (srcPath) => {
        const rel = path.relative(drawioSrc, srcPath);
        // NOTE: do NOT skip math/jax/ — drawio's App.main() blocks on
        // loading math/jax/output/SVG/fonts/TeX/fontdata.js before posting
        // its `init` message. Skipping the subtree produces a 404 that
        // prevents the bridge from ever seeing `init`. The earlier EPERM
        // errors were a Windows file-locking flake, not a permanent issue.
        return shouldCopyDrawioAsset(rel);
      },
    });
    const drawioIndex = path.join(assetsDest, 'index.html');
    fs.writeFileSync(
      drawioIndex,
      configureDrawioOfflineViewer(fs.readFileSync(drawioIndex, 'utf8')),
      'utf8'
    );
    const preConfigPath = path.join(assetsDest, 'js', 'PreConfig.js');
    fs.writeFileSync(
      preConfigPath,
      configureDrawioPreConfig(fs.readFileSync(preConfigPath, 'utf8')),
      'utf8'
    );
    return;
  }

  if (id === 'heic-viewer') {
    // libheif-js (HEIC/HEIF → RGBA) is an emscripten module. fetch on
    // whale-extension:// is unreliable, so the extension requests the wasm
    // bytes via the host IPC bridge and feeds them to emscripten as
    // `wasmBinary` (see src/extensions/heic-viewer/index.ts getLibheif).
    // Copy the wasm next to the bundle; it must NOT be bundled.
    const destDir = path.join(DIST_EXTENSIONS, id);
    if (!fs.existsSync(destDir)) return;
    const wasmSrc = path.join(
      ROOT,
      'node_modules',
      'libheif-js',
      'libheif-wasm',
      'libheif.wasm'
    );
    if (fs.existsSync(wasmSrc)) {
      fs.copyFileSync(wasmSrc, path.join(destDir, 'libheif.wasm'));
    } else {
      console.warn(`heic-viewer: libheif wasm not found at ${wasmSrc}`);
    }
    return;
  }
}

function main() {
  console.log('Building Whale extensions...');

  cleanDir(DIST_EXTENSIONS);
  ensureDir(SHARED_API_DEST_DIR);
  fs.copyFileSync(
    SHARED_API_SOURCE,
    path.join(SHARED_API_DEST_DIR, 'extension-api.js')
  );

  const extensions = discoverExtensions();
  if (extensions.length === 0) {
    console.log('No extensions found in', SRC_EXTENSIONS);
    fs.writeFileSync(
      path.join(DIST_EXTENSIONS, 'registry.json'),
      JSON.stringify({ extensions: [], generatedAt: new Date().toISOString() }, null, 2)
    );
    return;
  }

  // Fail before webpack if a viewer lacks a policy entry: the alternative is a
  // shipped HTML file with an unresolved `__WHALE_CSP__` attribute (CSP would
  // then be dropped entirely by Chromium, silently un-protecting the iframe).
  const cspPolicy = loadCspPolicy();
  const missingCsp = extensions
    .map((entry) => entry.id)
    .filter((id) => !Object.prototype.hasOwnProperty.call(cspPolicy.extensions, id));
  if (missingCsp.length > 0) {
    throw new Error(
      `CSP policy: missing entries for ${missingCsp.join(', ')} in ${CSP_POLICY_FILE}`
    );
  }

  for (const { id } of extensions) {
    copyExtensionStaticFiles(id);
    // Symlink/copy shared api into each extension folder so relative ./extension-api.js works.
    fs.copyFileSync(
      path.join(SHARED_API_DEST_DIR, 'extension-api.js'),
      path.join(DIST_EXTENSIONS, id, 'extension-api.js')
    );
  }

  // Run webpack for bundled TypeScript entries.
  const webpackConfig = path.join(ROOT, '.erb', 'configs', 'webpack.config.extensions.ts');
  try {
    execSync(
      // The config path is quoted: a checkout under a directory with spaces
      // ("C:\My Projects\WhaleTag") would otherwise split into two arguments.
      `npx cross-env NODE_ENV=production TS_NODE_TRANSPILE_ONLY=true webpack --config "${webpackConfig}"`,
      { cwd: ROOT, stdio: 'inherit' }
    );
  } catch {
    // Throw (instead of process.exit) so the --watch loop can report the
    // failure and keep watching for the next edit; the caller below exits 1.
    throw new Error('Webpack build for extensions failed');
  }

  // After webpack, inject manifest into each extension's extension-api.js,
  // synthesize the shared CSP into the built HTML, and fix HtmlWebpackPlugin's
  // asset paths (it mis-computes relative paths when output.filename includes
  // the entry name as a directory segment).
  // Emit the per-extension header policies next to the built folders: the
  // whale-extension:// protocol handler serves them as a real CSP header
  // (frame-ancestors only has an effect when it is not meta-delivered).
  writeCspManifest(cspPolicy);

  for (const { id, manifest } of extensions) {
    injectManifestIntoApi(id, manifest);
    injectCspIntoHtml(id, cspPolicy);
    fixHtmlAssetPaths(id);
    copyExtensionRuntimeAssets(id);
  }

  const registry = {
    extensions: extensions.map((e) => e.manifest),
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(DIST_EXTENSIONS, 'registry.json'),
    JSON.stringify(registry, null, 2)
  );

  console.log(`Built ${extensions.length} extension(s) to ${DIST_EXTENSIONS}`);
}

/**
 * Rebuild on source changes (`npm run watch:extensions`). The script used to
 * accept the flag and silently ignore it, so devs watched a stale dist.
 * Debounced because one save produces several events.
 */
function watchSources() {
  let timer = null;
  const rebuild = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        main();
      } catch (error) {
        // Keep the watcher alive: a transient syntax error is exactly what the
        // loop is for.
        console.error(
          '[extensions] rebuild failed:',
          error instanceof Error ? error.message : error
        );
      }
    }, 400);
    timer.unref?.();
  };

  try {
    fs.watch(SRC_EXTENSIONS, { recursive: true }, (_event, name) => {
      if (!name) return;
      const rel = String(name);
      if (rel.includes('node_modules')) return;
      console.log(`[extensions] change: ${rel}`);
      rebuild();
    });
  } catch (error) {
    // recursive watch is unsupported on some platforms (older Linux); a single
    // build already ran, so warn instead of pretending to watch.
    console.warn(
      '[extensions] --watch is not supported on this platform:',
      error instanceof Error ? error.message : error
    );
    return;
  }
  console.log(`[extensions] watching ${SRC_EXTENSIONS} for changes...`);
}

module.exports = {
  replaceManifestPlaceholder,
  shouldCopyDrawioAsset,
  configureDrawioOfflineViewer,
  configureDrawioPreConfig,
  // Exported for scripts/csp-policy.test.ts: the synthesis is pure, so the
  // regression test can pin the baseline without running webpack.
  loadCspPolicy,
  buildCspForExtension,
  buildMetaCspForExtension,
  buildCspManifest,
  writeCspManifest,
  CSP_POLICY_FILE,
  CSP_MANIFEST_FILENAME,
  REQUIRED_CSP_DIRECTIVES,
  META_OMITTED_DIRECTIVES,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }

  if (process.argv.includes('--watch')) watchSources();
}
