import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import fs from 'fs';

// Custom plugin to inline Tesseract.js resources
function inlineTesseractPlugin() {
  const cache = new Map();

  return {
    name: 'inline-tesseract',
    enforce: 'pre',

    async load(id) {
      if (id.includes('tesseract.js-core') && id.endsWith('.wasm.js')) {
        const cacheKey = id;
        if (!cache.has(cacheKey)) {
          console.log('Inlining Tesseract core:', id);
          let code = fs.readFileSync(id, 'utf-8');
          const wasmBinaryPath = id.replace('.wasm.js', '.wasm');
          if (fs.existsSync(wasmBinaryPath)) {
            const wasmBuffer = fs.readFileSync(wasmBinaryPath);
            console.log('Tesseract WASM size:', wasmBuffer.length, 'bytes');
          }
          cache.set(cacheKey, code);
        }
        return cache.get(cacheKey);
      }
    }
  };
}

export default defineConfig({
  root: 'src',
  plugins: [
    inlineTesseractPlugin(),
    viteSingleFile({
      removeViteModuleLoader: true,
    }),
  ],
  esbuild: {
    target: 'esnext',
  },
  optimizeDeps: {
    include: ['tesseract.js'],
    esbuildOptions: {
      target: 'esnext',
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: false, // Don't empty - we're building alongside main
    target: 'esnext',
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 100000,
    minify: 'esbuild',
    rollupOptions: {
      input: 'src/extract.html',
      external: ['html2canvas'],
      output: {
        inlineDynamicImports: true,
        manualChunks: undefined,
      },
    },
  },
});
