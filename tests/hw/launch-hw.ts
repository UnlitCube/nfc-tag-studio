// Launcher for the REAL-HARDWARE write test (tests/hw). Not part of `npm run e2e`:
// it writes to the tag on a real reader. Run it only with a tag that may be
// overwritten (a sacrificial tag), and name that tag's UID:
//
//   set NFCTS_HW_WRITE_UID=04A1B2C3D4E5F6   (PowerShell: $env:NFCTS_HW_WRITE_UID = '04A1B2C3D4E5F6'; the value is an example)
//   npm run hw:write
//
// Safety (the dev PC also has a USB token and a YubiKey on PC/SC):
//  - Nothing runs without NFCTS_HW_WRITE_UID. The tag on the active reader must have
//    exactly that UID, checked at start and again by every write of the spec
//    (main refuses a write whose expectedUid differs: TAG_CHANGED).
//  - The active reader must be a real reader that the app judged contactless (the
//    app never makes a token / YubiKey active, I6), never the virtual one.
//  - The spec writes the user memory only. Lock bits, CFG, PWD / PACK - which are
//    irreversible, or cannot be undone on a storage reader such as the PaSoRi - are
//    never written. The tag's user memory is restored at the end.
//  - Each launch gets its own --user-data-dir (no real settings / keys are touched).
import { _electron as electron, expect, test as base } from '@playwright/test';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TagKind } from '../../src/shared/tags';
import type { ReaderStatus } from '../../src/shared/types';
import { ROOT, assertBuilt } from '../e2e/launch';

/** Screenshots / the before image go here (outside the repository). */
export const HW_OUT = process.env.NFCTS_HW_OUT ?? path.join(os.tmpdir(), 'nfcts-hw');

export interface HwApp {
  app: ElectronApplication;
  page: Page;
  dir: string;
  /** The real reader in use. */
  reader: string;
  /** The UID the operator allowed to be written (upper-case hex, no separators). */
  uid: string;
  kind: TagKind;
  errors: string[];
  mainLog: string[];
  close(): Promise<void>;
}

/** "04:a1:b2 ..." -> "04A1B2..." */
export function normUid(s: string): string {
  return s.replace(/[^0-9a-f]/gi, '').toUpperCase();
}

function env(): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    const u = k.toUpperCase();
    if (u === 'ELECTRON_RUN_AS_NODE' || u === 'ELECTRON_NO_ATTACH_CONSOLE') continue;
    if (u.startsWith('NFCTS_')) continue; // never NFCTS_NO_PCSC here: this test uses the real reader
    e[k] = v;
  }
  e.NFCTS_E2E = '1'; // the quit confirmations answer themselves (app.close() never hangs)
  return e;
}

const NOISE = [/Autofill\.enable/, /Autofill\.setAddresses/, /Electron Security Warning/, /DevTools/];

export async function launchHw(): Promise<HwApp> {
  const allowed = normUid(process.env.NFCTS_HW_WRITE_UID ?? '');
  if (!allowed) {
    throw new Error('[SAFETY] NFCTS_HW_WRITE_UID が無い。書き込んでよい（捨ててよい）タグの UID を指定してください');
  }
  assertBuilt();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfcts-hw-'));
  const userData = path.join(dir, 'user-data');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ onboardingDone: true }, null, 2));

  const app = await electron.launch({ args: [ROOT, `--user-data-dir=${userData}`], cwd: ROOT, env: env(), timeout: 60_000 });
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
    if (!done && pid) {
      try {
        execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        /* already gone */
      }
    }
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  };

  try {
    const page = await app.firstWindow({ timeout: 60_000 });
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && !NOISE.some((re) => re.test(m.text()))) errors.push(`[console] ${m.text()}`);
    });
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    await expect(page.locator('.app-shell')).toBeVisible({ timeout: 30_000 });

    // Wait for the tag on the active reader to be identified.
    const status = async (): Promise<ReaderStatus | null> => {
      const env = await page.evaluate(() => window.nfcBridge.getReaderStatus());
      return env.ok ? env.value : null;
    };
    let s = await status();
    for (let i = 0; i < 80 && !(s?.cardState === 'ready'); i++) {
      await page.waitForTimeout(250);
      s = await status();
    }
    const active = s?.readers.find((r) => r.name === s?.activeReader);
    if (!s || !active || active.virtual || !active.likelyContactless || s.cardState !== 'ready' || !s.card?.kind) {
      throw new Error(`[SAFETY] 実機の NFC リーダーの上に、読み取れるタグが無い: ${JSON.stringify({ active: s?.activeReader, state: s?.cardState })}`);
    }
    if (normUid(s.card.uid) !== allowed) {
      throw new Error(`[SAFETY] リーダーの上のタグ（UID ${s.card.uid}）は、書き込んでよいと指定されたタグ（${allowed}）ではない。中止します`);
    }
    return { app, page, dir, reader: active.name, uid: normUid(s.card.uid), kind: s.card.kind, errors, mainLog, close };
  } catch (err) {
    await close();
    throw err;
  }
}

async function attachLogs(testInfo: TestInfo, e: HwApp): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return;
  await testInfo.attach('main-log', { body: e.mainLog.join(''), contentType: 'text/plain' }).catch(() => {});
  await testInfo.attach('renderer-errors', { body: e.errors.join('\n'), contentType: 'text/plain' }).catch(() => {});
  await testInfo
    .attach('failure.png', { body: await e.page.screenshot().catch(() => Buffer.alloc(0)), contentType: 'image/png' })
    .catch(() => {});
}

export const test = base.extend<{ hw: HwApp }>({
  hw: async ({}, use, testInfo) => {
    const e = await launchHw();
    try {
      await use(e);
    } finally {
      await attachLogs(testInfo, e);
      await e.close();
    }
  },
});

export { expect };
