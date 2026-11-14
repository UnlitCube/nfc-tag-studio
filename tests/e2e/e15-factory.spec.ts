// E15 full reset ("完全初期化", 2026-11-14) on the virtual reader:
//  - without advanced mode the tag can be read and the plan checked, but not run;
//  - with advanced mode: a used NTAG215 (URL + NFC counter on + UID mirror on) goes back to
//    the factory image after a danger confirmation that names the tag and needs the typed
//    word; the UID / lock / CC pages never change;
//  - a password-protected tag is refused with the reason;
//  - a MIFARE Classic 1K goes back to the transport configuration.
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from './launch';
import { confirmTarget, dialog, enableSimulator, expectCardState, nav, newTag, readVirtualTag, readerStatus, shot } from './helpers';
import { t } from './i18n';
import { factoryImage, ntagPages } from '../../src/shared/tags';
import { hexToBytes } from '../../src/shared/hex';

/** Set-up writes on the virtual tag, protected pages allowed (advanced mode is on in these tests). */
async function setUp(app: ElectronApplication, page: Page, writes: { unit: number; bytes: number[] }[]): Promise<void> {
  const s = await readerStatus(page);
  if (s.activeReader !== 'NFC Tag Studio Virtual NFC Reader' || !s.card?.kind) throw new Error(`[SAFETY] active reader is ${s.activeReader}`);
  void app;
  const env = await page.evaluate(
    async ([kind, uid, ws]) =>
      window.nfcBridge.writeTag({ kind, expectedUid: uid, writes: ws.map((w) => ({ unit: w.unit, data: new Uint8Array(w.bytes) })), allowProtected: true, verify: false }),
    [s.card.kind, s.card.uid, writes] as const,
  );
  if (!env.ok) throw new Error(`set-up write failed: ${JSON.stringify(env.error)}`);
}

async function runReset(page: Page, kind: Parameters<typeof confirmTarget>[0], uid: string): Promise<void> {
  const view = page.locator('.view-pane[data-view="factory"]:not([hidden])');
  await view.getByTestId('factory-run').click();
  const dlg = dialog(page);
  await expect(dlg.locator('.modal-title')).toHaveText(t('factory.cf.title'));
  await expect(dlg.getByTestId('confirm-target')).toHaveText(confirmTarget(kind, uid));
  await expect(dlg.getByTestId('confirm-ok')).toBeDisabled(); // the typed word is required
  await dlg.locator('input').fill(t('factory.cf.word'));
  await dlg.getByTestId('confirm-ok').click();
  await expect(dlg).toHaveCount(0);
  await expect(view.getByTestId('last-write')).toHaveAttribute('data-tone', 'ok');
}

test.describe('advanced mode off', () => {
  test('E15a 上級者モードでないときは、読み取って確かめられるが実行できない', async ({ nfc }) => {
    const { page } = nfc;
    const view = await nav(page, 'factory');
    await expect(view.getByTestId('factory-open-settings')).toBeVisible();
    await enableSimulator(page, 'NTAG215');
    await expectCardState(view, 'ready');
    await page.waitForTimeout(1000);
    await expect(view.getByTestId('factory-entry')).toBeVisible(); // never reads by itself
    await view.getByTestId('factory-read').click();
    await expect(view.getByTestId('factory-restore')).toBeVisible();
    await expect(view.getByTestId('factory-run')).toBeDisabled();
    await expect(view.getByTestId('factory-why')).toHaveText(t('factory.why.advanced'));
  });
});

test.describe('advanced mode on', () => {
  test.use({ appOptions: { settings: { advancedMode: true } } });

  test('E15 完全初期化: 使った NTAG215 が工場出荷時の内容に戻る（UID・ロック・CC は変わらない）／パスワード保護は断る／MIFARE も戻る', async ({ nfc }) => {
    const { app, page } = nfc;
    const view = await nav(page, 'factory');
    await enableSimulator(page, 'NTAG215');
    await expectCardState(view, 'ready');
    const s = await readerStatus(page);
    const uid = s.card!.uid;
    const p = ntagPages('NTAG215');
    await setUp(app, page, [
      { unit: 4, bytes: [0x03, 0x0b, 0xd1, 0x01] },
      { unit: 5, bytes: [0x07, 0x55, 0x04, 0x61] },
      { unit: 60, bytes: [0xde, 0xad, 0xbe, 0xef] },
      { unit: p.cfg1, bytes: [0x10, 0x05, 0x00, 0x00] }, // NFC counter on
      { unit: p.cfg0, bytes: [0x44, 0x00, 0x00, 0xff] }, // UID mirror on
    ]);
    const before = await readVirtualTag(app, page);

    await view.getByTestId('factory-read').click();
    await expect(view.getByTestId('factory-uid')).toHaveText(uid.match(/../g)!.join(':'));
    await expect(view.getByTestId('factory-restore').locator('[data-area="config"]')).toBeVisible();
    await expect(view.getByTestId('factory-restore').locator('[data-area="password"]')).toBeVisible();
    await expect(view.getByTestId('factory-cannot').locator('[data-issue="counter"]')).toBeVisible();
    await expect(view.getByTestId('factory-run')).toBeEnabled();
    await shot(page, 'E15-01-plan');

    await runReset(page, 'NTAG215', uid);
    const after = await readVirtualTag(app, page);
    const fac = factoryImage('NTAG215', hexToBytes(uid));
    // Everything readable is the factory image (PWD reads as 00 on the virtual reader too).
    for (let u = 0; u < p.pwd; u++) expect(after.data.slice(u * 4, u * 4 + 4), `page ${u}`).toEqual([...fac.slice(u * 4, u * 4 + 4)]);
    expect(after.data.slice(0, 16)).toEqual(before.data.slice(0, 16)); // UID / lock / CC unchanged
    await expect(view.getByTestId('factory-restore')).toContainText(t('factory.already'));
    await shot(page, 'E15-02-reset');

    // --- a password-protected tag is refused ---------------------------------------------
    await setUp(app, page, [{ unit: p.cfg0, bytes: [0x04, 0x00, 0x00, 0x10] }]); // AUTH0 = page 16
    await view.getByTestId('factory-reread').click();
    await expect(view.getByTestId('factory-block')).toHaveText(t('factory.block.password'));
    await expect(view.getByTestId('factory-run')).toBeDisabled();
    await view.getByTestId('factory-exit').click();
    await expect(view.getByTestId('factory-entry')).toBeVisible();

    // --- MIFARE Classic 1K: data blocks 00, trailers to the transport configuration ----------
    await newTag(page, 'MIFARE_CLASSIC_1K');
    await expectCardState(view, 'ready');
    const m = await readerStatus(page);
    await setUp(app, page, [{ unit: 4, bytes: new Array(16).fill(0x5a) }]);
    await view.getByTestId('factory-read').click();
    await expect(view.getByTestId('factory-restore').locator('[data-area="trailers"]')).toBeVisible();
    await runReset(page, 'MIFARE_CLASSIC_1K', m.card!.uid);
    const mi = await readVirtualTag(app, page);
    expect(mi.data.slice(4 * 16, 5 * 16).every((b) => b === 0)).toBe(true);
    expect(mi.data.slice(7 * 16 + 6, 7 * 16 + 10)).toEqual([0xff, 0x07, 0x80, 0x69]);
  });
});
