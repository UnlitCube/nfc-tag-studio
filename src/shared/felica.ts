// FeliCa Lite-S protocol framing + MC (Memory Configuration) decode. Pure logic
// (no Node/DOM). Used by the reader layer (command packets) and the inspector /
// flag editor (MC decode). CONTRACT FILE - integrator-owned.
//
// Scope: FeliCa Lite / Lite-S "Without Encryption" access only. This tool does
// NOT implement the card-key authentication / MAC (it never recovers keys).

/** Lite-S services: read-only 0x000B, read+write 0x0009 (random service). */
export const FELICA_SERVICE_RO = 0x000b;
export const FELICA_SERVICE_RW = 0x0009;

export class FelicaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FelicaError';
  }
}

/** A FeliCa packet = [len, ...payload] where len counts itself. */
function frame(payload: number[]): Uint8Array {
  const len = payload.length + 1;
  if (len > 0xff) throw new FelicaError('FeliCa パケットが長すぎます');
  return Uint8Array.from([len, ...payload]);
}

/** Polling (0x00). Returns the packet to transmit. */
export function felicaPolling(systemCode: number, requestCode = 0x01, timeSlot = 0x00): Uint8Array {
  return frame([0x00, (systemCode >> 8) & 0xff, systemCode & 0xff, requestCode & 0xff, timeSlot & 0xff]);
}

export interface PollingResult {
  idm: Uint8Array; // 8 bytes
  pmm: Uint8Array; // 8 bytes
  /** Present when requestCode=0x01: the card's system code. */
  systemCode: number | null;
}

/** Parse a Polling response (0x01). */
export function parsePolling(resp: Uint8Array): PollingResult {
  // [len][01][IDm8][PMm8]([reqData2])
  if (resp.length < 18 || resp[1] !== 0x01) throw new FelicaError('Polling 応答が不正です');
  const idm = resp.slice(2, 10);
  const pmm = resp.slice(10, 18);
  const systemCode = resp.length >= 20 ? (resp[18] << 8) | resp[19] : null;
  return { idm, pmm, systemCode };
}

/** Block-list element for block numbers < 256 (2-byte form, service index 0). */
function blockElement(block: number): [number, number] {
  return [0x80, block & 0xff];
}

/** Read Without Encryption (0x06) for one service + a list of block numbers. */
export function felicaReadWithoutEncryption(idm: Uint8Array, blocks: number[], service = FELICA_SERVICE_RO): Uint8Array {
  if (idm.length !== 8) throw new FelicaError('IDm は 8 バイトです');
  if (blocks.length < 1 || blocks.length > 4) throw new FelicaError('一度に読めるのは 1〜4 ブロックです');
  const payload = [
    0x06,
    ...idm,
    0x01,
    service & 0xff,
    (service >> 8) & 0xff, // service code, little-endian
    blocks.length,
    ...blocks.flatMap(blockElement),
  ];
  return frame(payload);
}

export interface ReadResult {
  statusFlag1: number;
  statusFlag2: number;
  /** 16-byte blocks, in request order (empty on error). */
  blocks: Uint8Array[];
}

/** Parse a Read Without Encryption response (0x07). statusFlag1 0x00 = success. */
export function parseRead(resp: Uint8Array): ReadResult {
  if (resp.length < 12 || resp[1] !== 0x07) throw new FelicaError('Read 応答が不正です');
  const sf1 = resp[10];
  const sf2 = resp[11];
  const blocks: Uint8Array[] = [];
  if (sf1 === 0x00) {
    const n = resp[12] ?? 0;
    for (let i = 0; i < n; i++) {
      const off = 13 + i * 16;
      blocks.push(resp.slice(off, off + 16));
    }
  }
  return { statusFlag1: sf1, statusFlag2: sf2, blocks };
}

/** Write Without Encryption (0x08) for one 16-byte block via the RW service. */
export function felicaWriteWithoutEncryption(idm: Uint8Array, block: number, data: Uint8Array, service = FELICA_SERVICE_RW): Uint8Array {
  if (idm.length !== 8) throw new FelicaError('IDm は 8 バイトです');
  if (data.length !== 16) throw new FelicaError('ブロックは 16 バイトです');
  const payload = [
    0x08,
    ...idm,
    0x01,
    service & 0xff,
    (service >> 8) & 0xff,
    0x01,
    ...blockElement(block),
    ...data,
  ];
  return frame(payload);
}

/** Parse a Write Without Encryption response (0x09). statusFlag1 0x00 = success. */
export function parseWrite(resp: Uint8Array): { statusFlag1: number; statusFlag2: number } {
  if (resp.length < 12 || resp[1] !== 0x09) throw new FelicaError('Write 応答が不正です');
  return { statusFlag1: resp[10], statusFlag2: resp[11] };
}

// --- MC (Memory Configuration, block 0x88) -----------------------------------
//
// Corrected 2026-11-12 against real FeliCa Lite-S hardware + nfcpy (FelicaLiteS).
// The per-block protection for Lite-S is NOT in MC[0]/MC[1] (that was wrong and
// had no effect on real cards); it lives in dedicated 16-bit masks, written as
// two identical copies, bit b (b = 0..14) controlling block 0x00..0x0E:
//   MC[6:8]   = read-protect mask   (1 = read protected)   - needs a card key/MAC
//   MC[8:10]  = write-protect mask  (1 = read-only)         } same value written
//   MC[10:12] = write-protect mask  (duplicate of MC[8:10]) } to both pairs
//   little-endian: MC[8] bit b -> block b (0..7), MC[9] bit (b-8) -> block 8..14.
//   Setting a write-protect bit to 1 is IRREVERSIBLE and latches on the next RF
//   activation (physical reseat on a PaSoRi; see CLAUDE.md).
// MC[2] = system-block (ID/SER_C/CKV/CK/MC) write enable: 0xFF = writable,
//   0x00 = read-only. (NOT a "SYS_OP" bit; Lite-S is identified by system code.)
// Factory default MC = FF FF FF 01 07 00..00 (all user blocks writable).

export interface FelicaMc {
  /** index 0..14 -> writable flag for block 0x00..0x0E (false = read-only). */
  writable: boolean[];
  /** index 0..14 -> read-protected flag for block 0x00..0x0E. */
  readProtected: boolean[];
  /** System blocks writable: MC[2] === 0xFF (0x00 = read-only). */
  systemBlocksWritable: boolean;
  raw: Uint8Array;
}

export function decodeFelicaMc(mc: Uint8Array): FelicaMc {
  const writeMask = (mc[8] | (mc[9] << 8)) & 0xffff; // 1 = write protected (read-only)
  const readMask = (mc[6] | (mc[7] << 8)) & 0xffff; // 1 = read protected
  const writable: boolean[] = [];
  const readProtected: boolean[] = [];
  for (let b = 0; b <= 0x0e; b++) {
    writable.push(((writeMask >> b) & 1) === 0);
    readProtected.push(((readMask >> b) & 1) === 1);
  }
  return { writable, readProtected, systemBlocksWritable: mc[2] === 0xff, raw: mc.slice(0, 16) };
}

/**
 * Re-encode the Lite-S protection masks (MC[6:8] read, MC[8:10] + MC[10:12] write)
 * and MC[2] (system-block write enable); all other MC bytes are preserved.
 */
export function encodeFelicaMc(mc: FelicaMc): Uint8Array {
  const out = new Uint8Array(16);
  out.set(mc.raw.subarray(0, 16));
  let writeMask = 0;
  let readMask = 0;
  for (let b = 0; b <= 0x0e; b++) {
    if (!mc.writable[b]) writeMask |= 1 << b; // 1 = read-only
    if (mc.readProtected[b]) readMask |= 1 << b;
  }
  out[6] = readMask & 0xff;
  out[7] = (readMask >> 8) & 0xff;
  out[8] = writeMask & 0xff;
  out[9] = (writeMask >> 8) & 0xff;
  out[10] = out[8]; // write-protect mask is stored as two identical copies
  out[11] = out[9];
  out[2] = mc.systemBlocksWritable ? 0xff : 0x00;
  return out;
}

/** FeliCa block name for the inspector (grid unit's real block number). */
export function felicaBlockName(block: number): string {
  if (block <= 0x0d) return `S_PAD${block}`;
  switch (block) {
    case 0x0e:
      return 'REG';
    case 0x80:
      return 'RC';
    case 0x81:
      return 'MAC';
    case 0x82:
      return 'ID';
    case 0x83:
      return 'D_ID';
    case 0x84:
      return 'SER_C';
    case 0x85:
      return 'SYS_C';
    case 0x86:
      return 'CKV';
    case 0x87:
      return 'CK';
    case 0x88:
      return 'MC';
    case 0x90:
      return 'WCNT';
    case 0x91:
      return 'MAC_A';
    case 0x92:
      return 'STATE';
    default:
      return `0x${block.toString(16).toUpperCase().padStart(2, '0')}`;
  }
}
