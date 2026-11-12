// Reader choices for Settings. Pure (tests/shell-home.test.ts). Owner: shell-ui.
// Automatic first, then NFC readers, then devices that are not detected as NFC
// readers ("{name} (not detected as an NFC reader)"), and the selected reader even
// when it is not connected ("(not connected) name"), so a stale selection is
// visible instead of the <select> silently showing "Automatic" (2026-11-12 UX
// audit CARD-14 / CARD-7).
//
// D10 (2026-11-12 review R-UX-7): a device that is not detected as an NFC reader
// (USB token, YubiKey, contact reader...) stays selectable - the detection is a
// guess from the name, and an unknown real NFC reader needs this way out - but
// choosing it asks first (needsNotNfcConfirm), because the app then sends it
// identification commands. Automatic selection never uses such a device (I6).
import type { ReaderStatus } from '@shared/types';
import type { SelectOption } from '../../components/ui';
import type { TFunc } from '../../i18n';

export function readerOptions(t: TFunc, reader: ReaderStatus | null, selected: string | null): SelectOption<string>[] {
  const real = reader?.readers.filter((r) => !r.virtual) ?? [];
  const nfc = real.filter((r) => r.likelyContactless);
  const other = real.filter((r) => !r.likelyContactless);
  const opts: SelectOption<string>[] = [{ value: '', label: t('settings.reader.auto') }];
  for (const r of nfc) opts.push({ value: r.name, label: r.name });
  for (const r of other) opts.push({ value: r.name, label: t('settings.reader.notNfcOption', { name: r.name }) });
  if (selected && !real.some((r) => r.name === selected)) {
    opts.push({ value: selected, label: t('settings.reader.missingOption', { name: selected }) });
  }
  return opts;
}

/** A connected real device with this name that is NOT detected as an NFC reader. */
export function isNotNfcDevice(reader: ReaderStatus | null, name: string | null | undefined): boolean {
  if (!name) return false;
  const r = reader?.readers.find((x) => x.name === name);
  return !!r && !r.virtual && !r.likelyContactless;
}

/**
 * Choosing `name` in "Reader to use" needs the warn confirmation (D10): it is a
 * connected device that is not detected as an NFC reader and it is not already
 * the selected reader (re-selecting the current choice does not ask again).
 */
export function needsNotNfcConfirm(reader: ReaderStatus | null, name: string | null, current: string | null): boolean {
  if (!name || name === current) return false;
  return isNotNfcDevice(reader, name);
}
