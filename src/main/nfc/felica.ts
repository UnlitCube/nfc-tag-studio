// FeliCa Lite-S read/write via the reader. Owner: agent "main-nfc".
//
// Two transports (verified 2026-11-12 on a Sony PaSoRi + real FeliCa Lite-S):
//   - raw channel (ReaderIo.raw = PN532 InCommunicateThru on ACR122, or the
//     transparent session): send Read/Write Without Encryption FeliCa frames.
//   - storage drivers (e.g. the Sony PaSoRi over the stock PC/SC driver, which
//     reject the raw channel): the driver maps FF B0 / FF D6 with P1P2 = the real
//     FeliCa block number to a FeliCa Read/Write Without Encryption, so block
//     read/write works there too (user 0x00-0x0D, REG 0x0E, MC 0x88, system blocks).
// Either way, no card-key authentication / MAC is implemented.
import type { TagKind } from '@shared/tags';
import { felicaBlockOfUnit, specFor, FELICA_LITE_S_INFO_BLOCKS, FELICA_LITE_S_SYSTEM_CODE } from '@shared/tags';
import {
  felicaReadWithoutEncryption,
  felicaWriteWithoutEncryption,
  parseRead,
  parseWrite,
  FELICA_SERVICE_RO,
  FELICA_SERVICE_RW,
} from '@shared/felica';
import type { UnitStatus } from '@shared/types';
import { OpError } from '../errors';
import { isSuccessSw } from './apdu';
import type { ReaderIo } from './driver';
import { isLinkLost, PresenceGuard, runUnitWrites, type UnitWriteOutcome } from './unit-ops';

export interface FelicaReadResult {
  data: Uint8Array;
  unitStatus: UnitStatus[];
  /** Read-only system blocks for display (hex), when readable. */
  info: { id: string | null; sysC: string | null; ckv: string | null };
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();

/**
 * One FeliCa block read:
 *  - Uint8Array: the 16 bytes
 *  - 'refused':  an answer that says no (raw: a FeliCa status-flag error from the
 *                card; storage: any non-90 00 status word, e.g. 91 00)
 *  - 'failed':   no usable answer (a transport / framing error that is not "the
 *                tag left") - a glitch, worth retrying
 * Throws when the tag left the reader.
 */
async function readBlockOutcome(io: ReaderIo, idm: Uint8Array, block: number, service = FELICA_SERVICE_RO): Promise<Uint8Array | 'refused' | 'failed'> {
  try {
    if (io.rawCommands) {
      const resp = await io.raw(felicaReadWithoutEncryption(idm, [block], service));
      const r = parseRead(resp);
      if (r.statusFlag1 !== 0x00 || r.blocks.length < 1) return 'refused';
      return r.blocks[0];
    }
    // Storage driver: FF B0 00 <block> 10 -> FeliCa Read Without Encryption. A
    // block the card errors on (e.g. MC via the wrong service) comes back as SW 91 00.
    const { data, sw } = await io.readBinarySw(block, 16);
    if (!isSuccessSw(sw)) return 'refused';
    return data.length >= 16 ? data.subarray(0, 16) : 'refused';
  } catch (e) {
    if (isLinkLost(e)) throw e;
    return 'failed';
  }
}

/**
 * Read one FeliCa block (16 bytes), or null when the card refuses it. Raw
 * driver: a transport failure throws (so a write read-back is not "skipped" as
 * if the block were unreadable). Storage driver: any failure is null.
 */
async function readBlock(io: ReaderIo, idm: Uint8Array, block: number, service = FELICA_SERVICE_RO): Promise<Uint8Array | null> {
  if (io.rawCommands) {
    const resp = await io.raw(felicaReadWithoutEncryption(idm, [block], service));
    const r = parseRead(resp);
    if (r.statusFlag1 !== 0x00 || r.blocks.length < 1) return null;
    return r.blocks[0];
  }
  const r = await readBlockOutcome(io, idm, block, service);
  return r instanceof Uint8Array ? r : null;
}

/**
 * Is this FeliCa card a Lite / Lite-S (the only FeliCa product this app edits)?
 * Suica, other transit cards and FeliCa Standard ID cards share the FeliCa ATR,
 * so the ATR alone must not decide (2026-11-12 UX audit CARD-12).
 *  - 'lite-s':  SYS_C (block 0x85) reads 88 B4, or - when SYS_C cannot be read -
 *               the Lite-S ID block (0x82, verified readable on a real Lite-S via
 *               PaSoRi 2026-11-12) answers: only the Lite family exposes these
 *               system blocks through the plain read-only service.
 *  - 'other':   SYS_C reads, with another system code (definitively not Lite-S).
 *  - 'refused': both blocks were answered with a refusal (another FeliCa product,
 *               most likely - a Lite-S always answers them). The caller retries
 *               and calls it unsupported only if that persists (2026-11-12 review R-MAIN-4).
 *  - 'unknown': no usable answer (a glitch / bad coupling): retried, then reported
 *               as a read error - never as "unsupported".
 * Throws when the tag left the reader.
 */
export async function probeFelicaLiteS(io: ReaderIo, idm: Uint8Array): Promise<'lite-s' | 'other' | 'refused' | 'unknown'> {
  const sysC = await readBlockOutcome(io, idm, FELICA_LITE_S_INFO_BLOCKS.sysC);
  if (sysC instanceof Uint8Array) return ((sysC[0] << 8) | sysC[1]) === FELICA_LITE_S_SYSTEM_CODE ? 'lite-s' : 'other';
  const id = await readBlockOutcome(io, idm, FELICA_LITE_S_INFO_BLOCKS.id);
  if (id instanceof Uint8Array) return 'lite-s';
  return sysC === 'refused' && id === 'refused' ? 'refused' : 'unknown';
}

/**
 * R-MAIN-3: "is the tag still there?" = read the Lite-S system blocks again (a
 * Lite-S always answers SYS_C or ID; the identification read one of them).
 */
function felicaGuard(io: ReaderIo, idm: Uint8Array, enabled: boolean): PresenceGuard {
  if (!enabled) return new PresenceGuard(null);
  return new PresenceGuard(async () => {
    if (await readBlock(io, idm, FELICA_LITE_S_INFO_BLOCKS.sysC)) return true;
    return (await readBlock(io, idm, FELICA_LITE_S_INFO_BLOCKS.id)) !== null;
  });
}

export interface FelicaOpOptions {
  /** Check that the tag is still there when a block is refused (R-MAIN-3). Default true. */
  checkPresence?: boolean;
}

/**
 * Read the whole editable FeliCa image (user 0x00-0x0D + REG + MC) plus a few
 * read-only system blocks for display. `idm` is the 8-byte IDm (from getUid).
 * Works on both raw and storage drivers; blocks the card refuses are 'denied'.
 */
export async function readFelica(io: ReaderIo, kind: TagKind, idm: Uint8Array, opts: FelicaOpOptions = {}): Promise<FelicaReadResult> {
  const spec = specFor(kind);
  const data = new Uint8Array(spec.unitCount * 16);
  const unitStatus: UnitStatus[] = new Array(spec.unitCount).fill('unread');
  const guard = felicaGuard(io, idm, opts.checkPresence !== false);
  for (let unit = 0; unit < spec.unitCount; unit++) {
    const block = felicaBlockOfUnit(kind, unit);
    try {
      const blk = await readBlock(io, idm, block);
      if (blk && blk.length === 16) {
        data.set(blk, unit * 16);
        unitStatus[unit] = 'ok';
      } else {
        unitStatus[unit] = 'denied';
      }
    } catch (e) {
      // Throws CARD_REMOVED (whole read fails) when the tag left the reader.
      if (isLinkLost(e)) throw e;
      unitStatus[unit] = 'error';
    }
    // A Lite-S answers every grid block: a refusal may be the tag leaving (R-MAIN-3).
    if (unitStatus[unit] !== 'ok') await guard.refused();
  }
  await guard.finish();
  const info = { id: null as string | null, sysC: null as string | null, ckv: null as string | null };
  try {
    const id = await readBlock(io, idm, FELICA_LITE_S_INFO_BLOCKS.id);
    if (id) info.id = hex(id);
    const sysC = await readBlock(io, idm, FELICA_LITE_S_INFO_BLOCKS.sysC);
    if (sysC) info.sysC = hex(sysC);
    const ckv = await readBlock(io, idm, FELICA_LITE_S_INFO_BLOCKS.ckv);
    if (ckv) info.ckv = hex(ckv);
  } catch {
    // info blocks are best-effort
  }
  return { data, unitStatus, info };
}

export type FelicaWriteResult = UnitWriteOutcome;

/**
 * Write units (grid index) to FeliCa via Write Without Encryption. A refused
 * block is recorded in `failed` (ErrorCode); a tag that leaves the reader stops
 * the loop (`aborted`, `notAttempted`) instead of rejecting the whole write, so
 * the caller can say which blocks were already written.
 */
export async function writeFelica(
  io: ReaderIo,
  kind: TagKind,
  idm: Uint8Array,
  writes: { unit: number; data: Uint8Array }[],
  opts: FelicaOpOptions = {},
): Promise<FelicaWriteResult> {
  return runUnitWrites(
    writes,
    async (w) => {
      const block = felicaBlockOfUnit(kind, w.unit);
      if (io.rawCommands) {
        const resp = await io.raw(felicaWriteWithoutEncryption(idm, block, w.data, FELICA_SERVICE_RW));
        const r = parseWrite(resp);
        if (r.statusFlag1 !== 0x00) {
          throw new OpError('WRITE_FAILED', `FeliCa status ${r.statusFlag1.toString(16)}/${r.statusFlag2.toString(16)}`);
        }
      } else {
        // Storage driver: FF D6 00 <block> 10 <16B> -> FeliCa Write Without
        // Encryption. A write-protected block is rejected by the card as SW 91 00,
        // which updateBinary surfaces as WRITE_FAILED (so protection is detected).
        await io.updateBinary(block, w.data);
      }
    },
    undefined,
    felicaGuard(io, idm, opts.checkPresence !== false),
  );
}

/** Read back one block for write verification (returns null when not readable). */
export async function readFelicaBlock(io: ReaderIo, kind: TagKind, idm: Uint8Array, unit: number): Promise<Uint8Array | null> {
  return readBlock(io, idm, felicaBlockOfUnit(kind, unit));
}
