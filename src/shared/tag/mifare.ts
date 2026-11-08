// MIFARE Classic access-condition descriptions and sector-trailer builder.
// Access-condition tables follow the MIFARE Classic data sheet (data block and
// sector-trailer condition tables). See docs/research/ntag-mifare.md.
// Pure TypeScript: no Node, no DOM.

import { type AccessBits, encodeAccessBits } from '../tags';

/** Plain-language access rights of one block group, derived from C1C2C3. */
export interface AccessDescription {
  read: 'never' | 'A' | 'B' | 'AB';
  write: 'never' | 'A' | 'B' | 'AB';
  /** For data blocks; null for trailer. */
  increment: 'never' | 'A' | 'B' | 'AB' | null;
  decrementTransferRestore: 'never' | 'A' | 'B' | 'AB' | null;
  /** Japanese one-liner. */
  summary: string;
}

type Who = 'never' | 'A' | 'B' | 'AB';

interface DataRights {
  read: Who;
  write: Who;
  increment: Who;
  decrement: Who;
}
interface TrailerRights {
  read: Who;
  write: Who;
}

// Index = (C1 << 2) | (C2 << 1) | C3.
const DATA_TABLE: Record<number, DataRights> = {
  0b000: { read: 'AB', write: 'AB', increment: 'AB', decrement: 'AB' },
  0b010: { read: 'AB', write: 'never', increment: 'never', decrement: 'never' },
  0b100: { read: 'AB', write: 'B', increment: 'never', decrement: 'never' },
  0b110: { read: 'AB', write: 'B', increment: 'B', decrement: 'AB' },
  0b001: { read: 'AB', write: 'never', increment: 'never', decrement: 'AB' },
  0b011: { read: 'B', write: 'B', increment: 'never', decrement: 'never' },
  0b101: { read: 'B', write: 'never', increment: 'never', decrement: 'never' },
  0b111: { read: 'never', write: 'never', increment: 'never', decrement: 'never' },
};

// Trailer: read = who may read the access bits, write = who may rewrite the trailer (keys + access).
const TRAILER_TABLE: Record<number, TrailerRights> = {
  0b000: { read: 'A', write: 'A' },
  0b010: { read: 'A', write: 'never' },
  0b100: { read: 'AB', write: 'B' },
  0b110: { read: 'AB', write: 'never' },
  0b001: { read: 'A', write: 'A' },
  0b011: { read: 'AB', write: 'B' },
  0b101: { read: 'AB', write: 'never' },
  0b111: { read: 'AB', write: 'never' },
};

function who(v: Who): string {
  return v === 'AB' ? '鍵A/B' : v === 'A' ? '鍵A' : v === 'B' ? '鍵B' : '不可';
}

/** Describe group i (0..2 data, 3 trailer) of decoded access bits. */
export function describeAccess(bits: AccessBits, group: 0 | 1 | 2 | 3): AccessDescription {
  const [c1, c2, c3] = bits.c[group];
  const key = ((c1 & 1) << 2) | ((c2 & 1) << 1) | (c3 & 1);
  if (group === 3) {
    const t = TRAILER_TABLE[key];
    return {
      read: t.read,
      write: t.write,
      increment: null,
      decrementTransferRestore: null,
      summary: `アクセス条件 読取:${who(t.read)} / 書換:${who(t.write)}`,
    };
  }
  const d = DATA_TABLE[key];
  return {
    read: d.read,
    write: d.write,
    increment: d.increment,
    decrementTransferRestore: d.decrement,
    summary: `読取:${who(d.read)} 書込:${who(d.write)} 加算:${who(d.increment)} 減算:${who(d.decrement)}`,
  };
}

/** Build a 16-byte sector trailer. Throws when keys are not 6 bytes. */
export function buildTrailer(keyA: Uint8Array, access: AccessBits, keyB: Uint8Array): Uint8Array {
  if (keyA.length !== 6) throw new Error('Key A は 6 バイト（16 進 12 桁）です');
  if (keyB.length !== 6) throw new Error('Key B は 6 バイト（16 進 12 桁）です');
  const out = new Uint8Array(16);
  out.set(keyA, 0);
  out.set(encodeAccessBits(access), 6);
  out.set(keyB, 10);
  return out;
}
