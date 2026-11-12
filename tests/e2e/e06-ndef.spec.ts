// E6 NDEF: the records already on a tag appear in the NDEF editor (after moving
// screens / reading again); adding a text record and writing gives 2 records; with
// 0 records "write" is disabled with the reason, and clearing is the separate
// "erase" with its own (danger) confirmation.
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './launch';
import { confirmTarget, containsUtf8, dialog, nav, readVirtualTag, shot, startWithReadTag, view } from './helpers';
import { t } from './i18n';

const URL = 'https://example.com/e2e';
const TEXT = 'こんにちは E2E';

async function addRecord(ndef: Locator, kindKey: 'ndef.kind.uri' | 'ndef.kind.text'): Promise<Locator> {
  const before = await ndef.locator('.ndef-record').count();
  await ndef.getByRole('button', { name: t('ndef.add'), exact: true }).click();
  await ndef.getByRole('menuitem', { name: t(kindKey), exact: true }).click();
  await expect(ndef.locator('.ndef-record')).toHaveCount(before + 1);
  return ndef.locator('.ndef-record').nth(before);
}

async function writeNdef(page: Page, ndef: Locator, uid: string, existingKey: string | null): Promise<void> {
  const write = ndef.getByTestId('ndef-write');
  await expect(write).toBeEnabled();
  await write.click();
  const dlg = dialog(page);
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.modal-title')).toHaveText(t('ndef.confirmTitle'));
  await expect(dlg.getByTestId('confirm-target')).toHaveText(confirmTarget('NTAG215', uid));
  if (existingKey) await expect(dlg).toContainText(existingKey);
  await dlg.getByTestId('confirm-ok').click();
  await expect(dlg).toBeHidden();
  const last = ndef.getByTestId('last-write');
  await expect(last).toHaveAttribute('data-tone', 'ok');
  await expect(last).toContainText(t('ndef.written'));
}

test('E6 NDEF: 既存のレコードが出る → テキストを足して 2 件 → 0 件は書けず「消去」で消す', async ({ nfc }) => {
  const { app, page } = nfc;
  const uid = await startWithReadTag(page, 'NTAG215');

  // --- write a URL record (the tag is blank) --------------------------------
  let ndef = await nav(page, 'ndef');
  await expect(ndef.locator('.ndef-record')).toHaveCount(0);
  const uri = await addRecord(ndef, 'ndef.kind.uri');
  await uri.locator('input').first().fill(URL);
  await expect(uri.locator('input').first()).toHaveValue(URL);
  await writeNdef(page, ndef, uid, null);
  expect(containsUtf8((await readVirtualTag(app, page)).data, 'example.com/e2e')).toBe(true);

  // --- home, read again, back: the record on the tag is shown ---------------------
  const home = await nav(page, 'home');
  await expect(home.getByTestId('home-doc-body')).toContainText(t('home.doc.ndefRecords', { n: 1 }));
  await home.getByTestId('home-read').click();
  await expect(dialog(page)).toHaveCount(0);
  ndef = await nav(page, 'ndef');
  await expect(ndef.locator('.ndef-record')).toHaveCount(1);
  await expect(ndef.locator('.ndef-record').nth(0).locator('input').first()).toHaveValue(URL);
  await expect(ndef.getByTestId('ndef-origin')).not.toContainText(t('ndef.origin.edited'));
  await shot(page, 'E6-01-existing-record');

  // --- add a text record and write: 2 records -------------------------------------
  const text = await addRecord(ndef, 'ndef.kind.text');
  await text.locator('textarea').first().fill(TEXT);
  await expect(text.locator('textarea').first()).toHaveValue(TEXT);
  await writeNdef(page, ndef, uid, t('ndef.confirmExisting.records', { n: 1 }));

  await ndef.getByTestId('ndef-read-tag').click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(ndef.locator('.ndef-record')).toHaveCount(2);
  await expect(ndef.locator('.ndef-record').nth(1).locator('textarea').first()).toHaveValue(TEXT);
  const img = await readVirtualTag(app, page);
  expect(containsUtf8(img.data, 'example.com/e2e')).toBe(true);
  expect(containsUtf8(img.data, TEXT)).toBe(true);
  await shot(page, 'E6-02-two-records');

  // --- 0 records: write is disabled with the reason; "erase" asks (danger) -----------
  for (let i = 0; i < 2; i++) {
    await ndef.locator('.ndef-record').first().getByRole('button', { name: t('ndef.remove'), exact: true }).click();
  }
  await expect(ndef.locator('.ndef-record')).toHaveCount(0);
  await expect(ndef.getByTestId('ndef-write')).toBeDisabled();
  await expect(ndef.getByTestId('ndef-write-why')).toHaveText(t('ndef.why.noRecords'));
  await ndef.getByTestId('ndef-erase').click();
  const dlg = dialog(page);
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.modal-title')).toHaveText(t('ndef.eraseTitle'));
  await expect(dlg.getByTestId('confirm-target')).toHaveText(confirmTarget('NTAG215', uid));
  await expect(dlg.getByTestId('confirm-cancel')).toBeFocused();
  // E2E-UX-5: the confirm button says what it does (not the generic "write to tag").
  await expect(dlg.getByTestId('confirm-ok')).toHaveText(t('ndef.eraseConfirm'));
  await page.waitForTimeout(300);
  await shot(page, 'E6-03-erase-confirm');
  await dlg.getByTestId('confirm-ok').click();
  await expect(dlg).toBeHidden();
  await expect(view(page, 'ndef').getByTestId('last-write')).toContainText(t('ndef.erased'));
  const erased = await readVirtualTag(app, page);
  // An empty NDEF message: TLV 03 00, or 03 03 D0 00 00 (one empty record, NFC Forum "initialized").
  const tlv = erased.data.slice(16, 21);
  expect(tlv[1] === 0x00 || (tlv[1] === 0x03 && tlv[2] === 0xd0 && tlv[3] === 0x00 && tlv[4] === 0x00), `TLV ${tlv}`).toBe(true);
  expect(containsUtf8(erased.data, TEXT)).toBe(false);
  expect(containsUtf8(erased.data, 'example.com/e2e')).toBe(false);
  // Read back on screen: no records (an empty message is not shown as a record to edit).
  await ndef.getByTestId('ndef-read-tag').click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(ndef.locator('.ndef-record')).toHaveCount(0);

  expect(nfc.errors).toEqual([]);
});
