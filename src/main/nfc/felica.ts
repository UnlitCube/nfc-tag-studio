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
import { felicaBlockOfUnit, specFor, FELICA_LITE_S_INFO_BLOCKS } from '@shared/tags';
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
import type { ReaderIo } from './driver';

export interface FelicaReadResult {
  data: Uint8Array;
  unitStatus: UnitStatus[];
  /** Read-only system blocks for display (hex), when readable. */
  info: { id: string | null; sysC: string | null; ckv: string | null };
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();

/** Read one FeliCa block (16 bytes), or null when the card refuses / cannot read it. */
async function readBlock(io: ReaderIo, idm: Uint8Array, block: number, service = FELICA_SERVICE_RO): Promise<Uint8Array | null> {
  if (io.rawCommands) {
    const resp = await io.raw(felicaReadWithoutEncryption(idm, [block], service));
    const r = parseRead(resp);
    if (r.statusFlag1 !== 0x00 || r.blocks.length < 1) return null;
    return r.blocks[0];
  }
  // Storage driver: FF B0 00 <block> 10 -> FeliCa Read Without Encryption. A block
  // the card errors on (e.g. MC via the wrong service) comes back as SW 91 00 and
  // readBinary throws READ_FAILED -> treat as 'not readable' (null), not an abort.
  try {
    const b = await io.readBinary(block, 16);
    return b.length >= 16 ? b.subarray(0, 16) : null;
  } catch (e) {
    if (e instanceof OpError && e.code === 'CARD_REMOVED') throw e;
    return null;
  }
}

/**
 * Read the whole editable FeliCa image (user 0x00-0x0D + REG + MC) plus a few
 * read-only system blocks for display. `idm` is the 8-byte IDm (from getUid).
 * Works on both raw and storage drivers; blocks the card refuses are 'denied'.
 */
export async function readFelica(io: ReaderIo, kind: TagKind, idm: Uint8Array): Promise<FelicaReadResult> {
  const spec = specFor(kind);
  const data = new Uint8Array(spec.unitCount * 16);
  const unitStatus: UnitStatus[] = new Array(spec.unitCount).fill('unread');
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
      if (e instanceof OpError && e.code === 'CARD_REMOVED') throw e;
      unitStatus[unit] = 'error';
    }
  }
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

export interface FelicaWriteResult {
  written: number[];
  failed: { unit: number; error: string }[];
}

/** Write units (grid index) to FeliCa via Write Without Encryption. */
export async function writeFelica(io: ReaderIo, kind: TagKind, idm: Uint8Array, writes: { unit: number; data: Uint8Array }[]): Promise<FelicaWriteResult> {
  const written: number[] = [];
  const failed: { unit: number; error: string }[] = [];
  for (const w of writes) {
    const block = felicaBlockOfUnit(kind, w.unit);
    try {
      if (io.rawCommands) {
        const resp = await io.raw(felicaWriteWithoutEncryption(idm, block, w.data, FELICA_SERVICE_RW));
        const r = parseWrite(resp);
        if (r.statusFlag1 === 0x00) written.push(w.unit);
        else failed.push({ unit: w.unit, error: `FeliCa status ${r.statusFlag1.toString(16)}/${r.statusFlag2.toString(16)}` });
      } else {
        // Storage driver: FF D6 00 <block> 10 <16B> -> FeliCa Write Without
        // Encryption. A write-protected block is rejected by the card as SW 91 00,
        // which updateBinary surfaces as WRITE_FAILED (so protection is detected).
        await io.updateBinary(block, w.data);
        written.push(w.unit);
      }
    } catch (e) {
      if (e instanceof OpError && e.code === 'CARD_REMOVED') throw e;
      failed.push({ unit: w.unit, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { written, failed };
}

/** Read back one block for write verification (returns null when not readable). */
export async function readFelicaBlock(io: ReaderIo, kind: TagKind, idm: Uint8Array, unit: number): Promise<Uint8Array | null> {
  return readBlock(io, idm, felicaBlockOfUnit(kind, unit));
}
