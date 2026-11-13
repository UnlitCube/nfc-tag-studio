// README・Wiki・Pages の画面のキャプチャ（npm run shots）。tests/shots の 1 本だけを流す。
// E2E と同じく仮想リーダーだけを使う（tests/e2e/launch.ts）。書き出し先は docs/images。
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/shots',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: path.join(os.tmpdir(), 'nfcts-shots-results'),
  use: { actionTimeout: 15_000 },
});
