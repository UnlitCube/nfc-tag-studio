// HW: the erase screen and the D14 "back to the start" on a REAL reader and a REAL
// NTAG (2026-11-14: Sony PaSoRi + a sacrificial NTAG213). Opt-in, see launch-hw.ts:
//   NFCTS_HW_WRITE_UID=<UID of the sacrificial tag> npm run hw:write
//
// Through the screens: the NDEF editor takes the auto-read tag over -> "Cancel"
// back to the entry, and the tag still on the reader is NOT read again; a URL is
// written; the erase screen (never reads by itself) empties the NDEF, then erases
// the whole data area. Every step is checked by reading the tag back: the UID /
// lock / CC pages and the configuration pages never change. At the end the user
// memory is put back to what it was. Only user memory is written.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { isNtag, ntagPages, specFor } from '../../src/shared/tags';
import type { ReaderStatus } from '../../src/shared/types';
import { initializeImage } from '../../src/renderer/src/views/hex/model';
import { bridge, confirmTarget, containsUtf8, dialog, formatUid, nav, pageBytes, view } from '../e2e/helpers';
import { t } from '../e2e/i18n';
import { HW_OUT, expect, normUid, test, type HwApp } from './launch-hw';

const URL = 'https://example.com/hw-erase';

interface Img {
  uid: string;
  data: number[];
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

/** Test set-up / clean-up writes: user memory only, with main's UID check. */
async function writeUser(hw: HwApp, writes: { unit: number; bytes: number[] }[]): Promise<void> {
  await assertSameTag(hw);
  const spec = specFor(hw.kind);
  const last = ntagPages(hw.kind).userLast;
  for (const w of writes) {
    if (w.unit < spec.userStartUnit || w.unit > last || w.bytes.length !== spec.unitSize) {
      throw new Error(`[SAFETY] ユーザー領域の外（ページ ${w.unit}）には書かない`);
    }
  }
  const env = await hw.page.evaluate(
    async ([kind, uid, ws]) =>
      window.nfcBridge.writeTag({ kind, expectedUid: uid, writes: ws.map((w) => ({ unit: w.unit, data: new Uint8Array(w.bytes) })), allowProtected: false, verify: true }),
    [hw.kind, hw.uid, writes] as const,
  );
  if (!env.ok) throw new Error(`write failed: ${JSON.stringify(env.error)}`);
  if (env.value.failed.length || env.value.aborted) throw new Error(`write incomplete: ${JSON.stringify(env.value)}`);
}

async function confirmWrite(hw: HwApp, title: string, okText?: string): Promise<void> {
  const dlg = dialog(hw.page);
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.modal-title')).toHaveText(title);
  await expect(dlg.getByTestId('confirm-target')).toHaveText(confirmTarget(hw.kind, hw.uid));
  if (okText) await expect(dlg.getByTestId('confirm-ok')).toHaveText(okText);
  await hw.page.waitForTimeout(400);
  await dlg.getByTestId('confirm-ok').click();
  await expect(dlg).toBeHidden();
}

/** Pages outside the user memory (UID / lock / CC and the configuration pages) are what they were. */
function expectOutsideUserUnchanged(kind: Parameters<typeof ntagPages>[0], a: number[], b: number[], where: string): void {
  const first = specFor(kind).userStartUnit;
  const last = ntagPages(kind).userLast;
  const units = a.length / 4;
  for (let p = 0; p < units; p++) {
    if (p >= first && p <= last) continue;
    expect(pageBytes(a, p), `${where}: page ${p}`).toEqual(pageBytes(b, p));
  }
}

test('HW 実機の NTAG: キャンセルで入口に戻り読み直さない・消去（NDEF を空に・データ領域をすべて）→ 元に戻す', async ({ hw }) => {
  test.setTimeout(240_000);
  const { page } = hw;
  expect(isNtag(hw.kind), `NTAG だけが対象（置かれているのは ${hw.kind}）`).toBe(true);
  const userFirst = specFor(hw.kind).userStartUnit;
  const userLast = ntagPages(hw.kind).userLast;
  const timings: Record<string, number> = {};
  /** Records on the tag before the URL is added (the sacrificial tag may already hold some). */
  let recordsBefore = 0;

  const before = await readReal(hw);
  fs.mkdirSync(HW_OUT, { recursive: true });
  fs.writeFileSync(path.join(HW_OUT, 'erase-before.json'), JSON.stringify(before));
  const home = view(page, 'home');
  await expect(home.getByTestId('home-doc-body').getByTestId('uid-text')).toHaveText(formatUid(hw.uid), { timeout: 15_000 });

  try {
    await test.step('NDEF 編集: キャンセルで入口に戻り、置いたままのタグを読み直さない', async () => {
      const ndef = await nav(page, 'ndef');
      // D15: the home screen's auto-read is not carried over; the NDEF editor reads the tag itself.
      await expect(ndef.getByTestId('ndef-entry')).toBeVisible();
      await ndef.getByTestId('ndef-read-tag').click();
      await expect(ndef.getByTestId('ndef-write')).toBeVisible();
      await ndef.getByRole('button', { name: t('ndef.add'), exact: true }).click();
      await ndef.getByRole('menuitem', { name: t('ndef.kind.text'), exact: true }).click();
      await ndef.locator('.ndef-record').last().locator('textarea').first().fill('HW 下書き');
      await expect(ndef.getByTestId('ndef-exit')).toHaveAttribute('data-exit-kind', 'cancel');
      await ndef.getByTestId('ndef-exit').click();
      await expect(dialog(page).locator('.modal-title')).toHaveText(t('ndef.exit.title'));
      await dialog(page).getByTestId('confirm-ok').click();
      await expect(ndef.getByTestId('ndef-entry')).toBeVisible();
      // The real tag stays on the reader (its status is refreshed by every poll): no read again.
      await page.waitForTimeout(3000);
      await expect(ndef.getByTestId('ndef-entry')).toBeVisible();
      await expect(ndef.getByTestId('ndef-write')).toHaveCount(0);
      // The home screen keeps its own read; the binary editor has read nothing (D15).
      await nav(page, 'home');
      await expect(home.getByTestId('home-doc-body')).toBeVisible();
      await nav(page, 'hex');
      await expect(view(page, 'hex').getByTestId('hex-read')).toBeVisible();
      await hwShot(page, 'HW-E1-cancelled');
    });

    await test.step('NDEF 編集: 入口から読み取り、URL を書き込む', async () => {
      const ndef = await nav(page, 'ndef');
      await ndef.getByTestId('ndef-read-tag').click();
      await expect(ndef.getByTestId('ndef-write')).toBeVisible();
      recordsBefore = await ndef.locator('.ndef-record').count();
      await ndef.getByRole('button', { name: t('ndef.add'), exact: true }).click();
      await ndef.getByRole('menuitem', { name: t('ndef.kind.uri'), exact: true }).click();
      await ndef.locator('.ndef-record').last().locator('input').first().fill(URL);
      await ndef.getByTestId('ndef-write').click();
      await confirmWrite(hw, t('ndef.confirmTitle'));
      await expect(ndef.getByTestId('last-write')).toHaveAttribute('data-tone', 'ok');
      expect(containsUtf8((await readReal(hw)).data, 'example.com/hw-erase')).toBe(true);
    });

    await test.step('消去: 置いただけでは読み取らない → 読み取る → NDEF を空にする', async () => {
      const erase = await nav(page, 'erase');
      await page.waitForTimeout(1500);
      await expect(erase.getByTestId('erase-entry')).toBeVisible();
      await erase.getByTestId('erase-read').click();
      await expect(erase.getByTestId('erase-uid')).toHaveText(formatUid(hw.uid));
      await expect(erase.getByTestId('erase-ndef')).toHaveText(t('erase.ndef.records', { n: recordsBefore + 1 }));
      await expect(erase.getByTestId('erase-mode-ndef').locator('input')).toBeChecked();
      await hwShot(page, 'HW-E2-erase-read');
      const t0 = Date.now();
      await erase.getByTestId('erase-run').click();
      await confirmWrite(hw, t('erase.cf.title'), t('erase.run'));
      await expect(erase.getByTestId('last-write')).toHaveAttribute('data-tone', 'ok');
      timings.eraseNdefMs = Date.now() - t0;
      await expect(erase.getByTestId('erase-ndef')).toHaveText(t('erase.ndef.empty'));
      const now = await readReal(hw);
      expect(containsUtf8(now.data, 'example.com/hw-erase')).toBe(false);
      expectOutsideUserUnchanged(hw.kind, now.data, before.data, 'NDEF を空に');
      await hwShot(page, 'HW-E3-ndef-erased');
    });

    await test.step('消去: データ領域をすべて消す → 工場出荷時の内容（先頭の Lock Control TLV は残る）', async () => {
      // Data further in the user memory, so the whole-area erase has something to do.
      await writeUser(hw, [
        { unit: 20, bytes: [0xde, 0xad, 0xbe, 0xef] },
        { unit: userLast, bytes: [0xca, 0xfe, 0xba, 0xbe] },
      ]);
      const pre = await readReal(hw);
      const expected = initializeImage(hw.kind, new Uint8Array(pre.data), 'zero');
      const erase = view(page, 'erase');
      await erase.getByTestId('erase-reread').click();
      await erase.getByTestId('erase-mode-all').click();
      const t0 = Date.now();
      await erase.getByTestId('erase-run').click();
      await confirmWrite(hw, t('erase.cf.title'), t('erase.run'));
      await expect(erase.getByTestId('last-write')).toHaveAttribute('data-tone', 'ok');
      timings.eraseAllMs = Date.now() - t0;
      await expect(erase.getByTestId('erase-mode-all')).toContainText(t('erase.mode.already'));
      const now = await readReal(hw);
      expect(now.data).toEqual([...expected]);
      expectOutsideUserUnchanged(hw.kind, now.data, before.data, 'すべて消す');
      // For the record: is the result the tag's own content before the test (factory, here)?
      timings.allEqualsBefore = now.data.slice(userFirst * 4, (userLast + 1) * 4).every((b, i) => b === before.data[userFirst * 4 + i]) ? 1 : 0;
      await hwShot(page, 'HW-E4-all-erased');

      await erase.getByTestId('erase-exit').click();
      await expect(erase.getByTestId('erase-entry')).toBeVisible();
    });
  } finally {
    const now = await readReal(hw);
    const writes: { unit: number; bytes: number[] }[] = [];
    for (let p = userFirst; p <= userLast; p++) {
      const want = pageBytes(before.data, p);
      if (pageBytes(now.data, p).some((x, i) => x !== want[i])) writes.push({ unit: p, bytes: want });
    }
    if (writes.length) await writeUser(hw, writes);
  }
  const after = await readReal(hw);
  expect(after.data).toEqual(before.data);
  fs.writeFileSync(path.join(HW_OUT, 'erase-timings.json'), JSON.stringify(timings, null, 2));
  expect(hw.errors).toEqual([]);
});
