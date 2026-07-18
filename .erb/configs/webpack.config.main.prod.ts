import path from 'path';
import { merge } from 'webpack-merge';
import { createBase } from './webpack.config.base';
import { MAIN_DIST, SRC_PATH } from './webpack.paths';

/**
 * Production build for the Electron MAIN process (main.js + preload.js).
 */
export default merge(createBase(), {
  mode: 'production',
  devtool: false,
  target: 'electron-main',
  entry: {
    main: path.resolve(SRC_PATH, 'main', 'main.ts'),
    preload: path.resolve(SRC_PATH, 'main', 'preload.ts'),
    // P0-2: utilityProcess entry that owns <root>/.whale/index.db.
    // Externalized (better-sqlite3 / pdfjs-dist / sharp) just like main.js
    // so the worker can load native bindings from asar-unpacked.
    'index-worker': path.resolve(SRC_PATH, 'main', 'index-worker.ts'),
    // utilityProcess entry for the pure-JS CPU-heavy thumbnail renders
    // (pdf / ebook / font), off the main event loop (docs/06 §8). pdfjs-dist
    // / @napi-rs/canvas / sharp stay externalized just like index-worker.
    'thumb-worker': path.resolve(SRC_PATH, 'main', 'thumb-worker.ts'),
  },
  output: {
    path: MAIN_DIST,
    filename: '[name].js',
    library: { type: 'commonjs2' },
  },
  node: {
    __dirname: false,
    __filename: false,
  },
  externals: [
    {
      electron: 'commonjs electron',
      // Defensive guard only: the Agent SDK is never statically imported in the
      // main bundle — it's loaded at runtime via loadClaudeSdk() (component-resolver),
      // which uses eval('require') + createRequire so webpack never sees it. Keeping
      // this external ensures any future stray static import stays externalized
      // rather than bundling a Node-only package into main.js.
      '@anthropic-ai/claude-agent-sdk':
        'commonjs @anthropic-ai/claude-agent-sdk',
      'pdfjs-dist': 'commonjs pdfjs-dist',
      sharp: 'commonjs sharp',
      'better-sqlite3': 'commonjs better-sqlite3',
      'ffmpeg-static': 'commonjs ffmpeg-static',
      // 7zip-bin computes its binary path via `path.join(__dirname, platform, ...)`.
      // If bundled, __dirname becomes main.js's dir and the path is wrong →
      // existsSync fails and sevenZipBinary() falsely reports "missing".
      // Externalize so __dirname resolves to the real module dir (asar-unpacked).
      '7zip-bin': 'commonjs 7zip-bin',
      '@napi-rs/canvas': 'commonjs @napi-rs/canvas',
      '@napi-rs/canvas-win32-x64-msvc': 'commonjs @napi-rs/canvas-win32-x64-msvc',
      // P2-7: lazy-loaded via createRequire in lazy-native.ts (getExifr /
      // getChardet / getIconv). Externalized so the runtime require resolves
      // them as separate modules (not inlined), matching sharp / canvas / pdfjs.
      exifr: 'commonjs exifr',
      jschardet: 'commonjs jschardet',
      'iconv-lite': 'commonjs iconv-lite',
    },
    // pdfjs-dist subpaths (e.g. pdfjs-dist/legacy/build/pdf.mjs) must also be
    // external. Object-form externals only match the bare name 'pdfjs-dist', so
    // subpath imports get bundled — and webpack then hard-codes the .mjs's
    // import.meta.url to the build machine's absolute path
    // (file:///C:/Whale/node_modules/pdfjs-dist/...). On any other machine that
    // path is gone, so pdfjs's createRequire(import.meta.url) can't resolve
    // @napi-rs/canvas, the DOMMatrix/ImageData polyfill silently fails, and the
    // main process crashes at startup: "ReferenceError: DOMMatrix is not defined".
    ({ request }, callback) => {
      if (request && /^pdfjs-dist(\/|$)/.test(request)) {
        return callback(null, `commonjs ${request}`);
      }
      callback();
    },
  ],
  optimization: {
    minimize: true,
  },
});
