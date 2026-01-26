import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import fs from 'fs';
import path from 'path';

// Custom plugin to inline WASM as base64
function inlineMuPdfPlugin() {
  const wasmBase64Cache = new Map();

  return {
    name: 'inline-mupdf',
    enforce: 'pre',

    resolveId(source) {
      // Ensure mupdf is bundled, not externalized
      if (source === 'mupdf') {
        return null; // Let Vite handle it normally
      }
    },

    async load(id) {
      // Handle mupdf-wasm.js to inline the WASM
      if (id.includes('node_modules/mupdf/dist/mupdf-wasm.js')) {
        const wasmPath = path.join(path.dirname(id), 'mupdf-wasm.wasm');

        if (!wasmBase64Cache.has(wasmPath)) {
          console.log('Reading WASM file:', wasmPath);
          const wasmBuffer = fs.readFileSync(wasmPath);
          wasmBase64Cache.set(wasmPath, wasmBuffer.toString('base64'));
          console.log('WASM size:', wasmBuffer.length, 'bytes');
        }

        const wasmBase64 = wasmBase64Cache.get(wasmPath);
        const originalCode = fs.readFileSync(id, 'utf-8');

        // Replace URL-based WASM loading with inline base64
        // The WASM is loaded via: new URL("mupdf-wasm.wasm",import.meta.url).href
        const modifiedCode = originalCode.replace(
          /new URL\("mupdf-wasm\.wasm",import\.meta\.url\)\.href/g,
          `(()=>{const b="${wasmBase64}";const u=Uint8Array.from(atob(b),c=>c.charCodeAt(0));return URL.createObjectURL(new Blob([u],{type:'application/wasm'}));})()`
        );

        return modifiedCode;
      }
    }
  };
}

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
    inlineMuPdfPlugin(),
    inlineTesseractPlugin(),
    viteSingleFile({
      removeViteModuleLoader: true,
    }),
  ],
  esbuild: {
    target: 'esnext',
  },
  optimizeDeps: {
    include: ['mupdf', 'tesseract.js'],
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
      output: {
        inlineDynamicImports: true,
        manualChunks: undefined,
      },
    },
  },
});
