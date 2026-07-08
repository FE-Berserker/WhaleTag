import path from 'path';
import TsconfigPathsPlugin from 'tsconfig-paths-webpack-plugin';
import { ROOT_PATH } from './webpack.paths';

/**
 * Shared resolution + TS transpilation rules, merged into every target config.
 * Path alias `-` is resolved from tsconfig.json (`-/*` -> src/renderer/*),
 * so imports like `-/components/Foo` work in renderer code.
 */
export default {
  resolve: {
    extensions: ['.js', '.jsx', '.json', '.ts', '.tsx'],
    plugins: [
      new TsconfigPathsPlugin({
        configFile: path.resolve(ROOT_PATH, 'tsconfig.json'),
      }),
    ],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'ts-loader',
          options: {
            transpileOnly: true,
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
