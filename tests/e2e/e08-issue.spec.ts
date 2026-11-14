// E8 batch issue: started with a tag already on the reader -> "take it off first"
// (never written implicitly) -> take it off, place new tags -> each result stays on
// screen while "take it off and place the next" -> stop -> the last run is shown
// with [Resume], and resuming continues the sequence.
import type { Locator } from '@playwright/test';
import { expect, test } from './launch';
import { containsUtf8, formatUid, nav, newTag, readVirtualTag, readerStatus, shot, startWithReadTag, tap, view } from './helpers';
import { t } from './i18n';

async function issueOne(status: Locator, page: import('@playwright/test').Page, seq: number): Promise<string> {
  await newTag(page, 'NTAG215');
  await expect(status).toHaveAttribute('data-phase', 'remove', { timeout: 20_000 });
  await expect(status).toHaveAttribute('data-outcome', 'ok');
  await expect(status).toContainText(t('issue.result.okSeq', { seq }));
  await expect(status).toContainText(t('issue.after.ok'));
  return (await readerStatus(page)).card!.uid;
}

test('E8 一括発行: 置いたまま開始 → いったん離して → 結果が残る → 停止 → 続きから再開', async ({ nfc }) => {
  const { app, page } = nfc;
  const uid0 = await startWithReadTag(page, 'NTAG215');

  // --- template: one text record with the sequence number, from the NDEF editor ---------
  const ndef = await nav(page, 'ndef');
  // D15: the NDEF editor starts at its entry (the home screen's read is not carried over): start a new set.
  await ndef.getByTestId('ndef-start-new').click();
  await ndef.getByRole('button', { name: t('ndef.add'), exact: true }).click();
  await ndef.getByRole('menuitem', { name: t('ndef.kind.text'), exact: true }).click();
  await ndef.locator('.ndef-record').first().locator('textarea').fill('No.{{seq}}');
  await ndef.getByRole('button', { name: t('ndef.sendToIssue'), exact: true }).click();
  const issue = view(page, 'issue');
  await expect(issue).toBeVisible();
  await expect(issue).toContainText(t('issue.ndef.records', { n: 1 }));

  // --- start with the tag still on the reader ------------------------------------------
  await expect(issue.getByTestId('issue-start')).toBeEnabled();
  await issue.getByTestId('issue-start').click();
  const status = issue.getByTestId('issue-status');
  await expect(status).toHaveAttribute('data-phase', 'clear');
  await expect(status).toContainText(t('issue.status.clear'));
  await expect(status).toContainText(t('issue.status.clear.hint', { uid: formatUid(uid0) }));
  await shot(page, 'E8-01-clear-reader');
  // Not written implicitly: it stays at "take it off" (no reading / writing, nothing issued).
  await page.waitForTimeout(1000);
  await expect(status).toHaveAttribute('data-phase', 'clear');
  await expect(issue.getByTestId('issue-counter')).toContainText('0');
  await expect(issue.getByTestId('issue-recent')).toHaveCount(0);

  await tap(page, false);
  await expect(status).toHaveAttribute('data-phase', 'waiting');
  await expect(status).toContainText(t('issue.status.waiting'));

  // --- first tag: the result stays while waiting for the removal ----------------------------
  await issueOne(status, page, 1);
  await page.waitForTimeout(1500);
  await expect(status).toHaveAttribute('data-phase', 'remove');
  await expect(status).toContainText(t('issue.result.okSeq', { seq: 1 }));
  await expect(issue.getByTestId('issue-recent').locator('tbody tr')).toHaveCount(1);
  await expect(issue.getByTestId('issue-counter')).toContainText('1');
  await shot(page, 'E8-02-result-stays');

  await tap(page, false);
  await expect(status).toHaveAttribute('data-phase', 'waiting');
  await expect(status).toContainText(t('issue.previous', { text: t('issue.result.okSeq', { seq: 1 }) }));
  await expect(issue.getByTestId('issue-recent').locator('tbody tr')).toHaveCount(1);

  // --- second tag, then stop -------------------------------------------------------------
  await issueOne(status, page, 2);
  await tap(page, false);
  await expect(status).toHaveAttribute('data-phase', 'waiting');
  await issue.getByTestId('issue-stop').click();

  const lastRun = issue.getByTestId('issue-last-run');
  await expect(lastRun).toBeVisible({ timeout: 15_000 });
  await expect(lastRun).toHaveAttribute('data-reason', 'user');
  await expect(lastRun).toContainText(t('issue.last.user'));
  await expect(lastRun).toContainText(t('issue.last.resume.seq', { seq: 3 }));
  const resume = issue.getByTestId('issue-resume');
  await expect(resume).toBeVisible();
  await expect(resume).toBeEnabled();
  await shot(page, 'E8-03-stopped-resume');

  // --- resume: the sequence continues at 3 --------------------------------------------------
  await resume.click();
  await expect(status).toHaveAttribute('data-phase', 'waiting');
  await issueOne(status, page, 3);
  await issue.getByTestId('issue-stop').click();
  await expect(issue.getByTestId('issue-last-run')).toContainText(t('issue.last.resume.seq', { seq: 4 }));
  // (main refuses reads while issuing, so the tag is checked after the stop) - the 3rd tag is still on the reader.
  expect(containsUtf8((await readVirtualTag(app, page)).data, 'No.3')).toBe(true);
  expect(containsUtf8((await readVirtualTag(app, page)).data, 'No.2')).toBe(false);

  expect(nfc.errors).toEqual([]);
});
