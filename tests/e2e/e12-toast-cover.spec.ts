// E12 (regression guard, 2026-11-13): right after a read, the "読み取りました" toast
// used to lie on top of the binary editor's "タグに書き込む" for ~4.5 s (bottom
// right), so a click there landed on the toast and nothing happened (measured
// every 0.5 s in the 2026-11-12 E2E run). D13 moved the toasts off the run bar.
// This test was test.fail() until the fix; it now guards it: the topmost element
// at the centre of the write button must be the button itself.
import { expect, test } from './launch';
import { editByte, nav, startWithReadTag, topAt } from './helpers';
import { t } from './i18n';

test('E12 読み取り直後のトーストが「タグに書き込む」を覆わない', async ({ nfc }) => {
  const { page } = nfc;
  await startWithReadTag(page, 'NTAG215');
  const hex = await nav(page, 'hex');
  await hex.getByTestId('hex-read').click(); // D15: the binary editor reads the tag itself
  await editByte(page, 40, 'A5');
  await hex.getByTestId('hex-docbar').getByRole('button', { name: t('hex.doc.read'), exact: true }).click();
  await page.getByTestId('confirm-ok').click(); // discard -> read again -> "read" toast
  await editByte(page, 40, 'A6');
  const write = hex.getByTestId('hex-write');
  await expect(write).toBeEnabled();
  expect(await topAt(write)).toBe('self');
});
