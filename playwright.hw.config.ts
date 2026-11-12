// REAL-HARDWARE write test (tests/hw): writes to the tag on a real reader.
// Opt-in only - never part of `npm run e2e` / CI. See tests/hw/launch-hw.ts.
// Run: set NFCTS_HW_WRITE_UID=<UID of a sacrificial tag> && npm run hw:write
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/hw',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0, // a write test is never retried on its own
  forbidOnly: true,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  outputDir: process.env.NFCTS_HW_OUT ? path.join(process.env.NFCTS_HW_OUT, 'results') : path.join(os.tmpdir(), 'nfcts-hw-results'),
  use: { actionTimeout: 20_000 },
});
