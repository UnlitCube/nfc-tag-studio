// Write planning: compare a read image with edited bytes and plan the minimal,
// safe set of unit writes. Pure TypeScript: no Node, no DOM.
//
// 2026-11-12 (UX audit WALK-2 / WRITE-7 / WRITE-15):
// - MIFARE trailer rules apply to MIFARE only. FeliCa Lite-S units 3/7/11/15
//   (S_PAD3/7/11, MC) used to be taken for MIFARE sector trailers, so a plain
//   S_PAD3 edit was "forbidden" and an MC edit raised MIFARE access-bit warnings.
// - Units the tag will refuse anyway are left out with a reason (LOCKED): NTAG
//   lock bits, FeliCa MC write-protect mask, MIFARE "never write" access bits.
//   A PaSoRi (storage driver) answers 90 00 to a write on a lock-bit-locked NTAG
//   page, so planning it would only surface as a verify mismatch afterwards.
// - A MIFARE trailer whose key A is still all-zero (a real card never returns
//   key A; it reads back as 00) is not written (KEY_A_UNKNOWN): writing it would
//   silently change the sector's key A to 000000000000.

import {
  type TagKind,
  isNtag,
  isMifare,
  isFelica,
  ntagPages,
  mifareIsTrailer,
  mifareSectorCount,
  mifareSectorFirstBlock,
  mifareSectorBlockCount,
  mifareTrailerBlock,
  isForbiddenUnit,
  isProtectedUnit,
  parseAccessBits,
  specFor,
} from '../tags';
import type { TagImage, UnitWrite } from '../types';
import { decodeFelicaMc } from '../felica';
import { unitBytes, diffUnits } from './image';
import { readNtagLockState } from './ntag';
import { describeAccess } from './mifare';

export type PlanWarningCode =
  | 'UID_READONLY'
  | 'CC_OTP'
  | 'LOCK_IRREVERSIBLE'
  | 'CONFIG'
  | 'PASSWORD'
  | 'TRAILER'
  | 'ACCESS_BITS_INVALID'
  | 'UNREAD_UNIT'
  /** The unit is locked on the tag (lock bits / MC write protect / access bits): not written. */
  | 'LOCKED'
  /** MIFARE trailer with key A = 00..00 (unknown, read back as 00): not written. */
  | 'KEY_A_UNKNOWN'
  /** FeliCa Lite-S MC (memory configuration) block. danger when it sets a protection bit. */
  | 'FELICA_MC';

export interface PlanWarning {
  unit: number | null;
  code: PlanWarningCode;
  severity: 'info' | 'warn' | 'danger';
  /** Japanese message for the operator. */
  message: string;
}

export interface WritePlan {
  /** Units to write, in address order (password-related writes reordered safely: PWD, PACK, CFG1, CFG0). */
  writes: UnitWrite[];
  /** Changed units that are protected (included in writes only when includeProtected). */
  protectedUnits: number[];
  /**
   * Changed units that can never be written by this plan (UID pages, block 0,
   * invalid trailers, locked units, trailers with an unknown key A). Never in writes.
   */
  forbiddenUnits: number[];
  warnings: PlanWarning[];
}

const MSG: Record<PlanWarningCode, string> = {
  UID_READONLY: 'UID（製造番号）は書き換えできません。この変更は書き込みません。',
  CC_OTP: 'CC（容量情報）は一度だけ書ける領域です。',
  LOCK_IRREVERSIBLE: 'ロックビットは一度立てると元に戻せません。',
  CONFIG: '設定ページ（CFG0 / CFG1）を書き換えます。',
  PASSWORD: 'パスワード設定ページを書き換えます。',
  TRAILER: 'セクタトレーラ（鍵・アクセス条件）を書き換えます。',
  ACCESS_BITS_INVALID: 'アクセスビットが不正です。書き込むとセクタが恒久的にロックされます。',
  UNREAD_UNIT: '読み取れていない領域に書き込みます（元の値が不明です）。',
  LOCKED: 'タグ側でロック（書き込み禁止）されています。この変更は書き込みません。',
  KEY_A_UNKNOWN:
    '鍵 A が分からない（タグからは 00 として読める）ため、このまま書くと鍵 A が 000000000000 に変わります。この変更は書き込みません。',
  FELICA_MC: 'MC（メモリ構成）を書き換えます。書き込み保護は一度立てると元に戻せません。',
};

const OTP_CLEAR_MSG = 'OTP ビットは 1 に固定され、0 に戻せません。';

function severityForCode(code: PlanWarningCode): 'info' | 'warn' | 'danger' {
  return code === 'LOCK_IRREVERSIBLE' || code === 'ACCESS_BITS_INVALID' || code === 'KEY_A_UNKNOWN' ? 'danger' : 'warn';
}

/** NTAG OTP units whose bits can only be set (page 2 static lock, page 3 CC, dynamic lock). */
function isNtagOtpUnit(kind: TagKind, unit: number): boolean {
  const p = ntagPages(kind);
  return unit === 2 || unit === 3 || unit === p.dynLock;
}

function protectedCode(kind: TagKind, unit: number): PlanWarningCode {
  if (isFelica(kind)) return 'FELICA_MC';
  if (isMifare(kind)) return 'TRAILER';
  const p = ntagPages(kind);
  if (unit === 2 || unit === p.dynLock) return 'LOCK_IRREVERSIBLE';
  if (unit === 3) return 'CC_OTP';
  if (unit === p.cfg0 || unit === p.cfg1) return 'CONFIG';
  if (unit === p.pwd || unit === p.pack) return 'PASSWORD';
  return 'CONFIG';
}

/** True when any set bit in `base` is cleared in `edit` (illegal for OTP regions). */
function clearsBit(base: Uint8Array, edit: Uint8Array): boolean {
  for (let i = 0; i < base.length; i++) {
    if ((base[i] & ~edit[i] & 0xff) !== 0) return true;
  }
  return false;
}

/**
 * NTAG page 2 = [BCC1, internal, LOCK0, LOCK1]. BCC1 (the UID check byte) and the
 * internal byte are fixed at manufacture: the tag ignores them on a write, so
 * they are always taken from `base` (I1 - an edit must never look like it changed
 * something derived from the UID). The two static lock bytes are OTP: the tag
 * ORs the written bits in and never clears one, so the write carries base|edit -
 * exactly what the tag will hold afterwards (the verify then matches).
 * 2026-11-12 review R-UX-8.
 */
export function ntagPage2Effective(base: Uint8Array, edit: Uint8Array): Uint8Array {
  return Uint8Array.from([base[0], base[1], (base[2] | edit[2]) & 0xff, (base[3] | edit[3]) & 0xff]);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * FeliCa MC edit that newly protects something: a read/write-protect mask bit
 * (MC[6..11]) goes 0 -> 1, or the system blocks become read-only (MC[2] leaves 0xFF).
 */
function felicaMcProtects(base: Uint8Array, edit: Uint8Array): boolean {
  for (let i = 6; i <= 11; i++) if ((edit[i] & ~base[i] & 0xff) !== 0) return true;
  return base[2] === 0xff && edit[2] !== 0xff;
}

/**
 * For NTAG: lock pages (static lock page 2, dynamic lock) after every other unit,
 * so data is written before the bits that lock it; then the password/config
 * group last in PWD, PACK, CFG1, CFG0 order (DESIGN §3.1).
 */
function reorderNtagGroup(kind: TagKind, writes: UnitWrite[]): UnitWrite[] {
  const p = ntagPages(kind);
  const locks = [2, p.dynLock];
  const group = [p.pwd, p.pack, p.cfg1, p.cfg0];
  const rest = writes.filter((w) => !group.includes(w.unit) && !locks.includes(w.unit));
  const pick = (us: number[]) => us.map((u) => writes.find((w) => w.unit === u)).filter((w): w is UnitWrite => Boolean(w));
  return [...rest, ...pick(locks), ...pick(group)];
}

/**
 * Units of `img` the tag refuses to write, decided from the image itself (as
 * read): NTAG static/dynamic lock bits (incl. the CC lock), FeliCa Lite-S MC
 * write-protect mask (and MC itself when the system blocks are read-only),
 * MIFARE blocks whose access bits allow no key to write. A unit whose control
 * bytes were not readable is not judged (returns nothing for it).
 */
export function lockedUnitsOf(kind: TagKind, img: TagImage): number[] {
  const out = new Set<number>();
  const ok = (u: number) => img.unitStatus[u] === 'ok';
  if (isNtag(kind)) {
    const p = ntagPages(kind);
    if (ok(2) || ok(p.dynLock)) {
      // Judge only from readable lock bytes (an unread page is zero-filled anyway).
      const data = new Uint8Array(img.data);
      if (!ok(2)) data.fill(0, 2 * 4 + 2, 2 * 4 + 4);
      if (!ok(p.dynLock)) data.fill(0, p.dynLock * 4, p.dynLock * 4 + 3);
      for (const u of readNtagLockState(kind, data).lockedPages) out.add(u);
    }
  } else if (isFelica(kind)) {
    const mcUnit = specFor(kind).unitCount - 1;
    if (ok(mcUnit)) {
      const mc = decodeFelicaMc(img.data.subarray(mcUnit * 16, mcUnit * 16 + 16));
      for (let b = 0; b < mcUnit && b < mc.writable.length; b++) if (!mc.writable[b]) out.add(b);
      if (!mc.systemBlocksWritable) out.add(mcUnit);
    }
  } else if (isMifare(kind)) {
    for (let s = 0; s < mifareSectorCount(kind); s++) {
      const trailer = mifareTrailerBlock(s);
      if (!ok(trailer)) continue;
      const bits = parseAccessBits(unitBytes(kind, img.data, trailer));
      if (!bits) continue;
      const first = mifareSectorFirstBlock(s);
      const count = mifareSectorBlockCount(s);
      for (let i = 0; i < count - 1; i++) {
        const group = (count === 4 ? i : Math.floor(i / 5)) as 0 | 1 | 2;
        const block = first + i;
        if (block === 0) continue; // manufacturer block: forbidden anyway
        if (describeAccess(bits, group).write === 'never') out.add(block);
      }
      if (describeAccess(bits, 3).write === 'never') out.add(trailer);
    }
  }
  return Array.from(out).sort((a, b) => a - b);
}

/**
 * Compare the image as read (`base`) with the edited bytes and plan the minimal
 * set of unit writes. Rules:
 * - forbidden units (isForbiddenUnit) are never written -> forbiddenUnits + UID_READONLY warning
 * - units locked on the tag (lockedUnitsOf(base) + opts.lockedUnits) are never written -> forbiddenUnits + LOCKED
 * - a MIFARE trailer whose access bits do not parse (parseAccessBits === null) is forbidden (ACCESS_BITS_INVALID, danger)
 * - protected units only when includeProtected; each gets a warning (CC_OTP / LOCK_IRREVERSIBLE / CONFIG / PASSWORD / TRAILER / FELICA_MC)
 * - a MIFARE trailer whose key A is all zero is not written (KEY_A_UNKNOWN, danger)
 * - units that were not readable in `base` (unitStatus !== 'ok') get UNREAD_UNIT warnings
 * - NTAG lock bytes / CC are OTP (bits only set): warn when an edit tries to clear a bit
 * - NTAG page 2: bytes 0-1 (UID check byte) always from base, lock bytes base|edit;
 *   a page 2 edit that leaves nothing to write is not written (forbiddenUnits)
 */
export function planWrites(
  kind: TagKind,
  base: TagImage,
  edited: Uint8Array,
  opts: { includeProtected: boolean; lockedUnits?: number[] },
): WritePlan {
  const writes: UnitWrite[] = [];
  const protectedUnits: number[] = [];
  const forbiddenUnits: number[] = [];
  const warnings: PlanWarning[] = [];
  const locked = new Set<number>([...lockedUnitsOf(kind, base), ...(opts.lockedUnits ?? [])]);

  for (const unit of diffUnits(kind, base.data, edited)) {
    const rawEdit = unitBytes(kind, edited, unit);
    let editUnit = rawEdit;
    const baseUnit = unitBytes(kind, base.data, unit);

    if (isForbiddenUnit(kind, unit)) {
      forbiddenUnits.push(unit);
      warnings.push({ unit, code: 'UID_READONLY', severity: 'warn', message: MSG.UID_READONLY });
      continue;
    }

    // NTAG page 2: bytes 0-1 (UID check byte + internal) are never written; the
    // lock bytes are written as base|edit (R-UX-8). When nothing the tag would
    // accept is left, the unit is not written at all and says why.
    let ntagLockClear = false;
    if (isNtag(kind) && unit === 2) {
      ntagLockClear = clearsBit(baseUnit.subarray(2, 4), rawEdit.subarray(2, 4));
      if (rawEdit[0] !== baseUnit[0] || rawEdit[1] !== baseUnit[1]) {
        warnings.push({ unit, code: 'UID_READONLY', severity: 'warn', message: MSG.UID_READONLY });
      }
      editUnit = ntagPage2Effective(baseUnit, rawEdit);
      if (bytesEqual(editUnit, baseUnit)) {
        forbiddenUnits.push(unit);
        if (ntagLockClear) warnings.push({ unit, code: 'LOCK_IRREVERSIBLE', severity: 'danger', message: OTP_CLEAR_MSG });
        continue;
      }
    }

    if (locked.has(unit)) {
      forbiddenUnits.push(unit);
      warnings.push({ unit, code: 'LOCKED', severity: 'warn', message: MSG.LOCKED });
      continue;
    }

    const mifareTrailer = isMifare(kind) && mifareIsTrailer(unit);
    if (mifareTrailer && parseAccessBits(editUnit) === null) {
      forbiddenUnits.push(unit);
      warnings.push({ unit, code: 'ACCESS_BITS_INVALID', severity: 'danger', message: MSG.ACCESS_BITS_INVALID });
      continue;
    }

    if (isProtectedUnit(kind, unit)) {
      if (opts.includeProtected && mifareTrailer && editUnit.subarray(0, 6).every((b) => b === 0)) {
        forbiddenUnits.push(unit);
        warnings.push({ unit, code: 'KEY_A_UNKNOWN', severity: 'danger', message: MSG.KEY_A_UNKNOWN });
        continue;
      }
      protectedUnits.push(unit);
      const otpClear = isNtag(kind) && isNtagOtpUnit(kind, unit) && (unit === 2 ? ntagLockClear : clearsBit(baseUnit, editUnit));
      if (opts.includeProtected || otpClear) {
        const code: PlanWarningCode = otpClear
          ? unit === 3
            ? 'CC_OTP'
            : 'LOCK_IRREVERSIBLE'
          : protectedCode(kind, unit);
        const severity = otpClear
          ? 'danger'
          : code === 'FELICA_MC'
            ? felicaMcProtects(baseUnit, editUnit)
              ? 'danger'
              : 'warn'
            : severityForCode(code);
        warnings.push({ unit, code, severity, message: otpClear ? OTP_CLEAR_MSG : MSG[code] });
      }
      if (opts.includeProtected) {
        writes.push({ unit, data: editUnit });
        if (base.unitStatus[unit] !== 'ok') {
          warnings.push({ unit, code: 'UNREAD_UNIT', severity: 'warn', message: MSG.UNREAD_UNIT });
        }
      }
      continue;
    }

    // normal writable user unit
    writes.push({ unit, data: editUnit });
    if (base.unitStatus[unit] !== 'ok') {
      warnings.push({ unit, code: 'UNREAD_UNIT', severity: 'warn', message: MSG.UNREAD_UNIT });
    }
  }

  writes.sort((a, b) => a.unit - b.unit);
  const ordered = isNtag(kind) ? reorderNtagGroup(kind, writes) : writes;
  return { writes: ordered, protectedUnits, forbiddenUnits, warnings };
}
