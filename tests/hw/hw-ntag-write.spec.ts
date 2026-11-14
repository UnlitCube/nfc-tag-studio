// HW: the read -> edit -> write / save flows on a REAL reader and a REAL NTAG
// (2026-11-13: Sony PaSoRi + a sacrificial NTAG213). Opt-in, see launch-hw.ts.
//
// Through the screens, as an operator would: binary edit -> write; NDEF URL ->
// write; backup save -> the tag changes -> "restore this tag" from the read
// document and from the saved file; NDEF erase. Every write is checked by reading
// the tag back. At the end the user memory is put back to what it was.
// Only user memory is written (never lock bits / CFG / PWD / PACK).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { isNtag, ntagPages, specFor } from '../../src/shared/tags';
import type { ReaderStatus } from '../../src/shared/types';
import { bridge, confirmTarget, containsUtf8, dialog, editByte, formatUid, nav, openFromHome, pageBytes, stubOpenDialog, stubSaveDialog, view } from '../e2e/helpers';
import { t } from '../e2e/i18n';
import { HW_OUT, expect, normUid, test, type HwApp } from './launch-hw';

const URL = 'https://example.com/hw-test';

interface Img {
  uid: string;
  data: number[];
}

async function hwShot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(HW_OUT, { recursive: true });
  await page.screenshot({ path: path.join(HW_OUT, `${name}.png`) });
}

/** The allowed tag is still the one on the reader the app uses. */
async function assertSameTag(hw: HwApp): Promise<void> {
  const s = await bridge<ReaderStatus>(hw.page, 'getReaderStatus');
  if (s.activeReader !== hw.reader || !s.card || normUid(s.card.uid) !== hw.uid) {
    throw new Error(`[SAFETY] リーダーかタグが変わった: ${JSON.stringify({ reader: s.activeReader, uid: s.card?.uid })}`);
  }
}

/** Read the real tag (checks only - no document is opened). */
async function readReal(hw: HwApp): Promise<Img> {
  await assertSameTag(hw);
  return bridge<Img>(hw.page, 'readTag', {});
}

/** Test set-up / clean-up writes, user memory only, with the UID check of main. */
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
      window.nfcBridge.writeTag({
        kind,
        expectedUid: uid,
        writes: ws.map((w) => ({ unit: w.unit, data: new Uint8Array(w.bytes) })),
        allowProtected: false,
        verify: true,
      }),
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
  await hw.page.waitForTimeout(300);
  await dlg.getByTestId('confirm-ok').click();
  await expect(dlg).toBeHidden();
}

test('HW 実機の NTAG: バイナリ編集・NDEF・バックアップから戻す・NDEF の消去 → 元に戻す', async ({ hw }) => {
  test.setTimeout(240_000);
  const { app, page } = hw;
  expect(isNtag(hw.kind), `NTAG だけが対象（置かれているのは ${hw.kind}）`).toBe(true);
  const userFirst = specFor(hw.kind).userStartUnit;
  const userLast = ntagPages(hw.kind).userLast;
  const timings: Record<string, number> = {};

  const before = await readReal(hw);
  fs.mkdirSync(HW_OUT, { recursive: true });
  fs.writeFileSync(path.join(HW_OUT, 'before.json'), JSON.stringify(before));

  // Auto-read opens the tag on the home screen.
  const home = view(page, 'home');
  await expect(home.getByTestId('home-doc-body').getByTestId('uid-text')).toHaveText(formatUid(hw.uid), { timeout: 15_000 });

  try {
    await test.step('バイナリ編集: 2 バイト変えて書き込む → 読み直して一致', async () => {
      // D15: the home screen's read goes to the binary editor only with "Open in binary editor".
      const hex = await openFromHome(page, 'hex');
      await expect(hex.getByTestId('hex-docbar')).toContainText(t('hex.doc.clean'));
      const a = 10 * 4;
      const b = userLast * 4;
      const va = before.data[a] === 0xa5 ? '5A' : 'A5';
      const vb = before.data[b] === 0x5a ? 'A5' : '5A';
      await editByte(page, a, va);
      await editByte(page, b, vb);
      await expect(hex.getByTestId('hex-docbar')).toContainText(t('hex.doc.dirtyPages', { n: 2 }));
      await hex.getByTestId('hex-write').click();
      const t0 = Date.now();
      await confirmWrite(hw, t('hex.cf.sameTitle'));
      const last = hex.getByTestId('last-write');
      await expect(last).toHaveAttribute('data-tone', 'ok');
      timings.hexWriteMs = Date.now() - t0;
      await expect(last).toContainText(t('op.write.done'));
      await expect(page.getByTestId('nav-dirty')).toHaveCount(0);
      await hwShot(page, 'HW-01-hex-written');

      const img = await readReal(hw);
      expect(img.data[a]).toBe(parseInt(va, 16));
      expect(img.data[b]).toBe(parseInt(vb, 16));
      await hex.getByTestId('hex-docbar').getByRole('button', { name: t('hex.doc.read'), exact: true }).click();
      await expect(dialog(page)).toHaveCount(0);
      await expect(hex.getByTestId('hex-grid').locator('.hx-cell').nth(a)).toHaveText(va);
      await expect(hex.getByTestId('hex-docbar')).toContainText(t('hex.doc.clean'));
    });

    await test.step('NDEF: URL を書き込む → ホームで 1 件 → 読み直しても出る', async () => {
      const ndef = await nav(page, 'ndef');
      // D15: the NDEF editor reads the tag itself.
      await ndef.getByTestId('ndef-read-tag').click();
      await expect(ndef.getByTestId('ndef-write')).toBeVisible();
      // Remove what the tag had (this tag may carry records from an earlier run).
      for (let i = await ndef.locator('.ndef-record').count(); i > 0; i--) {
        await ndef.locator('.ndef-record').first().getByRole('button', { name: t('ndef.remove'), exact: true }).click();
      }
      await ndef.getByRole('button', { name: t('ndef.add'), exact: true }).click();
      await page.getByRole('menuitem', { name: t('ndef.kind.uri'), exact: true }).click();
      const rec = ndef.locator('.ndef-record').first();
      await rec.locator('input').first().fill(URL);
      await ndef.getByTestId('ndef-write').click();
      const t0 = Date.now();
      await confirmWrite(hw, t('ndef.confirmTitle'));
      await expect(ndef.getByTestId('last-write')).toHaveAttribute('data-tone', 'ok');
      timings.ndefWriteMs = Date.now() - t0;
      await expect(ndef.getByTestId('last-write')).toContainText(t('ndef.written'));
      await hwShot(page, 'HW-02-ndef-written');
      expect(containsUtf8((await readReal(hw)).data, 'example.com/hw-test')).toBe(true);

      // The home screen keeps its own (earlier) read until it reads again (D15).
      const h = await nav(page, 'home');
      await h.getByTestId('home-read').click();
      await expect(dialog(page)).toHaveCount(0);
      await expect(h.getByTestId('home-doc-body')).toContainText(t('home.doc.ndefRecords', { n: 1 }));
      const n = await nav(page, 'ndef');
      await n.getByTestId('ndef-read-tag').click();
      await expect(dialog(page)).toHaveCount(0);
      await expect(n.locator('.ndef-record')).toHaveCount(1);
      await expect(n.locator('.ndef-record').first().locator('input').first()).toHaveValue(URL);
    });

    await test.step('バックアップ: 保存 → タグが変わる → 読んだ文書から戻す・保存したファイルから戻す', async () => {
      // D15: the home screen's read (just above) as the backup source - a one-way copy.
      await nav(page, 'home');
      const backup = await openFromHome(page, 'backup');
      await expect(backup.getByTestId('backup-source')).toBeVisible();
      const file = path.join(hw.dir, 'hw-backup.nfcdump');
      await stubSaveDialog(app, file);
      await backup.getByRole('button', { name: `${t('backup.save.button')}: ${t('backup.save.project')}`, exact: true }).click();
      await expect(backup.getByTestId('backup-saved')).toContainText('hw-backup.nfcdump');
      const saved = await readReal(hw);

      // From the read document.
      await writeUser(hw, [{ unit: 20, bytes: [0xde, 0xad, 0xbe, 0xef] }]);
      await backup.getByTestId('backup-read-target').click();
      await expect(backup.getByTestId('backup-target')).toHaveAttribute('data-mode', 'restore');
      await expect(backup.getByTestId('backup-target')).toContainText(formatUid(hw.uid));
      await expect(backup.getByTestId('backup-write')).toHaveText(t('backup.restore.button'));
      await backup.getByTestId('backup-write').click();
      let t0 = Date.now();
      await confirmWrite(hw, t('backup.restore.confirmTitle'));
      await expect(backup.getByTestId('last-write')).toContainText(t('backup.restore.done'));
      timings.restoreFromDocMs = Date.now() - t0;
      expect(pageBytes((await readReal(hw)).data, 20)).toEqual(pageBytes(saved.data, 20));
      await hwShot(page, 'HW-03-restored-from-doc');

      // From the saved file.
      await writeUser(hw, [{ unit: 21, bytes: [0xca, 0xfe, 0xba, 0xbe] }]);
      await stubOpenDialog(app, file);
      await backup.getByRole('button', { name: t('backup.open.button'), exact: true }).first().click();
      await expect(backup.getByTestId('backup-source')).toContainText('hw-backup.nfcdump');
      await backup.getByTestId('backup-read-target').click();
      await expect(backup.getByTestId('backup-target')).toHaveAttribute('data-mode', 'restore');
      await backup.getByTestId('backup-write').click();
      t0 = Date.now();
      await confirmWrite(hw, t('backup.restore.confirmTitle'));
      await expect(backup.getByTestId('last-write')).toContainText(t('backup.restore.done'));
      timings.restoreFromFileMs = Date.now() - t0;
      const restored = await readReal(hw);
      for (let p = userFirst; p <= userLast; p++) expect(pageBytes(restored.data, p), `page ${p}`).toEqual(pageBytes(saved.data, p));
      await hwShot(page, 'HW-04-restored-from-file');
    });

    await test.step('NDEF の消去: 確認 → 空の NDEF になる', async () => {
      const ndef = await nav(page, 'ndef');
      await ndef.getByTestId('ndef-read-tag').click();
      const ask = dialog(page);
      await page.waitForTimeout(500);
      // The open document came from the file: reading the tag may ask first.
      if (await ask.isVisible().catch(() => false)) await ask.getByTestId('confirm-ok').click();
      await expect(ndef.locator('.ndef-record')).toHaveCount(1);
      await ndef.locator('.ndef-record').first().getByRole('button', { name: t('ndef.remove'), exact: true }).click();
      await ndef.getByTestId('ndef-erase').click();
      await confirmWrite(hw, t('ndef.eraseTitle'), t('ndef.eraseConfirm'));
      await expect(view(page, 'ndef').getByTestId('last-write')).toContainText(t('ndef.erased'));
      const erased = await readReal(hw);
      expect(containsUtf8(erased.data, 'example.com/hw-test')).toBe(false);
      await hwShot(page, 'HW-05-ndef-erased');
    });
  } finally {
    // Put the user memory back to what it was before the test.
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
  fs.writeFileSync(path.join(HW_OUT, 'timings.json'), JSON.stringify(timings, null, 2));
  expect(hw.errors).toEqual([]);
});
