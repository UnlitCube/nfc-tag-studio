// E4 writing edits of tag A while tag B is on the reader: the app reads B first,
// the confirmation says "a different tag (copy)" with B's UID, and afterwards B has
// A's edit while B's own UID pages are untouched.
import { expect, test } from './launch';
import {
  confirmTarget,
  dialog,
  editByte,
  formatUid,
  nav,
  newTag,
  pageBytes,
  readVirtualTag,
  readerStatus,
  shot,
  startWithReadTag,
  view,
} from './helpers';
import { t } from './i18n';

const BYTE = 40; // page 10, byte 0

test('E4 タグ A の編集を別のタグ B に書き込む: 確認に「別のタグ」と B の UID、B の UID は変わらない', async ({ nfc }) => {
  const { app, page } = nfc;
  await startWithReadTag(page, 'NTAG215');
  // D15: the binary editor reads the tag itself (the home screen's read is not carried over).
  const hex = await nav(page, 'hex');
  await hex.getByTestId('hex-read').click();
  await expect(hex.getByTestId('hex-docbar')).toContainText(t('hex.doc.clean'));
  const uidA = (await readerStatus(page)).card!.uid;
  await editByte(page, BYTE, 'C7');

  await newTag(page, 'NTAG215');
  await expect.poll(async () => (await readerStatus(page)).card?.uid ?? null).not.toBe(uidA);
  const before = await readVirtualTag(app, page);
  const uidB = before.uid;
  expect(uidB).not.toBe(uidA);
  await expect(hex.getByTestId('hex-write-state')).toHaveText(t('hex.rel.otherCard', { uid: formatUid(uidB), docUid: formatUid(uidA) }));

  await hex.getByTestId('hex-write').click();
  const dlg = dialog(page);
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.modal-title')).toHaveText(t('hex.cf.copyTitle'));
  await expect(dlg.getByTestId('confirm-target')).toHaveText(confirmTarget('NTAG215', uidB));
  await expect(dlg).toContainText(t('op.write.confirm.copyCard', { idName: 'UID', uid: formatUid(uidA) }));
  await expect(dlg.getByTestId('confirm-cancel')).toBeFocused(); // a copy is a risky write
  await page.waitForTimeout(300);
  await shot(page, 'E4-01-copy-confirm');
  await dlg.getByTestId('confirm-ok').click();
  await expect(dlg).toBeHidden();

  const last = view(page, 'hex').getByTestId('last-write');
  await expect(last).toHaveAttribute('data-tone', 'ok');
  await expect(last).toContainText(formatUid(uidB));
  await shot(page, 'E4-02-copied');

  // B has A's edit, and B's UID pages (0-2) are B's.
  const after = await readVirtualTag(app, page);
  expect(after.uid).toBe(uidB);
  expect(after.data[BYTE]).toBe(0xc7);
  for (const p of [0, 1, 2]) expect(pageBytes(after.data, p)).toEqual(pageBytes(before.data, p));

  // The edit is written, so nothing was lost by switching: the document is now B
  // ("switched to the tag written" notice), clean, and reading B again shows the value.
  await expect(hex.getByTestId('hex-doc-source')).toContainText(formatUid(uidB));
  await expect(hex.getByTestId('hex-docbar')).toContainText(t('hex.doc.clean'));
  await expect(page.getByTestId('toast').filter({ hasText: t('hex.switched', { uid: formatUid(uidB) }) })).toBeVisible();
  await hex.getByTestId('hex-docbar').getByRole('button', { name: t('hex.doc.read'), exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(hex.getByTestId('hex-doc-source')).toContainText(formatUid(uidB));
  await expect(hex.getByTestId('hex-grid').locator('.hx-cell').nth(BYTE)).toHaveText('C7');

  expect(nfc.errors).toEqual([]);
});
