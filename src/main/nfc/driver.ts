// Reader driver resolution + raw NFC-A command tunnelling. Owner: agent "main-nfc".
//
// A PC/SC reader exposes contactless tags, but the way raw NTAG commands are sent
// differs per reader. driver.ts picks a mode from the reader name and frames raw
// commands for it:
//   - acr122:      PN53x "Direct Transmit"  FF 00 00 00 Lc  D4 42 <cmd>
//                  response D5 43 <status> <payload> + SW
//   - transparent: PC/SC 2.02 Part 3 transparent exchange  FF C2 00 01 Lc <objects>
//                  request object 95 = data to send; response object 97 = ICC answer
//   - storage:     storage-card pseudo-APDUs only (no raw commands at all)
//
// ReaderIo wraps a CardConnection so ntag.ts / mifare.ts can speak in storage
// primitives (getUid/readBinary/updateBinary/loadKey/authenticate) and, where the
// driver allows, raw() NTAG frames.

import type { ReaderDriverMode, ResolvedDriver } from '@shared/types';
import { VIRTUAL_READER_NAME } from '@shared/reader';
import { OpError } from '../errors';
import type { CardConnection } from './backend';
import {
  apduAuthenticate,
  apduGetUid,
  apduLoadKey,
  apduReadBinary,
  apduUpdateBinary,
  isSuccessSw,
  NTAG_ACK,
  splitResponse,
  swHex,
  swMeansDenied,
  type MifareKeyType,
  type Sw,
} from './apdu';

// ACR122U / Touchatag and other PN532-based readers.
const ACR122_NAME = /(ACR122|ACR1222|ACM122|PN53[0-9]|Touchatag|Tikitag)/i;
// Readers whose firmware exposes a PC/SC transparent session (or an equivalent
// escape) for raw NFC-A: ACR1252/1255/1281/1552/1555, Identiv/SCM, HID.
// NOTE: the Sony PaSoRi (RC-S3xx / "Sony FeliCa Port") is NOT here. Measured
// 2026-11-09 on a PaSoRi 3.0: it accepts storage-card commands (FF CA get UID,
// FF B0 read binary with Le=0x10, FF D6 update binary) but rejects both the
// ACR122 "Direct Transmit" wrap and the FF C2 transparent wrap for raw NTAG
// commands (GET_VERSION -> 6A 81). So Sony readers resolve to 'storage', where
// NTAG kind is identified from the CC (page 3) rather than GET_VERSION.
const TRANSPARENT_NAME =
  /(ACR1251|ACR1252|ACR1255|ACR1256|ACR1281|ACR1283|ACR1552|ACR1555|Identiv|SCM\s*Micro|SCL01|SCL3711|uTrust\s*3[57]|CLOUD\s*2700|OMNIKEY.*(5022|5x22|5427|CL)|SpringCard|Duali|Elatec|TWN4)/i;

/** Pick a driver from the reader name alone (used when driverMode = 'auto'). */
export function estimateDriver(readerName: string): ResolvedDriver {
  // The built-in virtual reader behaves like a full PN532 (raw commands work).
  if (readerName === VIRTUAL_READER_NAME) return 'acr122';
  if (ACR122_NAME.test(readerName)) return 'acr122';
  if (TRANSPARENT_NAME.test(readerName)) return 'transparent';
  // Unknown readers fall back to storage-only (read/write, no raw commands).
  return 'storage';
}

/** Resolve a driver mode against a reader name ('auto' -> estimateDriver). */
export function resolveDriver(readerName: string, mode: ReaderDriverMode): ResolvedDriver {
  return mode === 'auto' ? estimateDriver(readerName) : mode;
}

export function supportsRawCommands(driver: ResolvedDriver): boolean {
  return driver === 'acr122' || driver === 'transparent';
}

/** Frame a raw NFC-A command for the driver. Throws for storage (no raw channel). */
export function wrapRawCommand(driver: ResolvedDriver, cmd: Uint8Array): Uint8Array {
  if (driver === 'acr122') {
    // FF 00 00 00 Lc  D4 42 <cmd>   (Lc counts D4 42 + cmd)
    const lc = cmd.length + 2;
    return Uint8Array.from([0xff, 0x00, 0x00, 0x00, lc & 0xff, 0xd4, 0x42, ...cmd]);
  }
  if (driver === 'transparent') {
    // FF C2 00 01 Lc  95 <len> <cmd>   (object 95 = "data to transmit to the ICC")
    const body = [0x95, cmd.length & 0xff, ...cmd];
    return Uint8Array.from([0xff, 0xc2, 0x00, 0x01, body.length & 0xff, ...body]);
  }
  throw new OpError('READ_FAILED', 'driver has no raw command channel');
}

/**
 * A NTAG answers with a 4-bit NAK (carried as one byte) when it refuses a
 * command - e.g. a READ of a password-protected page, or a failed PWD_AUTH. The
 * only valid single-byte raw answer is the WRITE / PWD_AUTH ACK (0x0A); any other
 * single-byte answer is a NAK.
 */
function isNtagNak(payload: Uint8Array): boolean {
  return payload.length === 1 && payload[0] !== NTAG_ACK;
}

/**
 * Unwrap a raw-command response to the tag's own payload (no SW, no framing).
 * A tag NAK (protected page / failed auth) throws OpError('ACCESS_DENIED') so the
 * caller reports the page 'denied' rather than a generic read 'error'; a real
 * transport/framing failure throws OpError('READ_FAILED'). The NAK is recognised
 * from the answer itself (a short non-ACK frame), so it is classified the same
 * whether the reader reports it with a zero or a non-zero transport status.
 */
export function unwrapRawResponse(driver: ResolvedDriver, resp: Uint8Array): Uint8Array {
  const { data, sw } = splitResponse(resp);
  if (!isSuccessSw(sw)) throw new OpError('READ_FAILED', `raw SW ${swHex(sw)}`);
  if (driver === 'acr122') {
    if (data.length < 3 || data[0] !== 0xd5 || data[1] !== 0x43) {
      throw new OpError('READ_FAILED', 'unexpected PN532 response frame');
    }
    const status = data[2] & 0x3f; // PN532 error code (0 = ok)
    const payload = data.slice(3);
    if (isNtagNak(payload)) throw new OpError('ACCESS_DENIED', 'tag NAK');
    if (status !== 0) throw new OpError('READ_FAILED', `PN532 status ${status}`);
    return payload;
  }
  if (driver === 'transparent') {
    let status = 0;
    let payload: Uint8Array | null = null;
    let i = 0;
    while (i + 2 <= data.length) {
      const tag = data[i];
      const len = data[i + 1];
      const val = data.slice(i + 2, i + 2 + len);
      if (tag === 0xc0 && val.length >= 2) status = val[1]; // response status object
      else if (tag === 0x97) payload = val; // ICC response object
      i += 2 + len;
    }
    if (payload && isNtagNak(payload)) throw new OpError('ACCESS_DENIED', 'tag NAK');
    if (status !== 0) throw new OpError('READ_FAILED', `transparent status ${status}`);
    if (!payload) throw new OpError('READ_FAILED', 'no ICC response object');
    return payload;
  }
  throw new OpError('READ_FAILED', 'driver has no raw command channel');
}

/**
 * I/O helper bound to one open card connection + resolved driver. Storage
 * primitives work on every driver; raw() requires acr122 / transparent.
 */
export class ReaderIo {
  readonly driver: ResolvedDriver;
  private readonly conn: CardConnection;

  constructor(conn: CardConnection, driver: ResolvedDriver) {
    this.conn = conn;
    this.driver = driver;
  }

  get rawCommands(): boolean {
    return supportsRawCommands(this.driver);
  }

  async getUid(): Promise<Uint8Array> {
    const { data, sw } = splitResponse(await this.conn.transmit(apduGetUid()));
    if (!isSuccessSw(sw)) throw new OpError('READ_FAILED', 'could not read UID');
    return data;
  }

  /**
   * FF B0 that never throws for a refusing status word: returns the data and the
   * SW, so a caller can tell "the reader / card answered no" (any SW) from "no
   * answer at all" (the transport throws: CARD_REMOVED, CARD_UNRESPONSIVE, ...).
   */
  async readBinarySw(block: number, length: number): Promise<{ data: Uint8Array; sw: Sw }> {
    let { data, sw } = splitResponse(await this.conn.transmit(apduReadBinary(block, length)));
    // 6C XX = wrong Le; the reader wants exactly XX bytes. Some readers (e.g. the
    // Sony PaSoRi RC-S3xx) only accept a 16-byte FF B0 read and reject a 4-byte
    // page read with 6C 10. Re-issue with the reader-suggested Le, then slice back
    // to the requested length. (Measured 2026-11-09 on a PaSoRi 3.0 + NTAG215.)
    if (sw.sw1 === 0x6c && sw.sw2 !== 0x00) {
      ({ data, sw } = splitResponse(await this.conn.transmit(apduReadBinary(block, sw.sw2))));
    }
    return { data: isSuccessSw(sw) && data.length > length ? data.subarray(0, length) : data, sw };
  }

  async readBinary(block: number, length: number): Promise<Uint8Array> {
    const { data, sw } = await this.readBinarySw(block, length);
    if (isSuccessSw(sw)) return data;
    if (swMeansDenied(sw)) throw new OpError('ACCESS_DENIED', `block ${block}`);
    throw new OpError('READ_FAILED', `block ${block}`);
  }

  async updateBinary(block: number, data: Uint8Array): Promise<void> {
    const { sw } = splitResponse(await this.conn.transmit(apduUpdateBinary(block, data)));
    if (isSuccessSw(sw)) return;
    if (swMeansDenied(sw)) throw new OpError('ACCESS_DENIED', `block ${block}`);
    throw new OpError('WRITE_FAILED', `block ${block}`);
  }

  async loadKey(slot: number, key: Uint8Array): Promise<void> {
    const { sw } = splitResponse(await this.conn.transmit(apduLoadKey(slot, key)));
    if (!isSuccessSw(sw)) throw new OpError('AUTH_FAILED', 'load key failed');
  }

  /** Returns true on a successful authentication, false on a wrong key. */
  async authenticate(block: number, keyType: MifareKeyType, slot: number): Promise<boolean> {
    const { sw } = splitResponse(await this.conn.transmit(apduAuthenticate(block, keyType, slot)));
    return isSuccessSw(sw);
  }

  /** Send a raw NFC-A frame and return the tag's payload. Requires a raw driver. */
  async raw(cmd: Uint8Array): Promise<Uint8Array> {
    if (!this.rawCommands) throw new OpError('READ_FAILED', 'raw commands unavailable on this reader');
    return unwrapRawResponse(this.driver, await this.conn.transmit(wrapRawCommand(this.driver, cmd)));
  }
}
