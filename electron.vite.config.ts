import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Shared pure-TS modules live in src/shared and are imported by main, preload and
// renderer. They must stay free of Node and DOM APIs (see src/shared/README note).
const shared = resolve(__dirname, 'src/shared');

export default defineConfig({
  main: {
    build: {
      minify: true,
      sourcemap: false,
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
        // koffi is a native addon resolved at runtime; never bundle it.
        external: ['koffi'],
      },
    },
    resolve: { alias: { '@shared': shared } },
  },
  preload: {
    build: {
      minify: true,
      sourcemap: false,
      rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') },
    },
    resolve: { alias: { '@shared': shared } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      minify: true,
      sourcemap: false,
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
    resolve: {
      alias: {
        '@shared': shared,
        '@': resolve(__dirname, 'src/renderer/src'),
      },
    },
    plugins: [react()],
  },
});
