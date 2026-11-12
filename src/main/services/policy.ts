// Pure main-process policies (no Electron imports, unit-tested in
// tests/main-policy.test.ts). Owner: main-app.
import type { AppSettings, LanguageSetting } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';

const BOOLEAN_KEYS = ['sound', 'advancedMode', 'confirmBeforeWrite', 'autoRead', 'onboardingDone'] as const;

/**
 * Settings read from disk (possibly written by an older version, or corrupt)
 * -> a complete AppSettings. Missing / wrong-typed fields get their defaults, so
 * a settings file from before `autoRead` existed turns it on (the default).
 */
export function normaliseSettings(value: unknown): AppSettings {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? (value as Partial<AppSettings>) : {};
  const merged: AppSettings = { ...DEFAULT_SETTINGS, ...v };
  if (!['system', 'light', 'dark'].includes(merged.theme)) merged.theme = DEFAULT_SETTINGS.theme;
  if (!['ja', 'en'].includes(merged.language)) merged.language = DEFAULT_SETTINGS.language;
  if (!['auto', 'acr122', 'transparent', 'storage'].includes(merged.driverMode)) merged.driverMode = 'auto';
  for (const k of BOOLEAN_KEYS) {
    if (typeof merged[k] !== 'boolean') merged[k] = DEFAULT_SETTINGS[k];
  }
  if (typeof merged.preferredReader !== 'string' || merged.preferredReader.trim() === '') merged.preferredReader = null;
  // Never keep an NTAG password in settings.json (I4), whatever wrote it.
  merged.savedJobs = Array.isArray(merged.savedJobs)
    ? merged.savedJobs
        .filter((j) => !!j && typeof j === 'object')
        .map((j) => (j.options && j.options.ntagProtect ? { ...j, options: { ...j.options, ntagProtect: null } } : j))
    : [];
  merged.schemas = Array.isArray(merged.schemas) ? merged.schemas : [];
  return merged;
}

/**
 * Whether the PC/SC backend may start. E2E / CI set NFCTS_NO_PCSC=1 so the app
 * has only the virtual reader and can never touch a real reader or a real tag.
 * A packaged build ignores the variable (decision D8).
 */
export function pcscEnabled(env: Record<string, string | undefined>, isPackaged: boolean): boolean {
  return !(env.NFCTS_NO_PCSC === '1' && !isPackaged);
}

/**
 * Automation never blocks on a native modal (Playwright's app.close() would hang
 * on the quit confirmation). Development builds only - a packaged build always asks:
 *  - NFCTS_DIALOG_AUTO=proceed|cancel answers the quit confirmations (E2E can
 *    assert that unwritten changes keep the window open with "cancel");
 *  - otherwise NFCTS_E2E=1 / NFCTS_SMOKE=1 answer "proceed".
 * null = show the dialog.
 */
export function quitDialogAutoAnswer(env: Record<string, string | undefined>, isPackaged: boolean): 'proceed' | 'cancel' | null {
  if (isPackaged) return null;
  const v = env.NFCTS_DIALOG_AUTO;
  if (v === 'proceed' || v === 'cancel') return v;
  if (env.NFCTS_E2E === '1' || env.NFCTS_SMOKE === '1') return 'proceed';
  return null;
}

export interface QuitDialogText {
  title: string;
  message: string;
  detail: string;
  /** [proceed, cancel] - cancel is the default button. */
  buttons: [string, string];
}

/** Window close while the renderer holds unwritten changes (beforeunload prevented it). */
export function unsavedQuitText(lang: LanguageSetting): QuitDialogText {
  return lang === 'en'
    ? {
        title: 'NFC Tag Studio',
        message: 'You have changes that are not written yet. Quit anyway?',
        detail: 'If you quit, the changes that were not written to a tag or saved to a file are lost.',
        buttons: ['Quit', 'Cancel'],
      }
    : {
        title: 'NFC Tag Studio',
        message: '未書き込みの変更があります。終了しますか？',
        detail: '終了すると、タグに書き込んでいない・ファイルに保存していない変更は失われます。',
        buttons: ['終了', 'キャンセル'],
      };
}

/** Window close while batch issuing is running. */
export function issuingQuitText(lang: LanguageSetting): QuitDialogText {
  return lang === 'en'
    ? {
        title: 'NFC Tag Studio',
        message: 'Batch issuing is running. Stop it and quit?',
        detail: 'A tag being written is finished first. Keep it on the reader until the app closes.',
        buttons: ['Stop and quit', 'Cancel'],
      }
    : {
        title: 'NFC Tag Studio',
        message: '一括発行を実行中です。停止して終了しますか？',
        detail: '書き込み中のタグは、書き終えてから止まります。アプリが閉じるまでタグをリーダーの上に置いたままにしてください。',
        buttons: ['停止して終了', 'キャンセル'],
      };
}
