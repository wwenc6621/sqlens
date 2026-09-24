import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, '..', 'dist', 'webview'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'src', 'main.tsx'),
      output: {
        entryFileNames: 'index.js',
        assetFileNames: 'index[extname]',
        chunkFileNames: '[name].js',
      },
    },
    // Inline all assets to avoid CSP issues in VSCode webview
    assetsInlineLimit: 100_000,
    cssCodeSplit: false,
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
});
