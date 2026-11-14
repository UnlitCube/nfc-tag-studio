// Pure logic for the binary (hex) editor. No DOM, no store, no React - safe to
// import from the node-environment unit tests (tests/hex*.test.ts).
//
// Design invariant (I1/I2): the tag UID is fixed at manufacture and read-only.
// `restoreLockedBytes` is the single chokepoint the view runs on every edit so a
// forbidden unit (NTAG pages 0-1, MIFARE block 0) can never be changed by any
// operation here - increment, fill, paste, replace or direct typing.
import type { TagKind } from '@shared/tags';
import {
  felicaBlockOfUnit,
  isFelica,
  isForbiddenUnit,
  isMifare,
  isNtag,
  isProtectedUnit,
  mifareDataBlocks,
  mifareIsTrailer,
  mifareSectorCount,
  mifareSectorFirstBlock,
  mifareTrailerBlock,
  ntagPages,
  regionOf,
  specFor,
} from '@shared/tags';
import type { PlanWarningCode, WritePlan } from '@shared/tag';
import { lockedUnitsOf, planWrites } from '@shared/tag';
import { felicaBlockName } from '@shared/felica';
import type { ReaderStatus, TagImage } from '@shared/types';
import { hexToBytes, utf8ToBytes } from '@shared/hex';
import { tagOpBlock } from '../../lib/readerState';
import type { TagOpBlock } from '../../lib/readerState';

export type Endian = 'BE' | 'LE';
export type ByteMode = 'hex' | 'ascii';

/** Unit (page/block) index a byte belongs to. */
export function unitOfByte(kind: TagKind, byteIndex: number): number {
  return Math.floor(byteIndex / specFor(kind).unitSize);
}

/** First byte offset of a unit. */
export function unitOffset(kind: TagKind, unit: number): number {
  return unit * specFor(kind).unitSize;
}

/**
 * Region id used to pick the `--region-*` background token for a unit. MIFARE
 * sector trailers get their own 'trailer' key (the data region otherwise covers
 * them); everything else is the region id from the memory map.
 */
export function regionKey(kind: TagKind, unit: number): string {
  if (isMifare(kind) && mifareIsTrailer(unit)) return 'trailer';
  return regionOf(kind, unit)?.id ?? 'data';
}

/** Inclusive [lo, hi] selection from an anchor + cursor pair. */
export function selectionBounds(anchor: number, cursor: number): { lo: number; hi: number } {
  return { lo: Math.min(anchor, cursor), hi: Math.max(anchor, cursor) };
}

/**
 * NTAG page 2 bytes 0-1 (BCC1 = the UID check byte, and an internal byte) are
 * fixed at manufacture like the UID itself: read-only per BYTE (the lock bytes 2-3
 * of the same page stay editable as a protected area). R-UX-8.
 */
export function isUidCheckByte(kind: TagKind, byteIndex: number): boolean {
  return isNtag(kind) && (byteIndex === 8 || byteIndex === 9);
}

/** True when any byte of [lo, hi] (inclusive) lies in a forbidden unit (or is a UID check byte). */
export function rangeTouchesForbidden(kind: TagKind, lo: number, hi: number): boolean {
  const size = specFor(kind).unitSize;
  for (let u = Math.floor(lo / size); u <= Math.floor(hi / size); u++) {
    if (isForbiddenUnit(kind, u)) return true;
  }
  return isNtag(kind) && lo <= 9 && hi >= 8;
}

/** Read bytes [start, start+length) as an unsigned integer with the given endianness. */
export function readUint(data: Uint8Array, start: number, length: number, endian: Endian): bigint {
  let v = 0n;
  for (let i = 0; i < length; i++) {
    const idx = endian === 'BE' ? start + i : start + length - 1 - i;
    v = (v << 8n) | BigInt(data[idx] ?? 0);
  }
  return v;
}

/**
 * Copy of `data` with [start, start+length) set to `value`, masked to the width.
 * A value wider than the range wraps (two's complement for negatives), which is
 * what makes increment/decrement roll over cleanly.
 */
export function writeUint(data: Uint8Array, start: number, length: number, value: bigint, endian: Endian): Uint8Array {
  const out = new Uint8Array(data);
  let v = value;
  if (length > 0) {
    const mask = (1n << BigInt(length * 8)) - 1n;
    v &= mask; // BigInt AND on a negative yields its two's-complement tail -> wrap
  }
  for (let i = 0; i < length; i++) {
    const idx = endian === 'BE' ? start + length - 1 - i : start + i;
    out[idx] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Add `delta` (may be negative) to the integer in [start, start+length), wrapping within the width. */
export function incrementRange(data: Uint8Array, start: number, length: number, delta: bigint, endian: Endian): Uint8Array {
  const cur = readUint(data, start, length, endian);
  return writeUint(data, start, length, cur + delta, endian);
}

/** Copy of `data` with the inclusive byte range [a..b] set to `byte`. Bounds are clamped and order-independent. */
export function fillRange(data: Uint8Array, a: number, b: number, byte: number): Uint8Array {
  const out = new Uint8Array(data);
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(out.length - 1, Math.max(a, b));
  for (let i = lo; i <= hi; i++) out[i] = byte & 0xff;
  return out;
}

/** Copy of `data` with `src` written at `at` (truncated at the end of the buffer). */
export function pasteBytes(data: Uint8Array, at: number, src: Uint8Array): Uint8Array {
  const out = new Uint8Array(data);
  for (let i = 0; i < src.length && at + i < out.length; i++) out[at + i] = src[i];
  return out;
}

/** Start offsets of every non-overlapping occurrence of `needle` in `data`, from `from`. */
export function findBytes(data: Uint8Array, needle: Uint8Array, from = 0): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  let i = Math.max(0, from);
  while (i + needle.length <= data.length) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (data[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      out.push(i);
      i += needle.length;
    } else {
      i++;
    }
  }
  return out;
}

export interface ReplaceResult {
  data: Uint8Array;
  count: number;
  offsets: number[];
}

/**
 * Replace every non-overlapping occurrence of `needle` with `repl`. The image is
 * fixed-size, so `repl` must be the same length as `needle`.
 */
export function replaceBytes(data: Uint8Array, needle: Uint8Array, repl: Uint8Array): ReplaceResult {
  if (needle.length === 0) throw new Error('検索するバイト列が空です');
  if (repl.length !== needle.length) throw new Error('置換前と置換後のバイト数は同じにしてください');
  const offsets = findBytes(data, needle, 0);
  const out = new Uint8Array(data);
  for (const off of offsets) out.set(repl, off);
  return { data: out, count: offsets.length, offsets };
}

/** Parse a search/replace pattern. hex: lenient hex (spaces/0x ignored); ascii: UTF-8 bytes. May throw on bad hex. */
export function parsePattern(input: string, mode: ByteMode): Uint8Array {
  return mode === 'ascii' ? utf8ToBytes(input) : hexToBytes(input);
}

/**
 * I1/I2 guard. Returns a copy of `edited` in which every forbidden unit's bytes
 * are taken from `original`, so the UID / manufacturer block is never modified
 * regardless of which operation produced `edited`. `edited` and `original` must
 * be the same length (a full image for `kind`).
 */
export function restoreLockedBytes(kind: TagKind, edited: Uint8Array, original: Uint8Array): Uint8Array {
  const spec = specFor(kind);
  const out = new Uint8Array(edited);
  for (let unit = 0; unit < spec.unitCount; unit++) {
    if (!isForbiddenUnit(kind, unit)) continue;
    const off = unit * spec.unitSize;
    for (let i = 0; i < spec.unitSize; i++) out[off + i] = original[off + i];
  }
  // NTAG page 2 bytes 0-1: the UID check byte + internal byte (R-UX-8).
  if (isNtag(kind)) {
    out[8] = original[8];
    out[9] = original[9];
  }
  return out;
}

/** Byte indices that differ between `a` and `b` (as a boolean mask). */
export function changedMask(a: Uint8Array, b: Uint8Array): boolean[] {
  const n = Math.min(a.length, b.length);
  const mask = new Array<boolean>(a.length).fill(false);
  for (let i = 0; i < n; i++) mask[i] = a[i] !== b[i];
  return mask;
}

/** Count of units (pages/blocks) that have at least one changed byte. */
export function changedUnitCount(kind: TagKind, a: Uint8Array, b: Uint8Array): number {
  const spec = specFor(kind);
  let count = 0;
  for (let u = 0; u < spec.unitCount; u++) {
    const off = u * spec.unitSize;
    let diff = false;
    for (let i = 0; i < spec.unitSize; i++) {
      if (a[off + i] !== b[off + i]) {
        diff = true;
        break;
      }
    }
    if (diff) count++;
  }
  return count;
}

/** Parse a user-entered integer: 0x.. / 0b.. / decimal (sign allowed). Throws on garbage. */
export function parseIntInput(input: string): bigint {
  const s = input.trim();
  if (s === '' || s === '-' || s === '+') throw new Error('数値を入力してください');
  const neg = s.startsWith('-');
  const body = s.replace(/^[+-]/, '');
  let v: bigint;
  if (/^0x[0-9a-f]+$/i.test(body)) v = BigInt(body);
  else if (/^0b[01]+$/i.test(body)) v = BigInt(body);
  else if (/^[0-9]+$/.test(body)) v = BigInt(body);
  else throw new Error(`数値として読めません: ${input}`);
  return neg ? -v : v;
}

/** Parse a single byte value as hex (00..FF, optional 0x). Throws on anything else. */
export function parseByteInput(input: string): number {
  const s = input.trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]{1,2}$/i.test(s)) throw new Error('00〜FF（16 進）で入力してください');
  return parseInt(s, 16);
}

// ---------------------------------------------------------------------------
// Write gating (I5: irreversible operations need advanced mode + word input)
// ---------------------------------------------------------------------------

/**
 * Plan warning codes whose write can never be undone (or can permanently lock a
 * tag out): NTAG static/dynamic lock bytes, the one-time CC page, the config
 * pages (CFGLCK), password pages, MIFARE sector trailers (keys/access), and a
 * trailer with invalid access bits. planWrites raises an OTP-clear with `danger`
 * severity, so that case is caught by the severity check below.
 */
const IRREVERSIBLE_WARNING_CODES: ReadonlySet<PlanWarningCode> = new Set([
  'LOCK_IRREVERSIBLE',
  'ACCESS_BITS_INVALID',
  'CC_OTP',
  'TRAILER',
  'CONFIG',
  'PASSWORD',
  'FELICA_MC',
]);

/**
 * I5: writing an irreversible protection unit must be gated behind typing a
 * confirmation word, not a single OK click. Returns true when the plan contains
 * any such operation - a `danger` warning (lock / invalid access bits / clearing
 * an OTP bit), or a lock / OTP / trailer / config / password warning. Pure: it
 * only reads the plan the view already computed with planWrites.
 */
export function needsLockConfirm(plan: WritePlan): boolean {
  return plan.warnings.some((w) => w.severity === 'danger' || IRREVERSIBLE_WARNING_CODES.has(w.code));
}

/**
 * I5 (advanced-mode gate): protected areas may be written only while advanced
 * mode is on. The "also write protected areas" switch is shown only in advanced
 * mode, so when advanced mode is off its remembered value must not stay armed.
 * Deriving the effective flag here guarantees the plan, the write request and the
 * danger styling all use the gated value even if the local switch state is stale.
 */
export function effectiveIncludeProtected(advanced: boolean, includeProtected: boolean): boolean {
  return advanced && includeProtected;
}

/**
 * needsLockConfirm, but only for what is actually written: a danger warning on
 * a unit that the plan leaves out (an invalid trailer, an OTP clear while
 * protected writes are off, a trailer with an unknown key A) must not make the
 * operator type the lock word for an ordinary data write.
 */
export function needsLockConfirmForWrites(plan: WritePlan): boolean {
  const written = new Set(plan.writes.map((w) => w.unit));
  return needsLockConfirm({ ...plan, warnings: plan.warnings.filter((w) => w.unit === null || written.has(w.unit)) });
}

// ---------------------------------------------------------------------------
// Which tag a write goes to (2026-11-12 UX audit WRITE-1 / FLOW-1 / FLOW-13 /
// WALK-1 / WALK-8, decision D5)
// ---------------------------------------------------------------------------

/** Structural copy of the store's DocSource (keeps this module store-free). */
export type DocSourceLike =
  | { type: 'card'; uid: string }
  | { type: 'file'; name: string }
  | { type: 'new' };

/**
 * How the tag on the reader relates to the open document:
 *  - same:       the document was read from this very tag -> write the edits (diff vs doc.original)
 *  - other-card: the document was read from ANOTHER tag -> a copy onto this tag
 *  - file / new: the document came from a file / was created blank -> a copy onto this tag
 * For every relation but `same` the write first reads the target and plans the
 * difference against what is actually on it.
 */
export type WriteRelation = 'same' | 'other-card' | 'file' | 'new';

/** Why "write to tag" cannot be pressed right now (null = it can). */
export type WriteBlock =
  | { type: 'op'; block: TagOpBlock }
  | { type: 'kind'; cardKind: TagKind; docKind: TagKind }
  | { type: 'password' }
  | { type: 'nothing' }
  /** Same tag: there are changes, but none of them can be written (protected with the switch off, locked...). */
  | { type: 'excluded'; protectedN: number; lockedN: number; otherN: number };

export interface WriteReadiness {
  /** null while no supported tag is ready on the active reader. */
  relation: WriteRelation | null;
  card: { uid: string; kind: TagKind } | null;
  block: WriteBlock | null;
}

const sameUid = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();

export function relationOf(source: DocSourceLike, cardUid: string): WriteRelation {
  if (source.type === 'card') return sameUid(source.uid, cardUid) ? 'same' : 'other-card';
  return source.type;
}

/**
 * Decide, before the button is pressed, whether "write to tag" is possible and
 * why not (business-app-ux: 押してから断らない). `samePlan` is the plan of the
 * edits against doc.original (used only when the tag is the same one).
 */
export function writeReadiness(i: {
  source: DocSourceLike;
  kind: TagKind;
  reader: ReaderStatus | null;
  issueRunning: boolean;
  busyOp: string | null;
  passwordValid: boolean;
  samePlan: HexWritePlan | null;
}): WriteReadiness {
  const op = tagOpBlock(i.reader, { issueRunning: i.issueRunning, busyOp: i.busyOp });
  const c = i.reader?.card ?? null;
  if (op) return { relation: null, card: null, block: { type: 'op', block: op } };
  if (!c || !c.kind) return { relation: null, card: null, block: { type: 'op', block: 'unsupported' } };
  const card = { uid: c.uid, kind: c.kind };
  if (c.kind !== i.kind) return { relation: null, card, block: { type: 'kind', cardKind: c.kind, docKind: i.kind } };
  const relation = relationOf(i.source, c.uid);
  if (!i.passwordValid) return { relation, card, block: { type: 'password' } };
  if (relation === 'same') {
    const p = i.samePlan;
    if (!p || p.plan.writes.length === 0) {
      const ex = p ? p.excluded : null;
      const protectedN = ex ? ex.protected.length : 0;
      const lockedN = ex ? ex.locked.length : 0;
      const otherN = ex ? ex.keyA.length + ex.invalid.length + ex.otp.length : 0;
      if (protectedN + lockedN + otherN > 0) return { relation, card, block: { type: 'excluded', protectedN, lockedN, otherN } };
      return { relation, card, block: { type: 'nothing' } };
    }
  }
  return { relation, card, block: null };
}

// ---------------------------------------------------------------------------
// Write planning for the binary editor (same tag: edits; other tag: a copy)
// ---------------------------------------------------------------------------

export interface HexWritePlan {
  mode: 'same' | 'copy';
  plan: WritePlan;
  /** Changed units that this write leaves out, by reason. */
  excluded: {
    /** Protected (CC / lock / config / password / trailer / MC) while protected writes are off. */
    protected: number[];
    /** Locked on the tag (lock bits / MC write protect / access bits). */
    locked: number[];
    /** MIFARE trailer with key A still 00 (unknown). */
    keyA: number[];
    /** MIFARE trailer with invalid access bits. */
    invalid: number[];
    /** NTAG static lock page whose only change clears a lock bit (one-time bits cannot go back to 0). */
    otp: number[];
  };
  /** Copy only: units that differ from the target but are deliberately not copied. */
  notCopied: {
    /** Protected areas are never copied implicitly (I5); only ones the operator edited, with protected writes on. */
    protected: number[];
    /** Units the document never read (unknown content) and the operator did not edit. */
    unread: number[];
  };
  /** Protection settings are written: they take effect only after the tag is taken off and placed again. */
  reactivate: boolean;
}

function unitDiffers(a: Uint8Array, b: Uint8Array, unit: number, size: number, from = 0, to = size): boolean {
  const off = unit * size;
  for (let i = from; i < to; i++) if (a[off + i] !== b[off + i]) return true;
  return false;
}

/**
 * Bytes of a protected unit that a copy compares. NTAG page 2 bytes 0-1 are the
 * UID check byte + an internal byte (read-only, differ on every tag): only the
 * lock bytes 2-3 count. The NTAG213 dynamic-lock byte 3 is a fixed read value.
 */
function copyCompareRange(kind: TagKind, unit: number, size: number): [number, number] {
  if (isNtag(kind)) {
    if (unit === 2) return [2, 4];
    if (unit === ntagPages(kind).dynLock) return [0, 3];
  }
  return [0, size];
}

/** Units whose writes change protection (take effect after re-placing the tag). */
export function protectionUnits(kind: TagKind): number[] {
  if (isNtag(kind)) {
    const p = ntagPages(kind);
    return [2, p.dynLock, p.cfg0, p.cfg1, p.pwd, p.pack];
  }
  if (isFelica(kind)) return [specFor(kind).unitCount - 1];
  return [];
}

function summarizeExcluded(plan: WritePlan): HexWritePlan['excluded'] {
  const written = new Set(plan.writes.map((w) => w.unit));
  const byCode = (code: PlanWarningCode) => [...new Set(plan.warnings.filter((w) => w.code === code && w.unit !== null).map((w) => w.unit as number))];
  const forbidden = new Set(plan.forbiddenUnits);
  return {
    protected: plan.protectedUnits.filter((u) => !written.has(u) && !forbidden.has(u)),
    locked: byCode('LOCKED'),
    keyA: byCode('KEY_A_UNKNOWN'),
    invalid: byCode('ACCESS_BITS_INVALID'),
    // planWrites marks an NTAG page 2 edit that only clears lock bits as forbidden + LOCK_IRREVERSIBLE.
    otp: byCode('LOCK_IRREVERSIBLE').filter((u) => forbidden.has(u)),
  };
}

/**
 * Plan a write from the binary editor.
 *  - mode 'same': the target IS the tag the document was read from -> the edits
 *    (doc data vs doc.original), exactly like before.
 *  - mode 'copy': another tag, or a document from a file / new -> make the
 *    target's DATA AREA match the document: plan against what was just read
 *    from the target (`target`). The UID is never copied (I1); protected areas
 *    are copied only when the operator edited them and protected writes are on
 *    (I5); units the document never read (zero-filled) are not copied unless the
 *    operator edited them. Locked units of the target are left out (planWrites).
 */
export function planHexWrite(i: {
  kind: TagKind;
  mode: 'same' | 'copy';
  original: TagImage;
  data: Uint8Array;
  target?: TagImage;
  includeProtected: boolean;
  lockedUnits?: number[];
}): HexWritePlan {
  const spec = specFor(i.kind);
  const size = spec.unitSize;
  if (i.mode === 'same' || !i.target) {
    const plan = planWrites(i.kind, i.original, i.data, { includeProtected: i.includeProtected, lockedUnits: i.lockedUnits });
    return finish(i.kind, 'same', plan, { protected: [], unread: [] });
  }
  const target = i.target;
  const effective = new Uint8Array(target.data);
  const notCopied: HexWritePlan['notCopied'] = { protected: [], unread: [] };
  for (let u = 0; u < spec.unitCount; u++) {
    if (isForbiddenUnit(i.kind, u)) continue; // UID / manufacturer block: never copied
    const dirty = unitDiffers(i.data, i.original.data, u, size);
    if (isProtectedUnit(i.kind, u)) {
      const [from, to] = copyCompareRange(i.kind, u, size);
      if (!unitDiffers(i.data, target.data, u, size, from, to)) continue;
      if (i.includeProtected && dirty) {
        effective.set(i.data.subarray(u * size, (u + 1) * size), u * size);
        // NTAG page 2: the UID check bytes are the TARGET's own (I1, R-UX-8).
        if (isNtag(i.kind) && u === 2) effective.set(target.data.subarray(8, 10), 8);
      } else notCopied.protected.push(u);
      continue;
    }
    if (!unitDiffers(i.data, target.data, u, size)) continue;
    if (i.original.unitStatus[u] !== 'ok' && !dirty) {
      notCopied.unread.push(u);
      continue;
    }
    effective.set(i.data.subarray(u * size, (u + 1) * size), u * size);
  }
  const plan = planWrites(i.kind, target, effective, { includeProtected: i.includeProtected, lockedUnits: i.lockedUnits });
  return finish(i.kind, 'copy', plan, notCopied);
}

function finish(kind: TagKind, mode: 'same' | 'copy', plan: WritePlan, notCopied: HexWritePlan['notCopied']): HexWritePlan {
  const prot = new Set(protectionUnits(kind));
  return {
    mode,
    plan,
    excluded: summarizeExcluded(plan),
    notCopied,
    reactivate: plan.writes.some((w) => prot.has(w.unit)),
  };
}

/** Plan warnings grouped by code (first-seen order), only for written units unless `all`. */
export function groupWarnings(plan: WritePlan, opts: { all?: boolean } = {}): { code: PlanWarningCode; severity: 'info' | 'warn' | 'danger'; units: number[] }[] {
  const written = new Set(plan.writes.map((w) => w.unit));
  const rank = { info: 0, warn: 1, danger: 2 } as const;
  const out: { code: PlanWarningCode; severity: 'info' | 'warn' | 'danger'; units: number[] }[] = [];
  for (const w of plan.warnings) {
    if (!opts.all && w.unit !== null && !written.has(w.unit)) continue;
    let g = out.find((x) => x.code === w.code);
    if (!g) {
      g = { code: w.code, severity: w.severity, units: [] };
      out.push(g);
    }
    if (rank[w.severity] > rank[g.severity]) g.severity = w.severity;
    if (w.unit !== null && !g.units.includes(w.unit)) g.units.push(w.unit);
  }
  for (const g of out) g.units.sort((a, b) => a - b);
  return out;
}

/**
 * "4〜6, 10" for a set of units (FeliCa: block names "S_PAD3, MC"). At most
 * `max` items; `more` is how many were left out.
 */
export function formatUnits(kind: TagKind, units: number[], opts: { sep?: string; max?: number } = {}): { text: string; more: number } {
  const sep = opts.sep ?? '〜';
  const max = opts.max ?? 6;
  const sorted = [...new Set(units)].sort((a, b) => a - b);
  const items: string[] = [];
  if (isFelica(kind)) {
    for (const u of sorted) items.push(felicaBlockName(felicaBlockOfUnit(kind, u)));
  } else {
    for (let i = 0; i < sorted.length; ) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
      items.push(j === i ? String(sorted[i]) : `${sorted[i]}${sep}${sorted[j]}`);
      i = j + 1;
    }
  }
  const shown = items.slice(0, max);
  return { text: shown.join(', '), more: items.length - shown.length };
}

// ---------------------------------------------------------------------------
// Read-only cells (I1/I2 + protected + locked) - WRITE-7
// ---------------------------------------------------------------------------

/** 'uidCheck': NTAG page 2 bytes 0-1 (per byte, see isUidCheckByte). */
export type ReadOnlyReason = 'forbidden' | 'uidCheck' | 'locked' | 'protected';

/**
 * Units shown as locked in the grid: only for a document read from a tag (the
 * lock bits describe THAT tag). A file / new document is written as a copy, and
 * the target's own locks are applied when the write is planned.
 */
export function displayLockedUnits(source: DocSourceLike, kind: TagKind, original: TagImage): number[] {
  return source.type === 'card' ? lockedUnitsOf(kind, original) : [];
}

export function readOnlyReason(
  kind: TagKind,
  unit: number,
  ctx: { locked: ReadonlySet<number>; protectedEditable: boolean },
): ReadOnlyReason | null {
  if (isForbiddenUnit(kind, unit)) return 'forbidden';
  if (ctx.locked.has(unit)) return 'locked';
  if (!ctx.protectedEditable && isProtectedUnit(kind, unit)) return 'protected';
  return null;
}

/** readOnlyReason for one BYTE: adds the NTAG UID check bytes (page 2 bytes 0-1). */
export function byteReadOnlyReason(
  kind: TagKind,
  byteIndex: number,
  ctx: { locked: ReadonlySet<number>; protectedEditable: boolean },
): ReadOnlyReason | null {
  const unitReason = readOnlyReason(kind, Math.floor(byteIndex / specFor(kind).unitSize), ctx);
  if (unitReason === 'forbidden') return unitReason;
  if (isUidCheckByte(kind, byteIndex)) return 'uidCheck';
  return unitReason;
}

/**
 * Edit chokepoint: copy of `next` where every read-only unit keeps the bytes of
 * `current` (the document before this edit). `changed` reports whether any byte
 * had to be put back (so the view can say why part of an edit did not apply).
 */
export function keepReadOnlyUnits(
  kind: TagKind,
  next: Uint8Array,
  current: Uint8Array,
  ctx: { locked: ReadonlySet<number>; protectedEditable: boolean },
): { data: Uint8Array; changed: boolean } {
  const spec = specFor(kind);
  const out = new Uint8Array(next);
  let changed = false;
  for (let u = 0; u < spec.unitCount; u++) {
    if (!readOnlyReason(kind, u, ctx)) continue;
    const off = u * spec.unitSize;
    for (let i = off; i < off + spec.unitSize; i++) {
      if (out[i] !== current[i]) {
        out[i] = current[i];
        changed = true;
      }
    }
  }
  // NTAG page 2 bytes 0-1 stay read-only even when protected areas are editable (R-UX-8).
  if (isNtag(kind)) {
    for (const i of [8, 9]) {
      if (out[i] !== current[i]) {
        out[i] = current[i];
        changed = true;
      }
    }
  }
  return { data: out, changed };
}

// ---------------------------------------------------------------------------
// Initialize ("タグ初期化") per kind - WRITE-16
// ---------------------------------------------------------------------------

const NDEF_AID = 0x03e1;

/** MAD AID of a MIFARE data sector (0 when unmapped). Same layout as shared/ndef/mifare.ts. */
function mifareSectorAid(data: Uint8Array, sector: number): number {
  let off: number;
  if (sector >= 1 && sector <= 15) off = 16 + 2 * sector;
  else if (sector >= 17 && sector <= 39) off = 1024 + 2 * (sector - 16);
  else return 0;
  if (off + 1 >= data.length) return 0;
  return (data[off] << 8) | data[off + 1];
}

/** Data blocks of the sectors the MAD marks as NDEF (empty when the card is not NDEF-formatted). */
export function mifareNdefBlocks(kind: TagKind, data: Uint8Array): number[] {
  if (!isMifare(kind)) return [];
  const out: number[] = [];
  for (let s = 1; s < mifareSectorCount(kind); s++) {
    if (s === 16) continue; // MAD2 directory
    if (mifareSectorAid(data, s) !== NDEF_AID) continue;
    for (let b = mifareSectorFirstBlock(s); b < mifareTrailerBlock(s); b++) out.push(b);
  }
  return out;
}

export type InitMode = 'ndef' | 'zero';

/**
 * The data area cleared to a blank state, per kind:
 *  - NTAG: user pages zeroed + an empty NDEF TLV (03 00 FE) on page 4. UID, CC,
 *    lock, config and password pages are kept.
 *  - FeliCa Lite-S: S_PAD0..13 zeroed. REG and MC are kept.
 *  - MIFARE 'ndef': the data blocks of the NDEF sectors zeroed + 03 00 FE in the
 *    first one; MAD, trailers and non-NDEF sectors are kept (stays NDEF-formatted).
 *  - MIFARE 'zero': every data block zeroed (block 0 and trailers kept) - the MAD
 *    is erased too, so the card is no longer NDEF-formatted.
 */
export function initializeImage(kind: TagKind, data: Uint8Array, mode: InitMode = 'ndef'): Uint8Array {
  const spec = specFor(kind);
  const next = new Uint8Array(data);
  const size = spec.unitSize;
  if (isNtag(kind)) {
    const us = spec.userStartUnit * size;
    // Keep the Lock / Memory Control TLVs at the start of the user memory: they describe the
    // tag's lock bytes, not data, and are part of the factory content (a real NTAG213 ships
    // with 01 03 A0 0C 34 before the empty NDEF - Sony PaSoRi, 2026-11-14). Erasing them
    // would not be "back to the factory content".
    let keep = 0;
    while (keep + 2 <= spec.userBytes) {
      const type = data[us + keep];
      if (type !== 0x01 && type !== 0x02) break;
      const len = data[us + keep + 1];
      if (len === 0xff || keep + 2 + len + 3 > spec.userBytes) break;
      keep += 2 + len;
    }
    next.fill(0, us + keep, us + spec.userBytes);
    next.set([0x03, 0x00, 0xfe], us + keep);
    return next;
  }
  if (isFelica(kind)) {
    next.fill(0, 0, 14 * size); // S_PAD0..S_PAD13 (units 0..13); REG = 14, MC = 15
    return next;
  }
  const ndef = mode === 'ndef' ? mifareNdefBlocks(kind, data) : [];
  const blocks = mode === 'ndef' ? ndef : mifareDataBlocks(kind);
  for (const b of blocks) next.fill(0, b * size, (b + 1) * size);
  if (mode === 'ndef' && ndef.length > 0) next.set([0x03, 0x00, 0xfe], ndef[0] * size);
  return next;
}

/** NTAG password input: empty (none) or exactly 8 hex digits. */
export function isValidNtagPassword(s: string): boolean {
  return s === '' || /^[0-9a-fA-F]{8}$/.test(s);
}

// ---------------------------------------------------------------------------
// NTAG password auth vs the reader (2026-11-12 review R-UX-1, decision D11)
// ---------------------------------------------------------------------------

/**
 * True when the active reader cannot send PWD_AUTH: a storage-only reader (Sony
 * PaSoRi and the like: FF B0 / FF D6 only, no raw NFC-A commands). Known from the
 * tag on it (`card.rawCommands`), or - with no tag - from an explicit "storage"
 * driver setting. With no tag and the automatic driver it is not known yet: false.
 */
export function passwordAuthUnavailable(reader: ReaderStatus | null): boolean {
  if (!reader) return false;
  if (reader.card) return !reader.card.rawCommands;
  // No tag: the transport main resolved for the active reader (D11).
  if (reader.activeDriver) return reader.activeDriver === 'storage';
  return reader.driverMode === 'storage';
}

// ---------------------------------------------------------------------------
// NTAG password protection from the parameter editor (review R-UX-5)
// ---------------------------------------------------------------------------

export type DeniedHint = 'ntagStorage' | 'ntagWrongPw' | 'ntagNoPw' | 'ntag' | 'mifare' | 'other';

/**
 * Which explanation (and button) to show for the pages / blocks a read could not
 * open. NTAG: a storage-only reader cannot authenticate at all (R-UX-1); a read
 * that sent the password = wrong password; a password entered but this read did
 * not send it (auto-read never does) = "read with the password" (R-UX-12).
 * MIFARE (D9): "read with registered keys".
 */
export function deniedHint(i: {
  kind: TagKind;
  deniedN: number;
  noAuth: boolean;
  password: string;
  /** readAt of the last read that sent the password. */
  pwReadAt: number | null;
  /** readAt of the document as read. */
  readAt: number;
}): DeniedHint | null {
  if (i.deniedN === 0) return null;
  if (isNtag(i.kind)) {
    if (i.noAuth) return 'ntagStorage';
    if (i.password && i.pwReadAt === i.readAt) return 'ntagWrongPw';
    if (i.password) return 'ntagNoPw';
    return 'ntag';
  }
  return isMifare(i.kind) ? 'mifare' : 'other';
}

/**
 * CFGLCK together with AUTH0 at or before CFG1 cannot be written in one pass:
 * buildNtagConfigWrites throws (a Japanese-only message) for exactly this, so the
 * parameter editor refuses it first, in the UI language (R-UX-10).
 */
export function ntagCfgLockConflict(kind: TagKind, cfg: { auth0: number; cfgLock: boolean }): boolean {
  return isNtag(kind) && cfg.cfgLock && cfg.auth0 <= ntagPages(kind).cfg1;
}

/** AUTH0 within the memory = password protection is on (AUTH0 past the last page = off). */
export function ntagProtectionOn(kind: TagKind, auth0: number): boolean {
  return isNtag(kind) && auth0 < specFor(kind).unitCount;
}

/** The PWD or PACK page differs from what was read / opened (a password is being set in this document). */
export function ntagPasswordEdited(kind: TagKind, data: Uint8Array, original: Uint8Array): boolean {
  if (!isNtag(kind)) return false;
  const p = ntagPages(kind);
  return unitDiffers(data, original, p.pwd, 4) || unitDiffers(data, original, p.pack, 4);
}

/**
 * The writes turn password protection ON (CFG0's AUTH0 moves into the memory on a
 * tag where it was off) but do not write a password (no PWD page): the tag would
 * be "protected" by the PWD it already has (FFFFFFFF from the factory). R-UX-5.
 */
export function ntagArmsWithoutPassword(kind: TagKind, base: Uint8Array, writes: { unit: number; data: Uint8Array }[]): boolean {
  if (!isNtag(kind)) return false;
  const p = ntagPages(kind);
  const cfg0 = writes.find((w) => w.unit === p.cfg0);
  if (!cfg0) return false;
  if (writes.some((w) => w.unit === p.pwd)) return false;
  return ntagProtectionOn(kind, cfg0.data[3]) && !ntagProtectionOn(kind, base[p.cfg0 * 4 + 3]);
}

export type NewPasswordProblem = 'pwdFormat' | 'pwdZero' | 'pwdFactory' | 'mismatch' | 'packFormat';

/**
 * Checks the password chosen when protection is turned on. 00000000 cannot be
 * written by a diff-based plan (PWD always reads back as 00), FFFFFFFF is the
 * factory password everybody knows (no protection).
 */
export function newNtagPasswordProblem(pwd: string, confirm: string, pack: string): NewPasswordProblem | null {
  if (!/^[0-9a-fA-F]{8}$/.test(pwd)) return 'pwdFormat';
  if (/^0{8}$/.test(pwd)) return 'pwdZero';
  if (/^f{8}$/i.test(pwd)) return 'pwdFactory';
  if (pwd.toUpperCase() !== confirm.toUpperCase()) return 'mismatch';
  if (!/^[0-9a-fA-F]{4}$/.test(pack)) return 'packFormat';
  return null;
}
