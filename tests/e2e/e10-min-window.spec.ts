// E10 the smallest window: at a 1000 x 680 content area the binary editor's
// "write to tag" button is on screen without scrolling (the run bar is sticky),
// and nothing scrolls sideways.
import { expect, test } from './launch';
import { clearToasts, editByte, nav, shot, startWithReadTag, topAt } from './helpers';

test('E10 最小の窓（1000x680）でもバイナリ編集の「タグに書き込む」が画面内に見える', async ({ nfc }) => {
  const { app, page } = nfc;
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setContentSize(1000, 680);
  });
  await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([1000, 680]);

  await startWithReadTag(page, 'NTAG215');
  const hex = await nav(page, 'hex');
  const write = hex.getByTestId('hex-write');
  await expect(write).toBeVisible();
  await expect(write).toBeInViewport({ ratio: 1 });
  await editByte(page, 40, '5A');
  await expect(write).toBeEnabled();
  await expect(write).toBeInViewport({ ratio: 1 });

  // The page itself does not scroll sideways.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // Scrolled to the bottom of the editor the button is still on screen (sticky run bar).
  await page.locator('#main').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(write).toBeInViewport({ ratio: 1 });
  await page.locator('#main').evaluate((el) => el.scrollTo(0, 0));
  await expect(write).toBeInViewport({ ratio: 1 });
  // Right after the read the "read" toast lies on top of the button (reported as a UX
  // finding); with the toasts gone nothing else (status bar, run bar text) covers it.
  await shot(page, 'E10-01-min-window-hex-toast');
  await clearToasts(page);
  await expect.poll(() => topAt(write)).toBe('self');
  await shot(page, 'E10-02-min-window-hex');

  expect(nfc.errors).toEqual([]);
});
