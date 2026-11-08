// Reader classification helpers. CONTRACT FILE - frozen (integrator-owned).
//
// Background (measured 2026-11-08 on the dev PC): the only PC/SC "reader" was a
// Feitian USB security token ("FS USB Token 0", contact ATR 3B 9F 95 81 31 ...).
// The app must not treat such tokens as NFC readers, must not send tag APDUs to
// them automatically, and should explain why nothing happens.

import { parseStorageAtr } from './tags';

const CONTACTLESS_NAME =
  /(PICC|contactless|\bNFC\b|ACR12|ACR1252|ACR1255|ACR1281|ACR1552|ACR1555|ACR39U-?N|RC-S3|PaSoRi|FeliCa|SCL0?1|SCL3|uTrust\s*3[57]|OMNIKEY.*(5022|5x22|5427|CL)|\bCL\b|Duali|SpringCard|Elatec|Virtual NFC)/i;
const NOT_CONTACTLESS_NAME = /(token|yubikey|yubico|fido|epass|\bSAM\b|smart\s*card\s*reader$|SCR3|ACR38|ACR39U(?!-?N)|CCID\s*$|PIV|OpenPGP)/i;

/**
 * true  = looks like an NFC (contactless) reader
 * false = looks like a USB token / contact reader, or unknown
 * When a storage-card ATR (contactless pseudo-ATR) is present, that wins.
 */
export function isLikelyContactlessReader(name: string, atr: Uint8Array | null): boolean {
  if (atr && atr.length > 0 && parseStorageAtr(atr)) return true;
  if (NOT_CONTACTLESS_NAME.test(name)) return false;
  return CONTACTLESS_NAME.test(name);
}

/** Name of the built-in virtual reader. */
export const VIRTUAL_READER_NAME = 'NFC Tag Studio Virtual NFC Reader';
