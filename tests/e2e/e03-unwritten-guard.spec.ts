// E3 unwritten changes are never dropped silently:
//  - "read" with edits asks first; Cancel keeps the edits, Discard replaces them.
//  - placing a different tag while editing does NOT replace the document (auto-read
//    stays away from a dirty document) and the screen says "a different tag".
import { expect, test } from './launch';
import { dialog, editByte, formatUid, nav, newTag, openFromHome, readerStatus, shot, startWithReadTag, view } from './helpers';
import { prefix, t } from './i18n';

const BYTE = 44; // NTAG215 page 11, byte 0

test('E3 未書き込みの確認: キャンセルで残る・破棄で置き換わる・別のタグは自動で置き換えない', async ({ nfc }) => {
  const { page } = nfc;
  const uidA = await startWithReadTag(page, 'NTAG215');
  // D15: the home screen's tag goes to the binary editor only with "Open in binary editor".
  const hex = await openFromHome(page, 'hex');
  const cell = hex.getByTestId('hex-grid').locator('.hx-cell').nth(BYTE);
  const readBtn = hex.getByTestId('hex-docbar').getByRole('button', { name: t('hex.doc.read'), exact: true });

  await editByte(page, BYTE, '3C');

  // --- read with edits -> asked; Cancel keeps them ----------------------------
  await readBtn.click();
  const dlg = dialog(page);
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.modal-title')).toHaveText(t('discard.title'));
  await expect(dlg.getByTestId('confirm-ok')).toHaveText(t('discard.confirm'));
  await expect(dlg.getByTestId('confirm-target')).toContainText(formatUid(uidA));
  // Risky choice: the focus starts on Cancel, Enter alone does not discard.
  await expect(dlg.getByTestId('confirm-cancel')).toBeFocused();
  await page.waitForTimeout(300);
  await shot(page, 'E3-01-discard-confirm');
  await dlg.getByTestId('confirm-cancel').click();
  await expect(dlg).toBeHidden();
  await expect(cell).toHaveText('3C');
  await expect(page.getByTestId('status-dirty')).toHaveText(t('shell.status.dirtyPages', { n: 1 }));

  // --- read again -> Discard replaces the document ------------------------------
  await readBtn.click();
  await expect(dlg).toBeVisible();
  await dlg.getByTestId('confirm-ok').click();
  await expect(dlg).toBeHidden();
  await expect(cell).toHaveText('00');
  await expect(hex.getByTestId('hex-docbar')).toContainText(t('hex.doc.clean'));
  await expect(page.getByTestId('status-dirty')).toHaveCount(0);

  // --- a different tag while editing: never replaced automatically ----------------
  await editByte(page, BYTE, '3C');
  await newTag(page, 'NTAG215');
  await expect.poll(async () => (await readerStatus(page)).card?.uid ?? null).not.toBe(uidA);
  const uidB = (await readerStatus(page)).card!.uid;
  await expect(hex.getByTestId('hex-write-state')).toHaveText(t('hex.rel.otherCard', { uid: formatUid(uidB), docUid: formatUid(uidA) }));
  // (the run bar shows this button twice: TagOnReader's and the binary editor's own - see the UX notes)
  await expect(hex.getByTestId('hex-runbar').getByRole('button', { name: t('hex.rel.readThis'), exact: true }).first()).toBeVisible();
  await page.waitForTimeout(1000); // give auto-read every chance to (wrongly) run
  await expect(dialog(page)).toHaveCount(0);
  await expect(cell).toHaveText('3C');
  await expect(hex.getByTestId('hex-doc-source')).toContainText(formatUid(uidA));
  await shot(page, 'E3-02-hex-other-tag');

  // The home screen keeps its own read of tag A (D15): B is "another tag" there too, but the
  // binary editor's unsaved edits are not the home screen's (no "unsaved" line on home).
  const home = await nav(page, 'home');
  await expect(home.getByTestId('tag-on-reader-other')).toContainText(t('reader.otherTag'));
  await expect(home.getByTestId('home-guide')).toContainText(t('home.readyOther.title'));
  await expect(home.getByTestId('home-guide')).not.toContainText(t('home.readyOther.dirty'));
  await expect(home.getByTestId('home-doc-source')).toContainText(prefix('home.doc.sourceCard'));
  await expect(home.getByTestId('home-doc-body').getByTestId('uid-text')).toHaveText(formatUid(uidA));
  await expect(view(page, 'home').getByTestId('home-doc-on-reader')).toHaveAttribute('data-where', 'other-tag');
  await shot(page, 'E3-03-home-other-tag');

  expect(nfc.errors).toEqual([]);
});
