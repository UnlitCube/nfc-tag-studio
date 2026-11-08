import { describe, expect, it } from 'vitest';
import { VIRTUAL_READER_NAME } from '../src/shared/reader';
import { estimateDriver, resolveDriver, supportsRawCommands, unwrapRawResponse, wrapRawCommand } from '../src/main/nfc/driver';
import { ntagGetVersion } from '../src/main/nfc/apdu';

describe('driver estimation from reader name', () => {
  it('maps ACR122U-family readers to acr122', () => {
    expect(estimateDriver('ACS ACR122U PICC Interface')).toBe('acr122');
    expect(estimateDriver('ACS ACR122U 00 00')).toBe('acr122');
    expect(estimateDriver('Touchatag USB Reader')).toBe('acr122');
  });

  it('maps ACR1252/1255, Identiv and Sony readers to transparent', () => {
    expect(estimateDriver('ACS ACR1252 1S CL Reader PICC 0')).toBe('transparent');
    expect(estimateDriver('ACS ACR1255U-J1 PICC Reader')).toBe('transparent');
    expect(estimateDriver('Identiv uTrust 3700 F CL Reader')).toBe('transparent');
    expect(estimateDriver('Sony FeliCa Port/PaSoRi 3.0')).toBe('transparent');
  });

  it('falls back to storage for unknown readers', () => {
    expect(estimateDriver('Generic Smartcard Reader')).toBe('storage');
    expect(estimateDriver('Some Unknown PC/SC Device')).toBe('storage');
  });

  it('treats the built-in virtual reader as a full raw reader', () => {
    expect(estimateDriver(VIRTUAL_READER_NAME)).toBe('acr122');
  });

  it('honours an explicit (non-auto) driver mode', () => {
    expect(resolveDriver('ACS ACR122U', 'storage')).toBe('storage');
    expect(resolveDriver('Generic Reader', 'transparent')).toBe('transparent');
    expect(resolveDriver(VIRTUAL_READER_NAME, 'auto')).toBe('acr122');
  });

  it('reports which drivers can send raw NFC-A commands', () => {
    expect(supportsRawCommands('acr122')).toBe(true);
    expect(supportsRawCommands('transparent')).toBe(true);
    expect(supportsRawCommands('storage')).toBe(false);
  });
});

describe('raw command framing', () => {
  it('wraps an NTAG command for acr122 (FF 00 00 00 Lc D4 42 ...)', () => {
    expect(Array.from(wrapRawCommand('acr122', ntagGetVersion()))).toEqual([0xff, 0x00, 0x00, 0x00, 0x03, 0xd4, 0x42, 0x60]);
  });

  it('wraps an NTAG command for transparent (FF C2 00 01 Lc 95 len ...)', () => {
    expect(Array.from(wrapRawCommand('transparent', ntagGetVersion()))).toEqual([0xff, 0xc2, 0x00, 0x01, 0x03, 0x95, 0x01, 0x60]);
  });

  it('throws when the driver has no raw channel', () => {
    expect(() => wrapRawCommand('storage', ntagGetVersion())).toThrow();
  });

  it('unwraps an acr122 response frame (D5 43 status payload + SW)', () => {
    const resp = Uint8Array.from([0xd5, 0x43, 0x00, 0xaa, 0xbb, 0x90, 0x00]);
    expect(Array.from(unwrapRawResponse('acr122', resp))).toEqual([0xaa, 0xbb]);
  });

  it('unwraps a transparent response (C0 status + 97 payload)', () => {
    const resp = Uint8Array.from([0xc0, 0x03, 0x00, 0x00, 0x00, 0x97, 0x02, 0xaa, 0xbb, 0x90, 0x00]);
    expect(Array.from(unwrapRawResponse('transparent', resp))).toEqual([0xaa, 0xbb]);
  });

  it('throws on a PN532 error status', () => {
    expect(() => unwrapRawResponse('acr122', Uint8Array.from([0xd5, 0x43, 0x01, 0x90, 0x00]))).toThrow();
  });

  it('throws when the trailing SW is not 9000', () => {
    expect(() => unwrapRawResponse('acr122', Uint8Array.from([0xd5, 0x43, 0x00, 0x63, 0x00]))).toThrow();
  });
});

function thrownCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

describe('raw NAK is classified as access-denied, not a read error', () => {
  // A NTAG answers a protected READ / failed PWD_AUTH with a 4-bit NAK (one byte,
  // not the 0x0A ACK). Real readers surface it with a NON-ZERO transport status;
  // it must still become ACCESS_DENIED so the page shows 'denied' (locked), not a
  // generic read 'error'. (reader-apdu.md §3, §7.)
  it('maps an acr122 NAK with a non-zero PN532 status to ACCESS_DENIED', () => {
    // D5 43 <status=01> <nak=00> + SW 9000
    const nak = Uint8Array.from([0xd5, 0x43, 0x01, 0x00, 0x90, 0x00]);
    expect(thrownCode(() => unwrapRawResponse('acr122', nak))).toBe('ACCESS_DENIED');
  });

  it('maps an acr122 NAK with a zero status to ACCESS_DENIED too (robust to either framing)', () => {
    const nak = Uint8Array.from([0xd5, 0x43, 0x00, 0x00, 0x90, 0x00]);
    expect(thrownCode(() => unwrapRawResponse('acr122', nak))).toBe('ACCESS_DENIED');
  });

  it('maps a transparent NAK (97 = one non-ACK byte) to ACCESS_DENIED', () => {
    // C0 status=01, 97 payload=[00] + SW 9000
    const nak = Uint8Array.from([0xc0, 0x03, 0x00, 0x01, 0x00, 0x97, 0x01, 0x00, 0x90, 0x00]);
    expect(thrownCode(() => unwrapRawResponse('transparent', nak))).toBe('ACCESS_DENIED');
  });

  it('does not treat the single-byte WRITE ACK (0x0A) as a NAK', () => {
    const ack = unwrapRawResponse('acr122', Uint8Array.from([0xd5, 0x43, 0x00, 0x0a, 0x90, 0x00]));
    expect(Array.from(ack)).toEqual([0x0a]);
  });

  it('keeps a non-zero status with no tag answer as a transport READ_FAILED', () => {
    // No payload (e.g. a real timeout) must stay a read error, not 'denied'.
    expect(thrownCode(() => unwrapRawResponse('acr122', Uint8Array.from([0xd5, 0x43, 0x01, 0x90, 0x00])))).toBe('READ_FAILED');
  });
});
