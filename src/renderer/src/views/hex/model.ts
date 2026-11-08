// Pure logic for the binary (hex) editor. No DOM, no store, no React - safe to
// import from the node-environment unit tests (tests/hex*.test.ts).
//
// Design invariant (I1/I2): the tag UID is fixed at manufacture and read-only.
// `restoreLockedBytes` is the single chokepoint the view runs on every edit so a
// forbidden unit (NTAG pages 0-1, MIFARE block 0) can never be changed by any
// operation here - increment, fill, paste, replace or direct typing.
import type { TagKind } from '@shared/tags';
import { isForbiddenUnit, isMifare, mifareIsTrailer, regionOf, specFor } from '@shared/tags';
import type { PlanWarningCode, WritePlan } from '@shared/tag';
import { hexToBytes, utf8ToBytes } from '@shared/hex';

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

/** True when any byte of [lo, hi] (inclusive) lies in a forbidden unit. */
export function rangeTouchesForbidden(kind: TagKind, lo: number, hi: number): boolean {
  const size = specFor(kind).unitSize;
  for (let u = Math.floor(lo / size); u <= Math.floor(hi / size); u++) {
    if (isForbiddenUnit(kind, u)) return true;
  }
  return false;
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
