import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pure-logic + main-logic unit tests. They exercise src/shared and the main-side
// logic (NFC service against the simulator, issue engine) with no reader hardware.
const here = fileURLToPath(new URL('.', import.meta.url));

// Windows の罠: vitest の CLI が小文字のドライブ文字のパス（`c:\…`）で起動されると、
// ワーカーとテストファイルが別々の vitest を読み込み、全テストが `describe()` で
// "Cannot read properties of undefined (reading 'config')" になる。
// `npm run unit`（scripts/run-vitest.cjs）は本当の表記で起動し直すので落ちない。
// 直接 `npx vitest` を小文字の cwd から叩いたときだけ、原因の分かる文で止める。
const cliPath = process.argv[1] ?? '';
if (process.platform === 'win32' && /^[a-z]:[\\/]/.test(cliPath)) {
  throw new Error(
    `vitest が小文字のドライブ文字のパスで起動されました（${cliPath}）。` +
      'このままだと全テストが "reading \'config\'" で落ちます。' +
      '`npm run unit`（scripts/run-vitest.cjs）で起動してください。',
  );
}

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(here, 'src/shared') },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
