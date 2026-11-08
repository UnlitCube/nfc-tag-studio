// Navigate every view, enable the simulator, and report render errors.
// node scripts/smoke-views.cjs <out-dir>   (requires npm run build first)
const { _electron: electron } = require('@playwright/test');
const { mkdtempSync, rmSync, mkdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const os = require('node:os');

const VIEWS = ['home', 'issue', 'ndef', 'schema', 'hex', 'backup', 'log', 'keys', 'help', 'settings'];

(async () => {
  const root = resolve(__dirname, '..');
  const outDir = resolve(process.argv[2] || join(os.tmpdir(), 'nfcts-views'));
  mkdirSync(outDir, { recursive: true });
  const userData = mkdtempSync(join(os.tmpdir(), 'nfcts-views-'));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[k];
  const app = await electron.launch({ args: [root, `--user-data-dir=${userData}`], env, cwd: root });
  const allErrors = {};
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`[console] ${m.text()}`);
    });
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    await page.waitForSelector('.app-shell', { timeout: 15000 });

    // Dismiss the first-run onboarding modal if present.
    const onboard = await page.$('.modal-backdrop .btn-primary');
    if (onboard) {
      await onboard.click();
      await page.waitForSelector('.modal-backdrop', { state: 'detached', timeout: 5000 }).catch(() => {});
    }

    // Enable the simulator with an NTAG215 virtual tag so data-bearing views render.
    await page.evaluate(async () => {
      await window.nfcBridge.setSimulator({ enabled: true, kind: 'NTAG215' });
      await window.nfcBridge.simulatorTap(true);
    });
    await page.waitForTimeout(600);

    for (const view of VIEWS) {
      errors.length = 0;
      const nav = await page.$(`[data-testid="nav-${view}"]`);
      if (nav) await nav.click();
      await page.waitForTimeout(700);
      await page.screenshot({ path: join(outDir, `view-${view}.png`) });
      if (errors.length) allErrors[view] = [...errors];
    }
    const summary = await page.evaluate(() => ({
      reader: window.nfcBridge ? 'ok' : 'missing',
    }));
    console.log('[views] bridge', summary.reader);
  } finally {
    await app.close().catch(() => {});
    try {
      rmSync(userData, { recursive: true, force: true });
    } catch {}
  }
  console.log('[views] screenshots in', outDir);
  if (Object.keys(allErrors).length) {
    console.log('[views] ERRORS:\n' + JSON.stringify(allErrors, null, 2));
    process.exit(2);
  } else {
    console.log('[views] no console/page errors on any view');
  }
})().catch((e) => {
  console.error('[views] FAILED', e);
  process.exit(1);
});
