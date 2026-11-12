// One launcher for every E2E spec (Playwright `_electron` against the built app in out/).
//
// Safety (this PC has a real Sony PaSoRi, a USB token and a YubiKey attached):
//  - NFCTS_NO_PCSC=1 is always set: the app starts the virtual reader only (D8).
//  - tests/e2e/no-pcsc-guard.cjs is loaded into main with `-r`: koffi (winscard.dll)
//    cannot be loaded even if the variable were ignored. The guard proves itself at
//    start (its own import('koffi') must be refused) and counts the app's attempts.
//  - Right after start, main's env, the guard (selfTest 'blocked', 0 app attempts) and
//    getReaderStatus() are checked: every reader must be the virtual one. Anything else
//    fails the test at once, before any step of the test runs.
//
// Each launch gets its own --user-data-dir (settings.json / keys / issue log live there),
// so the repository's or the developer's real settings are never touched.
import { _electron as electron, expect, test as base } from '@playwright/test';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(__dirname, '..', '..');
const GUARD = path.join(__dirname, 'no-pcsc-guard.cjs');
export const VIRTUAL_READER = 'NFC Tag Studio Virtual NFC Reader';

/** Where screenshots go (outside the repository). Override with NFCTS_E2E_SHOTS. */
export const SHOTS_DIR = process.env.NFCTS_E2E_SHOTS ?? path.join(os.tmpdir(), 'nfcts-e2e-shots');

// ---------------------------------------------------------------------------
// out/ freshness: never measure an old UI
// ---------------------------------------------------------------------------

function newestMtime(dir: string): { t: number; file: string } {
  let best = { t: 0, file: '' };
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const sub = newestMtime(p);
      if (sub.t > best.t) best = sub;
    } else {
      const t = fs.statSync(p).mtimeMs;
      if (t > best.t) best = { t, file: p };
    }
  }
  return best;
}

let freshnessChecked = false;
/** Throws (in Japanese) when out/ is missing or older than src/. */
export function assertBuilt(): void {
  if (freshnessChecked) return;
  const outputs = ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html'].map((p) => path.join(ROOT, p));
  const missing = outputs.filter((p) => !fs.existsSync(p));
  if (missing.length) throw new Error(`E2E の前に npm run build を流してください（無い: ${missing.join(', ')}）`);
  const oldestOut = Math.min(...outputs.map((p) => fs.statSync(p).mtimeMs));
  const src = newestMtime(path.join(ROOT, 'src'));
  if (src.t > oldestOut) {
    throw new Error(`out/ が src/ より古い（${path.relative(ROOT, src.file)} の方が新しい）。E2E の前に npm run build を流してください`);
  }
  freshnessChecked = true;
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

export interface LaunchOptions {
  /** 'show' = first start (no settings.json: the first-run guide opens). Default 'skip'. */
  onboarding?: 'show' | 'skip';
  /** Extra settings written to settings.json before start (only with onboarding 'skip'). */
  settings?: Record<string, unknown>;
}

export interface E2EApp {
  app: ElectronApplication;
  page: Page;
  /** Temporary directory of this launch (user-data/ and files live here). */
  dir: string;
  userData: string;
  /** renderer console errors + page errors. */
  errors: string[];
  /** main stdout/stderr. */
  mainLog: string[];
  pid: number | undefined;
  close(): Promise<void>;
}

function sanitizedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    const u = k.toUpperCase();
    // ELECTRON_RUN_AS_NODE makes electron.exe a plain Node (CLAUDE.md trap); drop any casing.
    if (u === 'ELECTRON_RUN_AS_NODE' || u === 'ELECTRON_NO_ATTACH_CONSOLE') continue;
    if (u.startsWith('NFCTS_')) continue; // only what we set below
    env[k] = v;
  }
  env.NFCTS_NO_PCSC = '1'; // virtual reader only - never a real reader / tag (D8)
  env.NFCTS_E2E = '1'; // dev build: the quit confirmations answer themselves (app.close() never hangs)
  return env;
}

/** Known Chromium / DevTools noise that is not an app error. */
const NOISE = [/Autofill\.enable/, /Autofill\.setAddresses/, /Electron Security Warning/, /DevTools/];

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
}

/** globalThis.__NFCTS_E2E_GUARD (tests/e2e/no-pcsc-guard.cjs). */
interface GuardState {
  installed: boolean;
  hooks: string[];
  /** Times the APP tried to load koffi (must stay 0: NFCTS_NO_PCSC=1 keeps PC/SC off). */
  appAttempts: number;
  /** The guard's own import('koffi') at start: 'blocked' proves the guard works. */
  selfTest: string | Promise<string> | null;
}

export async function launchApp(opts: LaunchOptions = {}): Promise<E2EApp> {
  assertBuilt();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfcts-e2e-'));
  const userData = path.join(dir, 'user-data');
  fs.mkdirSync(userData, { recursive: true });
  if ((opts.onboarding ?? 'skip') === 'skip') {
    fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ onboardingDone: true, ...(opts.settings ?? {}) }, null, 2));
  }

  const app = await electron.launch({
    args: ['-r', GUARD, ROOT, `--user-data-dir=${userData}`],
    cwd: ROOT,
    env: sanitizedEnv(),
    timeout: 60_000,
  });
  const pid = app.process().pid;
  const mainLog: string[] = [];
  app.process().stdout?.on('data', (b: Buffer) => mainLog.push(b.toString()));
  app.process().stderr?.on('data', (b: Buffer) => mainLog.push(b.toString()));

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    let done = false;
    await Promise.race([
      app
        .close()
        .catch(() => {})
        .then(() => {
          done = true;
        }),
      new Promise((r) => setTimeout(r, 15_000)),
    ]);
    if (!done) killTree(pid);
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  };

  try {
    // --- safety first: main env + guard, before the window does anything ------
    const mainSide = await app.evaluate(async () => {
      const g = (globalThis as unknown as { __NFCTS_E2E_GUARD?: GuardState }).__NFCTS_E2E_GUARD;
      return {
        noPcsc: process.env.NFCTS_NO_PCSC ?? null,
        runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
        guard: g ? { installed: g.installed, hooks: g.hooks, appAttempts: g.appAttempts, selfTest: await g.selfTest } : null,
      };
    });
    if (
      mainSide.noPcsc !== '1' ||
      mainSide.runAsNode !== null ||
      !mainSide.guard?.installed ||
      mainSide.guard.selfTest !== 'blocked' ||
      mainSide.guard.appAttempts !== 0
    ) {
      throw new Error(`[SAFETY] main の環境が E2E 用になっていない（PC/SC を止められていない）: ${JSON.stringify(mainSide)}`);
    }

    const page = await app.firstWindow({ timeout: 60_000 });
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && !NOISE.some((re) => re.test(m.text()))) errors.push(`[console] ${m.text()}`);
    });
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    await expect(page.locator('.app-shell')).toBeVisible({ timeout: 30_000 });

    // --- readers must be the virtual one only (checked now and once more after the first poll) ---
    await assertVirtualOnly(app, page, 'launch');
    await page.waitForTimeout(800);
    await assertVirtualOnly(app, page, 'launch+800ms');

    return { app, page, dir, userData, errors, mainLog, pid, close };
  } catch (err) {
    await close();
    throw err;
  }
}

/** Fails the test at once when any reader other than the virtual one is visible to the app. */
export async function assertVirtualOnly(app: ElectronApplication, page: Page, label: string): Promise<void> {
  const env = await page.evaluate(() => window.nfcBridge.getReaderStatus());
  if (!env.ok) throw new Error(`[SAFETY] ${label}: getReaderStatus failed: ${JSON.stringify(env.error)}`);
  const s = env.value;
  const foreign = s.readers.filter((r) => !r.virtual || r.name !== VIRTUAL_READER);
  // -1 = the guard is missing: treated like an attempt (fail).
  const attempts = await app.evaluate(
    () => (globalThis as unknown as { __NFCTS_E2E_GUARD?: GuardState }).__NFCTS_E2E_GUARD?.appAttempts ?? -1,
  );
  if (foreign.length || (s.activeReader !== null && s.activeReader !== VIRTUAL_READER) || attempts !== 0) {
    throw new Error(
      `[SAFETY] ${label}: 仮想リーダー以外が見えている / アプリが PC/SC を読み込もうとした。中止します: ${JSON.stringify({
        readers: s.readers.map((r) => r.name),
        activeReader: s.activeReader,
        appAttempts: attempts,
      })}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Fixture: `nfc` launches per test and closes afterwards (logs attached on failure)
// ---------------------------------------------------------------------------

async function attachLogs(testInfo: TestInfo, e: E2EApp): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return;
  await testInfo.attach('main-log', { body: e.mainLog.join(''), contentType: 'text/plain' }).catch(() => {});
  await testInfo.attach('renderer-errors', { body: e.errors.join('\n'), contentType: 'text/plain' }).catch(() => {});
  await testInfo
    .attach('failure.png', { body: await e.page.screenshot().catch(() => Buffer.alloc(0)), contentType: 'image/png' })
    .catch(() => {});
}

export const test = base.extend<{ appOptions: LaunchOptions; nfc: E2EApp }>({
  appOptions: [{}, { option: true }],
  nfc: async ({ appOptions }, use, testInfo) => {
    const e = await launchApp(appOptions);
    try {
      await use(e);
    } finally {
      await attachLogs(testInfo, e);
      await e.close();
    }
  },
});

export { expect };
