// E2 the main flow: read -> edit one byte in the binary editor -> the "unwritten
// changes" marks (nav, status bar, document bar) -> write to the tag -> the
// confirmation names the target (kind + UID) -> the result stays on screen -> the
// marks go away -> reading again shows the new value.
import { expect, test } from './launch';
import { confirmTarget, dialog, editByte, formatUid, nav, readVirtualTag, shot, startWithReadTag, view } from './helpers';
import { t } from './i18n';

const BYTE = 40; // NTAG215 page 10, byte 0 (user memory, not the NDEF TLV)

test('E2 読み取り → 1 バイト編集 → タグに書き込む → 未書き込みの印が消える → 読み直して一致', async ({ nfc }) => {
  const { app, page } = nfc;
  const uid = await startWithReadTag(page, 'NTAG215');

  // D15: the tag read on the home screen is not carried over; the binary editor reads it itself.
  const hex = await nav(page, 'hex');
  await expect(hex.getByTestId('hex-docbar')).toHaveCount(0);
  await hex.getByTestId('hex-read').click();
  await expect(hex.getByTestId('hex-docbar')).toContainText(t('hex.doc.clean'));
  await expect(page.getByTestId('nav-dirty')).toHaveCount(0);

  await editByte(page, BYTE, 'A5');

  // --- unwritten-changes marks -------------------------------------------
  await expect(page.getByTestId('nav-hex').getByTestId('nav-dirty')).toBeVisible();
  await expect(page.getByTestId('status-dirty')).toHaveText(t('shell.status.dirtyPages', { n: 1 }));
  await expect(hex.getByTestId('hex-docbar')).toContainText(t('hex.doc.dirtyPages', { n: 1 }));
  await expect(hex.getByTestId('hex-write-state')).toHaveText(t('hex.rel.same', { uid: formatUid(uid) }));
  await shot(page, 'E2-01-edited');

  // --- write ---------------------------------------------------------------
  const write = hex.getByTestId('hex-write');
  await expect(write).toBeEnabled();
  await expect(write).toBeInViewport();
  await write.click();
  const dlg = dialog(page);
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.modal-title')).toHaveText(t('hex.cf.sameTitle'));
  await expect(dlg.getByTestId('confirm-target')).toHaveText(confirmTarget('NTAG215', uid));
  await expect(dlg.getByTestId('confirm-ok')).toHaveText(t('common.writeTag'));
  await expect(dlg.getByTestId('confirm-ok')).toBeFocused(); // a normal write: the confirm button has the focus
  await page.waitForTimeout(300); // let the dialog finish fading in for the screenshot
  await shot(page, 'E2-02-confirm');
  await dlg.getByTestId('confirm-ok').click();
  await expect(dlg).toBeHidden();

  // --- the result stays; the marks go away ------------------------------------
  const last = hex.getByTestId('last-write');
  await expect(last).toBeVisible();
  await expect(last).toHaveAttribute('data-tone', 'ok');
  await expect(last).toContainText(t('op.write.done'));
  await expect(page.getByTestId('nav-dirty')).toHaveCount(0);
  await expect(page.getByTestId('status-dirty')).toHaveCount(0);
  await expect(hex.getByTestId('hex-docbar')).toContainText(t('hex.doc.clean'));
  await shot(page, 'E2-03-written');

  // --- the tag really has it, and reading again shows it ------------------------
  const img = await readVirtualTag(app, page);
  expect(img.data[BYTE]).toBe(0xa5);

  await hex.getByTestId('hex-docbar').getByRole('button', { name: t('hex.doc.read'), exact: true }).click();
  await expect(dialog(page)).toHaveCount(0); // nothing unwritten: no "discard?" question
  await expect(view(page, 'hex').getByTestId('hex-grid').locator('.hx-cell').nth(BYTE)).toHaveText('A5');
  await expect(hex.getByTestId('hex-docbar')).toContainText(t('hex.doc.clean'));

  expect(nfc.errors).toEqual([]);
});
