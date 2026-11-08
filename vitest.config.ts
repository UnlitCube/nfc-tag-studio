import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Pure-logic unit tests only. They exercise src/shared (NDEF, ID schema, tag maps,
// APDU builders) with no Electron, no reader hardware, no DOM.
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
