const path = require('path');
const { rspack } = require('@rspack/core');

module.exports = {
  mode: 'development',
  devtool: 'cheap-module-source-map',
  entry: {
    background: './src/background.ts',
    popup: './src/ui/popup.ts',
    pdfViewer: './src/ui/pdfViewer.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    chunkFilename: '[name].js',
    publicPath: '',
    clean: true,
  },
  optimization: { splitChunks: false },
  resolve: { extensions: ['.ts', '.js'] },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        // Transpile-only (SWC); types are enforced by `npm run typecheck`.
        use: {
          loader: 'builtin:swc-loader',
          options: { jsc: { parser: { syntax: 'typescript' }, target: 'es2020' } },
        },
      },
    ],
  },
  plugins: [
    new rspack.CopyRspackPlugin({
      patterns: [
        { from: 'manifest.json', to: '.' },
        { from: 'src/ui/popup.html', to: '.' },
        { from: 'src/ui/popup.css', to: '.' },
        { from: 'src/ui/pdf-viewer.html', to: '.' },
        { from: 'src/ui/pdfViewer.css', to: '.' },
        { from: 'src/ui/tokens.css', to: '.' },
        { from: 'src/icons', to: 'icons' },
        // PDF.js runtime assets. The worker runs as a module Worker from the
        // extension origin; CMaps/fonts/wasm/ICC are fetched lazily by PDF.js
        // only for documents that need them.
        { from: 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs', to: 'pdfjs/pdf.worker.mjs' },
        { from: 'node_modules/pdfjs-dist/web/pdf_viewer.css', to: 'pdfjs/pdf_viewer.css' },
        { from: 'node_modules/pdfjs-dist/web/images', to: 'pdfjs/images' },
        { from: 'node_modules/pdfjs-dist/cmaps', to: 'pdfjs/cmaps' },
        { from: 'node_modules/pdfjs-dist/standard_fonts', to: 'pdfjs/standard_fonts' },
        { from: 'node_modules/pdfjs-dist/wasm', to: 'pdfjs/wasm' },
        { from: 'node_modules/pdfjs-dist/iccs', to: 'pdfjs/iccs' },
      ],
    }),
  ],
};
