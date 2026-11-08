// NTAG21x (NFC Forum Type 2) read / write. Owner: agent "main-nfc".
//
// Reading: GET_VERSION identifies the model; pages are read 4 at a time with the
// native READ (raw drivers) or FF B0 read-binary (storage driver). Pages that a
// password protects and that we cannot authenticate are left zero-filled and
// marked 'denied' - a read never fails as a whole. The NFC counter and the
// originality signature are display-only extras (raw drivers only).
//
// Writing: one 4-byte page per native WRITE / FF D6 update-binary, strictly in
// the order the caller planned (UnitWrite[]). Policy (forbidden / protected /
// invalid access bits) is enforced by the service before we are called.

import type { TagKind } from '@shared/tags';
import { isNtag, specFor } from '@shared/tags';
import type { NtagExtras, UnitStatus, UnitWrite } from '@shared/types';
import { bytesToHex, hexToBytes } from '@shared/hex';
import { OpError } from '../errors';
import { NTAG_ACK, ntagGetVersion, ntagPwdAuth, ntagRead, ntagReadCnt, ntagReadSig, ntagWrite } from './apdu';
import type { ReaderIo } from './driver';

export interface NtagReadResult {
  data: Uint8Array;
  unitStatus: UnitStatus[];
  extras: NtagExtras;
}

export interface UnitWriteOutcome {
  written: number[];
  failed: { unit: number; error: string }[];
}

/** GET_VERSION (8 bytes) or null when unavailable (storage driver or no answer). */
export async function ntagGetVersionBytes(io: ReaderIo): Promise<Uint8Array | null> {
  if (!io.rawCommands) return null;
  try {
    const v = await io.raw(ntagGetVersion());
    return v.length >= 8 ? v.slice(0, 8) : null;
  } catch {
    return null;
  }
}

async function ntagPwdAuthenticate(io: ReaderIo, password: string | undefined): Promise<void> {
  if (!password || !io.rawCommands) return;
  try {
    const pwd = hexToBytes(password);
    if (pwd.length === 4) await io.raw(ntagPwdAuth(pwd));
  } catch {
    // Wrong / unparseable password -> protected pages stay 'denied'.
  }
}

/** Read one page (4 bytes). Uses native READ (returns 4 pages) or FF B0. */
export async function readNtagPage(io: ReaderIo, page: number): Promise<Uint8Array> {
  const chunk = io.rawCommands ? await io.raw(ntagRead(page)) : await io.readBinary(page, 16);
  if (chunk.length < 4) throw new OpError('ACCESS_DENIED', `page ${page}`);
  return chunk.subarray(0, 4);
}

/** Read the whole NTAG image. `kind` must be an NTAG model. */
export async function readNtag(io: ReaderIo, kind: TagKind, opts: { password?: string }): Promise<NtagReadResult> {
  if (!isNtag(kind)) throw new OpError('INTERNAL', 'readNtag called for a non-NTAG kind');
  const spec = specFor(kind);
  const pages = spec.unitCount;
  const data = new Uint8Array(pages * 4);
  const unitStatus: UnitStatus[] = new Array(pages).fill('unread');

  await ntagPwdAuthenticate(io, opts.password);

  for (let page = 0; page < pages; page += 4) {
    const count = Math.min(4, pages - page);
    try {
      const chunk = io.rawCommands ? await io.raw(ntagRead(page)) : await io.readBinary(page, 16);
      if (chunk.length < count * 4) throw new OpError('ACCESS_DENIED', `page ${page}`);
      data.set(chunk.subarray(0, count * 4), page * 4);
      for (let q = 0; q < count; q++) unitStatus[page + q] = 'ok';
    } catch (e) {
      const st: UnitStatus = e instanceof OpError && e.code === 'ACCESS_DENIED' ? 'denied' : 'error';
      for (let q = 0; q < count; q++) unitStatus[page + q] = st;
    }
  }

  const extras = await readNtagExtras(io);
  return { data, unitStatus, extras };
}

async function readNtagExtras(io: ReaderIo): Promise<NtagExtras> {
  let version: string | null = null;
  let counter: number | null = null;
  let signature: string | null = null;
  if (io.rawCommands) {
    const v = await ntagGetVersionBytes(io);
    if (v) version = bytesToHex(v);
    try {
      const c = await io.raw(ntagReadCnt(0x02));
      if (c.length >= 3) counter = c[0] | (c[1] << 8) | (c[2] << 16); // 3-byte little-endian
    } catch {
      counter = null;
    }
    try {
      const s = await io.raw(ntagReadSig());
      if (s.length >= 32) signature = bytesToHex(s.subarray(0, 32));
    } catch {
      signature = null;
    }
  }
  return { version, counter, signature };
}

/**
 * Write pages in order. Uses FAST_READ nowhere; each page is one WRITE/FF D6.
 * Returns which units were written and which failed (never throws for a single
 * failed page - the service aggregates the result).
 */
export async function writeNtagPages(io: ReaderIo, writes: UnitWrite[], opts: { password?: string }): Promise<UnitWriteOutcome> {
  const written: number[] = [];
  const failed: { unit: number; error: string }[] = [];

  await ntagPwdAuthenticate(io, opts.password);

  for (const w of writes) {
    try {
      if (w.data.length !== 4) throw new OpError('WRITE_FAILED', `page ${w.unit} needs 4 bytes`);
      if (io.rawCommands) {
        const ack = await io.raw(ntagWrite(w.unit, w.data));
        if (!(ack.length >= 1 && ack[0] === NTAG_ACK)) throw new OpError('WRITE_FAILED', `page ${w.unit}`);
      } else {
        await io.updateBinary(w.unit, w.data);
      }
      written.push(w.unit);
    } catch (e) {
      failed.push({ unit: w.unit, error: e instanceof OpError ? e.code : 'WRITE_FAILED' });
    }
  }
  return { written, failed };
}
