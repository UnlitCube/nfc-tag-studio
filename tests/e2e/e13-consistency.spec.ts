// E13 consistency of the tag screens (D14, 2026-11-13):
//  - before a tag is read (or a file opened / a new one started) no editing controls
//    are shown on the NDEF editor, binary editor, backup and erase screens - only the
//    entry (tag on the reader + "read");
//  - every screen has the same way back at the bottom: 「キャンセル」 with unsaved
//    changes (asks first; "keep editing" keeps them), 「閉じる」 otherwise;
//  - going back returns to the entry, and the tag still on the reader is not read
//    again by itself (one automatic read per placement).
// D15 (2026-11-14): each screen keeps its own document - a tag read on one screen is
// not carried over to another (only the home screen's "Open in ..." copies it), and a
// write from one screen never changes another screen's document.
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './launch';
import { containsUtf8, dialog, editByte, enableSimulator, expectCardState, nav, openFromHome, readVirtualTag, shot, startWithReadTag, view } from './helpers';
import { t } from './i18n';

async function expectEntry(page: Page): Promise<void> {
  const ndef = view(page, 'ndef');
  await expect(ndef.getByTestId('ndef-entry')).toBeVisible();
  await expect(ndef.locator('.ndef-record')).toHaveCount(0);
  await expect(ndef.getByTestId('ndef-write')).toHaveCount(0);
}

async function addTextRecord(ndef: Locator, text: string): Promise<void> {
  const before = await ndef.locator('.ndef-record').count();
  await ndef.getByRole('button', { name: t('ndef.add'), exact: true }).click();
  await ndef.getByRole('menuitem', { name: t('ndef.kind.text'), exact: true }).click();
  await expect(ndef.locator('.ndef-record')).toHaveCount(before + 1);
  await ndef.locator('.ndef-record').nth(before).locator('textarea').first().fill(text);
}

test('E13 編集の画面は読み取るまで編集欄を出さず、キャンセル／閉じるで読み取る前に戻る（置いたままでも勝手に読み直さない）', async ({ nfc }) => {
  const { page } = nfc;

  // --- no tag read yet: only the entry on every tag screen ---------------------------
  await nav(page, 'ndef');
  await expectEntry(page);
  const hex = await nav(page, 'hex');
  await expect(hex.getByTestId('hex-read')).toBeVisible();
  await expect(hex.getByTestId('hex-write')).toHaveCount(0);
  const backup = await nav(page, 'backup');
  await expect(backup.getByTestId('backup-open')).toBeVisible();
  await expect(backup.getByTestId('backup-write')).toHaveCount(0);
  const erase = await nav(page, 'erase');
  await expect(erase.getByTestId('erase-entry')).toBeVisible();
  await expect(erase.getByTestId('erase-run')).toHaveCount(0);
  await shot(page, 'E13-01-erase-entry');

  // --- read on the home screen: D15 - the NDEF editor does NOT take it over; it reads itself ---
  await nav(page, 'home');
  await startWithReadTag(page, 'NTAG215');
  let ndef = await nav(page, 'ndef');
  await page.waitForTimeout(1000); // the tag stays placed: no automatic read on arrival either
  await expectEntry(page);
  await ndef.getByTestId('ndef-read-tag').click();
  await expect(ndef.getByTestId('ndef-entry')).toHaveCount(0);
  await expect(ndef.getByTestId('ndef-write')).toBeVisible();
  await expect(ndef.getByTestId('ndef-exit')).toHaveAttribute('data-exit-kind', 'close');

  // --- compose a record: 「キャンセル」 asks; "keep editing" keeps it --------------------
  await addTextRecord(ndef, 'E13 の下書き');
  const exit = ndef.getByTestId('ndef-exit');
  await expect(exit).toHaveAttribute('data-exit-kind', 'cancel');
  await expect(exit).toHaveText(t('common.exit.cancel'));
  await exit.click();
  await expect(dialog(page).locator('.modal-title')).toHaveText(t('ndef.exit.title'));
  await dialog(page).getByTestId('confirm-cancel').click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(ndef.locator('.ndef-record')).toHaveCount(1);

  // --- 「キャンセル」 + discard: back to the entry; the read document is closed too ----
  await exit.click();
  await dialog(page).getByTestId('confirm-ok').click();
  await expect(dialog(page)).toHaveCount(0);
  await expectEntry(page);
  // The tag is still on the reader: it is NOT read again by itself.
  await page.waitForTimeout(1500);
  await expectEntry(page);
  // D15: the home screen keeps its own read (the NDEF editor closed only its own).
  let home = await nav(page, 'home');
  await expect(home.getByTestId('home-doc-body')).toBeVisible();
  await shot(page, 'E13-02-ndef-cancelled');

  // --- read again from the NDEF entry, then the binary editor (its own read): edit -> cancel ---
  ndef = await nav(page, 'ndef');
  await ndef.getByTestId('ndef-read-tag').click();
  await expect(ndef.getByTestId('ndef-write')).toBeVisible();
  const hexPane = await nav(page, 'hex');
  await expect(hexPane.getByTestId('hex-read')).toBeVisible(); // D15: not the NDEF editor's / home's read
  await hexPane.getByTestId('hex-read').click();
  await editByte(page, 40, '5A');
  const hexExit = view(page, 'hex').getByTestId('hex-exit');
  await expect(hexExit).toHaveAttribute('data-exit-kind', 'cancel');
  await hexExit.click();
  await expect(dialog(page)).toBeVisible(); // "discard the unsaved change?"
  await dialog(page).getByTestId('confirm-ok').click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(view(page, 'hex').getByTestId('hex-read')).toBeVisible();
  await expect(view(page, 'hex').getByTestId('hex-write')).toHaveCount(0);
  // Closing the binary editor's document leaves the other screens' own (D15).
  home = await nav(page, 'home');
  await expect(home.getByTestId('home-doc-body')).toBeVisible();
  ndef = await nav(page, 'ndef');
  await expect(ndef.getByTestId('ndef-write')).toBeVisible();

  // --- nothing unsaved: 「閉じる」 goes back without asking (binary editor) ------------
  home = await nav(page, 'home');
  await home.getByTestId('home-to-hex').click(); // a one-way copy of the home screen's read
  const close = view(page, 'hex').getByTestId('hex-exit');
  await expect(close).toHaveAttribute('data-exit-kind', 'close');
  await expect(close).toHaveText(t('common.exit.close'));
  await close.click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(view(page, 'hex').getByTestId('hex-read')).toBeVisible();

  // --- backup: read the source -> 「閉じる」 -> the entry --------------------------------
  const bk = await nav(page, 'backup');
  await bk.getByRole('button', { name: t('backup.read'), exact: true }).click();
  await expect(bk.getByTestId('backup-source')).toBeVisible();
  await expect(bk.getByTestId('backup-exit')).toHaveAttribute('data-exit-kind', 'close');
  await bk.getByTestId('backup-exit').click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(bk.getByTestId('backup-write')).toHaveCount(0);
  await expect(bk.getByTestId('backup-open')).toBeVisible();
  await shot(page, 'E13-03-backup-closed');
});

test('E13c D15 画面ごとの文書: NDEF 編集で書いても、バイナリ編集の文書と未書き込みの変更はそのまま、結果は書いた画面にだけ出る', async ({ nfc }) => {
  const { app, page } = nfc;
  await startWithReadTag(page, 'NTAG215');
  const BYTE = 200; // NTAG215 page 50 (user memory, away from the NDEF written below)

  // The binary editor: a one-way copy of the home screen's read, with an unsaved edit.
  const hex = await openFromHome(page, 'hex');
  await editByte(page, BYTE, '5A');
  await expect(page.getByTestId('status-dirty')).toHaveText(t('shell.status.dirtyPages', { n: 1 }));
  const source = await hex.getByTestId('hex-doc-source').textContent();

  // The NDEF editor: its own read, a URL record, written to the tag.
  const ndef = await nav(page, 'ndef');
  await ndef.getByTestId('ndef-read-tag').click();
  await ndef.getByRole('button', { name: t('ndef.add'), exact: true }).click();
  await ndef.getByRole('menuitem', { name: t('ndef.kind.uri'), exact: true }).click();
  await ndef.locator('.ndef-record').first().locator('input').first().fill('https://example.com/d15');
  await ndef.getByTestId('ndef-write').click();
  await dialog(page).getByTestId('confirm-ok').click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(ndef.getByTestId('last-write')).toHaveAttribute('data-tone', 'ok');

  // On the tag: the NDEF, not the binary editor's unsaved edit.
  const img = await readVirtualTag(app, page);
  expect(containsUtf8(img.data, 'example.com/d15')).toBe(true);
  expect(img.data[BYTE]).toBe(0);

  // The binary editor: the same document, the edit still unsaved, no result from the NDEF editor.
  const hex2 = await nav(page, 'hex');
  await expect(hex2.getByTestId('hex-doc-source')).toHaveText(source ?? '');
  await expect(hex2.getByTestId('hex-grid').locator('.hx-cell').nth(BYTE)).toHaveText('5A');
  await expect(page.getByTestId('status-dirty')).toHaveText(t('shell.status.dirtyPages', { n: 1 }));
  await expect(hex2.getByTestId('last-write')).toHaveCount(0);
  await shot(page, 'E13c-01-hex-untouched');
  // The NDEF editor still shows its own result.
  await expect((await nav(page, 'ndef')).getByTestId('last-write')).toHaveAttribute('data-tone', 'ok');
  expect(nfc.errors).toEqual([]);
});

test('E13b 消去の画面は、タグを置いただけでは読み取らない', async ({ nfc }) => {
  const { page } = nfc;
  const erase = await nav(page, 'erase');
  await enableSimulator(page, 'NTAG215');
  await expectCardState(erase, 'ready');
  await page.waitForTimeout(1500);
  await expect(erase.getByTestId('erase-entry')).toBeVisible();
  await expect(erase.getByTestId('erase-tag')).toHaveCount(0);
});
