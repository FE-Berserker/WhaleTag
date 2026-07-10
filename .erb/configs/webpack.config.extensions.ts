import path from 'path';
import fs from 'fs';
import { merge } from 'webpack-merge';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import { createBase } from './webpack.config.base';
import { EXTENSIONS_SRC, EXTENSIONS_DIST, ROOT_PATH } from './webpack.paths';

function discoverExtensions(): {
  manifests: Record<string, Record<string, unknown>>;
  entries: Record<string, string>;
  htmlPlugins: HtmlWebpackPlugin[];
} {
  const manifests: Record<string, Record<string, unknown>> = {};
  const entries: Record<string, string> = {};
  const htmlPlugins: HtmlWebpackPlugin[] = [];

  if (!fs.existsSync(EXTENSIONS_SRC)) {
    return { manifests, entries, htmlPlugins };
  }

  const ids = fs
    .readdirSync(EXTENSIONS_SRC, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'shared')
    .map((d) => d.name)
    .sort();

  for (const id of ids) {
    const manifestPath = path.join(EXTENSIONS_SRC, id, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    manifests[id] = manifest;

    const entryHtml = String(manifest.entryPoint ?? 'index.html');
    const entryName = entryHtml.replace(/\.html?$/i, '');
    const entryTs = path.join(EXTENSIONS_SRC, id, `${entryName}.ts`);

    if (fs.existsSync(entryTs)) {
      entries[id] = entryTs;
    }

    htmlPlugins.push(
      new HtmlWebpackPlugin({
        template: path.join(EXTENSIONS_SRC, id, entryHtml),
        filename: `${id}/${entryHtml}`,
        chunks: fs.existsSync(entryTs) ? [id] : [],
        inject: 'head',
        minify: false, // Keep CSP meta and extension-api script tag intact.
      })
    );
  }

  return { manifests, entries, htmlPlugins };
}

const { manifests, entries, htmlPlugins } = discoverExtensions();

// Persist the discovered manifest list so build-extensions.js can write registry.json
// without re-scanning. We write to a temp JSON next to the webpack config.
const manifestDumpPath = path.join(__dirname, '.extension-manifests.json');
fs.writeFileSync(manifestDumpPath, JSON.stringify(manifests, null, 2));

export { manifests };

export default merge(createBase(), {
  mode: 'production',
  devtool: false,
  target: 'web',
  entry: entries,
  output: {
    path: EXTENSIONS_DIST,
    filename: '[name]/bundle.js',
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
    // Inline dynamic imports into each extension's single bundle. Self-contained
    // iframe extensions gain nothing from code-splitting, and eager mode avoids
    // async chunks landing outside the per-extension output folder (e.g.
    // Excalidraw's `import('./subset-worker.chunk.js')`).
    parser: {
      javascript: { dynamicImportMode: 'eager' },
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
      filename: '[name]/styles.css',
    }),
    ...htmlPlugins,
  ],
  optimization: {
    minimize: true,
    splitChunks: false, // Each extension is self-contained; no shared runtime.
  },
});
