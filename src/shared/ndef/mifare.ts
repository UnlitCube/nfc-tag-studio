// MIFARE Classic NDEF: locate NDEF data via the MIFARE Application Directory
// (MAD) and plan writes that never touch sector trailers or the MAD. Pure TS.
//
// MAD layout (NXP AN10787 / NFC Forum "Type MIFARE Classic Tag"):
//   MAD1 lives in sector 0, blocks 1-2 (bytes 16..47): CRC, Info, then one
//   2-byte AID per sector 1..15.  MAD2 lives in sector 16, blocks 64-66
//   (bytes 1024..1071): CRC, Info, then one 2-byte AID per sector 17..39.
//   Each AID is stored as [application code, function cluster code]; the NDEF
//   application AID reads 0x03E1 (bytes 03 E1).
//
// Design invariant: block 0 (UID / manufacturer) and the sector trailers (keys /
// access bits) are never written here. The UID is read-only and is not copied.

import { concatBytes } from '../hex';
import { isMifare, mifareSectorCount, mifareSectorFirstBlock, mifareTrailerBlock, specFor } from '../tags';
import type { TagKind } from '../tags';
import type { UnitWrite } from '../types';
import { findNdefMessage, wrapNdefTlv } from './tlv';
import { NdefError } from './types';

const NDEF_AID = 0x03e1;
const MAD2_SECTOR = 16;

/** 16-bit AID the MAD assigns to a data sector (0 when unmapped or out of range). */
function sectorAid(data: Uint8Array, sector: number): number {
  let off: number;
  if (sector >= 1 && sector <= 15) {
    off = 16 + 2 * sector; // MAD1: sector 1 -> byte 18
  } else if (sector >= 17 && sector <= 39) {
    off = 1024 + 2 * (sector - MAD2_SECTOR); // MAD2: sector 17 -> byte 1026
  } else {
    return 0; // sector 0 and sector 16 are MAD directories, not data
  }
  if (off + 1 >= data.length) return 0;
  return (data[off] << 8) | data[off + 1];
}

/** Ordered data-block indices of every sector the MAD marks as NDEF (AID 0x03E1). */
function ndefDataBlocks(kind: TagKind, data: Uint8Array): number[] {
  const blocks: number[] = [];
  const sectors = mifareSectorCount(kind);
  for (let s = 1; s < sectors; s++) {
    if (s === MAD2_SECTOR) continue; // MAD2 directory sector
    if (sectorAid(data, s) !== NDEF_AID) continue;
    const first = mifareSectorFirstBlock(s);
    const trailer = mifareTrailerBlock(s);
    for (let b = first; b < trailer; b++) blocks.push(b);
  }
  return blocks;
}

/**
 * MIFARE Classic NDEF: read the MAD, collect data blocks of sectors whose AID is
 * 0x03E1, scan TLVs and return the NDEF message, or null. `data` is a full image
 * (unreadable sectors are zero).
 */
export function extractMifareNdef(kind: TagKind, data: Uint8Array): Uint8Array | null {
  if (!isMifare(kind)) return null;
  const blocks = ndefDataBlocks(kind, data);
  if (blocks.length === 0) return null;
  const chunks: Uint8Array[] = [];
  for (const b of blocks) {
    const off = b * 16;
    chunks.push(data.slice(off, off + 16));
  }
  return findNdefMessage(concatBytes(...chunks));
}

/**
 * Writes for putting `message` onto an ALREADY NDEF-formatted MIFARE Classic
 * card (MAD present). Only data blocks of NDEF sectors are written; trailers and
 * MAD are never touched. Throws NdefError when the card is not NDEF-formatted or
 * the message does not fit.
 */
export function buildMifareNdefWrites(kind: TagKind, data: Uint8Array, message: Uint8Array): UnitWrite[] {
  if (!isMifare(kind)) throw new NdefError(`${kind} は MIFARE Classic ではありません`);
  const blocks = ndefDataBlocks(kind, data);
  if (blocks.length === 0) {
    throw new NdefError('NDEF フォーマットされていません（MAD に NDEF セクタがありません）');
  }
  const tlv = wrapNdefTlv(message);
  const capacity = blocks.length * 16;
  if (tlv.length > capacity) {
    throw new NdefError(`NDEF メッセージが大きすぎます（${tlv.length} バイト > 空き ${capacity} バイト）`);
  }
  const blockCount = Math.ceil(tlv.length / 16);
  const writes: UnitWrite[] = [];
  const unitSize = specFor(kind).unitSize; // 16
  for (let k = 0; k < blockCount; k++) {
    const chunk = new Uint8Array(unitSize);
    chunk.set(tlv.slice(k * unitSize, k * unitSize + unitSize));
    writes.push({ unit: blocks[k], data: chunk });
  }
  return writes;
}
