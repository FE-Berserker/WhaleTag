import path from 'path';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import { merge } from 'webpack-merge';
import { createBase } from './webpack.config.base';
import { MOBILE_DIST, MOBILE_SRC } from './webpack.paths';

/** Standalone browser build for the opt-in read-only LAN interface. */
export default merge(createBase({ esnext: true }), {
  mode: 'production',
  devtool: false,
  target: 'web',
  entry: { main: path.resolve(MOBILE_SRC, 'main.tsx') },
  output: {
    path: MOBILE_DIST,
    filename: '[name].[contenthash].js',
    publicPath: '/',
    clean: true,
  },
  resolve: { fallback: { fs: false, path: false } },
  module: {
    rules: [
      { test: /\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader'] },
    ],
  },
  plugins: [
    new MiniCssExtractPlugin({ filename: '[name].[contenthash].css' }),
    new HtmlWebpackPlugin({
      template: path.resolve(MOBILE_SRC, 'index.html'),
      filename: 'index.html',
      chunks: ['main'],
      minify: { removeComments: true, collapseWhitespace: true },
    }),
  ],
  optimization: { minimize: true, splitChunks: { chunks: 'all' } },
});
