// E5 taking the tag off while editing: "write to tag" is disabled and says why
// (place the tag). Placing it again enables it, and the edit is still there.
import { expect, test } from './launch';
import { dialog, editByte, nav, readVirtualTag, shot, startWithReadTag, tap } from './helpers';
import { t } from './i18n';

const BYTE = 48; // page 12, byte 0

test('E5 タグを離すと書き込みボタンが押せず理由が出る → 置き直すと押せる', async ({ nfc }) => {
  const { app, page } = nfc;
  await startWithReadTag(page, 'NTAG215');
  const hex = await nav(page, 'hex');
  await editByte(page, BYTE, '7E');
  const write = hex.getByTestId('hex-write');
  await expect(write).toBeEnabled();

  await tap(page, false);
  await expect(write).toBeDisabled();
  await expect(hex.getByTestId('hex-write-state')).toHaveText(t('op.block.absent'));
  await expect(page.getByTestId('status-card')).toHaveText(t('shell.status.tagAbsent'));
  await expect(hex.getByTestId('hex-grid').locator('.hx-cell').nth(BYTE)).toHaveText('7E');
  await shot(page, 'E5-01-removed');

  await tap(page, true);
  await expect(write).toBeEnabled();
  await expect(dialog(page)).toHaveCount(0); // auto-read does not touch the edited document
  await expect(hex.getByTestId('hex-grid').locator('.hx-cell').nth(BYTE)).toHaveText('7E');
  await shot(page, 'E5-02-placed-again');

  await write.click();
  await dialog(page).getByTestId('confirm-ok').click();
  await expect(hex.getByTestId('last-write')).toHaveAttribute('data-tone', 'ok');
  expect((await readVirtualTag(app, page)).data[BYTE]).toBe(0x7e);

  expect(nfc.errors).toEqual([]);
});
