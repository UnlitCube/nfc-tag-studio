// E14 erase screen ("消去", 2026-11-13): read -> what the tag holds -> erase the NDEF
// (danger confirmation naming the tag) -> erase the whole data area -> the user memory
// is the factory content and the UID / lock / CC pages did not change -> 「閉じる」.
import { expect, test } from './launch';
import { confirmTarget, containsUtf8, dialog, nav, readVirtualTag, shot, startWithReadTag } from './helpers';
import { t } from './i18n';

const URL = 'https://example.com/e14-erase';

test('E14 消去: NDEF を空にする → データ領域をすべて消す（UID・ロック・CC は変わらない）→ 閉じる', async ({ nfc }) => {
  const { app, page } = nfc;
  const uid = await startWithReadTag(page, 'NTAG215');

  // A URL on the tag, written the normal way (NDEF editor).
  const ndef = await nav(page, 'ndef');
  await ndef.getByTestId('ndef-start-new').click(); // D15: the NDEF editor starts at its entry
  await ndef.getByRole('button', { name: t('ndef.add'), exact: true }).click();
  await ndef.getByRole('menuitem', { name: t('ndef.kind.uri'), exact: true }).click();
  await ndef.locator('.ndef-record').first().locator('input').first().fill(URL);
  await ndef.getByTestId('ndef-write').click();
  await dialog(page).getByTestId('confirm-ok').click();
  await expect(ndef.getByTestId('last-write')).toHaveAttribute('data-tone', 'ok');
  const before = await readVirtualTag(app, page);
  expect(containsUtf8(before.data, 'example.com/e14-erase')).toBe(true);

  // --- read on the erase screen -----------------------------------------------------
  const erase = await nav(page, 'erase');
  await expect(erase.getByTestId('erase-entry')).toBeVisible();
  await erase.getByTestId('erase-read').click();
  await expect(erase.getByTestId('erase-tag')).toBeVisible();
  await expect(erase.getByTestId('erase-ndef')).toHaveText(t('erase.ndef.records', { n: 1 }));
  await expect(erase.getByTestId('erase-mode-ndef').locator('input')).toBeChecked();
  await expect(erase.getByTestId('erase-exit')).toHaveAttribute('data-exit-kind', 'close');
  await shot(page, 'E14-01-read');

  // --- erase the NDEF: danger confirmation with the tag ------------------------------
  await erase.getByTestId('erase-run').click();
  const dlg = dialog(page);
  await expect(dlg.locator('.modal-title')).toHaveText(t('erase.cf.title'));
  await expect(dlg.getByTestId('confirm-target')).toHaveText(confirmTarget('NTAG215', uid));
  await expect(dlg.getByTestId('confirm-ok')).toHaveText(t('erase.run'));
  await dlg.getByTestId('confirm-ok').click();
  await expect(dlg).toHaveCount(0);
  await expect(erase.getByTestId('last-write')).toHaveAttribute('data-tone', 'ok');
  await expect(erase.getByTestId('erase-ndef')).toHaveText(t('erase.ndef.empty'));
  const afterNdef = await readVirtualTag(app, page);
  expect(containsUtf8(afterNdef.data, 'example.com/e14-erase')).toBe(false);

  // --- erase the whole data area ------------------------------------------------------
  await erase.getByTestId('erase-mode-all').click();
  await erase.getByTestId('erase-run').click();
  await expect(dialog(page).getByTestId('confirm-target')).toHaveText(confirmTarget('NTAG215', uid));
  await dialog(page).getByTestId('confirm-ok').click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(erase.getByTestId('last-write')).toHaveAttribute('data-tone', 'ok');
  await expect(erase.getByTestId('erase-mode-all')).toContainText(t('erase.mode.already'));
  await expect(erase.getByTestId('erase-run')).toBeDisabled();
  await expect(erase.getByTestId('erase-why')).toHaveText(t('erase.why.nothing'));
  const after = await readVirtualTag(app, page);
  // UID / static lock / CC (pages 0-3) unchanged; the user memory is the factory content.
  expect(after.data.slice(0, 16)).toEqual(before.data.slice(0, 16));
  expect(after.data.slice(16, 20)).toEqual([0x03, 0x00, 0xfe, 0x00]);
  expect(after.data.slice(20, 130 * 4).every((b) => b === 0)).toBe(true);
  // The configuration pages after the user memory did not change.
  expect(after.data.slice(130 * 4)).toEqual(before.data.slice(130 * 4));
  await shot(page, 'E14-02-erased');

  // --- 「閉じる」: back to the entry -----------------------------------------------------
  await erase.getByTestId('erase-exit').click();
  await expect(erase.getByTestId('erase-entry')).toBeVisible();
  await expect(erase.getByTestId('erase-run')).toHaveCount(0);
});
