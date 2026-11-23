import { merge } from 'webpack-merge';
import production from './webpack.config.mobile.prod';

/** No dev server: the Electron main process remains the single HTTP origin. */
export default merge(production, {
  mode: 'development',
  devtool: 'source-map',
  optimization: { minimize: false },
  output: { clean: false },
});
