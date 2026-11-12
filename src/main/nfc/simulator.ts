// Virtual reader + virtual tag (the built-in simulator). Owner: agent "main-nfc".
//
// The simulator is a full ReaderBackend: it hands out CardConnections whose
// transmit() interprets APDUs at the same level real hardware does, so every
// layer above (tag ops, issue engine) runs unchanged against it. It understands
//   - storage pseudo-APDUs:  FF CA / FF B0 / FF D6 / FF 82 / FF 86
//   - acr122 raw framing:    FF 00 00 00 Lc D4 42 <cmd>
//   - transparent raw:       FF C2 00 01 Lc 95 <len> <cmd>
// and emulates NTAG21x (READ/FAST_READ/WRITE/GET_VERSION/PWD_AUTH/READ_CNT/
// READ_SIG, with password protection) and MIFARE Classic (per-sector key check).
//
// Invariants honoured as "hardware": UID (NTAG pages 0-1, MIFARE block 0) is
// never writable; there is no UID-changing command; MIFARE blocks open only when
// the loaded key matches the sector trailer. Like real tags, NTAG PWD / PACK read
// back as 00 and a new AUTH0 / PROT takes effect from the next connection;
// MIFARE trailers hide Key A (and Key B per the access bits).

import type { ReaderInfo, SimulatorState } from '@shared/types';
import type { TagKind } from '@shared/tags';
import {
  factoryImage,
  isFelica,
  isForbiddenUnit,
  isMifare,
  isNtag,
  mifareIsTrailer,
  mifareSectorOfBlock,
  mifareTrailerBlock,
  ntagPages,
  specFor,
  FELICA_LITE_S_SYSTEM_CODE,
} from '@shared/tags';
import { decodeFelicaMc } from '@shared/felica';
import { bytesToHex } from '@shared/hex';
import { VIRTUAL_READER_NAME } from '@shared/reader';
import { OpError } from '../errors';
import type { BackendEvent, CardConnection, ReaderBackend } from './backend';
import { NTAG_ACK, NTAG_CMD } from './apdu';
import { mifareTrailerReadbackMask } from './mifare';

const EMPTY = new Uint8Array(0);

/**
 * Transport status the simulator reports for a tag NAK. Real readers surface the
 * 4-bit NTAG NAK (protected-page READ, failed PWD_AUTH) with a NON-ZERO transport
 * status, not a clean status-0 short read, so we model it the same way. driver.ts
 * recognises the NAK nibble in the payload and maps it to ACCESS_DENIED
 * regardless of this status byte, so a protected page is reported 'denied' (not a
 * generic read 'error') on the raw drivers too.
 */
const NTAG_NAK_STATUS = 0x01;

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

let uidSeq = 0;

/** A pseudo-unique UID: byte 0 = 0x04 (NXP), the rest derived from a counter. */
function makeUid(bytes: number): Uint8Array {
  const u = new Uint8Array(bytes);
  const n = ++uidSeq;
  u[0] = 0x04;
  for (let i = 1; i < bytes; i++) u[i] = (n * 41 + i * 97 + 0x10) & 0xff;
  return u;
}

/** PC/SC Part 3 storage-card pseudo-ATR carrying the card-name hint. */
function storageAtr(kind: TagKind): Uint8Array {
  // FeliCa: standard byte 0x11; others: standard 0x03 + card-name hint.
  const standard = isFelica(kind) ? 0x11 : 0x03;
  const cardName = isFelica(kind) ? 0x0000 : isMifare(kind) ? (kind === 'MIFARE_CLASSIC_1K' ? 0x0001 : 0x0002) : 0x0003;
  const body = [0x3b, 0x8f, 0x80, 0x01, 0x80, 0x4f, 0x0c, 0xa0, 0x00, 0x00, 0x03, 0x06, standard, (cardName >> 8) & 0xff, cardName & 0xff, 0x00, 0x00, 0x00, 0x00];
  let tck = 0;
  for (let i = 1; i < body.length; i++) tck ^= body[i];
  return Uint8Array.from([...body, tck]);
}

/** GET_VERSION bytes (8) matching @shared/tags kindFromVersion. */
function ntagVersion(kind: TagKind): Uint8Array {
  const storageByte = kind === 'NTAG213' ? 0x0f : kind === 'NTAG215' ? 0x11 : 0x13;
  return Uint8Array.from([0x00, 0x04, 0x04, 0x02, 0x01, 0x00, storageByte, 0x03]);
}

class VirtualTag {
  readonly kind: TagKind;
  readonly uid: Uint8Array;
  readonly image: Uint8Array;
  /** Set by a correct PWD_AUTH; reset when a fresh RF session (connect) begins. */
  ntagAuthed = false;

  constructor(kind: TagKind, uid?: Uint8Array) {
    this.kind = kind;
    this.uid = uid ?? makeUid(isFelica(kind) ? 8 : isNtag(kind) ? 7 : 4);
    this.image = factoryImage(kind, this.uid);
  }

  get uidHex(): string {
    return bytesToHex(this.uid);
  }
}

function resp(data: ArrayLike<number>, sw1: number, sw2: number): Uint8Array {
  const out = new Uint8Array(data.length + 2);
  out.set(Array.from(data), 0);
  out[data.length] = sw1;
  out[data.length + 1] = sw2;
  return out;
}

const SW_OK = { sw1: 0x90, sw2: 0x00 };
const SW_DENIED = { sw1: 0x69, sw2: 0x82 };
const SW_WRONG_LEN = { sw1: 0x67, sw2: 0x00 };
const SW_AUTH_FAIL = { sw1: 0x63, sw2: 0x00 };
const SW_UNSUPPORTED = { sw1: 0x6d, sw2: 0x00 };

class VirtualConnection implements CardConnection {
  readonly readerName = VIRTUAL_READER_NAME;
  readonly atr: Uint8Array;
  private readonly backend: SimulatorBackend;
  private readonly loadedKeys = new Map<number, Uint8Array>();
  private authedSector = -1;
  private closed = false;
  /**
   * NTAG AUTH0 / PROT as the tag latched them when this RF session began. A real
   * NTAG applies a new CFG0/CFG1 only after it is activated again (measured
   * 2026-11-12 on an NTAG213 + PaSoRi: protection takes effect after a
   * reconnect), so a password setup written in one session does not lock its own
   * read-back (2026-11-12 review R-WRITE-2).
   */
  private readonly ntagCfg: { auth0: number; readProtected: boolean } | null;

  constructor(backend: SimulatorBackend, tag: VirtualTag) {
    this.backend = backend;
    this.atr = storageAtr(tag.kind);
    this.ntagCfg = isNtag(tag.kind) ? ntagAuthConfig(tag) : null;
  }

  async transmit(apdu: Uint8Array): Promise<Uint8Array> {
    if (this.closed) throw new OpError('CARD_REMOVED', 'connection closed');
    const tag = this.backend.tag;
    if (!tag || !this.backend.present) throw new OpError('CARD_REMOVED', 'no tag on the virtual reader');
    return this.interpret(tag, apdu);
  }

  async disconnect(): Promise<void> {
    this.closed = true;
  }

  // --- APDU dispatch ---------------------------------------------------------

  private interpret(tag: VirtualTag, apdu: Uint8Array): Uint8Array {
    if (apdu.length >= 2 && apdu[0] === 0xff) {
      switch (apdu[1]) {
        case 0xca: // Get UID
          return resp(tag.uid, SW_OK.sw1, SW_OK.sw2);
        case 0xb0: // Read Binary
          return this.readBinary(tag, apdu[3] ?? 0, apdu[4] ?? 0);
        case 0xd6: // Update Binary
          return this.updateBinary(tag, apdu[3] ?? 0, apdu.subarray(5, 5 + (apdu[4] ?? 0)));
        case 0x82: // Load Key
          this.loadedKeys.set(apdu[3] ?? 0, apdu.subarray(5, 5 + (apdu[4] ?? 0)).slice());
          return resp(EMPTY, SW_OK.sw1, SW_OK.sw2);
        case 0x86: // General Authenticate
          return this.authenticate(tag, apdu);
        case 0x00: // ACR122 direct transmit
          return this.acr122(tag, apdu);
        case 0xc2: // transparent exchange
          return this.transparent(tag, apdu);
        default:
          return resp(EMPTY, SW_UNSUPPORTED.sw1, SW_UNSUPPORTED.sw2);
      }
    }
    return resp(EMPTY, SW_UNSUPPORTED.sw1, SW_UNSUPPORTED.sw2);
  }

  // --- storage primitives ----------------------------------------------------

  private readWrap(tag: VirtualTag, byteOffset: number, len: number): Uint8Array {
    const img = tag.image;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = img[(byteOffset + i) % img.length];
    return out;
  }

  /**
   * NTAG READ / FAST_READ / FF B0: like real hardware, the PWD and PACK pages
   * always read back as 00 (NTAG21x datasheet; also tags.ts / inspect.ts), so
   * the simulator never hides a real-hardware verify mismatch (R-WRITE-2).
   */
  private ntagReadPages(tag: VirtualTag, page: number, len: number): Uint8Array {
    const out = this.readWrap(tag, page * 4, len);
    const p = ntagPages(tag.kind);
    const pages = tag.image.length / 4;
    for (let i = 0; i < len; i++) {
      const pg = Math.floor((page * 4 + i) / 4) % pages;
      if (pg === p.pwd || pg === p.pack) out[i] = 0x00;
    }
    return out;
  }

  private readBinary(tag: VirtualTag, block: number, le: number): Uint8Array {
    const length = le === 0 ? 16 : le;
    if (isFelica(tag.kind)) {
      // Storage readers (Sony PaSoRi, measured 2026-11-12) map FF B0 00 <block> 10
      // to a FeliCa Read Without Encryption of that real block number; a block the
      // card refuses comes back as SW 91 00.
      const blk = this.felicaBlock(tag, block);
      if (!blk || length !== 16) return resp(EMPTY, 0x91, 0x00);
      return resp(blk, SW_OK.sw1, SW_OK.sw2);
    }
    if (isMifare(tag.kind)) {
      if (this.authedSector !== mifareSectorOfBlock(block)) return resp(EMPTY, SW_DENIED.sw1, SW_DENIED.sw2);
      const raw = this.readWrap(tag, block * 16, length);
      // Real hardware never returns the trailer's Key A (reads back as 00), and
      // hides Key B unless the access conditions allow it. Match that so the
      // simulator does not paper over a real-hardware verify mismatch.
      const out = mifareIsTrailer(block) ? mifareTrailerReadbackMask(raw) : raw;
      return resp(out, SW_OK.sw1, SW_OK.sw2);
    }
    if (this.ntagReadProtected(tag, block)) return resp(EMPTY, SW_DENIED.sw1, SW_DENIED.sw2);
    return resp(this.ntagReadPages(tag, block, length), SW_OK.sw1, SW_OK.sw2);
  }

  private updateBinary(tag: VirtualTag, block: number, data: Uint8Array): Uint8Array {
    if (isFelica(tag.kind)) {
      // FF D6 00 <block> 10 <16B> -> FeliCa Write Without Encryption (storage readers).
      if (data.length !== 16) return resp(EMPTY, SW_WRONG_LEN.sw1, SW_WRONG_LEN.sw2);
      return this.felicaWriteBlock(tag, block, data) ? resp(EMPTY, SW_OK.sw1, SW_OK.sw2) : resp(EMPTY, 0x91, 0x00);
    }
    if (isMifare(tag.kind)) {
      if (block === 0) return resp(EMPTY, SW_DENIED.sw1, SW_DENIED.sw2); // manufacturer block
      if (this.authedSector !== mifareSectorOfBlock(block)) return resp(EMPTY, SW_DENIED.sw1, SW_DENIED.sw2);
      if (data.length !== 16) return resp(EMPTY, SW_WRONG_LEN.sw1, SW_WRONG_LEN.sw2);
      tag.image.set(data.subarray(0, 16), block * 16);
      return resp(EMPTY, SW_OK.sw1, SW_OK.sw2);
    }
    if (isForbiddenUnit(tag.kind, block)) return resp(EMPTY, SW_DENIED.sw1, SW_DENIED.sw2); // UID pages
    if (this.ntagWriteProtected(tag, block)) return resp(EMPTY, SW_DENIED.sw1, SW_DENIED.sw2);
    if (data.length < 4) return resp(EMPTY, SW_WRONG_LEN.sw1, SW_WRONG_LEN.sw2);
    tag.image.set(data.subarray(0, 4), block * 4);
    return resp(EMPTY, SW_OK.sw1, SW_OK.sw2);
  }

  private authenticate(tag: VirtualTag, apdu: Uint8Array): Uint8Array {
    // FF 86 00 00 05  01 00 <block> <keyType> <slot>
    if (!isMifare(tag.kind)) return resp(EMPTY, SW_AUTH_FAIL.sw1, SW_AUTH_FAIL.sw2);
    const block = apdu[7] ?? 0;
    const keyTypeByte = apdu[8] ?? 0x60;
    const slot = apdu[9] ?? 0;
    const key = this.loadedKeys.get(slot);
    if (!key || key.length !== 6) return resp(EMPTY, SW_AUTH_FAIL.sw1, SW_AUTH_FAIL.sw2);
    const sector = mifareSectorOfBlock(block);
    const trailer = mifareTrailerBlock(sector) * 16;
    const want = keyTypeByte === 0x61 ? tag.image.subarray(trailer + 10, trailer + 16) : tag.image.subarray(trailer, trailer + 6);
    if (bytesEq(key, want)) {
      this.authedSector = sector;
      return resp(EMPTY, SW_OK.sw1, SW_OK.sw2);
    }
    return resp(EMPTY, SW_AUTH_FAIL.sw1, SW_AUTH_FAIL.sw2);
  }

  // --- NTAG password protection ---------------------------------------------

  private ntagReadProtected(tag: VirtualTag, page: number): boolean {
    if (!isNtag(tag.kind) || tag.ntagAuthed || !this.ntagCfg) return false;
    const { auth0, readProtected } = this.ntagCfg;
    return readProtected && page >= auth0;
  }

  private ntagWriteProtected(tag: VirtualTag, page: number): boolean {
    if (!isNtag(tag.kind) || tag.ntagAuthed || !this.ntagCfg) return false;
    return page >= this.ntagCfg.auth0;
  }

  // --- raw NFC-A framing -----------------------------------------------------

  private acr122(tag: VirtualTag, apdu: Uint8Array): Uint8Array {
    // FF 00 00 00 Lc  D4 42 <cmd>   (Lc counts D4 42 + cmd)
    if (apdu[5] !== 0xd4 || apdu[6] !== 0x42) return resp(EMPTY, SW_UNSUPPORTED.sw1, SW_UNSUPPORTED.sw2);
    const cmd = apdu.subarray(7, 5 + (apdu[4] ?? 0));
    const r = this.rawCommand(tag, cmd);
    return resp([0xd5, 0x43, r.status, ...Array.from(r.payload)], SW_OK.sw1, SW_OK.sw2);
  }

  private transparent(tag: VirtualTag, apdu: Uint8Array): Uint8Array {
    // FF C2 00 01 Lc  95 <len> <cmd>
    if (apdu[2] !== 0x00 || apdu[3] !== 0x01) return resp(EMPTY, SW_UNSUPPORTED.sw1, SW_UNSUPPORTED.sw2);
    const body = apdu.subarray(5, 5 + (apdu[4] ?? 0));
    let cmd: Uint8Array | null = null;
    let i = 0;
    while (i + 2 <= body.length) {
      const tag95 = body[i];
      const len = body[i + 1];
      if (tag95 === 0x95) {
        cmd = body.subarray(i + 2, i + 2 + len);
        break;
      }
      i += 2 + len;
    }
    if (!cmd) return resp(EMPTY, SW_UNSUPPORTED.sw1, SW_UNSUPPORTED.sw2);
    const r = this.rawCommand(tag, cmd);
    const out = [0xc0, 0x03, 0x00, r.status, 0x00, 0x97, r.payload.length & 0xff, ...Array.from(r.payload)];
    return resp(out, SW_OK.sw1, SW_OK.sw2);
  }

  /** Interpret one native NFC-A command. status 0 = ok, non-zero = transport error. */
  private rawCommand(tag: VirtualTag, cmd: Uint8Array): { status: number; payload: Uint8Array } {
    if (cmd.length === 0) return { status: 0x01, payload: EMPTY };
    if (isFelica(tag.kind)) return { status: 0, payload: this.felicaCommand(tag, cmd) };
    if (isMifare(tag.kind)) return { status: 0x01, payload: EMPTY }; // raw NFC-A not modelled for MIFARE
    const nak = (): { status: number; payload: Uint8Array } => ({ status: NTAG_NAK_STATUS, payload: Uint8Array.from([0x00]) });
    switch (cmd[0]) {
      case NTAG_CMD.GET_VERSION:
        return { status: 0, payload: ntagVersion(tag.kind) };
      case NTAG_CMD.READ: {
        const page = cmd[1] ?? 0;
        if (this.ntagReadProtected(tag, page)) return nak();
        return { status: 0, payload: this.ntagReadPages(tag, page, 16) };
      }
      case NTAG_CMD.FAST_READ: {
        const start = cmd[1] ?? 0;
        const end = cmd[2] ?? 0;
        if (this.ntagReadProtected(tag, start)) return nak();
        return { status: 0, payload: this.ntagReadPages(tag, start, (end - start + 1) * 4) };
      }
      case NTAG_CMD.WRITE: {
        const page = cmd[1] ?? 0;
        if (isForbiddenUnit(tag.kind, page) || this.ntagWriteProtected(tag, page)) return nak();
        tag.image.set(cmd.subarray(2, 6), page * 4);
        return { status: 0, payload: Uint8Array.from([NTAG_ACK]) };
      }
      case NTAG_CMD.PWD_AUTH: {
        const pwd = cmd.subarray(1, 5);
        const p = ntagPages(tag.kind);
        const tagPwd = tag.image.subarray(p.pwd * 4, p.pwd * 4 + 4);
        if (bytesEq(pwd, tagPwd)) {
          tag.ntagAuthed = true;
          return { status: 0, payload: tag.image.subarray(p.pack * 4, p.pack * 4 + 2).slice() };
        }
        return nak();
      }
      case NTAG_CMD.READ_CNT:
        return { status: 0, payload: Uint8Array.from([0x00, 0x00, 0x00]) }; // counters disabled by default
      case NTAG_CMD.READ_SIG:
        return { status: 0, payload: ntagSignature(tag) };
      default:
        return { status: 0x01, payload: EMPTY };
    }
  }

  /** Read a FeliCa block number from the image (grid blocks) or synthesize a
   * read-only system block. Returns null when the block is not modelled. */
  private felicaBlock(tag: VirtualTag, block: number): Uint8Array | null {
    const spec = specFor(tag.kind);
    const unit = (spec.blockMap ?? []).indexOf(block);
    if (unit >= 0) return tag.image.subarray(unit * 16, unit * 16 + 16).slice();
    const out = new Uint8Array(16);
    switch (block) {
      case 0x82: // ID = DFC(2) + IDm(8) + reserved
        out.set(tag.uid.subarray(0, 8), 2);
        return out;
      case 0x85: // SYS_C
        out[0] = (FELICA_LITE_S_SYSTEM_CODE >> 8) & 0xff;
        out[1] = FELICA_LITE_S_SYSTEM_CODE & 0xff;
        return out;
      case 0x86: // CKV
      case 0x90: // WCNT
      case 0x92: // STATE
        return out;
      default:
        return null;
    }
  }

  /** Emulate FeliCa Lite-S Polling / Read / Write Without Encryption. Returns the
   * FeliCa response frame ([len, respCode, ...]); an empty frame means no reply. */
  private felicaCommand(tag: VirtualTag, packet: Uint8Array): Uint8Array {
    // packet = [len, cmd, ...]
    const cmd = packet[1];
    const frame = (payload: number[]): Uint8Array => Uint8Array.from([payload.length + 1, ...payload]);
    if (cmd === 0x00) {
      // Polling: [len,00, sys(2), reqCode, timeSlot] -> [len,01, IDm(8), PMm(8), (sysC)]
      const reqCode = packet[4] ?? 0x00;
      const pmm = new Uint8Array(8).fill(0xff);
      const body = [0x01, ...tag.uid.subarray(0, 8), ...pmm];
      if (reqCode === 0x01) body.push((FELICA_LITE_S_SYSTEM_CODE >> 8) & 0xff, FELICA_LITE_S_SYSTEM_CODE & 0xff);
      return frame(body);
    }
    if (cmd === 0x06) {
      // Read Without Encryption: [len,06, IDm(8), nSvc, svc(2), nBlk, blkList...]
      const nBlk = packet[13] ?? 0;
      const blocks: number[] = [];
      let off = 14;
      for (let i = 0; i < nBlk; i++) {
        // 2-byte element: [0x80, blockNo]
        blocks.push(packet[off + 1] ?? 0);
        off += 2;
      }
      const datas: number[] = [];
      for (const b of blocks) {
        const blk = this.felicaBlock(tag, b);
        if (!blk) return frame([0x07, ...tag.uid.subarray(0, 8), 0x01, 0xa8]); // status error
        datas.push(...Array.from(blk));
      }
      return frame([0x07, ...tag.uid.subarray(0, 8), 0x00, 0x00, blocks.length, ...datas]);
    }
    if (cmd === 0x08) {
      // Write Without Encryption: [len,08, IDm(8), nSvc, svc(2), nBlk, blkList(2), data(16)]
      const block = packet[15] ?? 0;
      const data = packet.subarray(16, 32);
      const spec = specFor(tag.kind);
      const unit = (spec.blockMap ?? []).indexOf(block);
      if (unit < 0) return frame([0x09, ...tag.uid.subarray(0, 8), 0x01, 0xa8]); // not writable
      if (!this.felicaWriteBlock(tag, block, data)) return frame([0x09, ...tag.uid.subarray(0, 8), 0x02, 0xa8]); // read-only
      return frame([0x09, ...tag.uid.subarray(0, 8), 0x00, 0x00]);
    }
    return EMPTY;
  }

  /** Write one FeliCa block of the grid, honouring the MC write-protect mask. false = refused. */
  private felicaWriteBlock(tag: VirtualTag, block: number, data: Uint8Array): boolean {
    const spec = specFor(tag.kind);
    const unit = (spec.blockMap ?? []).indexOf(block);
    if (unit < 0 || data.length < 16) return false;
    // Enforce the MC per-block write-permission bitmap for user blocks (0x00-0x0E).
    if (block <= 0x0e) {
      const mcUnit = (spec.blockMap ?? []).indexOf(0x88);
      const mc = decodeFelicaMc(tag.image.subarray(mcUnit * 16, mcUnit * 16 + 16));
      if (!mc.writable[block]) return false;
    }
    tag.image.set(data.subarray(0, 16), unit * 16);
    return true;
  }
}

/** NTAG AUTH0 (CFG0 byte 3) and PROT (CFG1 bit 7) as stored in the tag's memory now. */
function ntagAuthConfig(tag: VirtualTag): { auth0: number; readProtected: boolean } {
  const p = ntagPages(tag.kind);
  const cfg0 = tag.image.subarray(p.cfg0 * 4, p.cfg0 * 4 + 4);
  const cfg1 = tag.image.subarray(p.cfg1 * 4, p.cfg1 * 4 + 4);
  return { auth0: cfg0[3], readProtected: (cfg1[0] & 0x80) !== 0 };
}

/** Deterministic 32-byte "originality signature" (display only; not a real ECC sig). */
function ntagSignature(tag: VirtualTag): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (tag.uid[i % tag.uid.length] ^ (i * 7 + 0x5a)) & 0xff;
  return out;
}

/** The simulator backend. Also exposes control methods used by the service. */
export class SimulatorBackend implements ReaderBackend {
  readonly id = 'simulator' as const;
  private enabled = false;
  present = false;
  tag: VirtualTag | null = null;
  private listener: ((e: BackendEvent) => void) | null = null;

  async start(listener: (e: BackendEvent) => void): Promise<void> {
    this.listener = listener;
    this.emitReaders();
  }

  async stop(): Promise<void> {
    this.listener = null;
  }

  async refresh(): Promise<void> {
    this.emitReaders();
  }

  readers(): ReaderInfo[] {
    return this.enabled ? [this.readerInfo()] : [];
  }

  async connect(readerName: string): Promise<CardConnection> {
    if (readerName !== VIRTUAL_READER_NAME) throw new OpError('NO_READER', 'not the virtual reader');
    if (!this.enabled || !this.present || !this.tag) throw new OpError('NO_CARD', 'no tag on the virtual reader');
    this.tag.ntagAuthed = false; // a new RF session resets NTAG authentication
    return new VirtualConnection(this, this.tag);
  }

  // --- control (service -> simulator) ---------------------------------------

  get state(): SimulatorState {
    return {
      enabled: this.enabled,
      kind: this.tag?.kind ?? 'NTAG215',
      present: this.present,
      uid: this.tag?.uidHex ?? '',
    };
  }

  setEnabled(enabled: boolean, kind?: TagKind): void {
    // Turning the virtual reader off takes its tag away: say so (card-removed), or
    // the service keeps showing the virtual tag and issue mode waits for a removal
    // that never comes (2026-11-12 UX audit CARD-5).
    const hadCard = !enabled && this.enabled && this.present && !!this.tag;
    this.enabled = enabled;
    if (enabled) {
      if (!this.tag || (kind && kind !== this.tag.kind)) this.tag = new VirtualTag(kind ?? this.tag?.kind ?? 'NTAG215');
    } else {
      this.present = false;
    }
    if (hadCard) this.listener?.({ type: 'card-removed', reader: VIRTUAL_READER_NAME });
    this.emitReaders();
    if (enabled && this.present && this.tag) {
      this.listener?.({ type: 'card-inserted', reader: VIRTUAL_READER_NAME, atr: storageAtr(this.tag.kind) });
    }
  }

  tap(present: boolean): void {
    if (!this.enabled || !this.tag) return;
    if (this.present === present) return;
    this.present = present;
    this.emitReaders();
    if (present) this.listener?.({ type: 'card-inserted', reader: VIRTUAL_READER_NAME, atr: storageAtr(this.tag.kind) });
    else this.listener?.({ type: 'card-removed', reader: VIRTUAL_READER_NAME });
  }

  newTag(kind: TagKind): void {
    const hadCard = this.present && !!this.tag;
    this.enabled = true;
    this.tag = new VirtualTag(kind);
    this.present = true;
    this.emitReaders();
    if (hadCard) this.listener?.({ type: 'card-removed', reader: VIRTUAL_READER_NAME });
    this.listener?.({ type: 'card-inserted', reader: VIRTUAL_READER_NAME, atr: storageAtr(kind) });
  }

  private readerInfo(): ReaderInfo {
    return {
      name: VIRTUAL_READER_NAME,
      likelyContactless: true,
      cardPresent: this.present,
      inUse: false,
      atr: this.present && this.tag ? bytesToHex(storageAtr(this.tag.kind)) : null,
      virtual: true,
    };
  }

  private emitReaders(): void {
    this.listener?.({ type: 'readers', readers: this.readers() });
  }
}

export function createSimulatorBackend(): SimulatorBackend {
  return new SimulatorBackend();
}
