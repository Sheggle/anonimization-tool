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
      // Handle tesseract-core WASM.js file - inline the WASM binary
      if (id.includes('tesseract.js-core') && id.endsWith('.wasm.js')) {
        const cacheKey = id;
        if (!cache.has(cacheKey)) {
          console.log('Inlining Tesseract core:', id);
          let code = fs.readFileSync(id, 'utf-8');

          // The .wasm.js file contains the WASM as a base64 string already
          // But it may reference external files, let's check and handle
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
    emptyOutDir: true,
    target: 'esnext',
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 100000,
    minify: 'esbuild',
    rollupOptions: {
      external: ['html2canvas'],
      output: {
        inlineDynamicImports: true,
        manualChunks: undefined,
      },
    },
  },
});
