const path = require('path');
const { rspack } = require('@rspack/core');
const { patchPdfWorker } = require('./scripts/pdfjs-worker-patch.cjs');

module.exports = {
  mode: 'development',
  devtool: 'cheap-module-source-map',
  entry: {
    background: './src/background.ts',
    popup: './src/ui/popup.ts',
    pdfViewer: './src/ui/pdfViewer.ts',
    pdfHub: './src/ui/pdfHub.ts',
    pdfUpkeep: './src/ui/pdfUpkeep.ts',
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
        // ONNX Runtime refers to its wasm with `new URL(…, import.meta.url)`;
        // the copies under ort/ are what it loads (wasmPaths), so the bundler
        // must not emit a second, hashed copy.
        test: /node_modules[\\/]onnxruntime-web[\\/]/,
        parser: { url: false },
      },
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
        { from: 'src/ui/pdf-hub.html', to: '.' },
        { from: 'src/ui/pdfHub.css', to: '.' },
        { from: 'src/ui/pdf-upkeep.html', to: '.' },
        { from: 'src/ui/tokens.css', to: '.' },
        { from: 'src/icons', to: 'icons' },
        // PDF.js runtime assets. The worker runs as a module Worker from the
        // extension origin; CMaps/fonts/wasm/ICC are fetched lazily by PDF.js
        // only for documents that need them. The worker is the readable build,
        // patched to report per-character positions (scripts/pdfjs-worker-patch.cjs).
        {
          from: 'node_modules/pdfjs-dist/build/pdf.worker.mjs',
          to: 'pdfjs/pdf.worker.mjs',
          transform: (content) => patchPdfWorker(content.toString('utf8')),
        },
        { from: 'node_modules/pdfjs-dist/web/pdf_viewer.css', to: 'pdfjs/pdf_viewer.css' },
        { from: 'node_modules/pdfjs-dist/web/images', to: 'pdfjs/images' },
        { from: 'node_modules/pdfjs-dist/cmaps', to: 'pdfjs/cmaps' },
        { from: 'node_modules/pdfjs-dist/standard_fonts', to: 'pdfjs/standard_fonts' },
        { from: 'node_modules/pdfjs-dist/wasm', to: 'pdfjs/wasm' },
        { from: 'node_modules/pdfjs-dist/iccs', to: 'pdfjs/iccs' },
        // Figure auto-detect: the layout model and ONNX Runtime's wasm, both
        // loaded only when auto-detect first runs (src/ui/pdfViewer/layoutModel.ts).
        { from: 'assets/models', to: 'models' },
        { from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', to: 'ort/ort-wasm-simd-threaded.wasm' },
        { from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', to: 'ort/ort-wasm-simd-threaded.mjs' },
      ],
    }),
  ],
};
