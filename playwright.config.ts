// E2E: the real app (out/, built by `npm run build`) driven by Playwright `_electron`
// against the virtual reader only (NFCTS_NO_PCSC=1 + tests/e2e/no-pcsc-guard.cjs).
// Run: npm run e2e   (= npm run build && playwright test)
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

// Results / traces live outside the repository (nothing to gitignore).
const OUT = process.env.NFCTS_E2E_OUT ?? path.join(os.tmpdir(), 'nfcts-e2e-results');

export default defineConfig({
  testDir: 'tests/e2e',
  // Both are needed: without testMatch Playwright would also pick up vitest's tests/**/*.test.ts.
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1, // one GUI app at a time (they share out/ and the virtual reader per process)
  retries: 0,
  forbidOnly: !!process.env.CI, // a forgotten .only must not shrink the gate to one test
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: OUT,
  use: {
    actionTimeout: 15_000,
  },
});
