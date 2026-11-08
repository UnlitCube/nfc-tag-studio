// npm 11 does not run install scripts by default and Electron 44 creates its
// dist/ lazily, so after `npm install` / `npm ci` the Electron binary may be
// missing ("Error: Electron uninstall"). Fetch it explicitly here.
// Safe to run repeatedly: install.js is a no-op when dist/ is already present.
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const electronDir = join(__dirname, '..', 'node_modules', 'electron');
const installJs = join(electronDir, 'install.js');
if (!existsSync(installJs)) {
  // electron not installed (e.g. production-only install) - nothing to do.
  process.exit(0);
}
const env = { ...process.env };
// Same reason as start-dev.bat: never let this variable leak into Electron.
for (const k of Object.keys(env)) if (k.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[k];
const r = spawnSync(process.execPath, [installJs], { stdio: 'inherit', env });
if (r.status !== 0) {
  console.error('[ensure-electron] failed to fetch the Electron binary');
  process.exit(r.status ?? 1);
}
const versionFile = join(electronDir, 'dist', 'version');
console.log(existsSync(versionFile) ? '[ensure-electron] Electron binary ready' : '[ensure-electron] WARNING: dist/version not found');
