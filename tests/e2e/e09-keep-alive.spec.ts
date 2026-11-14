// E9 keep-alive (D3): records being composed in the NDEF editor survive moving to
// other screens (binary editor, home, help) and back.
import { expect, test } from './launch';
import { nav, shot, startWithReadTag } from './helpers';
import { t } from './i18n';

test('E9 NDEF で組み立て中のレコードは、他の画面へ移って戻っても残る', async ({ nfc }) => {
  const { page } = nfc;
  await startWithReadTag(page, 'NTAG215');

  let ndef = await nav(page, 'ndef');
  // D15: the NDEF editor reads the tag itself (the home screen's read is not carried over).
  await ndef.getByTestId('ndef-read-tag').click();
  await expect(ndef.getByTestId('ndef-origin')).toBeVisible();
  await ndef.getByRole('button', { name: t('ndef.add'), exact: true }).click();
  await ndef.getByRole('menuitem', { name: t('ndef.kind.text'), exact: true }).click();
  await ndef.locator('.ndef-record').first().locator('textarea').fill('組み立て中の下書き');
  await ndef.getByRole('button', { name: t('ndef.add'), exact: true }).click();
  await ndef.getByRole('menuitem', { name: t('ndef.kind.uri'), exact: true }).click();
  await ndef.locator('.ndef-record').nth(1).locator('input').first().fill('https://example.com/draft');
  await expect(ndef.getByTestId('ndef-origin')).toContainText(t('ndef.origin.edited'));

  for (const v of ['hex', 'home', 'help', 'backup'] as const) {
    const pane = await nav(page, v);
    // D15: the NDEF editor's read does not show up on the binary editor or the backup screen.
    if (v === 'hex') await expect(pane.getByTestId('hex-read')).toBeVisible();
    if (v === 'backup') await expect(pane.getByTestId('backup-source')).toHaveCount(0);
  }

  ndef = await nav(page, 'ndef');
  await expect(ndef.locator('.ndef-record')).toHaveCount(2);
  await expect(ndef.locator('.ndef-record').first().locator('textarea')).toHaveValue('組み立て中の下書き');
  await expect(ndef.locator('.ndef-record').nth(1).locator('input').first()).toHaveValue('https://example.com/draft');
  await expect(ndef.getByTestId('ndef-origin')).toContainText(t('ndef.origin.edited'));
  await shot(page, 'E9-01-draft-kept');

  expect(nfc.errors).toEqual([]);
});
