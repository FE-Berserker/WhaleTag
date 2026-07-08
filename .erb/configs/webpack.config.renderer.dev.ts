import path from 'path';
import { merge } from 'webpack-merge';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import base from './webpack.config.base';
import { RENDERER_SRC, DEV_SERVER_PORT, ROOT_PATH } from './webpack.paths';

/**
 * Dev build for the RENDERER process.
 * Served by webpack-dev-server on http://localhost:<DEV_SERVER_PORT>;
 * main.ts loads that URL when NODE_ENV === 'development'.
 */
export default merge(base, {
  mode: 'development',
  devtool: 'inline-source-map',
  target: 'web',
  entry: {
    main: path.resolve(RENDERER_SRC, 'index.tsx'),
  },
  output: {
    filename: '[name].js',
    publicPath: '/',
  },
  resolve: {
    fallback: {
      fs: false,
      path: false,
    },
  },
  module: {
    rules: [
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: path.resolve(RENDERER_SRC, 'index.html'),
      filename: 'index.html',
      chunks: ['main'],
      favicon: path.resolve(ROOT_PATH, 'resources', 'icon.ico'),
      templateParameters: () => ({
        // Dev CSP must allow webpack HMR (unsafe-eval + localhost WS).
        csp: [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' whale-extension://*",
          "style-src 'self' 'unsafe-inline' whale-extension://*",
          "img-src 'self' data: blob: https: http: whale-extension://*",
          "media-src 'self' blob: whale-extension://*",
          "font-src 'self' data: whale-extension://*",
          "frame-src 'self' whale-extension://*",
          "connect-src 'self' http://localhost:4002 ws://localhost:4002",
        ].join('; '),
      }),
    }),
  ],
  devServer: {
    port: DEV_SERVER_PORT,
    hot: true,
    compress: true,
    client: {
      overlay: {
        errors: true,
        warnings: false,
        // "ResizeObserver loop completed with undelivered notifications" is a
        // benign notice fired by MUI / react-window resize observers; the spec
        // says it's safe to ignore, but the dev overlay surfaces it as a fatal
        // runtime error. Suppress just this one; everything else still shows.
        runtimeErrors: (error?: Error) =>
          !/ResizeObserver loop/.test(error?.message ?? ''),
      },
    },
  },
});
