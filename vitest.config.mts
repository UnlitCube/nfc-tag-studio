import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pure-logic + main-logic unit tests. They exercise src/shared and the main-side
// logic (NFC service against the simulator, issue engine) with no reader hardware.
const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(here, 'src/shared') },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
