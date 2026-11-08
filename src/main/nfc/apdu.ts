// APDU / command byte builders for NFC tag I/O. Owner: agent "main-nfc".
//
// Two command families live here:
//  - PC/SC "storage card" pseudo-APDUs (FF CA / FF B0 / FF D6 / FF 82 / FF 86):
//    these are understood by the reader firmware and work on every contactless
//    PC/SC reader. MIFARE Classic and the storage-driver fallback use them.
//  - NTAG21x native NFC-A command frames (READ, FAST_READ, WRITE, GET_VERSION,
//    PWD_AUTH, READ_CNT, READ_SIG): the raw bytes the tag itself sees. They are
//    tunnelled through the reader by driver.ts (acr122 / transparent).
//
// Pure byte helpers: no Node, no DOM, no secrets kept here.

/** Status word (SW1 SW2) that ends a PC/SC response. */
export interface Sw {
  sw1: number;
  sw2: number;
}

/** Split a PC/SC response into its data part and the trailing SW1 SW2. */
export function splitResponse(resp: Uint8Array): { data: Uint8Array; sw: Sw } {
  if (resp.length < 2) {
    // No status word at all -> treat as a hard failure (SW 0000).
    return { data: resp.slice(0), sw: { sw1: 0x00, sw2: 0x00 } };
  }
  return {
    data: resp.slice(0, resp.length - 2),
    sw: { sw1: resp[resp.length - 2], sw2: resp[resp.length - 1] },
  };
}

export function isSuccessSw(sw: Sw): boolean {
  return sw.sw1 === 0x90 && sw.sw2 === 0x00;
}

/** True when a failing SW means "authentication / access condition not met". */
export function swMeansDenied(sw: Sw): boolean {
  // 6982 security status not satisfied, 6985 conditions of use not satisfied,
  // 6986 command not allowed, 63xx operation failed (ACS auth/read failure).
  if (sw.sw1 === 0x69 && (sw.sw2 === 0x82 || sw.sw2 === 0x85 || sw.sw2 === 0x86)) return true;
  if (sw.sw1 === 0x63) return true;
  return false;
}

export function swHex(sw: Sw): string {
  const h = (b: number): string => b.toString(16).toUpperCase().padStart(2, '0');
  return h(sw.sw1) + h(sw.sw2);
}

// ---------------------------------------------------------------------------
// PC/SC storage-card pseudo-APDUs
// ---------------------------------------------------------------------------

/** Get the card UID (FF CA 00 00 00). */
export function apduGetUid(): Uint8Array {
  return Uint8Array.from([0xff, 0xca, 0x00, 0x00, 0x00]);
}

/** Read `le` bytes starting at `block` (FF B0 00 blk le). */
export function apduReadBinary(block: number, le: number): Uint8Array {
  return Uint8Array.from([0xff, 0xb0, 0x00, block & 0xff, le & 0xff]);
}

/** Write `data` to `block` (FF D6 00 blk Lc data). */
export function apduUpdateBinary(block: number, data: Uint8Array): Uint8Array {
  return Uint8Array.from([0xff, 0xd6, 0x00, block & 0xff, data.length & 0xff, ...data]);
}

/** Load a 6-byte MIFARE key into a volatile reader key slot (FF 82 00 slot 06 key). */
export function apduLoadKey(slot: number, key: Uint8Array): Uint8Array {
  if (key.length !== 6) throw new Error('MIFARE key must be 6 bytes');
  return Uint8Array.from([0xff, 0x82, 0x00, slot & 0xff, 0x06, ...key]);
}

export type MifareKeyType = 'A' | 'B';

export function mifareKeyTypeByte(keyType: MifareKeyType): number {
  return keyType === 'A' ? 0x60 : 0x61;
}

/**
 * General Authenticate for a MIFARE block using a previously loaded key slot
 * (FF 86 00 00 05  01 00 blk keyType slot).
 */
export function apduAuthenticate(block: number, keyType: MifareKeyType, slot: number): Uint8Array {
  return Uint8Array.from([0xff, 0x86, 0x00, 0x00, 0x05, 0x01, 0x00, block & 0xff, mifareKeyTypeByte(keyType), slot & 0xff]);
}

// ---------------------------------------------------------------------------
// NTAG21x native NFC-A command frames
// ---------------------------------------------------------------------------

export const NTAG_CMD = {
  READ: 0x30,
  FAST_READ: 0x3a,
  WRITE: 0xa2,
  GET_VERSION: 0x60,
  PWD_AUTH: 0x1b,
  READ_CNT: 0x39,
  READ_SIG: 0x3c,
} as const;

/** NTAG 4-bit ACK, returned (as one byte) after a successful WRITE / PWD_AUTH. */
export const NTAG_ACK = 0x0a;

/** READ: 16 bytes (4 pages) starting at `page`. */
export function ntagRead(page: number): Uint8Array {
  return Uint8Array.from([NTAG_CMD.READ, page & 0xff]);
}

/** FAST_READ: pages `start`..`end` inclusive. */
export function ntagFastRead(start: number, end: number): Uint8Array {
  return Uint8Array.from([NTAG_CMD.FAST_READ, start & 0xff, end & 0xff]);
}

/** WRITE: one 4-byte page. */
export function ntagWrite(page: number, data: Uint8Array): Uint8Array {
  if (data.length !== 4) throw new Error('NTAG WRITE needs exactly 4 bytes');
  return Uint8Array.from([NTAG_CMD.WRITE, page & 0xff, data[0], data[1], data[2], data[3]]);
}

export function ntagGetVersion(): Uint8Array {
  return Uint8Array.from([NTAG_CMD.GET_VERSION]);
}

/** PWD_AUTH: 4-byte password; the tag answers with the 2-byte PACK on success. */
export function ntagPwdAuth(pwd: Uint8Array): Uint8Array {
  if (pwd.length !== 4) throw new Error('PWD_AUTH needs exactly 4 bytes');
  return Uint8Array.from([NTAG_CMD.PWD_AUTH, pwd[0], pwd[1], pwd[2], pwd[3]]);
}

/** READ_CNT: read one of the 3 NFC counters (counter 0..2). 3 bytes LE. */
export function ntagReadCnt(counter: number): Uint8Array {
  return Uint8Array.from([NTAG_CMD.READ_CNT, counter & 0xff]);
}

/** READ_SIG: 32-byte originality signature (display only). */
export function ntagReadSig(): Uint8Array {
  return Uint8Array.from([NTAG_CMD.READ_SIG, 0x00]);
}
