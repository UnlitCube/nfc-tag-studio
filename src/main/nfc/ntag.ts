// NTAG21x (NFC Forum Type 2) read / write. Owner: agent "main-nfc".
//
// Reading: GET_VERSION identifies the model; pages are read 4 at a time with the
// native READ (raw drivers) or FF B0 read-binary (storage driver). Pages that a
// password protects and that we cannot authenticate are left zero-filled and
// marked 'denied'. A tag that leaves the reader mid-read rejects the whole read
// with CARD_REMOVED (2026-11-12 UX audit CARD-4: a half-read image must never be
// returned as a success). The NFC counter and the originality signature are
// display-only extras (raw drivers only).
//
// Writing: one 4-byte page per native WRITE / FF D6 update-binary, strictly in
// the order the caller planned (UnitWrite[]). Policy (forbidden / protected /
// invalid access bits) is enforced by the service before we are called. A tag
// that leaves mid-write stops the loop (`aborted`, `notAttempted`).

import type { TagKind } from '@shared/tags';
import { isNtag, specFor } from '@shared/tags';
import type { NtagExtras, UnitStatus, UnitWrite } from '@shared/types';
import { bytesToHex, hexToBytes } from '@shared/hex';
import { OpError } from '../errors';
import { isSuccessSw, NTAG_ACK, ntagGetVersion, ntagPwdAuth, ntagRead, ntagReadCnt, ntagReadSig, ntagWrite } from './apdu';
import type { ReaderIo } from './driver';
import { isLinkLost, PresenceGuard, readChunk, runUnitWrites, type UnitWriteOutcome } from './unit-ops';

export type { UnitWriteOutcome } from './unit-ops';

export interface NtagReadResult {
  data: Uint8Array;
  unitStatus: UnitStatus[];
  extras: NtagExtras;
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
  if (!password) return;
  // A storage reader (PaSoRi) cannot send PWD_AUTH. Never skip the password
  // silently: the operator would be told the pages "need a password" although
  // they gave it (2026-11-12 review R-UX-1, D11). The service refuses earlier;
  // this is the backstop for any other caller.
  if (!io.rawCommands) throw new OpError('READER_NO_AUTH', 'storage driver: no PWD_AUTH');
  try {
    const pwd = hexToBytes(password);
    if (pwd.length === 4) await io.raw(ntagPwdAuth(pwd));
  } catch (e) {
    if (isLinkLost(e)) throw e;
    // Wrong / unparseable password -> protected pages stay 'denied'.
  }
}

/** Read one page (4 bytes). Uses native READ (returns 4 pages) or FF B0. */
export async function readNtagPage(io: ReaderIo, page: number): Promise<Uint8Array> {
  const chunk = io.rawCommands ? await io.raw(ntagRead(page)) : await io.readBinary(page, 16);
  if (chunk.length < 4) throw new OpError('ACCESS_DENIED', `page ${page}`);
  return chunk.subarray(0, 4);
}

/**
 * The presence check of R-MAIN-3 for NTAG: re-read `page` (one this tag already
 * answered, e.g. the CC page the identification read). Storage readers only -
 * on a raw driver a refusal is the tag's own NAK (it answered, so it is there),
 * and a probe after a NAK would hit a tag that went back to IDLE.
 */
function ntagGuard(io: ReaderIo, probePage: number | null | undefined): PresenceGuard {
  if (io.rawCommands || probePage === null || probePage === undefined) return new PresenceGuard(null);
  return new PresenceGuard(async () => {
    const { data, sw } = await io.readBinarySw(probePage, 16);
    return isSuccessSw(sw) && data.length >= 4;
  });
}

export interface NtagOpOptions {
  password?: string;
  /**
   * A page this tag is known to answer (storage readers: the CC page 3 when the
   * identification read it). Enables the "did the tag leave?" check on refusals.
   * null / undefined = no check.
   */
  probePage?: number | null;
}

/** Read the whole NTAG image. `kind` must be an NTAG model. */
export async function readNtag(io: ReaderIo, kind: TagKind, opts: NtagOpOptions): Promise<NtagReadResult> {
  if (!isNtag(kind)) throw new OpError('INTERNAL', 'readNtag called for a non-NTAG kind');
  const spec = specFor(kind);
  const pages = spec.unitCount;
  const data = new Uint8Array(pages * 4);
  const unitStatus: UnitStatus[] = new Array(pages).fill('unread');
  const guard = ntagGuard(io, opts.probePage);

  await ntagPwdAuthenticate(io, opts.password);

  for (let page = 0; page < pages; page += 4) {
    const count = Math.min(4, pages - page);
    // Throws CARD_REMOVED (whole read fails) when the tag left the reader.
    const r = await readChunk(io, async () => {
      const chunk = io.rawCommands ? await io.raw(ntagRead(page)) : await io.readBinary(page, 16);
      if (chunk.length < count * 4) throw new OpError('ACCESS_DENIED', `page ${page}`);
      return chunk;
    });
    if (r.status === 'ok') data.set(r.data.subarray(0, count * 4), page * 4);
    for (let q = 0; q < count; q++) unitStatus[page + q] = r.status;
    // A refused chunk on a storage reader: protected, or the tag just left? (R-MAIN-3)
    if (r.status !== 'ok') await guard.refused();
  }
  await guard.finish();

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
 * failed page - the service aggregates the result). When the tag leaves the
 * reader the loop stops: `aborted` is set and the untried pages are listed.
 */
export async function writeNtagPages(io: ReaderIo, writes: UnitWrite[], opts: NtagOpOptions): Promise<UnitWriteOutcome> {
  try {
    await ntagPwdAuthenticate(io, opts.password);
  } catch (e) {
    // The tag left before the first page: nothing was written.
    if (isLinkLost(e)) return { written: [], failed: [], aborted: e.code, notAttempted: writes.map((w) => w.unit) };
    throw e;
  }

  return runUnitWrites(
    writes,
    async (w) => {
      if (w.data.length !== 4) throw new OpError('WRITE_FAILED', `page ${w.unit} needs 4 bytes`);
      if (io.rawCommands) {
        const ack = await io.raw(ntagWrite(w.unit, w.data));
        if (!(ack.length >= 1 && ack[0] === NTAG_ACK)) throw new OpError('WRITE_FAILED', `page ${w.unit}`);
      } else {
        await io.updateBinary(w.unit, w.data);
      }
    },
    undefined,
    ntagGuard(io, opts.probePage),
  );
}
