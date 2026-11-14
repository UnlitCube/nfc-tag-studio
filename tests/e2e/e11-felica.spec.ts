// E11 FeliCa Lite-S (virtual): home calls the id "IDm" and offers no NDEF; the
// binary editor edits a user block (S_PAD) and writes it.
import { expect, test } from './launch';
import { confirmTarget, dialog, editByte, openFromHome, readVirtualTag, shot, startWithReadTag, view } from './helpers';
import { t } from './i18n';

const BYTE = 32; // S_PAD2, byte 0 (FeliCa unit = 16-byte block)

test('E11 FeliCa Lite-S: ホームは IDm と表示し NDEF を出さない → ユーザーブロックを編集して書ける', async ({ nfc }) => {
  const { app, page } = nfc;
  const idm = await startWithReadTag(page, 'FELICA_LITE_S');
  const home = view(page, 'home');
  const body = home.getByTestId('home-doc-body');
  await expect(body).toContainText(t('home.idm'));
  await expect(body).not.toContainText(t('home.uid'));
  await expect(body).toContainText(t('home.doc.felicaNote'));
  await expect(home.getByTestId('home-to-ndef')).toHaveCount(0);
  await expect(body.locator('dt').filter({ hasText: new RegExp(`^${t('home.doc.ndef')}$`) })).toHaveCount(0);
  await shot(page, 'E11-01-home-felica');

  const hex = await openFromHome(page, 'hex'); // D15: a one-way copy of the home screen's tag
  await editByte(page, BYTE, '5A');
  await expect(page.getByTestId('status-dirty')).toHaveText(t('shell.status.dirtyBlocks', { n: 1 }));
  await hex.getByTestId('hex-write').click();
  const dlg = dialog(page);
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId('confirm-target')).toHaveText(confirmTarget('FELICA_LITE_S', idm));
  await page.waitForTimeout(300);
  await shot(page, 'E11-02-felica-confirm');
  await dlg.getByTestId('confirm-ok').click();
  await expect(hex.getByTestId('last-write')).toHaveAttribute('data-tone', 'ok');
  await expect(page.getByTestId('status-dirty')).toHaveCount(0);

  const img = await readVirtualTag(app, page);
  expect(img.kind).toBe('FELICA_LITE_S');
  expect(img.data[BYTE]).toBe(0x5a);

  expect(nfc.errors).toEqual([]);
});
