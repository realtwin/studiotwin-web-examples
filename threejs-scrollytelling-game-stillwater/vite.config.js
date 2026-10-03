import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: { input: { main: resolve(__dirname, 'index.html'), journal: resolve(__dirname, 'journal.html'), treelab: resolve(__dirname, 'treelab.html') } },
  },
  resolve: { alias: [{ find: /^three$/, replacement: 'three/webgpu' }] },
  esbuild: { target: 'es2022' },
});
