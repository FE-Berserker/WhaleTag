import path from 'path';
import TsconfigPathsPlugin from 'tsconfig-paths-webpack-plugin';
import { ROOT_PATH } from './webpack.paths';

export interface BaseOptions {
  /** Emit ESM (`module: 'esnext'`) from ts-loader so webpack sees dynamic
   *  `import()` as a split point and can code-split + tree-shake. Enable ONLY
   *  for the renderer (React.lazy views).
   *
   *  The MAIN process must NOT enable this: under ESM, webpack's node-plugin
   *  recognises the `createRequire` binding imported from `'module'` and stubs
   *  `createRequire(__filename)` to `undefined` (it can't resolve the path at
   *  build time), which crashes `fulltext.ts` / `thumbnail.ts` at load with
   *  `Cannot read properties of undefined (reading 'resolve')`. Under CommonJS
   *  the import is a plain `require('module')` and createRequire is left alone. */
  esnext?: boolean;
}

/**
 * Shared resolution + TS transpilation rules. Pass `{ esnext: true }` for the
 * renderer (enables code-splitting); omit it for the main process + extensions.
 * Path alias `-` is resolved from tsconfig.json (`-/*` -> src/renderer/*).
 */
export function createBase(opts: BaseOptions = {}) {
  return {
    resolve: {
      extensions: ['.js', '.jsx', '.json', '.ts', '.tsx'],
      plugins: [
        new TsconfigPathsPlugin({
          configFile: path.resolve(ROOT_PATH, 'tsconfig.json'),
        }),
      ],
      // Force every `import ... from 'echarts'` (no path) to resolve to the
      // lean ESM `echarts/core` instead of the full UMD distribution. echarts
      // marks its own `index.js` as side-effecting in its package.json
      // (`sideEffects: ['index.js', ...]`), so without this alias webpack
      // would refuse to tree-shake the giant bundle and we'd ship every
      // chart + every component + every renderer + every theme regardless
      // of what the call sites actually use.
      //
      // The `$` suffix is webpack's "exact match" — `import 'echarts/core'`
      // and `import 'echarts/charts'` keep their original targets, only the
      // bare `'echarts'` specifier is rewritten. This affects
      // `echarts-for-react` and `echarts-wordcloud` (both do `import * as
      // echarts from 'echarts'` as a defensive fallback) without disturbing
      // our explicit on-demand imports in `services/echarts-setup.ts`.
      alias: {
        echarts$: 'echarts/core',
      },
    },
    module: {
      rules: [
        {
          // ESM packages (e.g. @mui/material/internal/*.mjs) deep-import
          // siblings like `react-transition-group/TransitionGroupContext`
          // without an extension. Webpack applies `fullySpecified: true` to
          // `.mjs` by default, which breaks those imports. Relax it for all
          // JS/MJS so CommonJS-style deep imports resolve (MUI interop fix;
          // only meaningful under the renderer's ESM `module: 'esnext'`).
          test: /\.m?js$/,
          resolve: { fullySpecified: false },
        },
        {
          test: /\.tsx?$/,
          exclude: /node_modules/,
          use: {
            loader: 'ts-loader',
            options: {
              transpileOnly: true,
              ...(opts.esnext
                ? { compilerOptions: { module: 'esnext' } }
                : {}),
            },
          },
        },
        {
          test: /\.(png|jpg|jpeg|gif|svg)$/i,
          type: 'asset/resource',
        },
      ],
    },
  };
}
