import path from 'path';
import { merge } from 'webpack-merge';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import base from './webpack.config.base';
import { RENDERER_DIST, RENDERER_SRC, ROOT_PATH } from './webpack.paths';

/**
 * Production build for the RENDERER process.
 * Output is loaded via file:// in the packaged app, so publicPath is relative ('./').
 */
export default merge(base, {
  mode: 'production',
  devtool: false,
  target: 'web',
  entry: {
    main: path.resolve(RENDERER_SRC, 'index.tsx'),
  },
  output: {
    path: RENDERER_DIST,
    filename: '[name].[contenthash].js',
    publicPath: './',
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
        use: [MiniCssExtractPlugin.loader, 'css-loader'],
      },
    ],
  },
  plugins: [
    new MiniCssExtractPlugin({
      filename: '[name].[contenthash].css',
    }),
    new HtmlWebpackPlugin({
      template: path.resolve(RENDERER_SRC, 'index.html'),
      filename: 'index.html',
      chunks: ['main'],
      favicon: path.resolve(ROOT_PATH, 'resources', 'icon.ico'),
      minify: {
        removeComments: true,
        collapseWhitespace: true,
      },
      templateParameters: () => ({
        // Production CSP: no 'unsafe-eval', no remote connect, strict script-src.
        csp: [
          "default-src 'self'",
          "script-src 'self' whale-extension://*",
          "style-src 'self' 'unsafe-inline' whale-extension://*",
          "img-src 'self' data: blob: https: http: whale-extension://*",
          "media-src 'self' blob: whale-extension://*",
          "font-src 'self' data: whale-extension://*",
          "frame-src 'self' whale-extension://*",
          "connect-src 'self'",
        ].join('; '),
      }),
    }),
  ],
  optimization: {
    minimize: true,
    splitChunks: {
      chunks: 'all',
    },
  },
});
