// HW: the full reset screen ("完全初期化") on a REAL reader and a REAL NTAG (2026-11-14:
// Sony PaSoRi + a sacrificial NTAG213). Opt-in, see launch-hw.ts:
//   NFCTS_HW_WRITE_UID=<UID of the sacrificial tag> npm run hw:write
//
// Extra guards for this one (it writes protected pages):
//  - before confirming, the plan shown is re-computed here and must write only user
//    pages and PWD / PACK, plus CFG0 / CFG1 only if their new bytes are exactly the
//    factory ones (protection off). Lock bits, CC and AUTH0 < FF are never written.
//  - afterwards UID / lock / CC / dynamic lock / CFG0 / CFG1 are checked against the
//    factory values, and the user memory is put back to what it was.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { factoryImage, isNtag, ntagPages, specFor } from '../../src/shared/tags';
import { hexToBytes } from '../../src/shared/hex';
import type { AppSettings, ReaderStatus, TagImage } from '../../src/shared/types';
import { planFactoryReset } from '../../src/renderer/src/views/factory/model';
import { bridge, confirmTarget, dialog, formatUid, nav, pageBytes } from '../e2e/helpers';
import { t } from '../e2e/i18n';
import { HW_OUT, expect, normUid, test, type HwApp } from './launch-hw';

interface Img {
  uid: string;
  kind: TagImage['kind'];
  data: number[];
  unitStatus: TagImage['unitStatus'];
  readAt: number;
}

async function hwShot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(HW_OUT, { recursive: true });
  await page.screenshot({ path: path.join(HW_OUT, `${name}.png`) });
}

async function assertSameTag(hw: HwApp): Promise<void> {
  const s = await bridge<ReaderStatus>(hw.page, 'getReaderStatus');
  if (s.activeReader !== hw.reader || !s.card || normUid(s.card.uid) !== hw.uid) {
    throw new Error(`[SAFETY] リーダーかタグが変わった: ${JSON.stringify({ reader: s.activeReader, uid: s.card?.uid })}`);
  }
}

async function readReal(hw: HwApp): Promise<Img> {
  await assertSameTag(hw);
  return bridge<Img>(hw.page, 'readTag', {});
}

async function writeUser(hw: HwApp, writes: { unit: number; bytes: number[] }[]): Promise<void> {
  await assertSameTag(hw);
  const spec = specFor(hw.kind);
  const last = ntagPages(hw.kind).userLast;
  for (const w of writes) {
    if (w.unit < spec.userStartUnit || w.unit > last || w.bytes.length !== spec.unitSize) throw new Error(`[SAFETY] ユーザー領域の外（ページ ${w.unit}）には書かない`);
  }
  const env = await hw.page.evaluate(
    async ([kind, uid, ws]) =>
      window.nfcBridge.writeTag({ kind, expectedUid: uid, writes: ws.map((w) => ({ unit: w.unit, data: new Uint8Array(w.bytes) })), allowProtected: false, verify: true }),
    [hw.kind, hw.uid, writes] as const,
  );
  if (!env.ok) throw new Error(`write failed: ${JSON.stringify(env.error)}`);
  if (env.value.failed.length || env.value.aborted) throw new Error(`write incomplete: ${JSON.stringify(env.value)}`);
}

test('HW 実機の NTAG: 完全初期化（データ・パスワードを工場出荷時に。設定は工場出荷時の値のときだけ）→ 元に戻す', async ({ hw }) => {
  test.setTimeout(240_000);
  const { page } = hw;
  expect(isNtag(hw.kind), `NTAG だけが対象（置かれているのは ${hw.kind}）`).toBe(true);
  const p = ntagPages(hw.kind);
  const userFirst = specFor(hw.kind).userStartUnit;
  const fac = factoryImage(hw.kind, hexToBytes(hw.uid));
  const timings: Record<string, number> = {};

  const before = await readReal(hw);
  fs.mkdirSync(HW_OUT, { recursive: true });
  fs.writeFileSync(path.join(HW_OUT, 'factory-before.json'), JSON.stringify(before));

  // Advanced mode (protected pages): this test's own user-data, never the operator's settings.
  const s = await bridge<AppSettings>(page, 'getSettings');
  await bridge(page, 'saveSettings', { ...s, advancedMode: true });

  try {
    // --- the guard: what the screen will write ---------------------------------------
    const plan = planFactoryReset({ ...before, data: new Uint8Array(before.data) } as TagImage);
    expect(plan.block, '保護・途切れのあるタグは対象外').toBeNull();
    const allowed = new Set<number>([p.pwd, p.pack]);
    for (let u = userFirst; u <= p.userLast; u++) allowed.add(u);
    for (const w of plan.writes) {
      if (w.unit === p.cfg0 || w.unit === p.cfg1) {
        expect([...w.data], `CFG ${w.unit} は工場出荷時の値だけ`).toEqual(pageBytes([...fac], w.unit));
        continue;
      }
      expect(allowed.has(w.unit), `ページ ${w.unit} は書かない`).toBe(true);
    }
    const pwd = plan.writes.find((w) => w.unit === p.pwd);
    expect(pwd && [...pwd.data]).toEqual([0xff, 0xff, 0xff, 0xff]);

    // --- through the screen ---------------------------------------------------------------
    const view = await nav(page, 'factory');
    await page.waitForTimeout(1500);
    await expect(view.getByTestId('factory-entry')).toBeVisible(); // never reads by itself
    await view.getByTestId('factory-read').click();
    await expect(view.getByTestId('factory-uid')).toHaveText(formatUid(hw.uid));
    await expect(view.getByTestId('factory-run')).toBeEnabled();
    await hwShot(page, 'HW-F1-plan');
    const t0 = Date.now();
    await view.getByTestId('factory-run').click();
    const dlg = dialog(page);
    await expect(dlg.locator('.modal-title')).toHaveText(t('factory.cf.title'));
    await expect(dlg.getByTestId('confirm-target')).toHaveText(confirmTarget(hw.kind, hw.uid));
    await dlg.locator('input').fill(t('factory.cf.word'));
    await page.waitForTimeout(400);
    await dlg.getByTestId('confirm-ok').click();
    await expect(dlg).toBeHidden();
    await expect(view.getByTestId('last-write')).toHaveAttribute('data-tone', 'ok');
    timings.factoryResetMs = Date.now() - t0;
    await expect(view.getByTestId('factory-restore')).toContainText(t('factory.already'));
    await hwShot(page, 'HW-F2-reset');

    const now = await readReal(hw);
    // UID / lock / CC (pages 0-3), the user memory and CFG0 / CFG1 are the factory values.
    for (let u = 0; u <= p.cfg1; u++) {
      if (u === p.dynLock) continue;
      if (u <= 1) {
        expect(pageBytes(now.data, u), `page ${u}`).toEqual(pageBytes(before.data, u));
        continue;
      }
      expect(pageBytes(now.data, u), `page ${u}`).toEqual(pageBytes([...fac], u));
    }
    expect(pageBytes(now.data, p.dynLock), 'dynamic lock').toEqual(pageBytes(before.data, p.dynLock));
  } finally {
    // Put the user memory back to what it was before the test (PWD / PACK stay at the factory value).
    const now = await readReal(hw);
    const writes: { unit: number; bytes: number[] }[] = [];
    for (let u = userFirst; u <= p.userLast; u++) {
      const want = pageBytes(before.data, u);
      if (pageBytes(now.data, u).some((x, i) => x !== want[i])) writes.push({ unit: u, bytes: want });
    }
    if (writes.length) await writeUser(hw, writes);
  }
  const after = await readReal(hw);
  expect(after.data).toEqual(before.data);
  fs.writeFileSync(path.join(HW_OUT, 'factory-timings.json'), JSON.stringify(timings, null, 2));
  expect(hw.errors).toEqual([]);
});
