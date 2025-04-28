const path = require('path');
const ShebangPlugin = require('webpack-shebang-plugin');

/**
 * webpack配置
 * @param {Record<string, string>} env
 * @param {import('webpack').WebpackOptionsNormalized} argv
 * @returns {import('webpack').Configuration}
*/
module.exports = function(env, argv) {
  const isProd = argv.mode === 'production';

  const outputPath = path.resolve(__dirname, 'bin');

  return {
    entry: './src/index.js',
    devtool: isProd ? false : 'source-map',
    output: {
      filename: 'index.js',
      path: outputPath,
      clean: true,
    },
    target: 'node',
    plugins: [
      new ShebangPlugin(),
    ],
    resolve: {
      alias: {
        '@hap-toolkit': path.resolve(__dirname, 'hap-toolkit'),
      },
    },
  }
}
