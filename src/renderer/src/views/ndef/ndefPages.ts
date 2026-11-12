// Pure helpers for the NDEF view (no React / DOM). Owner: agent "renderer-ndef".
// Kept separate from the view so the read / write-planning logic can be unit
// tested (tests/renderer-ndef/**).
//
// 2026-11-12 UX rework (WRITE-12 / FLOW-4 / FLOW-5 / FLOW-9 / FIRST-14 / WALK-5):
//  - readImageNdef(): what NDEF an image (the open document, or the tag about to
//    be written) carries - records / empty / none / unreadable / unsupported.
//  - planNdefWrite(): the page / block writes are planned from the CONTENT OF THE
//    TAG BEING WRITTEN (read right before writing), never from the open document:
//    MIFARE follows that tag's own MAD, NTAG its own CC. Only units that differ
//    are written, and leftovers of the old NDEF inside the NDEF area are cleared
//    to zero (no old Wi-Fi password etc. stays behind the new terminator).
//
// Invariant (I1/I2): only the NDEF data area is ever planned. UID / CC / lock /
// config pages, MIFARE block 0, the MAD sectors and the sector trailers are never
// in a plan.
import type { TagImage, UnitWrite } from '@shared/types';
import type { TagKind } from '@shared/tags';
import { isMifare, isNtag, mifareSectorCount, mifareSectorFirstBlock, mifareTrailerBlock, ntagPages, specFor } from '@shared/tags';
import type { NdefRecordDraft } from '@shared/ndef/types';
import { decodeToDrafts, extractMifareNdef, scanType2Tlvs, wrapNdefTlv } from '@shared/ndef';
import { readNtagConfig, readNtagLockState } from '@shared/tag';

export interface WriteKindResolution {
  /** Kind to plan the write (and size the capacity meter) for. */
  kind: TagKind;
  /**
   * Set when the operator's selected kind disagrees with the kind detected from
   * the card physically on the reader.
   */
  mismatch: { selected: TagKind; detected: TagKind } | null;
}

/**
 * Resolve the tag kind the capacity meter (and any plan) must follow.
 *
 * `selectedKind` is what the operator is composing for; `detectedKind` is the
 * kind of the tag physically on the reader (null when none / unknown). The real
 * chip owns its memory layout, so the detected kind is authoritative when known.
 */
export function resolveWriteKind(selectedKind: TagKind, detectedKind: TagKind | null): WriteKindResolution {
  if (detectedKind && detectedKind !== selectedKind) {
    return { kind: detectedKind, mismatch: { selected: selectedKind, detected: detectedKind } };
  }
  return { kind: detectedKind ?? selectedKind, mismatch: null };
}

/** Format bytes as grouped uppercase hex: [0x03, 0xAB] -> "03 AB". */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

/**
 * Split the first `byteLen` bytes of a Type 2 user `area` into 4-byte page
 * writes starting at page `startUnit`. (Kept for callers that write a whole TLV
 * without diffing; the NDEF view itself uses planNdefWrite.)
 */
export function userAreaToPages(area: Uint8Array, startUnit: number, byteLen: number): UnitWrite[] {
  const pages = Math.ceil(Math.max(0, byteLen) / 4);
  const writes: UnitWrite[] = [];
  for (let i = 0; i < pages; i++) {
    writes.push({ unit: startUnit + i, data: area.slice(i * 4, i * 4 + 4) });
  }
  return writes;
}

/** The NDEF editor handles NFC Forum Type 2 (NTAG) and MIFARE Classic (MAD). FeliCa Lite-S is not supported. */
export function supportsNdef(kind: TagKind): boolean {
  return isNtag(kind) || isMifare(kind);
}

// ---------------------------------------------------------------------------
// Where the NDEF lives
// ---------------------------------------------------------------------------

const NDEF_AID = 0x03e1;
const MAD2_SECTOR = 16;

function madAid(data: Uint8Array, sector: number): number {
  let off: number;
  if (sector >= 1 && sector <= 15) off = 16 + 2 * sector;
  else if (sector >= 17 && sector <= 39) off = 1024 + 2 * (sector - MAD2_SECTOR);
  else return 0;
  if (off + 1 >= data.length) return 0;
  return (data[off] << 8) | data[off + 1];
}

/** MAD1 (sector 0 blocks 1-2): must be readable to know where the NDEF lives. */
const MAD1_BLOCKS = [1, 2];

/**
 * Data blocks of every sector the MAD marks as NDEF (AID 03 E1), in order. The
 * same directory walk as @shared/ndef extractMifareNdef / buildMifareNdefWrites
 * (block 0, the MAD sectors 0 / 16 and every trailer are never included).
 */
export function mifareNdefBlocks(kind: TagKind, data: Uint8Array): number[] {
  if (!isMifare(kind)) return [];
  const out: number[] = [];
  const sectors = mifareSectorCount(kind);
  for (let s = 1; s < sectors; s++) {
    if (s === MAD2_SECTOR) continue;
    if (madAid(data, s) !== NDEF_AID) continue;
    for (let b = mifareSectorFirstBlock(s); b < mifareTrailerBlock(s); b++) out.push(b);
  }
  return out;
}

/** NTAG NDEF area (bytes from page 4) as declared by the tag's own CC (page 3), capped at the user memory. null = no NDEF CC. */
export function type2NdefAreaBytes(img: TagImage): number | null {
  const spec = specFor(img.kind);
  if (img.unitStatus[3] !== 'ok') return null;
  const cc = img.data.subarray(12, 16);
  if (cc[0] !== 0xe1) return null;
  const declared = cc[2] * 8;
  return declared > 0 ? Math.min(declared, spec.userBytes) : spec.userBytes;
}

/** Largest NDEF message that fits an NDEF area of `areaBytes` (TLV header + terminator). */
export function tlvCapacity(areaBytes: number): number {
  const short = areaBytes - 3;
  return Math.max(0, short <= 254 ? short : areaBytes - 5);
}

// ---------------------------------------------------------------------------
// Reading the NDEF of an image
// ---------------------------------------------------------------------------

export type ImageNdef =
  /** At least one record with content. */
  | { state: 'records'; drafts: NdefRecordDraft[] }
  /** An NDEF message is present but empty (D0 00 00 / zero length / only empty records). */
  | { state: 'empty' }
  /** No NDEF message (blank tag, or MIFARE without an NDEF sector in its MAD). */
  | { state: 'none' }
  /** The NDEF area could not be read (password / missing key): the content is unknown. */
  | { state: 'unreadable' }
  /** The bytes are not a valid NDEF message. */
  | { state: 'invalid'; error: string }
  /** The tag kind has no NDEF mapping in this editor (FeliCa Lite-S). */
  | { state: 'unsupported' };

function allOk(img: TagImage, units: number[]): boolean {
  return units.every((u) => img.unitStatus[u] === 'ok');
}

function decodeMessage(message: Uint8Array): ImageNdef {
  if (message.length === 0) return { state: 'empty' };
  try {
    const drafts = decodeToDrafts(message);
    if (drafts.length === 0 || drafts.every((d) => d.kind === 'empty')) return { state: 'empty' };
    return { state: 'records', drafts };
  } catch (e) {
    return { state: 'invalid', error: e instanceof Error ? e.message : String(e) };
  }
}

/** The NDEF message an image carries (the open document, or a tag that was just read). */
export function readImageNdef(img: TagImage): ImageNdef {
  const kind = img.kind;
  if (!supportsNdef(kind)) return { state: 'unsupported' };
  if (isNtag(kind)) {
    const spec = specFor(kind);
    const start = spec.userStartUnit;
    const areaBytes = type2NdefAreaBytes(img) ?? spec.userBytes;
    const area = img.data.slice(start * 4, start * 4 + areaBytes);
    const scan = scanType2Tlvs(area);
    // Bytes the scan actually depended on: up to the terminator, else the NDEF
    // TLV, else the whole area. Any unreadable page in there = content unknown.
    let consumed = area.length;
    if (scan.terminatorOffset !== null) consumed = scan.terminatorOffset + 1;
    else if (scan.ndef && scan.ndefTlvOffset !== null) consumed = scan.ndefTlvOffset + 4 + scan.ndef.length;
    const pages: number[] = [];
    for (let p = 0; p * 4 < Math.min(consumed, area.length); p++) pages.push(start + p);
    if (!allOk(img, pages)) return { state: 'unreadable' };
    if (!scan.ndef) return { state: 'none' };
    return decodeMessage(scan.ndef);
  }
  // MIFARE: the directory must be readable, and so must the NDEF sectors.
  if (!allOk(img, MAD1_BLOCKS)) return { state: 'unreadable' };
  const blocks = mifareNdefBlocks(kind, img.data);
  if (blocks.length === 0) return { state: 'none' };
  if (!allOk(img, blocks)) return { state: 'unreadable' };
  const message = extractMifareNdef(kind, img.data);
  if (!message) return { state: 'none' };
  return decodeMessage(message);
}

// ---------------------------------------------------------------------------
// Planning a write against the tag being written
// ---------------------------------------------------------------------------

export type NdefPlanError =
  /** FeliCa Lite-S etc.: not handled by the NDEF editor. */
  | 'unsupported-kind'
  /** NTAG without an NDEF CC / MIFARE without an NDEF sector in its MAD. */
  | 'not-formatted'
  /** The message does not fit this tag's NDEF area. */
  | 'too-large'
  /** Part of the area to write could not be read on this tag (password / key missing). */
  | 'unreadable'
  /** NTAG: the pages to write are password protected (AUTH0). */
  | 'password'
  /** NTAG: the pages to write are permanently locked (lock bits). */
  | 'locked';

export type NdefWritePlan =
  | {
      ok: true;
      kind: TagKind;
      uid: string;
      /** Only the units whose bytes change, ascending. Empty = the tag already holds exactly this NDEF. */
      writes: UnitWrite[];
      /** What the tag holds now (replaced by the write). */
      existing: ImageNdef;
      /** Max message bytes for this tag. */
      capacity: number;
      /** Bytes of the message being written. */
      messageBytes: number;
    }
  | { ok: false; reason: NdefPlanError; kind: TagKind; uid: string; capacity: number | null; messageBytes: number };

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Plan writing `message` (an encoded NDEF message; an empty-record message
 * erases) onto `target`, the image of the tag ON THE READER read right before
 * writing. The desired NDEF area = TLV(message) + terminator + zeros; every unit
 * of the area that differs from the target is written. Units the target could
 * not read are refused inside the new TLV and skipped beyond it (they cannot be
 * cleared without the password / key anyway).
 */
export function planNdefWrite(target: TagImage, message: Uint8Array): NdefWritePlan {
  const kind = target.kind;
  const uid = target.uid;
  const messageBytes = message.length;
  const fail = (reason: NdefPlanError, capacity: number | null = null): NdefWritePlan => ({
    ok: false,
    reason,
    kind,
    uid,
    capacity,
    messageBytes,
  });
  if (!supportsNdef(kind)) return fail('unsupported-kind');
  const tlv = wrapNdefTlv(message);
  const spec = specFor(kind);
  const size = spec.unitSize;

  let units: number[]; // NDEF-area units, in byte order
  let capacity: number;
  if (isNtag(kind)) {
    if (target.unitStatus[3] !== 'ok') return fail('unreadable');
    const areaBytes = type2NdefAreaBytes(target);
    if (areaBytes === null) return fail('not-formatted');
    capacity = tlvCapacity(areaBytes);
    if (messageBytes > capacity) return fail('too-large', capacity);
    units = [];
    for (let p = 0; p * 4 < areaBytes; p++) units.push(spec.userStartUnit + p);
  } else {
    if (!allOk(target, MAD1_BLOCKS)) return fail('unreadable');
    units = mifareNdefBlocks(kind, target.data);
    if (units.length === 0) return fail('not-formatted');
    // Same rule as the shared buildMifareNdefWrites: TLV + terminator must fit the NDEF sectors.
    capacity = tlvCapacity(units.length * size);
    if (messageBytes > capacity) return fail('too-large', capacity);
  }

  const desired = new Uint8Array(units.length * size);
  desired.set(tlv, 0);
  const tlvUnits = Math.ceil(tlv.length / size);
  const writes: UnitWrite[] = [];
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const want = desired.slice(i * size, (i + 1) * size);
    if (target.unitStatus[unit] !== 'ok') {
      if (i < tlvUnits) return fail('unreadable', capacity);
      continue; // beyond the new NDEF: cannot be read, cannot be cleared - leave it
    }
    const have = target.data.slice(unit * size, (unit + 1) * size);
    if (!sameBytes(want, have)) writes.push({ unit, data: want });
  }

  if (isNtag(kind) && writes.length > 0) {
    const p = ntagPages(kind);
    const lastWrite = writes[writes.length - 1].unit;
    if (target.unitStatus[p.cfg0] === 'ok' && target.unitStatus[p.cfg1] === 'ok') {
      const cfg = readNtagConfig(kind, target.data);
      if (cfg.auth0 <= lastWrite) return fail('password', capacity);
    }
    if (target.unitStatus[2] === 'ok' && target.unitStatus[p.dynLock] === 'ok') {
      const locked = new Set(readNtagLockState(kind, target.data).lockedPages);
      if (writes.some((w) => locked.has(w.unit))) return fail('locked', capacity);
    }
  }

  return { ok: true, kind, uid, writes, existing: readImageNdef(target), capacity, messageBytes };
}

/** Message bytes vs. the capacity of `kind` as shipped (spec CC). null = unknown for this kind (MIFARE depends on its MAD). */
export function nominalCapacity(kind: TagKind): number | null {
  if (!isNtag(kind)) return null;
  const ccBytes = kind === 'NTAG213' ? 144 : kind === 'NTAG215' ? 496 : 872;
  return tlvCapacity(ccBytes);
}
