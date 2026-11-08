// Unit tests for the hardware-independent parts of the PC/SC backend.
// These exercise src/main/nfc/pcsc/pure.ts only (no koffi, no reader). The koffi
// calls themselves (winscard.ts / index.ts loop) are verified by the integrator
// on real hardware.

import { describe, it, expect } from 'vitest';
import {
  parseReaderNamesW,
  parseReaderNamesA,
  extractAtr,
  readerInfoFrom,
  readerListEqual,
  statusWord,
  isSuccessSw,
  isOk,
  isServiceUnavailableRv,
  isNoReadersRv,
  isRemovedCardRv,
  normalizeRv,
  pcscErrorCode,
  opErrorForPcsc,
  rvName,
  SCARD_STATE_PRESENT,
  SCARD_STATE_INUSE,
  SCARD_STATE_EMPTY,
  SCARD_S_SUCCESS,
  SCARD_E_NO_SERVICE,
  SCARD_E_SERVICE_STOPPED,
  SCARD_E_NO_SMARTCARD,
  SCARD_E_SHARING_VIOLATION,
  SCARD_E_NO_READERS_AVAILABLE,
  SCARD_E_READER_UNAVAILABLE,
  SCARD_E_CARD_UNSUPPORTED,
  SCARD_W_REMOVED_CARD,
  SCARD_W_RESET_CARD,
  SCARD_E_TIMEOUT,
  SCARD_E_CANCELLED,
  SCARD_E_INVALID_PARAMETER,
} from '../src/main/nfc/pcsc/pure';

// Helper: UTF-16 code units for an ASCII string.
function wchars(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

// The signed 32-bit LONG koffi returns for a 0x8010xxxx HRESULT on Windows.
function asSignedLong(u32: number): number {
  return u32 | 0; // ToInt32
}

// Standard PC/SC Part-3 storage ATR for MIFARE Classic 1K (cardName 0x0001).
const MIFARE_1K_ATR = Uint8Array.from([
  0x3b, 0x8f, 0x80, 0x01, 0x80, 0x4f, 0x0c, 0xa0, 0x00, 0x00, 0x03, 0x06, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x6a,
]);
// Feitian USB security token contact ATR (not a storage ATR).
const TOKEN_ATR = Uint8Array.from([0x3b, 0x9f, 0x95, 0x81, 0x31, 0xfe, 0x9f, 0x00]);

describe('reader name parsing (multi-string)', () => {
  it('parses a UTF-16 multi-string terminated by a double NUL', () => {
    const buf = [...wchars('ACS ACR122U PICC Interface'), 0, ...wchars('FS USB Token 0'), 0, 0];
    expect(parseReaderNamesW(buf)).toEqual(['ACS ACR122U PICC Interface', 'FS USB Token 0']);
  });

  it('honours the reported wide-char count and ignores trailing garbage', () => {
    const content = [...wchars('Reader A'), 0, 0];
    const buf = content.concat([0x41, 0x42, 0x43]); // junk past the terminator
    expect(parseReaderNamesW(buf, content.length)).toEqual(['Reader A']);
  });

  it('returns an empty list for an empty buffer', () => {
    expect(parseReaderNamesW([0, 0])).toEqual([]);
    expect(parseReaderNamesW([])).toEqual([]);
  });

  it('parses an ANSI (pcsclite) multi-string', () => {
    const enc = (s: string) => [...s].map((c) => c.charCodeAt(0));
    const buf = Uint8Array.from([...enc('/dev/reader0'), 0, ...enc('/dev/reader1'), 0, 0]);
    expect(parseReaderNamesA(buf)).toEqual(['/dev/reader0', '/dev/reader1']);
  });
});

describe('ATR extraction', () => {
  it('slices cbAtr bytes out of the 36-byte rgbAtr buffer', () => {
    const rgb = new Uint8Array(36);
    rgb.set(MIFARE_1K_ATR, 0);
    const atr = extractAtr(rgb, MIFARE_1K_ATR.length);
    expect([...atr]).toEqual([...MIFARE_1K_ATR]);
  });

  it('clamps an out-of-range length', () => {
    expect(extractAtr(new Uint8Array(36), 999).length).toBe(36);
    expect(extractAtr(new Uint8Array(36), -1).length).toBe(0);
  });
});

describe('readerInfoFrom', () => {
  it('flags a contactless reader with a present storage card', () => {
    const info = readerInfoFrom('ACS ACR122U PICC Interface', SCARD_STATE_PRESENT | SCARD_STATE_INUSE, MIFARE_1K_ATR);
    expect(info.likelyContactless).toBe(true);
    expect(info.cardPresent).toBe(true);
    expect(info.inUse).toBe(true);
    expect(info.atr).toBe('3B8F8001804F0CA000000306030001000000006A'); // uppercase hex, no separators
    expect(info.virtual).toBe(false);
  });

  it('does not treat a USB security token as an NFC reader (I6)', () => {
    const info = readerInfoFrom('FS USB Token 0', SCARD_STATE_PRESENT, TOKEN_ATR);
    expect(info.likelyContactless).toBe(false);
    expect(info.cardPresent).toBe(true);
  });

  it('reports no ATR when no card is present', () => {
    const info = readerInfoFrom('ACS ACR1252U PICC', SCARD_STATE_EMPTY, MIFARE_1K_ATR);
    expect(info.cardPresent).toBe(false);
    expect(info.atr).toBeNull();
  });
});

describe('readerListEqual', () => {
  it('detects card-present changes', () => {
    const a = readerInfoFrom('R', SCARD_STATE_EMPTY, null);
    const b = readerInfoFrom('R', SCARD_STATE_PRESENT, MIFARE_1K_ATR);
    expect(readerListEqual([a], [a])).toBe(true);
    expect(readerListEqual([a], [b])).toBe(false);
    expect(readerListEqual([a], [a, b])).toBe(false);
  });
});

describe('status word', () => {
  it('reads the trailing SW1 SW2', () => {
    expect(statusWord(Uint8Array.from([0x04, 0x11, 0x22, 0x90, 0x00]))).toBe(0x9000);
    expect(isSuccessSw(Uint8Array.from([0x90, 0x00]))).toBe(true);
    expect(isSuccessSw(Uint8Array.from([0x63, 0x00]))).toBe(false);
    expect(statusWord(Uint8Array.from([0x90]))).toBe(0);
  });
});

describe('return-code normalisation', () => {
  it('normalises a signed 32-bit LONG back to unsigned', () => {
    expect(normalizeRv(asSignedLong(SCARD_E_NO_SERVICE))).toBe(SCARD_E_NO_SERVICE);
    expect(normalizeRv(SCARD_E_NO_SERVICE)).toBe(SCARD_E_NO_SERVICE);
    expect(normalizeRv(BigInt(SCARD_E_NO_SERVICE))).toBe(SCARD_E_NO_SERVICE);
    expect(normalizeRv(0)).toBe(0);
  });

  it('classifies service / reader / removed states', () => {
    expect(isOk(SCARD_S_SUCCESS)).toBe(true);
    expect(isOk(asSignedLong(SCARD_E_NO_SERVICE))).toBe(false);
    expect(isServiceUnavailableRv(asSignedLong(SCARD_E_NO_SERVICE))).toBe(true);
    expect(isServiceUnavailableRv(asSignedLong(SCARD_E_SERVICE_STOPPED))).toBe(true);
    expect(isServiceUnavailableRv(asSignedLong(SCARD_E_NO_READERS_AVAILABLE))).toBe(false);
    expect(isNoReadersRv(asSignedLong(SCARD_E_NO_READERS_AVAILABLE))).toBe(true);
    expect(isRemovedCardRv(asSignedLong(SCARD_W_REMOVED_CARD))).toBe(true);
    expect(isRemovedCardRv(asSignedLong(SCARD_W_RESET_CARD))).toBe(true);
    expect(isRemovedCardRv(SCARD_S_SUCCESS)).toBe(false);
  });

  it('names codes for diagnostics', () => {
    expect(rvName(asSignedLong(SCARD_E_NO_SERVICE))).toBe('SCARD_E_NO_SERVICE');
    expect(rvName(0x12345678)).toBe('0x12345678');
  });
});

describe('PC/SC error -> OpError mapping', () => {
  const cases: Array<[number, string]> = [
    [SCARD_E_NO_SERVICE, 'NO_SERVICE'],
    [SCARD_E_SERVICE_STOPPED, 'NO_SERVICE'],
    [SCARD_E_NO_READERS_AVAILABLE, 'NO_READER'],
    [SCARD_E_READER_UNAVAILABLE, 'NO_READER'],
    [SCARD_E_NO_SMARTCARD, 'NO_CARD'],
    [SCARD_W_REMOVED_CARD, 'CARD_REMOVED'],
    [SCARD_W_RESET_CARD, 'CARD_REMOVED'],
    [SCARD_E_SHARING_VIOLATION, 'BUSY'],
    [SCARD_E_CARD_UNSUPPORTED, 'UNSUPPORTED_TAG'],
    [SCARD_E_TIMEOUT, 'READ_FAILED'],
    [SCARD_E_CANCELLED, 'CANCELLED'],
    [SCARD_E_INVALID_PARAMETER, 'INTERNAL'],
  ];

  it('maps each code (both signed and unsigned forms)', () => {
    for (const [code, expected] of cases) {
      expect(pcscErrorCode(code)).toBe(expected);
      expect(pcscErrorCode(asSignedLong(code))).toBe(expected);
    }
  });

  it('builds an OpError whose detail is only the code name (no secrets)', () => {
    const err = opErrorForPcsc(asSignedLong(SCARD_W_REMOVED_CARD));
    expect(err.code).toBe('CARD_REMOVED');
    expect(err.detail).toBe('SCARD_W_REMOVED_CARD');
  });

  it('defaults unknown codes to INTERNAL', () => {
    expect(pcscErrorCode(0x80100099)).toBe('INTERNAL');
  });
});
