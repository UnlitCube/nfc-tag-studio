// Launch the built app (out/) with Playwright's Electron driver, take a
// screenshot, print console errors, close. Used by the integrator and agents to
// confirm the window actually renders. Usage:
//   node scripts/smoke-launch.cjs [screenshot.png] [--sim]
// Requires `npm run build` first (Playwright reads out/, not the sources).
const { _electron: electron } = require('@playwright/test');
const { mkdtempSync, rmSync, statSync } = require('node:fs');
const { join, resolve } = require('node:path');
const os = require('node:os');

(async () => {
  const root = resolve(__dirname, '..');
  const shot = process.argv[2] && !process.argv[2].startsWith('--') ? resolve(process.argv[2]) : join(os.tmpdir(), 'nfcts-smoke.png');
  const outMain = join(root, 'out', 'main', 'index.js');
  console.log('[smoke] out/main built at', statSync(outMain).mtime.toISOString());
  const userData = mkdtempSync(join(os.tmpdir(), 'nfcts-smoke-'));
  const env = { ...process.env, NFCTS_SMOKE: '1' };
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[k];
  const app = await electron.launch({ args: [root, `--user-data-dir=${userData}`], env, cwd: root });
  const errors = [];
  try {
    const page = await app.firstWindow();
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
    });
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    await page.waitForSelector('.app-shell', { timeout: 15000 });
    await page.waitForTimeout(1200);
    const info = await page.evaluate(() => ({
      bridge: typeof window.nfcBridge,
      theme: document.documentElement.getAttribute('data-theme'),
      navItems: document.querySelectorAll('.nav-item').length,
      title: document.title,
    }));
    console.log('[smoke] page:', JSON.stringify(info));
    await page.screenshot({ path: shot });
    console.log('[smoke] screenshot:', shot);
  } finally {
    await app.close().catch(() => {});
    try {
      rmSync(userData, { recursive: true, force: true });
    } catch {
      /* locked files on Windows - ignore */
    }
  }
  if (errors.length) console.log('[smoke] console:\n' + errors.join('\n'));
})().catch((e) => {
  console.error('[smoke] FAILED', e);
  process.exit(1);
});
