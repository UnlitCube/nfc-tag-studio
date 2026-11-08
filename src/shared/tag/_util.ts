// Internal helpers for the tag module. NOT part of the public API (index.ts does
// not re-export this file). Pure TypeScript: no Node, no DOM (TextDecoder ok).

import { bytesToHex, hexToBytes } from '../hex';
import { type TagKind, isNtag } from '../tags';

/** True when every byte is zero. */
export function allZero(b: Uint8Array): boolean {
  for (const x of b) if (x !== 0) return false;
  return true;
}

/**
 * UID bytes read out of a raw memory image:
 *  - NTAG: 7 bytes from pages 0-1 (page0 bytes 0-2, page1 bytes 0-3); byte 3 is BCC0.
 *  - MIFARE Classic: 4 bytes from block 0.
 */
export function extractUidBytes(kind: TagKind, data: Uint8Array): Uint8Array {
  if (isNtag(kind)) {
    return Uint8Array.from([data[0], data[1], data[2], data[4], data[5], data[6], data[7]]);
  }
  return data.slice(0, 4);
}

/** UID as uppercase hex without separators. */
export function extractUid(kind: TagKind, data: Uint8Array): string {
  return bytesToHex(extractUidBytes(kind, data));
}

/** hex UID -> bytes (spaces/separators ignored). */
export function uidHexToBytes(uid: string): Uint8Array {
  return hexToBytes(uid);
}

/** Decode up to n leading bytes as UTF-8 text for sniffing (lenient). */
export function sniffText(bytes: Uint8Array, n: number): string {
  const slice = bytes.length > n ? bytes.slice(0, n) : bytes;
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(slice);
  } catch {
    let s = '';
    for (const b of slice) s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ' ';
    return s;
  }
}
