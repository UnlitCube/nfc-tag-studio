// Raw binary memory-image import/export. Pure TypeScript: no Node, no DOM.

import { type TagKind, specFor, imageSize } from '../tags';
import type { TagImage, UnitStatus } from '../types';
import { extractUid } from './_util';

/** Raw image byte-size -> kind (NTAG213 180 / 215 540 / 216 924, MIFARE 1K 1024 / 4K 4096). */
const BIN_SIZES: Record<number, TagKind> = {
  180: 'NTAG213',
  540: 'NTAG215',
  924: 'NTAG216',
  1024: 'MIFARE_CLASSIC_1K',
  4096: 'MIFARE_CLASSIC_4K',
};

/** Kind implied by a raw image's byte length, or undefined. */
export function binSizeKind(size: number): TagKind | undefined {
  return BIN_SIZES[size];
}

/** Raw memory image (all units concatenated). */
export function exportBin(img: TagImage): Uint8Array {
  return new Uint8Array(img.data);
}

/** Raw image -> TagImage. Kind from size (180/540/924/1024/4096) unless kindHint given; uid from the header. */
export function importBin(bytes: Uint8Array, kindHint?: TagKind): TagImage {
  const kind = kindHint ?? BIN_SIZES[bytes.length];
  if (!kind) throw new Error(`サイズ ${bytes.length} バイトからタグ種類を判定できません`);
  const size = imageSize(kind);
  if (bytes.length !== size) throw new Error(`${kind} は ${size} バイトですが、${bytes.length} バイトでした`);
  const data = new Uint8Array(bytes);
  return {
    kind,
    uid: extractUid(kind, data),
    data,
    unitStatus: new Array(specFor(kind).unitCount).fill('ok') as UnitStatus[],
    readAt: Date.now(),
  };
}
