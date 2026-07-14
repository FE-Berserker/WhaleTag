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

function injectManifestIntoApi(id, manifest) {
  const apiPath = path.join(DIST_EXTENSIONS, id, 'extension-api.js');
  if (!fs.existsSync(apiPath)) return;

  let content = fs.readFileSync(apiPath, 'utf8');
  content = content.replace(
    '/* MANIFEST_INJECTED_BY_BUILD */ {}',
    JSON.stringify(manifest)
  );
  fs.writeFileSync(apiPath, content, 'utf8');
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
        // Skip Maven metadata and Electron desktop files that are not needed
        // for the iframe-based webapp.
        const rel = path.relative(drawioSrc, srcPath);
        if (rel === 'META-INF') return false;
        if (rel === 'electron.js' || rel === 'electronFilesWorker.js') return false;
        if (rel.startsWith('open.html')) return false;
        // NOTE: do NOT skip math/jax/ — drawio's App.main() blocks on
        // loading math/jax/output/SVG/fonts/TeX/fontdata.js before posting
        // its `init` message. Skipping the subtree produces a 404 that
        // prevents the bridge from ever seeing `init`. The earlier EPERM
        // errors were a Windows file-locking flake, not a permanent issue.
        return true;
      },
    });
    return;
  }

  if (id === 'md-editor') {
    // Mermaid v11 is loaded by a separate sandbox iframe (see
    // src/extensions/md-editor/mermaid-sandbox.html). The IIFE
    // bundle is the simplest form that works inside a sandboxed
    // iframe (no ESM module loader needed). Must be COPIED, not
    // bundled, because the sandbox loads it via a static <script
    // src="./mermaid.min.js">. Without this, the sandbox's
    // <script src> would 404 and every render would fail.
    const destDir = path.join(DIST_EXTENSIONS, id);
    if (!fs.existsSync(destDir)) return;
    const mermaidSrc = path.join(
      ROOT,
      'node_modules',
      'mermaid',
      'dist',
      'mermaid.min.js'
    );
    if (!fs.existsSync(mermaidSrc)) {
      console.warn(`md-editor: mermaid.min.js not found at ${mermaidSrc}`);
      return;
    }
    const mermaidDest = path.join(destDir, 'mermaid.min.js');
    fs.copyFileSync(mermaidSrc, mermaidDest);
    // mermaid 11.16's IIFE wrapper is broken upstream: line 1 declares
    // `var __esbuild_esm_mermaid_nm;` (undefined), then writes the
    // module export via `(__esbuild_esm_mermaid_nm || {}).mermaid = ...`,
    // which falls through to a throwaway `{}` because the var is falsy.
    // The final line then tries to read
    // `globalThis.__esbuild_esm_mermaid_nm.mermaid.default` and throws
    // `Cannot read properties of undefined (reading 'mermaid')`, so
    // `window.mermaid` is never assigned and every render in the
    // sandbox hangs/times out.
    //
    // We can't fix it upstream — patch in-place after copy. Replace
    // the broken `var __esbuild_esm_mermaid_nm;` with a declaration
    // that ALSO publishes the namespace to globalThis, so the final
    // `globalThis.__esbuild_esm_mermaid_nm["mermaid"].default` line
    // can find the export. See docs/09 §18.3.3 (mermaid fix).
    const MERMAID_BROKEN_PREFIX = 'var __esbuild_esm_mermaid_nm;';
    const MERMAID_PATCHED_PREFIX =
      'var __esbuild_esm_mermaid_nm = globalThis.__esbuild_esm_mermaid_nm = {};';
    const mermaidRaw = fs.readFileSync(mermaidDest, 'utf8');
    if (!mermaidRaw.includes(MERMAID_BROKEN_PREFIX)) {
      console.warn(
        'md-editor: mermaid.min.js IIFE prefix not found — upstream ' +
          'may have been fixed; skipping patch. Re-verify the sandbox ' +
          'still loads mermaid.'
      );
    } else {
      const mermaidFixed = mermaidRaw.replace(
        MERMAID_BROKEN_PREFIX,
        MERMAID_PATCHED_PREFIX
      );
      fs.writeFileSync(mermaidDest, mermaidFixed, 'utf8');
      console.log('md-editor: patched mermaid.min.js IIFE wrapper');
    }

    // §18.3.3 — KaTeX math rendering. The sandbox iframe loads
    // `katex.min.js` via static `<script src>` and the main iframe
    // loads `katex.min.css` via `<link rel="stylesheet">`. KaTeX is
    // pure JS (no `new Function` / `eval`), so unlike mermaid's
    // IIFE it doesn't need the upstream-prefix patch. We just copy
    // the two files verbatim — the sandbox's CSP allows loading
    // them same-origin, and the main iframe's CSP allows the
    // stylesheet from `whale-extension://md-editor/`.
    const katexDist = path.join(ROOT, 'node_modules', 'katex', 'dist');
    const katexJs = path.join(katexDist, 'katex.min.js');
    const katexCss = path.join(katexDist, 'katex.min.css');
    if (fs.existsSync(katexJs)) {
      fs.copyFileSync(katexJs, path.join(destDir, 'katex.min.js'));
    } else {
      console.warn(`md-editor: katex.min.js not found at ${katexJs}`);
    }
    if (fs.existsSync(katexCss)) {
      fs.copyFileSync(katexCss, path.join(destDir, 'katex.min.css'));
    } else {
      console.warn(`md-editor: katex.min.css not found at ${katexCss}`);
    }
    // KaTeX's CSS references `fonts/KaTeX_*.woff2|.woff|.ttf` (60 files) relative
    // to katex.min.css — copy the whole fonts/ dir so rendered math uses the
    // proper Main/Math/Size/Caligraphic fonts. Without it the formulas render in
    // a fallback font (wrong glyphs, no math italic). Same-origin under the main
    // iframe's `default-src 'self'`, so no CSP change is needed.
    const katexFontsSrc = path.join(katexDist, 'fonts');
    if (fs.existsSync(katexFontsSrc)) {
      fs.cpSync(katexFontsSrc, path.join(destDir, 'fonts'), { recursive: true });
    } else {
      console.warn(`md-editor: katex fonts/ not found at ${katexFontsSrc}`);
    }
    return;
  }

  if (id === 'cad-viewer') {
    // occt-import-js (STEP/IGES/BREP → mesh) is an emscripten module: its JS
    // fetches `occt-import-js.wasm` at runtime from the extension's own dist
    // folder (whale-extension://cad-viewer/occt-import-js.wasm, enabled by
    // the supportFetchAPI privilege). Copy the wasm next to the bundle so it
    // resolves; it must NOT be bundled (keeps bundle.js small).
    const destDir = path.join(DIST_EXTENSIONS, id);
    if (!fs.existsSync(destDir)) return;
    const wasmSrc = path.join(
      ROOT,
      'node_modules',
      'occt-import-js',
      'dist',
      'occt-import-js.wasm'
    );
    if (fs.existsSync(wasmSrc)) {
      fs.copyFileSync(wasmSrc, path.join(destDir, 'occt-import-js.wasm'));
    } else {
      console.warn(`cad-viewer: occt wasm not found at ${wasmSrc}`);
    }
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
  } catch (e) {
    console.error('Webpack build for extensions failed');
    process.exit(1);
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

main();
