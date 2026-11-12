// main-process policies: settings normalisation (old / corrupt files), the
// E2E switch that keeps PC/SC off (D8), and the quit dialog texts.
import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import { issuingQuitText, normaliseSettings, pcscEnabled, quitDialogAutoAnswer, unsavedQuitText } from '../src/main/services/policy';

describe('normaliseSettings', () => {
  it('a settings file from before autoRead existed turns it on (default)', () => {
    const old = { theme: 'dark', language: 'en', sound: false, advancedMode: true, confirmBeforeWrite: false, driverMode: 'storage', preferredReader: 'Sony FeliCa Port/PaSoRi 3.0 0', onboardingDone: true, savedJobs: [], schemas: [] };
    const s = normaliseSettings(old);
    expect(s.autoRead).toBe(true);
    expect(s.theme).toBe('dark');
    expect(s.language).toBe('en');
    expect(s.sound).toBe(false);
    expect(s.driverMode).toBe('storage');
    expect(s.preferredReader).toBe('Sony FeliCa Port/PaSoRi 3.0 0');
  });

  it('keeps autoRead off when the operator turned it off', () => {
    expect(normaliseSettings({ autoRead: false }).autoRead).toBe(false);
  });

  it('repairs wrong types instead of passing them on', () => {
    const s = normaliseSettings({ autoRead: 'yes', sound: 1, advancedMode: 'true', theme: 'blue', language: 'fr', driverMode: 'x', preferredReader: '', savedJobs: {}, schemas: 'no' });
    expect(s.autoRead).toBe(true);
    expect(s.sound).toBe(DEFAULT_SETTINGS.sound);
    expect(s.advancedMode).toBe(false);
    expect(s.theme).toBe('system');
    expect(s.language).toBe('ja');
    expect(s.driverMode).toBe('auto');
    expect(s.preferredReader).toBeNull();
    expect(s.savedJobs).toEqual([]);
    expect(s.schemas).toEqual([]);
  });

  it('an empty / corrupt file gives the defaults', () => {
    expect(normaliseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normaliseSettings([1, 2])).toEqual(DEFAULT_SETTINGS);
    expect(normaliseSettings('x')).toEqual(DEFAULT_SETTINGS);
  });
});

describe('pcscEnabled (NFCTS_NO_PCSC, D8)', () => {
  it('development / E2E: NFCTS_NO_PCSC=1 keeps PC/SC off', () => {
    expect(pcscEnabled({ NFCTS_NO_PCSC: '1' }, false)).toBe(false);
  });
  it('normally on', () => {
    expect(pcscEnabled({}, false)).toBe(true);
    expect(pcscEnabled({ NFCTS_NO_PCSC: '0' }, false)).toBe(true);
  });
  it('a packaged build ignores the variable', () => {
    expect(pcscEnabled({ NFCTS_NO_PCSC: '1' }, true)).toBe(true);
  });
});

describe('quitDialogAutoAnswer (automation never blocks on a native modal)', () => {
  it('a packaged build always shows the dialog', () => {
    expect(quitDialogAutoAnswer({ NFCTS_DIALOG_AUTO: 'proceed', NFCTS_E2E: '1' }, true)).toBeNull();
  });
  it('development: explicit answer, else proceed under E2E / smoke, else ask', () => {
    expect(quitDialogAutoAnswer({ NFCTS_DIALOG_AUTO: 'cancel', NFCTS_E2E: '1' }, false)).toBe('cancel');
    expect(quitDialogAutoAnswer({ NFCTS_SMOKE: '1' }, false)).toBe('proceed');
    expect(quitDialogAutoAnswer({ NFCTS_E2E: '1' }, false)).toBe('proceed');
    expect(quitDialogAutoAnswer({ NFCTS_DIALOG_AUTO: 'maybe' }, false)).toBeNull();
    expect(quitDialogAutoAnswer({}, false)).toBeNull();
  });
});

describe('quit dialog texts', () => {
  it('unsaved changes: the agreed wording, cancel second (default)', () => {
    const ja = unsavedQuitText('ja');
    expect(ja.message).toBe('未書き込みの変更があります。終了しますか？');
    expect(ja.buttons).toEqual(['終了', 'キャンセル']);
    const en = unsavedQuitText('en');
    expect(en.buttons[1]).toBe('Cancel');
    expect(en.message).not.toMatch(/[぀-ヿ一-鿿]/);
  });
  it('issuing: says the tag being written is finished first', () => {
    expect(issuingQuitText('ja').detail).toContain('書き終えてから');
    expect(issuingQuitText('en').message).not.toMatch(/[぀-ヿ一-鿿]/);
  });
});
