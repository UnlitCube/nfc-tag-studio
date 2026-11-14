// Screen text for the E2E, taken from the app's own dictionaries (never copied into
// the specs: a wording change must not silently break a test, and a key that goes
// away is a compile error here). Only the pure dictionary files are imported (no
// React / store).
import { interpolate } from '../../src/renderer/src/i18n/define';
import common from '../../src/renderer/src/i18n/common';
import shell from '../../src/renderer/src/i18n/shell';
import hex from '../../src/renderer/src/i18n/hex';
import ndef from '../../src/renderer/src/i18n/ndef';
import schema from '../../src/renderer/src/i18n/schema';
import issue from '../../src/renderer/src/i18n/issue';
import backup from '../../src/renderer/src/i18n/backup';
import erase from '../../src/renderer/src/i18n/erase';
import factory from '../../src/renderer/src/i18n/factory';

const ja = { ...common.ja, ...shell.ja, ...hex.ja, ...ndef.ja, ...schema.ja, ...issue.ja, ...backup.ja, ...erase.ja, ...factory.ja };
export type MsgKey = keyof typeof ja;

/** Japanese text of `key` (the default UI language). */
export function t(key: MsgKey, vars?: Record<string, string | number>): string {
  return interpolate(ja[key], vars);
}

/**
 * The fixed part of a message before its first placeholder, for `toContainText`
 * when the placeholder value is not known to the test.
 */
export function prefix(key: MsgKey): string {
  const s: string = ja[key];
  const i = s.indexOf('{');
  return (i < 0 ? s : s.slice(0, i)).trim();
}

/** Escape for use inside a RegExp. */
export function re(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
