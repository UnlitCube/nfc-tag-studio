#!/usr/bin/env node
// vitest を「ディスク上の本当の大文字小文字」のパスで起動するラッパー。
//
// 罠（2026-11-12 特定）: Windows でカレントディレクトリが小文字のドライブ文字
// （例 `c:\dev\nfc-editor`。Claude Code・VS Code の一部の端末がこうなる）だと、
// vitest のワーカー（workers/forks.js）は `file:///c:/…` から読み込まれ、
// テストファイルの `import 'vitest'` は vite に正規化されて `file:///C:/…` になる。
// Node の ESM はこの 2 つを別モジュールとして扱うため @vitest/runner が二重化し、
// どのテストも `describe()` の行で
//   TypeError: Cannot read properties of undefined (reading 'config')
// で落ちる（src を読まない 1 行のテストでも 100% 再現。版・lockfile は無関係）。
//
// 対処: リポジトリのルートと vitest の CLI を fs.realpathSync.native で
// 本当の表記（`C:\…`）に直し、その cwd・パスで node から起動し直す。
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = fs.realpathSync.native(path.resolve(__dirname, '..'));
const cli = fs.realpathSync.native(path.join(root, 'node_modules', 'vitest', 'vitest.mjs'));

const env = { ...process.env };
// Electron 由来の環境変数が残っていると、テストから起こす子プロセスが素の Node になる。
delete env.ELECTRON_RUN_AS_NODE;
env.NFC_STUDIO_VITEST_LAUNCHER = '1';

const r = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env,
});
if (r.error) {
  console.error(r.error);
  process.exit(1);
}
process.exit(r.status === null ? 1 : r.status);
