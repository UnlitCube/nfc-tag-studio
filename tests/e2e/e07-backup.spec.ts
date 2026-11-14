// E7 backup: read -> save to a file (save dialog replaced) -> open that file ->
// write it to a NEW tag (duplicate) -> the data area matches, the new tag keeps its
// own UID. Then restoring the same tag ("このタグに戻す") puts a changed page back.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './launch';
import {
  confirmTarget,
  dialog,
  formatUid,
  nav,
  newTag,
  openFromHome,
  pageBytes,
  readVirtualTag,
  readerStatus,
  shot,
  startWithReadTag,
  stubOpenDialog,
  stubSaveDialog,
  view,
  writeDirect,
} from './helpers';
import { t } from './i18n';

const P10 = [0x11, 0x22, 0x33, 0x44];
const P20 = [0x55, 0x66, 0x77, 0x88];
const USER_PAGES = Array.from({ length: 126 }, (_, i) => 4 + i); // NTAG215 user memory: pages 4-129

test('E7 バックアップ: 保存 → 開く → 新しいタグへ複製 → 一致 / 同じタグへ「このタグに戻す」', async ({ nfc }) => {
  const { app, page, dir } = nfc;
  const uidA = await startWithReadTag(page, 'NTAG215');
  await writeDirect(app, page, [
    { unit: 10, bytes: P10 },
    { unit: 20, bytes: P20 },
  ]);
  const home = view(page, 'home');
  await home.getByTestId('home-read').click(); // read A again with its data
  await expect(dialog(page)).toHaveCount(0);
  const imgA = await readVirtualTag(app, page);
  expect(pageBytes(imgA.data, 10)).toEqual(P10);

  // --- save to a file -----------------------------------------------------------
  // D15: the home screen's tag becomes the backup source only with "Open in backup & duplicate".
  const backup = await openFromHome(page, 'backup');
  await expect(backup.getByTestId('backup-source')).toBeVisible();
  const file = path.join(dir, 'backup-a.nfcdump');
  await stubSaveDialog(app, file);
  await backup.getByRole('button', { name: `${t('backup.save.button')}: ${t('backup.save.project')}`, exact: true }).click();
  await expect(backup.getByTestId('backup-saved')).toContainText('backup-a.nfcdump');
  // D13: the saved result stays in the card; no toast repeats it (and covers the screen).
  await expect(page.getByTestId('toast').filter({ hasText: 'backup-a.nfcdump' })).toHaveCount(0);
  expect(fs.statSync(file).size).toBeGreaterThan(540);
  await shot(page, 'E7-01-saved');

  // --- open the file (the source is now the file) -----------------------------------
  await stubOpenDialog(app, file);
  await backup.getByRole('button', { name: t('backup.open.button'), exact: true }).first().click();
  await expect(backup.getByTestId('backup-source')).toContainText('backup-a.nfcdump');
  // E2E-UX-7: the open document IS the saved file - no false "changed since saved".
  await expect(backup.getByText(t('backup.savedChanged'))).toHaveCount(0);

  // --- a new blank tag: duplicate -------------------------------------------------
  await newTag(page, 'NTAG215');
  await expect.poll(async () => (await readerStatus(page)).card?.uid ?? null).not.toBe(uidA);
  const blankB = await readVirtualTag(app, page);
  const uidB = blankB.uid;
  await backup.getByTestId('backup-read-target').click();
  await expect(backup.getByTestId('backup-target')).toHaveAttribute('data-mode', 'duplicate');
  await expect(backup.getByTestId('backup-write')).toHaveText(t('backup.dup.button'));
  await backup.getByTestId('backup-write').click();
  let dlg = dialog(page);
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.modal-title')).toHaveText(t('backup.dup.confirmTitle'));
  await expect(dlg.getByTestId('confirm-target')).toHaveText(confirmTarget('NTAG215', uidB));
  await page.waitForTimeout(300);
  await shot(page, 'E7-02-duplicate-confirm');
  await dlg.getByTestId('confirm-ok').click();
  await expect(dlg).toBeHidden();
  await expect(backup.getByTestId('last-write')).toHaveAttribute('data-tone', 'ok');
  await expect(backup.getByTestId('last-write')).toContainText(t('backup.dup.done'));

  const imgB = await readVirtualTag(app, page);
  expect(imgB.uid).toBe(uidB);
  for (const p of USER_PAGES) expect(pageBytes(imgB.data, p), `page ${p}`).toEqual(pageBytes(imgA.data, p));
  for (const p of [0, 1, 2]) expect(pageBytes(imgB.data, p), `UID page ${p}`).toEqual(pageBytes(blankB.data, p));
  await shot(page, 'E7-03-duplicated');

  // --- restore the same tag: B becomes the source, page 10 is changed on the tag, then put back ---
  await backup.getByRole('button', { name: t('backup.read'), exact: true }).first().click();
  dlg = dialog(page);
  await expect(dlg).toBeVisible(); // the tag on the reader is not the backup source: asked first
  await expect(dlg.locator('.modal-title')).toHaveText(t('backup.reread.title'));
  await dlg.getByTestId('confirm-ok').click();
  await expect(backup.getByTestId('backup-source')).not.toContainText('backup-a.nfcdump');
  await writeDirect(app, page, [{ unit: 10, bytes: [0, 0, 0, 0] }]);

  await backup.getByTestId('backup-read-target').click();
  await expect(backup.getByTestId('backup-target')).toHaveAttribute('data-mode', 'restore');
  await expect(backup.getByTestId('backup-target')).toContainText(formatUid(uidB));
  await expect(backup.getByTestId('backup-write')).toHaveText(t('backup.restore.button'));
  await backup.getByTestId('backup-write').click();
  dlg = dialog(page);
  await expect(dlg.locator('.modal-title')).toHaveText(t('backup.restore.confirmTitle'));
  await dlg.getByTestId('confirm-ok').click();
  await expect(backup.getByTestId('last-write')).toContainText(t('backup.restore.done'));
  expect(pageBytes((await readVirtualTag(app, page)).data, 10)).toEqual(P10);
  await shot(page, 'E7-04-restored');

  expect(nfc.errors).toEqual([]);
});

test('E7b 複製先のタグの横に「このタグを読み取る」が出ず、バックアップ元が黙って置き換わらない', async ({ nfc }) => {
  const { app, page, dir } = nfc;
  const uidA = await startWithReadTag(page, 'NTAG215');
  // D15: the backup screen has nothing until it reads; take the home screen's tag (one-way copy).
  let backup = await nav(page, 'backup');
  await expect(backup.getByTestId('backup-source')).toHaveCount(0);
  await nav(page, 'home');
  backup = await openFromHome(page, 'backup');
  const file = path.join(dir, 'a.nfcdump');
  await stubSaveDialog(app, file);
  await backup.getByRole('button', { name: `${t('backup.save.button')}: ${t('backup.save.project')}`, exact: true }).click();
  await expect(backup.getByTestId('backup-saved')).toBeVisible();

  await newTag(page, 'NTAG215'); // the tag to copy TO
  await expect.poll(async () => (await readerStatus(page)).card?.uid ?? null).not.toBe(uidA);
  await backup.getByTestId('backup-read-target').click();
  await expect(backup.getByTestId('backup-target')).toHaveAttribute('data-mode', 'duplicate');
  await shot(page, 'E7b-01-target-placed');

  // The only way to make the tag on the reader the SOURCE is the source card's
  // "read" button, which asks first (FLOW-14). The shared tag line must not offer
  // a silent shortcut next to the target.
  const silent = backup.getByRole('button', { name: t('reader.readThis'), exact: true });
  if ((await silent.count()) > 0) {
    await silent.first().click();
    await expect(dialog(page)).toBeVisible({ timeout: 3_000 });
  }
  await expect(backup.locator('.mono').first()).toHaveText(formatUid(uidA)); // source UID unchanged
  await expect(backup.getByTestId('backup-target')).toHaveAttribute('data-mode', 'duplicate');
  expect(nfc.errors).toEqual([]);
});
