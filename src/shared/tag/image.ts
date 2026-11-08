// Tag image helpers (construction, cloning, diffing, blank detection).
// Pure TypeScript: no Node, no DOM.

import { bytesToHex, hexToBytes } from '../hex';
import { type TagKind, factoryImage, isNtag, specFor, ntagPages, mifareDataBlocks } from '../tags';
import type { TagImage, UnitStatus } from '../types';
import { allZero } from './_util';

/** Factory-fresh image wrapped as TagImage (all units 'ok'). uid = hex of 7 (NTAG) / 4 (MIFARE) bytes. */
export function blankImage(kind: TagKind, uid: string): TagImage {
  const uidBytes = hexToBytes(uid);
  const data = factoryImage(kind, uidBytes);
  const unitCount = specFor(kind).unitCount;
  return {
    kind,
    uid: bytesToHex(uidBytes),
    data,
    unitStatus: new Array(unitCount).fill('ok') as UnitStatus[],
    readAt: Date.now(),
  };
}

/** Deep copy. */
export function cloneImage(img: TagImage): TagImage {
  const copy: TagImage = {
    kind: img.kind,
    uid: img.uid,
    data: new Uint8Array(img.data),
    unitStatus: img.unitStatus.slice(),
    readAt: img.readAt,
  };
  if (img.ntag) copy.ntag = { ...img.ntag };
  if (img.mifare) copy.mifare = { sectors: img.mifare.sectors.map((s) => ({ ...s })) };
  return copy;
}

/** Bytes of one unit (copy). */
export function unitBytes(kind: TagKind, data: Uint8Array, unit: number): Uint8Array {
  const size = specFor(kind).unitSize;
  return data.slice(unit * size, unit * size + size);
}

/** Indices of units whose bytes differ between a and b (same kind/size). */
export function diffUnits(kind: TagKind, a: Uint8Array, b: Uint8Array): number[] {
  const spec = specFor(kind);
  const out: number[] = [];
  for (let u = 0; u < spec.unitCount; u++) {
    const off = u * spec.unitSize;
    for (let i = 0; i < spec.unitSize; i++) {
      if (a[off + i] !== b[off + i]) {
        out.push(u);
        break;
      }
    }
  }
  return out;
}

/**
 * True when the writable data area carries no operator data:
 * NTAG - user area has no NDEF message with records (empty TLV 03 00 or all zero);
 * MIFARE - every readable data block (excluding block 0 and trailers) is all zero.
 */
export function isBlankDataArea(kind: TagKind, data: Uint8Array): boolean {
  if (isNtag(kind)) {
    const p = ntagPages(kind);
    const user = data.slice(4 * 4, (p.userLast + 1) * 4);
    let i = 0;
    while (i < user.length) {
      const t = user[i];
      if (t === 0x00) {
        i++; // NULL TLV (padding)
        continue;
      }
      if (t === 0xfe) return true; // terminator reached with no NDEF data
      if (i + 1 >= user.length) break;
      let len = user[i + 1];
      let hdr = 2;
      if (len === 0xff) {
        if (i + 3 >= user.length) break;
        len = (user[i + 2] << 8) | user[i + 3];
        hdr = 4;
      }
      if (t === 0x03) return len === 0; // NDEF TLV: blank only when empty
      i += hdr + len; // skip other TLVs (lock/memory control, proprietary)
    }
    return true;
  }
  for (const b of mifareDataBlocks(kind)) {
    if (!allZero(data.slice(b * 16, b * 16 + 16))) return false;
  }
  return true;
}
