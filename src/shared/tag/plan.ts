// Write planning: compare a read image with edited bytes and plan the minimal,
// safe set of unit writes. Pure TypeScript: no Node, no DOM.

import {
  type TagKind,
  isNtag,
  ntagPages,
  mifareIsTrailer,
  isForbiddenUnit,
  isProtectedUnit,
  parseAccessBits,
} from '../tags';
import type { TagImage, UnitWrite } from '../types';
import { unitBytes, diffUnits } from './image';

export type PlanWarningCode =
  | 'UID_READONLY'
  | 'CC_OTP'
  | 'LOCK_IRREVERSIBLE'
  | 'CONFIG'
  | 'PASSWORD'
  | 'TRAILER'
  | 'ACCESS_BITS_INVALID'
  | 'UNREAD_UNIT';

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
  /** Changed units that can never be written (UID pages, block 0, invalid trailers). Never in writes. */
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
};

const OTP_CLEAR_MSG = 'OTP ビットは 1 に固定され、0 に戻せません。';

function severityForCode(code: PlanWarningCode): 'info' | 'warn' | 'danger' {
  return code === 'LOCK_IRREVERSIBLE' || code === 'ACCESS_BITS_INVALID' ? 'danger' : 'warn';
}

/** NTAG OTP units whose bits can only be set (page 2 static lock, page 3 CC, dynamic lock). */
function isNtagOtpUnit(kind: TagKind, unit: number): boolean {
  const p = ntagPages(kind);
  return unit === 2 || unit === 3 || unit === p.dynLock;
}

function protectedCode(kind: TagKind, unit: number): PlanWarningCode {
  if (!isNtag(kind)) return 'TRAILER';
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

/** For NTAG, move the password/config group to the end in PWD, PACK, CFG1, CFG0 order. */
function reorderNtagGroup(kind: TagKind, writes: UnitWrite[]): UnitWrite[] {
  const p = ntagPages(kind);
  const group = [p.pwd, p.pack, p.cfg1, p.cfg0];
  const rest = writes.filter((w) => !group.includes(w.unit));
  const groupWrites = group
    .map((u) => writes.find((w) => w.unit === u))
    .filter((w): w is UnitWrite => Boolean(w));
  return [...rest, ...groupWrites];
}

/**
 * Compare the image as read (`base`) with the edited bytes and plan the minimal
 * set of unit writes. Rules:
 * - forbidden units (isForbiddenUnit) are never written -> forbiddenUnits + UID_READONLY warning
 * - protected units only when includeProtected; each gets a warning (CC_OTP / LOCK_IRREVERSIBLE / CONFIG / PASSWORD / TRAILER)
 * - a MIFARE trailer whose access bits do not parse (parseAccessBits === null) is forbidden (ACCESS_BITS_INVALID, danger)
 * - units that were not readable in `base` (unitStatus !== 'ok') get UNREAD_UNIT warnings
 * - NTAG lock bytes / CC are OTP (bits only set): warn when an edit tries to clear a bit
 */
export function planWrites(
  kind: TagKind,
  base: TagImage,
  edited: Uint8Array,
  opts: { includeProtected: boolean },
): WritePlan {
  const writes: UnitWrite[] = [];
  const protectedUnits: number[] = [];
  const forbiddenUnits: number[] = [];
  const warnings: PlanWarning[] = [];

  for (const unit of diffUnits(kind, base.data, edited)) {
    const editUnit = unitBytes(kind, edited, unit);
    const baseUnit = unitBytes(kind, base.data, unit);

    if (isForbiddenUnit(kind, unit)) {
      forbiddenUnits.push(unit);
      warnings.push({ unit, code: 'UID_READONLY', severity: 'warn', message: MSG.UID_READONLY });
      continue;
    }

    if (!isNtag(kind) && mifareIsTrailer(unit) && parseAccessBits(editUnit) === null) {
      forbiddenUnits.push(unit);
      warnings.push({ unit, code: 'ACCESS_BITS_INVALID', severity: 'danger', message: MSG.ACCESS_BITS_INVALID });
      continue;
    }

    if (isProtectedUnit(kind, unit)) {
      protectedUnits.push(unit);
      const otpClear = isNtag(kind) && isNtagOtpUnit(kind, unit) && clearsBit(baseUnit, editUnit);
      if (opts.includeProtected || otpClear) {
        const code: PlanWarningCode = otpClear
          ? unit === 3
            ? 'CC_OTP'
            : 'LOCK_IRREVERSIBLE'
          : protectedCode(kind, unit);
        warnings.push({
          unit,
          code,
          severity: otpClear ? 'danger' : severityForCode(code),
          message: otpClear ? OTP_CLEAR_MSG : MSG[code],
        });
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
