import path from 'path';
import fs from 'fs';
import { merge } from 'webpack-merge';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import { createBase } from './webpack.config.base';
import { EXTENSIONS_SRC, EXTENSIONS_DIST } from './webpack.paths';

interface ExtensionBuild {
  id: string;
  manifest: Record<string, unknown>;
  entryHtml: string;
  entryTs: string | null;
}

function discoverExtensions(): ExtensionBuild[] {
  if (!fs.existsSync(EXTENSIONS_SRC)) return [];

  const ids = fs
    .readdirSync(EXTENSIONS_SRC, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'shared')
    .map((d) => d.name)
    .sort();
  const extensions: ExtensionBuild[] = [];

  for (const id of ids) {
    const manifestPath = path.join(EXTENSIONS_SRC, id, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const entryHtml = String(manifest.entryPoint ?? 'index.html');
    const entryName = entryHtml.replace(/\.html?$/i, '');
    const entryTs = path.join(EXTENSIONS_SRC, id, `${entryName}.ts`);
    extensions.push({
      id,
      manifest,
      entryHtml,
      entryTs: fs.existsSync(entryTs) ? entryTs : null,
    });
  }

  return extensions;
}

const extensions = discoverExtensions();
const manifests = Object.fromEntries(
  extensions.map(({ id, manifest }) => [id, manifest])
);

export { manifests };

// A separate compiler per extension is intentional: with a multi-entry compiler
// [runtime] collapses to "_" in the chunk-loading runtime, while removing it
// would emit every extension's chunks at the output root. Per-extension output
// plus a relative chunkFilename keeps both the emitted files and their runtime
// URLs under <extId>/chunks. splitChunks therefore cannot share across extensions.
export default extensions.map(({ id, entryHtml, entryTs }) =>
  merge(createBase(), {
    name: id,
    mode: 'production',
    devtool: false,
    target: 'web',
    entry: entryTs ? { [id]: entryTs } : {},
    output: {
      path: path.join(EXTENSIONS_DIST, id),
      filename: 'bundle.js',
      chunkFilename: 'chunks/[id].[contenthash].js',
      publicPath: '',
      clean: false, // Build script manages the output folder.
    },
    resolve: {
      fallback: {
        fs: false,
        path: false,
        os: false,
        crypto: false,
      },
    },
    module: {
      // Keep dynamic imports asynchronous so heavy editor-only dependencies do
      // not inflate the entry bundle. createBase() retains the extensions' safe
      // CommonJS TypeScript compilation.
      parser: {
        javascript: { dynamicImportMode: 'lazy' },
      },
      rules: [
        {
          // Excalidraw (and deps like roughjs) ship ESM that imports without file
          // extensions; webpack's strict ESM resolution rejects those unless we
          // relax fullySpecified for .js/.mjs.
          test: /\.m?js$/,
          resolve: { fullySpecified: false },
        },
        {
          test: /\.css$/,
          // url:false leaves CSS url(...) refs untouched so bundled package CSS
          // (e.g. Excalidraw's @font-face) resolves to files copied next to the
          // extension's styles.css at runtime, rather than needing a font loader.
          use: [
            MiniCssExtractPlugin.loader,
            { loader: 'css-loader', options: { url: false } },
          ],
        },
      ],
    },
    plugins: [
      new MiniCssExtractPlugin({
        filename: 'styles.css',
      }),
      new HtmlWebpackPlugin({
        template: path.join(EXTENSIONS_SRC, id, entryHtml),
        filename: entryHtml,
        chunks: entryTs ? [id] : [],
        inject: 'head',
        minify: false, // Keep CSP meta and extension-api script tag intact.
      }),
    ],
    optimization: {
      minimize: true,
      // Deduplicate modules shared by this extension's async chunks only.
      splitChunks: { chunks: 'async' },
    },
  })
);
