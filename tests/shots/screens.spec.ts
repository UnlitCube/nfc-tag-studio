// README・Wiki・Pages に載せる画面のキャプチャ（npm run shots）。E2E と同じ起動（tests/e2e/launch.ts）なので、
// 仮想リーダーだけを使い、実機のリーダーとタグには触れない（NFCTS_NO_PCSC=1 と koffi の番人）。
// 書き出し先は docs/images/<ja|en>/<画面>.png。値はすべて架空（example.com・仮想タグの UID）。
// 普段の npm run e2e には入らない（playwright.shots.config.ts の testDir は tests/shots）。
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, test } from '../e2e/launch';
import { clearToasts, dialog, nav, startWithReadTag, view } from '../e2e/helpers';
import { interpolate } from '../../src/renderer/src/i18n/define';
import common from '../../src/renderer/src/i18n/common';
import shell from '../../src/renderer/src/i18n/shell';
import ndefDict from '../../src/renderer/src/i18n/ndef';

type Lang = 'ja' | 'en';
const DICT = {
  ja: { ...common.ja, ...shell.ja, ...ndefDict.ja },
  en: { ...common.en, ...shell.en, ...ndefDict.en },
};
type Key = keyof (typeof DICT)['ja'];
const tr = (lang: Lang, key: Key, vars?: Record<string, string | number>): string => interpolate(DICT[lang][key], vars);

const OUT = path.resolve(__dirname, '..', '..', 'docs', 'images');
const SAMPLE = {
  ja: { url: 'https://example.com/', text: '総務部 受付（3F）' },
  en: { url: 'https://example.com/', text: 'Reception desk (3F)' },
};

async function setWindow(app: ElectronApplication, page: Page): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
  await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([1280, 800]);
}

async function capture(page: Page, lang: Lang, name: string): Promise<void> {
  await clearToasts(page);
  await page.mouse.move(1270, 790);
  await page.waitForTimeout(400);
  fs.mkdirSync(path.join(OUT, lang), { recursive: true });
  await page.screenshot({ path: path.join(OUT, lang, `${name}.png`) });
}

async function addRecord(lang: Lang, ndef: Locator, kind: 'ndef.kind.uri' | 'ndef.kind.text'): Promise<Locator> {
  const before = await ndef.locator('.ndef-record').count();
  await ndef.getByRole('button', { name: tr(lang, 'ndef.add'), exact: true }).click();
  await ndef.getByRole('menuitem', { name: tr(lang, kind), exact: true }).click();
  await expect(ndef.locator('.ndef-record')).toHaveCount(before + 1);
  return ndef.locator('.ndef-record').nth(before);
}

/** 仮想の NTAG215 に URL とテキストの 2 件を書いておく（読み取り・NDEF 編集・バイナリ編集の画面に中身が出る） */
async function prepareTag(lang: Lang, page: Page): Promise<void> {
  await startWithReadTag(page, 'NTAG215');
  const ndef = await nav(page, 'ndef');
  const uri = await addRecord(lang, ndef, 'ndef.kind.uri');
  await uri.locator('input').first().fill(SAMPLE[lang].url);
  const text = await addRecord(lang, ndef, 'ndef.kind.text');
  await text.locator('textarea').first().fill(SAMPLE[lang].text);
  await ndef.getByTestId('ndef-write').click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByTestId('confirm-ok').click();
  await expect(dialog(page)).toBeHidden();
  await expect(ndef.getByTestId('last-write')).toHaveAttribute('data-tone', 'ok');
  const home = await nav(page, 'home');
  await home.getByTestId('home-read').click();
  await expect(home.getByTestId('home-doc-body')).toContainText(tr(lang, 'home.doc.ndefRecords', { n: 2 }));
}

for (const lang of ['ja', 'en'] as const) {
  test.describe(`screens (${lang})`, () => {
    test.use({ appOptions: { settings: { language: lang, theme: 'light' } } });

    test(`main screens ${lang}`, async ({ nfc }) => {
      const { app, page } = nfc;
      await setWindow(app, page);
      await prepareTag(lang, page);
      await capture(page, lang, 'home');

      const ndef = await nav(page, 'ndef');
      await ndef.getByTestId('ndef-read-tag').click();
      await expect(ndef.locator('.ndef-record')).toHaveCount(2);
      await capture(page, lang, 'ndef');

      await nav(page, 'hex');
      await expect(view(page, 'hex').getByTestId('hex-grid')).toBeVisible();
      await capture(page, lang, 'hex');

      for (const id of ['issue', 'backup', 'schema', 'keys', 'settings'] as const) {
        await nav(page, id);
        await capture(page, lang, id);
      }
    });
  });
}

test.describe('screens (dark)', () => {
  test.use({ appOptions: { settings: { language: 'ja', theme: 'dark' } } });
  test('home in the dark theme', async ({ nfc }) => {
    const { app, page } = nfc;
    await setWindow(app, page);
    await prepareTag('ja', page);
    await capture(page, 'ja', 'home-dark');
  });
});
