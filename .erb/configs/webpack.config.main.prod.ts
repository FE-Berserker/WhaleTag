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
      // The Claude Agent SDK is a Node-only package that spawns the Claude Code
      // CLI as a subprocess; it must not be bundled into main.js. Mirrors the
      // sharp / better-sqlite3 pattern above.
      '@anthropic-ai/claude-agent-sdk':
        'commonjs @anthropic-ai/claude-agent-sdk',
      // The Claude Code CLI binary itself — bundled (asarUnpack'd) so users
      // don't need to install it separately. Must not be webpack-bundled.
      '@anthropic-ai/claude-code': 'commonjs @anthropic-ai/claude-code',
      'pdfjs-dist': 'commonjs pdfjs-dist',
      sharp: 'commonjs sharp',
      'better-sqlite3': 'commonjs better-sqlite3',
      'ffmpeg-static': 'commonjs ffmpeg-static',
      '@napi-rs/canvas': 'commonjs @napi-rs/canvas',
      '@napi-rs/canvas-win32-x64-msvc': 'commonjs @napi-rs/canvas-win32-x64-msvc',
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
