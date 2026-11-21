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
 * Copies an extension's runtime assets pulled from node_modules. Excalidraw loads
 * its fonts at runtime from window.EXCALIDRAW_ASSET_PATH (set to this extension's
 * served root in index.ts), so the package's fonts must sit next to the bundle.
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
      `npx cross-env NODE_ENV=production TS_NODE_TRANSPILE_ONLY=true webpack --config ${webpackConfig}`,
      { cwd: ROOT, stdio: 'inherit' }
    );
  } catch {
    // Throw (instead of process.exit) so the --watch loop can report the
    // failure and keep watching for the next edit; the caller below exits 1.
    throw new Error('Webpack build for extensions failed');
  }

  // After webpack, inject manifest into each extension's extension-api.js
  // and fix HtmlWebpackPlugin's asset paths (it mis-computes relative paths
  // when output.filename includes the entry name as a directory segment).
  for (const { id, manifest } of extensions) {
    injectManifestIntoApi(id, manifest);
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
