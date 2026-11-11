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
// MC[0] / MC[1] = MC_ALL: per-block read/write permission for blocks 0x00..0x0E.
//   MC[0] bit i (i=0..7)  -> block 0x00..0x07
//   MC[1] bit i (i=0..6)  -> block 0x08..0x0E
//   1 = read & write, 0 = read-only (writing 0 is IRREVERSIBLE for that block).
// MC[2] bit0 = SYS_OP: 0 = FeliCa Lite compatible, 1 = Lite-S extended mode.
// Other MC bytes carry RF / system-block settings and are shown as raw.

export interface FelicaMc {
  /** index 0..14 -> writable flag for block 0x00..0x0E. */
  writable: boolean[];
  /** false = Lite compatible, true = Lite-S. */
  liteS: boolean;
  raw: Uint8Array;
}

export function decodeFelicaMc(mc: Uint8Array): FelicaMc {
  const writable: boolean[] = [];
  for (let b = 0; b <= 0x0e; b++) {
    const byte = b < 8 ? mc[0] : mc[1];
    const bit = b < 8 ? b : b - 8;
    writable.push(((byte >> bit) & 1) === 1);
  }
  return { writable, liteS: (mc[2] & 0x01) === 1, raw: mc.slice(0, 16) };
}

/** Re-encode MC[0], MC[1] (write bitmap) and MC[2] bit0 (SYS_OP); other bytes kept. */
export function encodeFelicaMc(mc: FelicaMc): Uint8Array {
  const out = new Uint8Array(16);
  out.set(mc.raw.subarray(0, 16));
  let b0 = 0;
  let b1 = 0;
  for (let b = 0; b <= 0x0e; b++) {
    if (!mc.writable[b]) continue;
    if (b < 8) b0 |= 1 << b;
    else b1 |= 1 << (b - 8);
  }
  out[0] = b0;
  out[1] = b1;
  out[2] = (out[2] & ~0x01) | (mc.liteS ? 0x01 : 0x00);
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
