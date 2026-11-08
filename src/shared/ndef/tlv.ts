// NFC Forum Type 2 TLV handling and NTAG capacity/CC helpers. Pure TypeScript.
// Builds on the layout facts in ../tags.ts (integrator-owned).

import { concatBytes } from '../hex';
import { isNtag, specFor } from '../tags';
import type { TagKind } from '../tags';
import { NdefError } from './types';
import type { Type2TlvScan } from './types';

const TLV_NULL = 0x00;
const TLV_NDEF = 0x03;
const TLV_TERMINATOR = 0xfe;

/** NDEF data area the NTAG Capability Container declares (bytes): 213=144, 215=496, 216=872. */
function ccNdefBytes(kind: TagKind): number {
  switch (kind) {
    case 'NTAG213':
      return 144;
    case 'NTAG215':
      return 496;
    case 'NTAG216':
      return 872;
    default:
      throw new NdefError(`${kind} は NFC Forum Type 2（NTAG）ではありません`);
  }
}

/** NDEF message -> NDEF TLV (03 L V, 3-byte length form FF hi lo when L >= 255) followed by terminator FE. */
export function wrapNdefTlv(message: Uint8Array): Uint8Array {
  const len = message.length;
  const header =
    len < 255 ? Uint8Array.from([TLV_NDEF, len]) : Uint8Array.from([TLV_NDEF, 0xff, (len >> 8) & 0xff, len & 0xff]);
  return concatBytes(header, message, Uint8Array.from([TLV_TERMINATOR]));
}

interface RawScan {
  tlvs: { tag: number; offset: number; length: number; valueOffset: number }[];
  ndef: Uint8Array | null;
  ndefTlvOffset: number | null;
  terminatorOffset: number | null;
}

/** Walk a Type 2 TLV byte run. NULL (0x00) padding is skipped; scanning stops at the terminator. */
function scanTlvs(area: Uint8Array): RawScan {
  const tlvs: RawScan['tlvs'] = [];
  let ndef: Uint8Array | null = null;
  let ndefTlvOffset: number | null = null;
  let terminatorOffset: number | null = null;
  let i = 0;
  while (i < area.length) {
    const tag = area[i];
    if (tag === TLV_NULL) {
      i += 1; // NULL TLV: single byte of padding
      continue;
    }
    if (tag === TLV_TERMINATOR) {
      terminatorOffset = i;
      tlvs.push({ tag, offset: i, length: 0, valueOffset: i + 1 });
      break;
    }
    if (i + 1 >= area.length) break; // truncated length field
    let length: number;
    let valueOffset: number;
    if (area[i + 1] === 0xff) {
      if (i + 3 >= area.length) break;
      length = (area[i + 2] << 8) | area[i + 3];
      valueOffset = i + 4;
    } else {
      length = area[i + 1];
      valueOffset = i + 2;
    }
    tlvs.push({ tag, offset: i, length, valueOffset });
    if (tag === TLV_NDEF && ndef === null) {
      const end = Math.min(valueOffset + length, area.length);
      ndef = area.slice(valueOffset, end);
      ndefTlvOffset = i;
    }
    i = valueOffset + length;
  }
  return { tlvs, ndef, ndefTlvOffset, terminatorOffset };
}

/** Find the first NDEF message within a Type 2 TLV byte run, or null. */
export function findNdefMessage(area: Uint8Array): Uint8Array | null {
  return scanTlvs(area).ndef;
}

/**
 * Scan a Type 2 user area (bytes from page 4) for TLVs: 00 NULL, 01 Lock Control,
 * 02 Memory Control, 03 NDEF, FD Proprietary, FE Terminator.
 */
export function scanType2Tlvs(area: Uint8Array): Type2TlvScan {
  const s = scanTlvs(area);
  const limit = s.terminatorOffset ?? area.length;
  let allZero = true;
  for (let k = 0; k < limit; k++) {
    if (area[k] !== 0) {
      allZero = false;
      break;
    }
  }
  return {
    ndef: s.ndef,
    ndefTlvOffset: s.ndefTlvOffset,
    terminatorOffset: s.terminatorOffset,
    tlvs: s.tlvs,
    blank: s.ndef === null && allZero,
  };
}

/** Maximum NDEF message length (bytes) that fits a Type 2 tag of `kind`, accounting for TLV overhead + terminator. */
export function type2Capacity(kind: TagKind): number {
  const area = ccNdefBytes(kind);
  // Overhead = tag(1) + length(1 for <255, else 3) + terminator(1).
  const short = area - 3; // messages up to 254 bytes use the 1-byte length form
  return short <= 254 ? short : area - 5;
}

/**
 * Full user area (exactly specFor(kind).userBytes bytes) holding `message` as an
 * NDEF TLV + terminator, rest zero. Throws NdefError when it does not fit.
 */
export function buildType2UserArea(kind: TagKind, message: Uint8Array): Uint8Array {
  if (!isNtag(kind)) throw new NdefError(`${kind} は NFC Forum Type 2（NTAG）ではありません`);
  const cap = type2Capacity(kind);
  if (message.length > cap) {
    throw new NdefError(`NDEF メッセージが大きすぎます（${message.length} バイト > 上限 ${cap} バイト）`);
  }
  const area = new Uint8Array(specFor(kind).userBytes);
  area.set(wrapNdefTlv(message), 0);
  return area;
}

/** Default NTAG Capability Container (page 3): E1 10 <size/8> 00. */
export function defaultCc(kind: TagKind): Uint8Array {
  if (!isNtag(kind)) throw new NdefError(`${kind} は NFC Forum Type 2（NTAG）ではありません`);
  return Uint8Array.from([0xe1, 0x10, ccNdefBytes(kind) / 8, 0x00]);
}
