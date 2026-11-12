// E1 first start: the first-run guide -> home. With no reader the home screen says
// so and offers the fixes; turning on the trial (virtual reader) places a virtual
// tag, and auto-read (default on) opens it as the document.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './launch';
import { expectCardState, formatUid, readerStatus, shot, view } from './helpers';
import { prefix, t } from './i18n';

test.use({ appOptions: { onboarding: 'show' } });

test('E1 初回ガイド → ホーム → リーダーなしの案内 → お試しで自動読み取り', async ({ nfc }) => {
  const { page, userData } = nfc;

  // --- first-run guide ----------------------------------------------------
  const guide = page.getByTestId('onboarding');
  await expect(guide).toBeVisible();
  await expect(page.locator('.modal-title')).toHaveText(t('onboarding.title'));
  const start = page.getByRole('button', { name: t('onboarding.start'), exact: true });
  await expect(start).toBeFocused(); // Enter starts (not "open help")
  await shot(page, 'E1-01-onboarding');
  await start.click();
  await expect(guide).toBeHidden();

  // The flag is stored: the guide does not come back on the next start.
  await expect
    .poll(() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')).onboardingDone;
      } catch {
        return null;
      }
    })
    .toBe(true);

  // --- home, no reader ------------------------------------------------------
  const home = view(page, 'home');
  await expect(home).toBeVisible();
  await expectCardState(home, 'no-reader');
  await expect(home.getByTestId('home-guide')).toContainText(t('home.connect.title'));
  await expect(home.getByTestId('home-refresh')).toBeVisible();
  await expect(home.getByTestId('home-try-sim')).toBeVisible();
  await expect(page.getByTestId('status-reader')).toContainText(t('shell.status.connect'));
  await shot(page, 'E1-02-home-no-reader');

  // "Look again" does not break anything and keeps the guidance.
  await home.getByTestId('home-refresh').click();
  await expectCardState(home, 'no-reader');

  // --- trial: the virtual tag is placed and read automatically ----------------
  await home.getByTestId('home-try-sim').click();
  await expectCardState(home, 'ready');
  await expect(home.getByTestId('home-sim-active')).toBeVisible();
  // E2E-UX-9: turning the trial on must not scroll this notice out of view.
  await expect(home.getByTestId('home-sim-active')).toBeInViewport();
  const body = home.getByTestId('home-doc-body');
  await expect(body).toBeVisible({ timeout: 15_000 }); // auto-read opened the document
  await expect(home.getByTestId('home-doc-source')).toContainText(prefix('home.doc.sourceCard'));

  const s = await readerStatus(page);
  expect(s.simulator.enabled).toBe(true);
  expect(s.card?.uid).toBeTruthy();
  await expect(body.getByTestId('uid-text')).toHaveText(formatUid(s.card!.uid));
  await expect(home.getByTestId('home-guide')).toContainText(t('home.readySame.title'));
  await expect(page.getByTestId('status-reader')).toContainText(t('shell.status.virtual'));
  await shot(page, 'E1-03-home-trial-read');

  expect(nfc.errors).toEqual([]);
});
